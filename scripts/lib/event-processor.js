/**
 * event-processor.js
 *
 * Shared event processing logic used by both process-timeline.js (single-release)
 * and process-service-timeline.js (full service timeline).
 *
 * Provides: event classification, nag/manual-fix detection, idle gap computation,
 * review wait calculation, sentiment classification, and helper utilities.
 */

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

const REVIEW_WAIT_SKIP_TYPES = new Set([
  'idle_gap', 'bot_comment', 'label_added', 'ci_status',
  'release_pipeline_started', 'release_pipeline_completed', 'release_pipeline_failed',
  'release_pending', 'convert_to_draft'
]);

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

function stripQuotedDescription(body) {
  const lines = body.split('\n');
  const firstNonQuote = lines.find(l => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !trimmed.startsWith('>');
  });
  const text = firstNonQuote || lines[0] || '';
  return text.trim().slice(0, 100).replace(/\n/g, ' ');
}

/**
 * Compute total time waiting for reviewer response.
 */
function computeReviewWaitDays(events, readyForReviewAt) {
  let totalMs = 0;
  let cycleCount = 0;
  let waitStart = null;
  const startAfter = readyForReviewAt ? new Date(readyForReviewAt).getTime() : 0;

  for (const e of events) {
    if (REVIEW_WAIT_SKIP_TYPES.has(e.type)) continue;
    const ts = new Date(e.timestamp).getTime();
    if (ts < startAfter) continue;

    if (e.type === 'ready_for_review') {
      waitStart = ts;
      continue;
    }
    if (e.type === 'pr_created') {
      if (!readyForReviewAt) waitStart = ts;
      continue;
    }
    if (e.actorRole === 'reviewer') {
      if (waitStart !== null) {
        totalMs += ts - waitStart;
        cycleCount++;
        waitStart = null;
      }
      continue;
    }
    if (e.actorRole === 'author' || e.actorRole === 'bot' || e.actorRole === 'copilot') {
      if (waitStart === null) waitStart = ts;
    }
  }

  const totalDays = totalMs > 0 ? Math.round((totalMs / 86400000) * 100) / 100 : 0;
  return { reviewWaitDays: totalDays, reviewWaitCycles: cycleCount };
}

/**
 * Process raw PR data into classified event list.
 */
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

  // Draft lifecycle events
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

  // Compute idle gaps (>24h between events)
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

/**
 * Generate insights for a single release cycle (spec PR + SDK PRs).
 */
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

module.exports = {
  BOT_ACTORS,
  NAG_PHRASES,
  MANUAL_FIX_PHRASES,
  REVIEW_WAIT_SKIP_TYPES,
  isBot,
  makeActorRole,
  classifySentiment,
  daysBetween,
  stripQuotedDescription,
  computeReviewWaitDays,
  processEvents,
  generateInsights
};
