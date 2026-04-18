#!/usr/bin/env node
/**
 * backfill-consolidate-windows.js
 *
 * Re-applies the release-window detection + consolidation logic to existing
 * service timeline JSON files (in-place). This groups follow-up spec PRs
 * under their API-version anchor windows and recalculates summaries.
 *
 * Usage: node scripts/backfill-consolidate-windows.js data/service-*.json
 */

const fs = require('fs');
const path = require('path');

const { daysBetween, computeReviewWaitDays } = require('./lib/event-processor');

function run(filePath) {
  const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (d.type !== 'service-timeline') {
    console.error(`Skipping ${filePath}: not a service-timeline`);
    return;
  }

  console.error(`Processing ${filePath}...`);
  console.error(`  Before: ${d.releaseWindows.length} windows`);

  // Remove version bump PRs from sdkPRs
  const bumpNums = new Set();
  for (const [lang, prs] of Object.entries(d.sdkPRs || {})) {
    for (const pr of prs) {
      if (/^increment\s+versions?\s+for\s+/i.test(pr.title || '') ||
          /^update\s+typespec\s+emitter\s+version\s+/i.test(pr.title || '') ||
          /^prepare\s+for\s+release\b/i.test(pr.title || '') ||
          /^update\s+changelog\b/i.test(pr.title || '')) {
        bumpNums.add(pr.number);
      }
    }
    d.sdkPRs[lang] = prs.filter(pr => !bumpNums.has(pr.number));
  }
  if (bumpNums.size > 0) console.error(`  Removed ${bumpNums.size} version bump PRs`);

  // Re-detect windows from scratch using the spec + SDK PR data
  const specPRs = d.specPRs || [];
  const sdkPRs = d.sdkPRs || {};

  const windows = detectReleaseWindows(specPRs, sdkPRs);

  // Recompute per-window summaries
  for (const win of windows) {
    win.summary = computeWindowSummary(win, specPRs, sdkPRs);
  }

  d.releaseWindows = windows;

  // Update overall summary counts
  if (d.summary) {
    d.summary.totalReleaseWindows = windows.length;
  }

  console.error(`  After: ${windows.length} windows`);
  for (const w of windows) {
    const sdkCount = Object.values(w.sdkPRNumbers || {}).flat().length;
    console.error(`    ${w.label} | ${w.specPRNumbers.length} specs, ${sdkCount} SDKs | ${w.startDate?.slice(0, 10)} → ${w.endDate?.slice(0, 10)}`);
  }

  fs.writeFileSync(filePath, JSON.stringify(d, null, 2) + '\n');
  console.error(`  Saved ${filePath}`);
}

/* ── Release Window Detection (mirrors process-service-timeline.js) ── */

