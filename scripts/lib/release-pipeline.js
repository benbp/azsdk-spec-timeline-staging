/**
 * release-pipeline.js
 *
 * Shared Azure DevOps release pipeline lookup helpers.
 * Used by both fetch-timeline.js and fetch-service-timeline.js.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEVOPS_ORG = 'https://dev.azure.com/azure-sdk';
const DEVOPS_PROJECT = 'internal';

// Pipeline naming conventions per language (service key → pipeline name candidates)
const PIPELINE_PATTERNS = {
  'Java':       (svc) => [`java - ${svc}`],
  'Go':         (svc) => [`go - arm${svc}`],
  'Python':     (svc) => [`python - ${svc}`],
  '.NET':       (svc) => [`net - ${svc} - mgmt`, `net - ${svc}`],
  'JavaScript': (svc) => [`js - ${svc} - mgmt`, `js - ${svc}`]
};

// Package name patterns per language (for fallback when TypeSpec metadata unavailable)
const PACKAGE_PATTERNS = {
  'Java':       (svc) => `azure-resourcemanager-${svc}`,
  'Go':         (svc) => `sdk/resourcemanager/${svc}/arm${svc}`,
  'Python':     (svc) => `azure-mgmt-${svc}`,
  '.NET':       (svc) => `Azure.ResourceManager.${svc.charAt(0).toUpperCase() + svc.slice(1)}`,
  'JavaScript': (svc) => `@azure/arm-${svc}`
};

// CSV language name mapping
const CSV_LANG_MAP = {
  'Java': 'java',
  'Go': 'go',
  'Python': 'python',
  '.NET': 'dotnet',
  'JavaScript': 'js'
};

// Cache: (language:serviceName) → pipeline result
const pipelineCache = new Map();

/* ── Azure DevOps API ──────────────────────────────────────── */

function azDevOps(area, resource, routeParams, queryParams) {
  const route = Object.entries(routeParams || {})
    .map(([k, v]) => `${k}=${v}`).join(' ');
  const query = Object.entries(queryParams || {})
    .map(([k, v]) => `"${k.replace(/\$/g, '\\$')}=${v}"`).join(' ');
  const cmd = `az devops invoke --area ${area} --resource ${resource}` +
    ` --organization ${DEVOPS_ORG}` +
    ` --route-parameters project=${DEVOPS_PROJECT} ${route}` +
    (query ? ` --query-parameters ${query}` : '') +
    ` --output json`;
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000
    });
    return JSON.parse(result.trim());
  } catch (e) {
    return null;
  }
}

/* ── Pipeline Lookup (with caching) ────────────────────────── */

function findReleasePipeline(language, serviceName) {
  const key = `${language}:${serviceName}`;
  if (pipelineCache.has(key)) return pipelineCache.get(key);

  const patternFn = PIPELINE_PATTERNS[language];
  if (!patternFn) { pipelineCache.set(key, null); return null; }

  const names = patternFn(serviceName);
  for (const name of names) {
    console.error(`    Searching DevOps pipeline: "${name}"`);
    const result = azDevOps('build', 'definitions', {}, { name });
    const defs = result?.value || [];
    if (defs.length > 0) {
      const pipeline = { definitionId: defs[0].id, name: defs[0].name, url: defs[0]._links?.web?.href };
      pipelineCache.set(key, pipeline);
      return pipeline;
    }
  }
  pipelineCache.set(key, null);
  return null;
}

function findReleaseBuilds(definitionId, afterDate) {
  console.error(`    Fetching builds for definition ${definitionId}...`);
  const params = {
    definitions: String(definitionId),
    $top: '20',
    queryOrder: 'finishTimeDescending',
    reasonFilter: 'manual'
  };
  if (afterDate) {
    params.minFinishTime = afterDate;
  }
  const result = azDevOps('build', 'builds', {}, params);
  return (result?.value || []).filter(b => {
    if (afterDate && b.finishTime && b.finishTime < afterDate) return false;
    return true;
  });
}

function getReleaseStage(buildId) {
  console.error(`    Fetching timeline for build ${buildId}...`);
  const result = azDevOps('build', 'timeline', { buildId: String(buildId) }, {});
  if (!result?.records) return null;

  const stage = result.records.find(r =>
    r.type === 'Stage' && /releas/i.test(r.name)
  );
  if (!stage) return null;
  return {
    name: stage.name,
    state: stage.state,
    result: stage.result,
    startTime: stage.startTime,
    finishTime: stage.finishTime
  };
}

