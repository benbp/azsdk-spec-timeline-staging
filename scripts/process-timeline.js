#!/usr/bin/env node
/**
 * process-timeline.js
 *
 * Processes raw fetch-timeline.js output into a final timeline JSON
 * suitable for the timeline-viz website.
 *
 * Usage: node scripts/process-timeline.js <raw-json> <output-json> <title>
 *
 * The raw JSON is produced by fetch-timeline.js and contains `_raw` fields
 * with comments, reviews, reviewComments, and commits arrays. This script
 * classifies events, detects nags/manual fixes, computes idle gaps,
 * and generates insights.
 */

const fs = require('fs');
const path = require('path');

const BOT_ACTORS = new Set([
  'azure-sdk', 'github-actions[bot]', 'azure-pipelines[bot]',
  'copilot-pull-request-reviewer[bot]', 'Copilot', 'msftbot[bot]'
]);

const NAG_PHRASES = [
  'please review', 'could you check', 'can you merge',
  'can you approve', 'could you approve', 'please merge',
  'can you take a look'
];

const MANUAL_FIX_PHRASES = [
  'manually edited', 'manually ran', 'manual intervention', 'had to manually'
];

function isBot(user) {
  return BOT_ACTORS.has(user) || (user && user.endsWith('[bot]'));
}

function makeActorRole(user, owner) {
  if (user === owner) return 'author';
  if (user === 'Copilot' || user === 'copilot-pull-request-reviewer[bot]') return 'copilot';
  if (isBot(user)) return 'bot';
  return 'reviewer';
}

function classifySentiment(eventType) {
  if (eventType === 'pr_merged' || eventType === 'review_approved') return 'positive';
  if (eventType === 'review_changes_requested' || eventType === 'author_nag') return 'blocking';
  if (eventType === 'manual_fix') return 'negative';
  if (eventType === 'idle_gap') return 'blocking';
  return 'neutral';
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const d1 = new Date(a);
  const d2 = new Date(b);
  return Math.round(((d2 - d1) / 86400000) * 100) / 100;
}

// Extract description from comment body, skipping markdown quote lines (> ...)
function stripQuotedDescription(body) {
  const lines = body.split('\n');
  const firstNonQuote = lines.find(l => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !trimmed.startsWith('>');
  });
  const text = firstNonQuote || lines[0] || '';
  return text.trim().slice(0, 100).replace(/\n/g, ' ');
}

// Compute total time waiting for reviewer response.
// A wait cycle starts at PR creation (or ready_for_review if draft) or after an author action,
// and ends when a non-bot reviewer responds.
const REVIEW_WAIT_SKIP_TYPES = new Set([
  'idle_gap', 'bot_comment', 'label_added', 'ci_status',
  'release_pipeline_started', 'release_pipeline_completed', 'release_pipeline_failed',
  'release_pending', 'convert_to_draft'
]);

function computeReviewWaitDays(events, readyForReviewAt) {
  let totalMs = 0;
  let cycleCount = 0;
  let waitStart = null;

  // If there's a ready_for_review event, skip all events before it
  const startAfter = readyForReviewAt ? new Date(readyForReviewAt).getTime() : 0;

  for (const e of events) {
    if (REVIEW_WAIT_SKIP_TYPES.has(e.type)) continue;

    const ts = new Date(e.timestamp).getTime();

    // Skip events before ready_for_review for draft PRs
    if (ts < startAfter) continue;

    if (e.type === 'ready_for_review') {
      // Draft PR becoming ready — start waiting for review
      waitStart = ts;
      continue;
    }

    if (e.type === 'pr_created') {
      // Non-draft PR creation or fallback — start waiting
      if (!readyForReviewAt) {
        waitStart = ts;
      }
      continue;
    }

    if (e.actorRole === 'reviewer') {
      // Reviewer responded — end this wait cycle
      if (waitStart !== null) {
        totalMs += ts - waitStart;
        cycleCount++;
        waitStart = null;
      }
      continue;
    }

    // Author/bot/copilot action — if no wait in progress, start one
    if (e.actorRole === 'author' || e.actorRole === 'bot' || e.actorRole === 'copilot') {
      if (waitStart === null) {
        waitStart = ts;
      }
      // If wait already in progress, author actions just keep the clock running
    }
  }

  const totalDays = totalMs > 0 ? Math.round((totalMs / 86400000) * 100) / 100 : 0;
  return { reviewWaitDays: totalDays, reviewWaitCycles: cycleCount };
}