function detectReleaseWindows(specPRs, sdkPRs) {
  const windows = [];
  const claimed = {};
  for (const lang of Object.keys(sdkPRs)) {
    claimed[lang] = new Set();
  }

  // Pass 1: explicit matches (spec PR number or merge commit in body/title)
  for (let i = 0; i < specPRs.length; i++) {
    const spec = specPRs[i];
    const windowSdkPRs = {};

    for (const [lang, prs] of Object.entries(sdkPRs)) {
      const matching = prs.filter(pr => {
        if (claimed[lang].has(pr.number)) return false;
        const body = pr._rawBody || '';
        const title = pr.title || '';
        const mentionsSpec = body.includes(`#${spec.number}`) || title.includes(`#${spec.number}`);
        const mentionsCommit = spec._mergeCommitSha &&
          (body.includes(spec._mergeCommitSha) || body.includes(spec._mergeCommitSha.slice(0, 12)));
        return mentionsSpec || mentionsCommit;
      });

      if (matching.length > 0) {
        windowSdkPRs[lang] = matching.map(pr => pr.number);
        for (const pr of matching) claimed[lang].add(pr.number);
      }
    }

    windows.push({ specIndex: i, spec, windowSdkPRs });
  }

  // Pass 2: temporal proximity for unclaimed SDK PRs
  for (const [lang, prs] of Object.entries(sdkPRs)) {
    for (const pr of prs) {
      if (claimed[lang].has(pr.number)) continue;
      if (!pr.createdAt) continue;

      let bestWindow = null;
      let bestGap = Infinity;
      for (const win of windows) {
        const specMergedAt = win.spec.mergedAt;
        if (!specMergedAt) continue;
        const gap = daysBetween(specMergedAt, pr.createdAt);
        if (gap !== null && gap >= -2 && gap <= 30 && Math.abs(gap) < bestGap) {
          bestGap = Math.abs(gap);
          bestWindow = win;
        }
      }

      if (bestWindow) {
        if (!bestWindow.windowSdkPRs[lang]) bestWindow.windowSdkPRs[lang] = [];
        bestWindow.windowSdkPRs[lang].push(pr.number);
        claimed[lang].add(pr.number);
      }
    }
  }

  // Build final window objects with API version splitting
  const result = [];
  const apiVersionRegex = /(?:API [Vv]ersion|Spec API version)[:\s]+(\d{4}-\d{2}-\d{2}(?:-preview)?)/;

  for (const win of windows) {
    const spec = win.spec;
    const prsByVersion = {};
    const unversioned = {};

    for (const [lang, prNums] of Object.entries(win.windowSdkPRs)) {
      for (const num of prNums) {
        const pr = (sdkPRs[lang] || []).find(p => p.number === num);
        const body = pr?._rawBody || '';
        const vMatch = body.match(apiVersionRegex);
        if (vMatch) {
          const ver = vMatch[1];
          if (!prsByVersion[ver]) prsByVersion[ver] = {};
          if (!prsByVersion[ver][lang]) prsByVersion[ver][lang] = [];
          prsByVersion[ver][lang].push(num);
        } else {
          if (!unversioned[lang]) unversioned[lang] = [];
          unversioned[lang].push(num);
        }
      }
    }

    const versions = Object.keys(prsByVersion);
    if (versions.length > 1) {
      for (const ver of versions.sort()) {
        result.push(buildWindow(spec, prsByVersion[ver], sdkPRs, `API ${ver}`));
      }
      if (Object.keys(unversioned).length > 0) {
        const firstWin = result[result.length - versions.length];
        for (const [lang, nums] of Object.entries(unversioned)) {
          if (!firstWin.sdkPRNumbers[lang]) firstWin.sdkPRNumbers[lang] = [];
          firstWin.sdkPRNumbers[lang].push(...nums);
        }
      }
    } else {
      const mergedSdkPRs = { ...win.windowSdkPRs };
      // Match date: "2025-09-01" or "2025 12 01"
      const dashDate = (spec.title || '').match(/(\d{4}-\d{2}-\d{2})/);
      const spaceDate = (spec.title || '').match(/(\d{4})\s+(\d{2})\s+(\d{2})/);
      const label = versions.length === 1
        ? `API ${versions[0]}`
        : dashDate
          ? `API ${dashDate[1]}`
          : spaceDate
            ? `API ${spaceDate[1]}-${spaceDate[2]}-${spaceDate[3]}`
            : `Spec PR #${spec.number}`;
      result.push(buildWindow(spec, mergedSdkPRs, sdkPRs, label));
    }
  }

  // Consolidation: merge follow-up spec PRs into API-version anchors
  const consolidated = consolidateWindows(result, specPRs, sdkPRs);
  consolidated.forEach((w, i) => { w.id = `rw-${i + 1}`; });
  return consolidated;
}

function consolidateWindows(windows, specPRs, sdkPRs) {
  const anchors = [];
  const followers = [];

  for (let i = 0; i < windows.length; i++) {
    if (windows[i].label.startsWith('API ')) {
      anchors.push(i);
    } else {
      followers.push(i);
    }
  }

  if (anchors.length === 0 || followers.length === 0) return windows;

  const merged = new Set();
  for (const fi of followers) {
    const follower = windows[fi];
    const followerDate = follower.startDate;

    let bestAnchor = null;
    let bestDist = Infinity;
    for (const ai of anchors) {
      const anchor = windows[ai];
      if (anchor.startDate <= followerDate) {
        const dist = new Date(followerDate) - new Date(anchor.startDate);
        if (dist < bestDist) {
          bestDist = dist;
          bestAnchor = ai;
        }
      }
    }

    if (bestAnchor === null) {
      for (const ai of anchors) {
        const dist = Math.abs(new Date(followerDate) - new Date(windows[ai].startDate));
        if (dist < bestDist) {
          bestDist = dist;
          bestAnchor = ai;
        }
      }
    }

    if (bestAnchor === null) continue;

    const anchor = windows[bestAnchor];
    for (const num of follower.specPRNumbers) {
      if (!anchor.specPRNumbers.includes(num)) anchor.specPRNumbers.push(num);
    }
    for (const [lang, nums] of Object.entries(follower.sdkPRNumbers)) {
      if (!anchor.sdkPRNumbers[lang]) anchor.sdkPRNumbers[lang] = [];
      for (const num of nums) {
        if (!anchor.sdkPRNumbers[lang].includes(num)) anchor.sdkPRNumbers[lang].push(num);
      }
    }
    merged.add(fi);
  }

  const result = [];
  for (let i = 0; i < windows.length; i++) {
    if (merged.has(i)) continue;
    const win = windows[i];

    const allDates = [];
    for (const specNum of win.specPRNumbers) {
      const sp = specPRs.find(p => p.number === specNum);
      if (sp?.createdAt) allDates.push(sp.createdAt);
      if (sp?.mergedAt) allDates.push(sp.mergedAt);
    }
    for (const [lang, nums] of Object.entries(win.sdkPRNumbers)) {
      for (const num of nums) {
        const pr = (sdkPRs[lang] || []).find(p => p.number === num);
        if (pr?.createdAt) allDates.push(pr.createdAt);
        if (pr?.mergedAt) allDates.push(pr.mergedAt);
        if (pr?.release?.releasedAt) allDates.push(pr.release.releasedAt);
      }
    }
    allDates.sort();
    if (allDates.length > 0) {
      win.startDate = allDates[0];
      win.endDate = allDates[allDates.length - 1];
    }

    result.push(win);
  }

  return result;
}