/* ── Main Entry Point ──────────────────────────────────────── */

/**
 * Fetch release pipeline data for a merged SDK PR.
 *
 * @param {Object} opts
 * @param {string} opts.language      - Language name (e.g. 'Python', 'Java')
 * @param {string} opts.serviceName   - Pipeline service key (e.g. 'durabletask')
 * @param {string} opts.mergedAt      - ISO date when the PR was merged
 * @param {string} [opts.packageName] - Explicit package name (from TypeSpec metadata)
 * @returns {Object|null} Release data: { pipeline, status, packageName, buildId, buildUrl, releasedAt, releaseGapDays, stage }
 */
function fetchReleaseForPR({ language, serviceName, mergedAt, packageName }) {
  if (!serviceName || !language || !mergedAt) return null;

  console.error(`  Looking up release: ${language} / ${serviceName}`);
  const pipeline = findReleasePipeline(language, serviceName);
  if (!pipeline) {
    console.error(`    No pipeline found`);
    return null;
  }

  console.error(`    Found pipeline: ${pipeline.name} (${pipeline.definitionId})`);
  const builds = findReleaseBuilds(pipeline.definitionId, mergedAt);
  if (builds.length === 0) {
    console.error(`    No release builds found after ${mergedAt}`);
    return { pipeline, status: 'pending', packageName: packageName || inferPackageName(language, serviceName) };
  }

  // Check each build for a release stage
  for (const build of builds.slice(0, 5)) {
    const stage = getReleaseStage(build.id);
    if (!stage) continue;

    const buildUrl = `https://dev.azure.com/azure-sdk/internal/_build/results?buildId=${build.id}&view=results`;
    const pkg = packageName || inferPackageName(language, serviceName);

    if (stage.result === 'succeeded' && stage.finishTime) {
      const mergeMs = new Date(mergedAt).getTime();
      const relMs = new Date(stage.finishTime).getTime();
      const gapDays = parseFloat(((relMs - mergeMs) / 86400000).toFixed(1));
      console.error(`    Released via build ${build.id} at ${stage.finishTime}`);
      return {
        pipeline, status: 'released', stage,
        packageName: pkg, buildId: String(build.id), buildUrl,
        releasedAt: stage.finishTime, releaseGapDays: gapDays
      };
    }
    if (stage.result === 'failed') {
      console.error(`    Release FAILED in build ${build.id}`);
      return {
        pipeline, status: 'failed', stage,
        packageName: pkg, buildId: String(build.id), buildUrl,
        releasedAt: null, releaseGapDays: null
      };
    }
    // skipped — keep searching
  }

  console.error(`    No successful release found — pending`);
  return { pipeline, status: 'pending', packageName: packageName || inferPackageName(language, serviceName) };
}

function inferPackageName(language, serviceName) {
  const fn = PACKAGE_PATTERNS[language];
  return fn ? fn(serviceName) : null;
}

/* ── Service Name Inference (from PR title) ────────────────── */

function inferServiceName(prTitle) {
  const patterns = [
    /\[AutoPR\s+(?:azure-resourcemanager-|azure-mgmt-|arm-)([^\]]+)\]/i,
    /\[AutoPR\s+(?:Azure\.ResourceManager\.)([^\]]+)\]/i,
    /\[AutoPR\s+sdk-resourcemanager\/([^/\]]+)/i,
    /\[AutoPR\s+@azure-arm-([^\]]+)\]/i,
    /\[AutoPR\s+@azure-([^\]]+)\]/i,
    /\[AutoPR\s+([^\]]+)\]/i,
  ];
  for (const pat of patterns) {
    const m = prTitle.match(pat);
    if (m) return m[1].toLowerCase().replace(/[-_]$/, '').replace(/-generated$/, '');
  }
  return null;
}