function processEvents(prData, owner) {
  const events = [];
  const raw = prData._raw || {};

  // PR created
  if (prData.createdAt) {
    events.push({
      type: 'pr_created',
      timestamp: prData.createdAt,
      actor: prData.author,
      actorRole: isBot(prData.author) ? 'bot' : 'author',
      description: `PR #${prData.number} opened: ${(prData.title || '').slice(0, 60)}`,
      sentiment: 'neutral',
      details: { url: prData.url }
    });
  }

  // PR merged
  if (prData.mergedAt) {
    const merger = prData.mergedBy || 'unknown';
    events.push({
      type: 'pr_merged',
      timestamp: prData.mergedAt,
      actor: merger,
      actorRole: makeActorRole(merger, owner),
      description: `PR #${prData.number} merged`,
      sentiment: 'positive',
      details: { url: prData.url }
    });
  }

  // PR closed without merge
  if (prData.state === 'closed' && !prData.mergedAt && prData.closedAt) {
    events.push({
      type: 'pr_closed',
      timestamp: prData.closedAt,
      actor: 'unknown',
      actorRole: 'reviewer',
      description: `PR #${prData.number} closed without merge`,
      sentiment: 'neutral',
      details: { url: prData.url }
    });
  }

  // Commits
  for (const c of (raw.commits || [])) {
    const author = (c.author && c.author.login) ||
                   (c.commit && c.commit.author && c.commit.author.name) || 'unknown';
    const msg = ((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 60);
    const ts = (c.commit && c.commit.author && c.commit.author.date) ||
               (c.commit && c.commit.committer && c.commit.committer.date);
    if (ts) {
      events.push({
        type: 'commit_pushed', timestamp: ts,
        actor: author, actorRole: makeActorRole(author, owner),
        description: msg, sentiment: 'neutral',
        details: { url: c.html_url || '' }
      });
    }
  }

  // Reviews
  for (const r of (raw.reviews || [])) {
    const user = (r.user && r.user.login) || 'unknown';
    const state = r.state || '';
    const body = r.body || '';
    const ts = r.submitted_at;
    if (!ts) continue;

    let etype;
    if (state === 'APPROVED') etype = 'review_approved';
    else if (state === 'CHANGES_REQUESTED') etype = 'review_changes_requested';
    else if (state === 'COMMENTED' && body.trim()) etype = 'review_comment';
    else continue;

    const descMap = {
      review_approved: 'Approved',
      review_changes_requested: 'Changes requested',
      review_comment: 'Review comment'
    };
    events.push({
      type: etype, timestamp: ts,
      actor: user, actorRole: makeActorRole(user, owner),
      description: `${descMap[etype]} by ${user}`,
      sentiment: classifySentiment(etype),
      details: { body: body.slice(0, 500) || null, url: r.html_url || '' }
    });
  }

  // Issue comments
  for (const c of (raw.comments || [])) {
    const user = (c.user && c.user.login) || 'unknown';
    const body = c.body || '';
    const ts = c.created_at;
    if (!ts) continue;
    const bodyLower = body.toLowerCase();

    // Author nag detection
    if (user === owner && NAG_PHRASES.some(p => bodyLower.includes(p))) {
      const mentions = (body.match(/@(\w+)/g) || []).map(m => m.slice(1));
      const targets = mentions.filter(m => m !== owner && !isBot(m));
      if (targets.length) {
        events.push({
          type: 'author_nag', timestamp: ts,
          actor: user, actorRole: 'author',
          description: `Author pinged ${targets.map(t => '@' + t).join(', ')} for review`,
          sentiment: 'blocking',
          details: { body: body.slice(0, 500), url: c.html_url || '', targetUser: targets[0] }
        });
        continue;
      }
    }

    // Manual fix detection
    if (user === owner && MANUAL_FIX_PHRASES.some(p => bodyLower.includes(p))) {
      events.push({
        type: 'manual_fix', timestamp: ts,
        actor: user, actorRole: 'author',
        description: 'Manual fix needed on auto-generated PR',
        sentiment: 'negative',
        details: { body: body.slice(0, 500), url: c.html_url || '' }
      });
      continue;
    }

    const etype = isBot(user) ? 'bot_comment' : 'issue_comment';
    events.push({
      type: etype, timestamp: ts,
      actor: user, actorRole: makeActorRole(user, owner),
      description: body ? stripQuotedDescription(body) : `Comment by ${user}`,
      sentiment: 'neutral',
      details: { body: body ? body.slice(0, 500) : null, url: c.html_url || '' }
    });
  }

  // Inline review comments
  for (const c of (raw.reviewComments || [])) {
    const user = (c.user && c.user.login) || 'unknown';
    const body = c.body || '';
    const ts = c.created_at;
    if (!ts) continue;
    events.push({
      type: 'review_comment', timestamp: ts,
      actor: user, actorRole: makeActorRole(user, owner),
      description: body ? stripQuotedDescription(body) : `Inline review by ${user}`,
      sentiment: user !== owner ? 'blocking' : 'neutral',
      details: { body: body ? body.slice(0, 500) : null, url: c.html_url || '' }
    });
  }

  // Draft lifecycle events (ready_for_review, convert_to_draft)
  for (const e of (raw.issueEvents || [])) {
    if (e.event === 'ready_for_review' && e.created_at) {
      const user = (e.actor && e.actor.login) || 'unknown';
      events.push({
        type: 'ready_for_review', timestamp: e.created_at,
        actor: user, actorRole: makeActorRole(user, owner),
        description: `PR marked ready for review`,
        sentiment: 'positive',
        details: { url: prData.url }
      });
    }
    if (e.event === 'convert_to_draft' && e.created_at) {
      const user = (e.actor && e.actor.login) || 'unknown';
      events.push({
        type: 'convert_to_draft', timestamp: e.created_at,
        actor: user, actorRole: makeActorRole(user, owner),
        description: `PR converted to draft`,
        sentiment: 'neutral',
        details: { url: prData.url }
      });
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Compute idle gaps
  const idle = [];
  for (let i = 1; i < events.length; i++) {
    const t1 = new Date(events[i - 1].timestamp);
    const t2 = new Date(events[i].timestamp);
    const gapHours = (t2 - t1) / 3600000;
    if (gapHours > 24) {
      idle.push({
        type: 'idle_gap',
        timestamp: events[i - 1].timestamp,
        endTimestamp: events[i].timestamp,
        actor: 'system', actorRole: 'bot',
        description: `Idle for ${Math.round(gapHours)}h (${(gapHours / 24).toFixed(1)}d)`,
        sentiment: gapHours > 72 ? 'blocking' : 'neutral',
        details: { durationHours: Math.round(gapHours * 10) / 10 }
      });
    }
  }
  events.push(...idle);
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return events;
}

function generateInsights(specOut, sdkOuts, specData) {
  const insights = [];
  const allPRs = [specOut, ...sdkOuts];

  const specDays = daysBetween(specData.createdAt, specData.mergedAt);
  const firstSdkCreated = sdkOuts
    .filter(pr => pr.createdAt && pr.state !== 'missing')
    .map(pr => pr.createdAt)
    .sort()[0] || null;
  const pipeGap = (specData.mergedAt && firstSdkCreated)
    ? daysBetween(specData.mergedAt, firstSdkCreated)
    : null;

  if (pipeGap !== null && pipeGap > 0) {
    insights.push({
      type: 'bottleneck',
      severity: pipeGap < 1 ? 'info' : 'warning',
      description: `Pipeline gap: ${pipeGap.toFixed(1)}d between spec merge and first SDK PR`,
      durationDays: Math.round(pipeGap * 10) / 10,
      startDate: specData.mergedAt,
      endDate: firstSdkCreated
    });
  }

  if (specDays && specDays > 7) {
    insights.push({
      type: 'bottleneck', severity: 'warning',
      description: `Spec PR took ${Math.round(specDays)}d to merge`,
      durationDays: Math.round(specDays),
      startDate: specData.createdAt, endDate: specData.mergedAt,
      prRef: `Azure/azure-rest-api-specs#${specData.number}`
    });
  }

  const nags = allPRs.reduce((n, pr) =>
    n + pr.events.filter(e => e.type === 'author_nag').length, 0);
  if (nags > 0) {
    insights.push({
      type: 'nag', severity: 'warning',
      description: `Author sent ${nags} review nag(s) across PRs`
    });
  }

  for (const pr of sdkOuts) {
    if (pr.state === 'closed' && !pr.mergedAt) {
      insights.push({
        type: 'summary', severity: 'info',
        description: `${pr.language} PR #${pr.number} closed without merge`,
        prRef: `${pr.repo}#${pr.number}`
      });
    }
  }

  for (const pr of sdkOuts) {
    if (pr.state === 'open') {
      insights.push({
        type: 'bottleneck', severity: 'warning',
        description: `${pr.language} PR #${pr.number} is still open`,
        prRef: `${pr.repo}#${pr.number}`
      });
    }
  }

  for (const pr of sdkOuts) {
    if (pr.state === 'missing') {
      insights.push({
        type: 'summary', severity: 'info',
        description: `${pr.language} SDK PR not yet generated`
      });
    }
  }

  const durations = sdkOuts
    .filter(pr => pr.mergedAt && pr.createdAt)
    .map(pr => ({ language: pr.language, days: daysBetween(pr.createdAt, pr.mergedAt) }))
    .filter(d => d.days !== null);

  const slowest = durations.sort((a, b) => b.days - a.days)[0];
  const fastest = durations.sort((a, b) => a.days - b.days)[0];

  if (slowest) {
    insights.push({
      type: 'summary', severity: 'info',
      description: `Slowest SDK PR: ${slowest.language} (${slowest.days.toFixed(1)}d)`
    });
  }
  if (fastest) {
    insights.push({
      type: 'positive', severity: 'info',
      description: `Fastest SDK PR: ${fastest.language} (${fastest.days.toFixed(1)}d)`
    });
  }

  return { insights, pipeGap, specDays, durations, nags, slowest, fastest };
}

const ALL_LANGUAGES = {
  Java:       'Azure/azure-sdk-for-java',
  Go:         'Azure/azure-sdk-for-go',
  Python:     'Azure/azure-sdk-for-python',
  '.NET':     'Azure/azure-sdk-for-net',
  JavaScript: 'Azure/azure-sdk-for-js'
};

function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node process-timeline.js <raw-json> <output-json> <title>');
    process.exit(1);
  }

  const [rawFile, outFile, title] = args;
  const data = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  const spec = data.specPR;
  const sdks = data.sdkPRs;
  const owner = spec.author;

  // Process spec PR events
  const specOut = { ...spec };
  delete specOut._raw;
  specOut.events = processEvents(spec, owner);

  // Compute review wait for spec PR
  const specWait = computeReviewWaitDays(specOut.events, specOut.readyForReviewAt || null);
  specOut.reviewWaitDays = specWait.reviewWaitDays;
  specOut.reviewWaitCycles = specWait.reviewWaitCycles;

  // Process SDK PR events
  const sdkOuts = sdks.map(pr => {
    const out = { ...pr };
    delete out._raw;
    out.events = processEvents(pr, owner);
    const w = computeReviewWaitDays(out.events, out.readyForReviewAt || null);
    out.reviewWaitDays = w.reviewWaitDays;
    out.reviewWaitCycles = w.reviewWaitCycles;
    return out;
  });

  // Add missing language placeholders
  const presentLangs = new Set(sdkOuts.map(pr => pr.language));
  for (const [lang, repo] of Object.entries(ALL_LANGUAGES)) {
    if (!presentLangs.has(lang)) {
      sdkOuts.push({
        repo, language: lang, number: null, url: null,
        title: 'No SDK PR generated', author: null,
        createdAt: null, mergedAt: null,
        state: 'missing', generationFlow: null, events: []
      });
    }
  }

  // Collect all timestamps
  const allTs = [];
  for (const e of specOut.events) {
    allTs.push(e.timestamp);
    if (e.endTimestamp) allTs.push(e.endTimestamp);
  }
  for (const pr of sdkOuts) {
    for (const e of pr.events) {
      allTs.push(e.timestamp);
      if (e.endTimestamp) allTs.push(e.endTimestamp);
    }
  }
  allTs.sort();
  const startDate = allTs[0] || spec.createdAt;
  const endDate = allTs[allTs.length - 1] || spec.mergedAt || spec.createdAt;

  // Generate insights and summary
  const { insights, pipeGap, specDays, durations, nags, slowest, fastest } = 
    generateInsights(specOut, sdkOuts, spec);

  const manuals = sdkOuts.reduce((n, pr) =>
    n + pr.events.filter(e => e.type === 'manual_fix').length, 0);
  const reviewers = new Set();
  for (const pr of [specOut, ...sdkOuts]) {
    for (const e of pr.events) {
      if (e.actorRole === 'reviewer') reviewers.add(e.actor);
    }
  }

  // Aggregate review wait across all PRs
  const allPRsForWait = [specOut, ...sdkOuts.filter(p => p.state !== 'missing')];
  const totalReviewWaitDays = allPRsForWait.reduce((sum, pr) => sum + (pr.reviewWaitDays || 0), 0);
  const totalReviewWaitCycles = allPRsForWait.reduce((sum, pr) => sum + (pr.reviewWaitCycles || 0), 0);

  // Check if any PRs had draft phases (ready_for_review events exist)
  const hasDraftPRs = allPRsForWait.some(pr =>
    pr.readyForReviewAt || pr.events.some(e => e.type === 'ready_for_review')
  );

  const totalDays = daysBetween(startDate, endDate);

  const output = {
    title, owner, startDate, endDate,
    specPR: specOut,
    sdkPRs: sdkOuts,
    insights,
    summary: {
      totalDurationDays: totalDays != null ? Math.round(totalDays * 100) / 100 : null,
      specPRDays: specDays != null ? Math.round(specDays * 100) / 100 : null,
      pipelineGapDays: pipeGap != null ? Math.round(pipeGap * 100) / 100 : null,
      sdkPRMaxDays: slowest ? Math.round(slowest.days * 100) / 100 : null,
      fastestSDKPR: fastest ? { language: fastest.language, days: Math.round(fastest.days * 100) / 100 } : null,
      slowestSDKPR: slowest ? { language: slowest.language, days: Math.round(slowest.days * 100) / 100 } : null,
      totalUniqueReviewers: reviewers.size,
      totalNags: nags,
      totalManualFixes: manuals,
      totalPREdits: 0,
      totalReviewWaitDays: Math.round(totalReviewWaitDays * 100) / 100,
      totalReviewWaitCycles,
      hasDraftPRs
    }
  };

  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`✅ ${outFile} — spec=${specOut.events.length} events, ${sdkOuts.length} SDK PRs, ${insights.length} insights`);
  for (const pr of sdkOuts) {
    const num = pr.number || '—';
    console.log(`   ${(pr.language || '?').padEnd(12)} #${String(num).padStart(6)} ${(pr.state || '?').padEnd(8)} ${pr.events.length} events`);
  }
}

main();