function buildWindow(spec, windowSdkPRs, sdkPRs, label) {
  const allDates = [spec.createdAt].filter(Boolean);
  for (const [lang, prNums] of Object.entries(windowSdkPRs)) {
    for (const num of prNums) {
      const pr = (sdkPRs[lang] || []).find(p => p.number === num);
      if (pr) {
        if (pr.createdAt) allDates.push(pr.createdAt);
        if (pr.mergedAt) allDates.push(pr.mergedAt);
        if (pr.release?.releasedAt) allDates.push(pr.release.releasedAt);
      }
    }
  }
  if (spec.mergedAt) allDates.push(spec.mergedAt);
  allDates.sort();

  return {
    id: 'rw-0',
    label,
    startDate: allDates[0] || spec.createdAt,
    endDate: allDates[allDates.length - 1] || spec.createdAt,
    specPRNumbers: [spec.number],
    sdkPRNumbers: windowSdkPRs,
    summary: {}
  };
}

/* ── Per-Window Summary ── */

function computeWindowSummary(window, specPRs, sdkPRs) {
  const windowSpecPRs = window.specPRNumbers
    .map(n => specPRs.find(p => p.number === n))
    .filter(Boolean);
  const specPR = windowSpecPRs[0];
  const windowSdkPRs = [];

  for (const [lang, nums] of Object.entries(window.sdkPRNumbers)) {
    for (const num of nums) {
      const pr = (sdkPRs[lang] || []).find(p => p.number === num);
      if (pr) windowSdkPRs.push(pr);
    }
  }

  const totalDays = daysBetween(window.startDate, window.endDate);
  const specDaysArr = windowSpecPRs
    .filter(sp => sp.createdAt && sp.mergedAt)
    .map(sp => daysBetween(sp.createdAt, sp.mergedAt))
    .filter(d => d != null);
  const specDays = specDaysArr.length > 0
    ? specDaysArr.reduce((a, b) => a + b, 0) : null;

  const firstSpecMerged = windowSpecPRs
    .filter(sp => sp.mergedAt)
    .map(sp => sp.mergedAt)
    .sort()[0] || null;
  const firstSdkCreated = windowSdkPRs
    .filter(pr => pr.createdAt)
    .map(pr => pr.createdAt)
    .sort()[0] || null;
  const pipeGap = (firstSpecMerged && firstSdkCreated)
    ? daysBetween(firstSpecMerged, firstSdkCreated)
    : null;

  const allPRs = [...windowSpecPRs, ...windowSdkPRs];
  const totalNags = allPRs.reduce((n, pr) =>
    n + (pr.events || []).filter(e => e.type === 'author_nag').length, 0);
  const totalManualFixes = allPRs.reduce((n, pr) =>
    n + (pr.events || []).filter(e => e.type === 'manual_fix').length, 0);

  const reviewers = new Set();
  for (const pr of allPRs) {
    for (const e of (pr.events || [])) {
      if (e.actorRole === 'reviewer') reviewers.add(e.actor);
    }
  }

  const prsWithWait = allPRs.filter(p => p.state !== 'missing');
  const totalReviewWaitDays = prsWithWait.reduce((s, p) => s + (p.reviewWaitDays || 0), 0);
  const totalReviewWaitCycles = prsWithWait.reduce((s, p) => s + (p.reviewWaitCycles || 0), 0);

  return {
    totalDurationDays: totalDays != null ? Math.round(totalDays * 100) / 100 : null,
    specPRDays: specDays != null ? Math.round(specDays * 100) / 100 : null,
    specPRCount: windowSpecPRs.length,
    pipelineGapDays: pipeGap != null && pipeGap > 0 ? Math.round(pipeGap * 100) / 100 : null,
    totalNags,
    totalManualFixes,
    totalUniqueReviewers: reviewers.size,
    totalReviewWaitDays: Math.round(totalReviewWaitDays * 100) / 100,
    totalReviewWaitCycles
  };
}

// Process all files passed as arguments
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/backfill-consolidate-windows.js data/service-*.json');
  process.exit(1);
}
for (const f of files) run(f);