/* ── CSV Release Lookup ────────────────────────────────────── */

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function lookupReleaseCSV({ language, serviceName, packageName, releaseCsvDir }) {
  if (!releaseCsvDir || !language) return null;

  const csvLang = CSV_LANG_MAP[language];
  if (!csvLang) return null;

  const csvPath = path.join(releaseCsvDir, 'latest', `${csvLang}-packages.csv`);
  if (!fs.existsSync(csvPath)) {
    console.error(`    CSV not found: ${csvPath}`);
    return null;
  }

  // Use explicit package name if available, else derive from service name
  const expectedPkg = packageName || inferPackageName(language, serviceName);
  if (!expectedPkg) return null;

  console.error(`  Looking up CSV: ${expectedPkg} in ${csvPath}`);
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n');
  const header = lines[0].split(',').map(h => h.trim());

  const pkgIdx = header.indexOf('Package');
  const gaVersionIdx = header.indexOf('VersionGA');
  const gaDateIdx = header.indexOf('LatestGADate');

  if (pkgIdx === -1) return null;

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    const pkg = cols[pkgIdx]?.trim();

    if (pkg === expectedPkg) {
      const version = gaVersionIdx >= 0 ? cols[gaVersionIdx]?.trim() : null;
      const dateStr = gaDateIdx >= 0 ? cols[gaDateIdx]?.trim() : null;

      let gaDate = null;
      if (dateStr) {
        const [m, d, y] = dateStr.split('/').map(Number);
        if (y && m && d) {
          gaDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T23:59:59Z`;
        }
      }

      console.error(`    CSV match: ${pkg} v${version} released ${gaDate || 'unknown'}`);
      return { packageName: pkg, packageVersion: version, gaDate };
    }
  }

  console.error(`    No CSV match for ${expectedPkg}`);
  return null;
}

/* ── Attach Release to Processed PR ────────────────────────── */

/**
 * Attach release data and events to a processed PR object.
 * Follows the schema from backfill-releases-apply.js.
 *
 * @param {Object} pr - The processed PR object (must have events array)
 * @param {Object} releaseData - Result from fetchReleaseForPR()
 */
function attachReleaseToPR(pr, releaseData) {
  if (!releaseData) return;

  const { pipeline, status, packageName, buildId, buildUrl, releasedAt, releaseGapDays, stage } = releaseData;
  const pipelineName = pipeline?.name || null;
  const pipelineUrl = buildUrl || pipeline?.url || null;

  if (status === 'released' && releasedAt) {
    pr.release = {
      packageName, packageVersion: null,
      pipelineName, pipelineUrl,
      buildId, releasedAt, releaseGapDays,
      status: 'released'
    };
    pr.events.push({
      type: 'release_pipeline_started',
      timestamp: stage?.startTime || releasedAt,
      actor: 'azure-pipelines[bot]',
      actorRole: 'bot',
      description: `Release pipeline started: ${pipelineName}`,
      sentiment: 'neutral',
      details: { url: pipelineUrl, body: `Build ${buildId}` }
    });
    pr.events.push({
      type: 'release_pipeline_completed',
      timestamp: releasedAt,
      actor: 'azure-pipelines[bot]',
      actorRole: 'bot',
      description: `Package released: ${packageName}`,
      sentiment: 'positive',
      details: { url: pipelineUrl, body: `Build ${buildId} succeeded` }
    });
  } else if (status === 'failed') {
    pr.release = {
      packageName, pipelineName, pipelineUrl,
      buildId, releasedAt: null, releaseGapDays: null,
      status: 'failed'
    };
    pr.events.push({
      type: 'release_pipeline_started',
      timestamp: stage?.startTime || pr.mergedAt,
      actor: 'azure-pipelines[bot]',
      actorRole: 'bot',
      description: `Release pipeline started: ${pipelineName}`,
      sentiment: 'neutral',
      details: { url: pipelineUrl, body: `Build ${buildId}` }
    });
    pr.events.push({
      type: 'release_pipeline_failed',
      timestamp: stage?.finishTime || pr.mergedAt,
      actor: 'azure-pipelines[bot]',
      actorRole: 'bot',
      description: `Release pipeline failed: ${pipelineName}`,
      sentiment: 'negative',
      details: { url: pipelineUrl, body: `Build ${buildId} failed` }
    });
  } else {
    // pending or skipped
    pr.release = {
      packageName, pipelineName, pipelineUrl: null,
      buildId: null, releasedAt: null, releaseGapDays: null,
      status: 'pending'
    };
    pr.events.push({
      type: 'release_pending',
      timestamp: pr.mergedAt,
      actor: 'system',
      actorRole: 'bot',
      description: `Package release pending: ${pipelineName || 'unknown'}`,
      sentiment: 'neutral',
      details: {}
    });
  }

  // Re-sort events by timestamp
  pr.events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

module.exports = {
  azDevOps,
  findReleasePipeline,
  findReleaseBuilds,
  getReleaseStage,
  fetchReleaseForPR,
  inferServiceName,
  inferPackageName,
  lookupReleaseCSV,
  attachReleaseToPR,
  PIPELINE_PATTERNS,
  PACKAGE_PATTERNS,
  CSV_LANG_MAP
};
