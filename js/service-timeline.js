/**
 * service-timeline.js
 * Service timeline renderer — multi-PR swim lanes per language, release windows,
 * window selector, contextual metrics, gap compaction for year-long timelines.
 */
const ServiceTimeline = (() => {
  let data = null;
  let timeRange = null;
  let contentWidth = 0;
  let zoomLevel = 1;
  const padding = { left: 20, right: 20 };
  let hiddenEventTypes = new Set(['bot_comment', 'label_added', 'ci_status', 'commit_pushed']);
  let hiddenActors = new Set();
  let allActors = [];
  let selectedWindow = null; // null = all-up, or a releaseWindows index

  // Gap compaction — 7-day threshold for year-long timelines
  const GAP_THRESHOLD_MS = 7 * 86400000;
  const COMPRESSED_GAP_PX = 44;
  const MIN_SEGMENT_PX = 100;
  let segments = [];

  // High-signal event types for Smart View preset
  const SMART_VIEW_TYPES = new Set([
    'review_changes_requested', 'author_nag', 'manual_fix', 'idle_gap',
    'review_approved', 'pr_created', 'pr_merged', 'ready_for_review',
    'release_pipeline_completed', 'release_pipeline_failed', 'release_pending'
  ]);

  /* ── Public ─────────────────────────────────────────────── */

  function render(timelineData) {
    data = timelineData;
    timeRange = { start: new Date(data.startDate), end: new Date(data.endDate) };
    hiddenActors.clear();
    selectedWindow = null;

    renderServiceHeader();
    renderWindowSelector();
    renderSummaryCards();
    renderFilters();
    renderTimeline();
    renderInsights();

    hide('header-info');
    show('service-header');
    show('service-window-selector');
    show('summary-cards');
    show('filters');
    show('timeline-container');
    show('insights-panel');
    hide('empty-state');
  }

  /* ── Service Header ─────────────────────────────────────── */

  function renderServiceHeader() {
    const el = document.getElementById('service-header');
    if (!el) return;
    const specCount = data.specPRs.length;
    const sdkCount = Object.values(data.sdkPRs).reduce((s, a) => s + a.length, 0);
    const langs = Object.keys(data.sdkPRs).join(', ');
    const days = DataLoader.computeDurationDays(data.startDate, data.endDate);
    const generated = data.generatedAt
      ? new Date(data.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';

    el.innerHTML = `
      <h2>${escapeHtml(data.service)} — Full Service Timeline</h2>
      <div class="service-header-meta">
        <span title="TypeSpec project path">📂 ${escapeHtml(data.specPath || '')}</span>
        <span>📅 ${DataLoader.formatDate(data.startDate)} → ${DataLoader.formatDate(data.endDate)} (${Math.round(days)}d)</span>
        <span>📋 ${specCount} spec PRs · ${sdkCount} SDK PRs · ${data.releaseWindows?.length || 0} release windows</span>
        <span>🌐 ${langs}</span>
        <span class="generated-stamp" title="Data generated at ${data.generatedAt}">Data as of ${generated}</span>
      </div>
    `;
  }

  /* ── Window Selector ────────────────────────────────────── */

  function renderWindowSelector() {
    const el = document.getElementById('service-window-selector');
    if (!el) return;

    const windows = data.releaseWindows || [];
    el.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'filters-label';
    label.textContent = '📦 Release Windows:';
    el.appendChild(label);

    const pills = document.createElement('div');
    pills.className = 'window-pills';

    // All-up pill
    const allPill = document.createElement('button');
    allPill.className = `window-pill ${selectedWindow === null ? 'active' : ''}`;
    allPill.innerHTML = `<span class="pill-label">All</span><span class="pill-sub">${data.summary?.totalSpecPRs || 0} spec · ${data.summary?.totalSDKPRs || 0} SDK</span>`;
    allPill.addEventListener('click', () => selectWindow(null));
    pills.appendChild(allPill);

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const sdkCount = Object.values(w.sdkPRNumbers || {}).flat().length;
      const pill = document.createElement('button');
      pill.className = `window-pill ${selectedWindow === i ? 'active' : ''}`;
      pill.innerHTML = `<span class="pill-label">${escapeHtml(w.label)}</span><span class="pill-sub">${sdkCount} SDK PRs</span>`;
      pill.addEventListener('click', () => selectWindow(i));
      pills.appendChild(pill);
    }

    el.appendChild(pills);
  }

  function selectWindow(idx) {
    selectedWindow = idx;
    renderWindowSelector();
    renderSummaryCards();
    renderInsights();
    highlightWindow();
  }

  function highlightWindow() {
    // Remove existing highlights
    document.querySelectorAll('.window-highlight').forEach(el => el.remove());

    if (selectedWindow === null) {
      // Show all PR bars normally
      document.querySelectorAll('.pr-bar-multi').forEach(el => el.classList.remove('dimmed'));
      return;
    }

    const win = data.releaseWindows[selectedWindow];
    if (!win) return;

    // Dim PRs not in this window
    const windowPRNums = new Set();
    for (const specNum of win.specPRNumbers) windowPRNums.add(specNum);
    for (const nums of Object.values(win.sdkPRNumbers || {})) {
      for (const n of nums) windowPRNums.add(n);
    }

    document.querySelectorAll('.pr-bar-multi').forEach(el => {
      const prNum = parseInt(el.dataset.prNumber, 10);
      if (windowPRNums.has(prNum)) {
        el.classList.remove('dimmed');
      } else {
        el.classList.add('dimmed');
      }
    });

    // Add highlight overlay for window time range
    const lanes = document.getElementById('lanes');
    if (!lanes || segments.length === 0) return;

    const startX = timeToX(win.startDate);
    const endX = timeToX(win.endDate);
    const highlight = document.createElement('div');
    highlight.className = 'window-highlight';
    highlight.style.left = startX + 'px';
    highlight.style.width = Math.max(endX - startX, 4) + 'px';
    highlight.style.height = lanes.scrollHeight + 'px';
    lanes.appendChild(highlight);

    // Scroll to window
    const scrollEl = document.querySelector('.timeline-scroll');
    if (scrollEl) {
      const centerX = (startX + endX) / 2;
      scrollEl.scrollLeft = Math.max(0, centerX - scrollEl.clientWidth / 2);
    }
  }

  /* ── Summary Cards (contextual) ─────────────────────────── */

  function renderSummaryCards() {
    const container = document.getElementById('summary-cards');
    container.innerHTML = '';

    const fmt = (v, suffix = 'd') => v != null ? `${v}${suffix}` : '—';

    let cards;
    if (selectedWindow !== null) {
      // Per-window metrics
      const win = data.releaseWindows[selectedWindow];
      const s = win?.summary || {};
      cards = [
        { label: 'Window', value: escapeHtml(win?.label || ''), sub: `${DataLoader.formatDate(win.startDate)} → ${DataLoader.formatDate(win.endDate)}`, cls: 'info' },
        { label: 'Duration', value: fmt(s.totalDurationDays), sub: 'End to end', cls: 'info' },
        { label: 'Spec PR', value: fmt(s.specPRDays), sub: 'API review', cls: 'info' },
        { label: 'Pipeline Gap', value: fmt(s.pipelineGapDays), sub: 'Merge → SDK PRs', cls: s.pipelineGapDays > 7 ? 'critical' : 'warning' },
        { label: 'Nags', value: `${s.totalNags || 0}`, sub: 'Author nudges', cls: s.totalNags > 0 ? 'warning' : 'positive' },
        { label: 'Manual Fixes', value: `${s.totalManualFixes || 0}`, sub: 'On auto PRs', cls: s.totalManualFixes > 0 ? 'warning' : 'positive' },
        { label: 'Reviewers', value: `${s.totalUniqueReviewers ?? '—'}`, sub: 'Unique people', cls: 'info' },
        { label: 'Review Wait', value: fmt(s.totalReviewWaitDays), sub: `${s.totalReviewWaitCycles || 0} wait cycles`, cls: s.totalReviewWaitDays > 7 ? 'critical' : 'info' },
      ];
    } else {
      // All-up metrics
      const s = data.summary || {};
      const langEntries = Object.entries(s.languageBreakdown || {});
      const slowest = langEntries.sort((a, b) => (b[1].avgDays || 0) - (a[1].avgDays || 0))[0];
      const fastest = langEntries.sort((a, b) => (a[1].avgDays || 0) - (b[1].avgDays || 0))[0];

      cards = [
        { label: 'Spec PRs', value: `${s.totalSpecPRs || 0}`, sub: 'Total specs', cls: 'info' },
        { label: 'SDK PRs', value: `${s.totalSDKPRs || 0}`, sub: `${Object.keys(data.sdkPRs).length} languages`, cls: 'info' },
        { label: 'Avg Cycle', value: fmt(s.avgCycleTimeDays), sub: 'Per release window', cls: s.avgCycleTimeDays > 30 ? 'warning' : 'info' },
        { label: 'Avg Pipe Gap', value: fmt(s.avgPipelineGapDays), sub: 'Spec merge → SDK', cls: s.avgPipelineGapDays > 7 ? 'critical' : 'warning' },
        { label: 'Avg Review Wait', value: fmt(s.avgReviewWaitDays), sub: 'Per PR', cls: s.avgReviewWaitDays > 5 ? 'warning' : 'info' },
        { label: 'Nags', value: `${s.totalNags || 0}`, sub: 'Total nudges', cls: s.totalNags > 5 ? 'warning' : 'positive' },
        { label: 'Automation', value: s.automationRate != null ? `${Math.round(s.automationRate * 100)}%` : '—', sub: 'Of SDK PRs', cls: s.automationRate >= 0.8 ? 'positive' : 'warning' },
      ];

      if (slowest && slowest[1].avgDays != null) {
        cards.push({ label: 'Slowest', value: fmt(slowest[1].avgDays), sub: slowest[0], cls: 'warning' });
      }
      if (fastest && fastest[1].avgDays != null) {
        cards.push({ label: 'Fastest', value: fmt(fastest[1].avgDays), sub: fastest[0], cls: 'positive' });
      }

      if (s.topReviewers?.length > 0) {
        cards.push({
          label: 'Top Reviewer',
          value: escapeHtml(s.topReviewers[0].login),
          sub: `${s.topReviewers[0].reviewCount} reviews`,
          cls: 'info'
        });
      }

      if (s.totalToolCalls > 0) {
        const rate = s.toolCallSuccessRate != null ? `${Math.round(s.toolCallSuccessRate * 100)}%` : '—';
        cards.push({ label: 'Tool Calls', value: `${s.totalToolCalls}`, sub: `${rate} success`, cls: s.toolCallSuccessRate < 0.8 ? 'warning' : 'positive' });
      }
    }

    for (const card of cards) {
      const el = document.createElement('div');
      el.className = `summary-card ${card.cls}`;
      el.innerHTML = `
        <div class="card-label">${card.label}</div>
        <div class="card-value">${card.value}</div>
        <div class="card-sub">${card.sub}</div>
      `;
      container.appendChild(el);
    }
  }

  /* ── Filters ────────────────────────────────────────────── */

  function renderFilters() {
    const container = document.getElementById('filter-buttons');
    container.innerHTML = '';

    const types = [
      'pr_created', 'pr_merged', 'ready_for_review', 'review_approved', 'review_changes_requested',
      'review_comment', 'issue_comment', 'author_nag', 'manual_fix',
      'commit_pushed', 'bot_comment', 'ci_status', 'idle_gap',
      'release_pipeline_started', 'release_pipeline_completed',
      'release_pipeline_failed', 'release_pending', 'tool_call'
    ];

    // Toggle all
    const allBtn = document.createElement('button');
    const allOn = hiddenEventTypes.size === 0;
    allBtn.className = `filter-btn toggle-all ${allOn ? 'active' : ''}`;
    allBtn.textContent = allOn ? 'Hide All' : 'Show All';
    allBtn.addEventListener('click', () => {
      if (hiddenEventTypes.size === 0) types.forEach(t => hiddenEventTypes.add(t));
      else hiddenEventTypes.clear();
      updateEventVisibility();
      renderFilters();
    });
    container.appendChild(allBtn);

    // Smart View
    const isSmartView = [...SMART_VIEW_TYPES].every(t => !hiddenEventTypes.has(t)) &&
      types.filter(t => !SMART_VIEW_TYPES.has(t)).every(t => hiddenEventTypes.has(t));
    const smartBtn = document.createElement('button');
    smartBtn.className = `filter-btn preset-btn ${isSmartView ? 'active' : ''}`;
    smartBtn.textContent = '⚡ Smart View';
    smartBtn.title = 'Show only high-signal events';
    smartBtn.addEventListener('click', () => {
      hiddenEventTypes.clear();
      types.forEach(t => { if (!SMART_VIEW_TYPES.has(t)) hiddenEventTypes.add(t); });
      updateEventVisibility();
      renderFilters();
    });
    container.appendChild(smartBtn);

    for (const type of types) {
      const info = DataLoader.getEventTypeInfo(type);
      const btn = document.createElement('button');
      btn.className = `filter-btn ${hiddenEventTypes.has(type) ? '' : 'active'}`;
      const swatch = `<span class="legend-swatch"><span class="event-marker ${type}"></span></span>`;
      btn.innerHTML = `${swatch} ${info.label}`;
      btn.addEventListener('click', () => {
        if (hiddenEventTypes.has(type)) { hiddenEventTypes.delete(type); btn.classList.add('active'); }
        else { hiddenEventTypes.add(type); btn.classList.remove('active'); }
        updateEventVisibility();
      });
      container.appendChild(btn);
    }

    renderActorFilters();
    renderBarLegend();
  }

  function renderBarLegend() {
    const container = document.getElementById('bar-legend');
    if (!container) return;
    const items = [
      { cls: 'pr-bar merged', label: 'Merged PR' },
      { cls: 'pr-bar open', label: 'Open PR' },
      { cls: 'pr-bar closed', label: 'Closed PR' },
      { cls: 'release-bar released', label: 'Release' },
      { cls: 'idle-gap warning', label: 'Idle gap' },
    ];
    container.innerHTML =
      '<span class="filters-label">Legend:</span>' +
      items.map(item =>
        `<span class="bar-legend-item">${item.label}<span class="bar-legend-swatch ${item.cls}"></span></span>`
      ).join('');
    container.classList.remove('hidden');
  }

  // Known bot actors
  const BOT_ACTOR_NAMES = new Set([
    'azure-sdk', 'copilot-agent', 'copilot', 'azure-pipelines', 'github-actions[bot]',
    'copilot-pull-request-reviewer[bot]', 'azure-pipelines[bot]', 'unknown', 'system', 'developer'
  ]);
  function isActorBot(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    return BOT_ACTOR_NAMES.has(lower) || lower.endsWith('[bot]');
  }

  function renderActorFilters() {
    let section = document.getElementById('actor-filters');
    if (!section) {
      section = document.createElement('section');
      section.id = 'actor-filters';
      section.className = 'filters actor-filters';
      const filtersEl = document.getElementById('filters');
      filtersEl.parentNode.insertBefore(section, filtersEl.nextSibling);
    }
    section.classList.remove('hidden');

    const actorCounts = {};
    const events = DataLoader.getAllEvents(data);
    for (const ev of events) {
      if (!ev.actor) continue;
      actorCounts[ev.actor] = (actorCounts[ev.actor] || 0) + 1;
    }
    allActors = Object.keys(actorCounts).sort((a, b) => actorCounts[b] - actorCounts[a]);

    const humanActors = allActors.filter(a => !isActorBot(a));
    const botActors = allActors.filter(a => isActorBot(a));

    section.innerHTML = '';

    // People — show top 15 with expander for service timeline (can be very large)
    const peopleLabel = document.createElement('span');
    peopleLabel.className = 'filters-label';
    peopleLabel.textContent = `👤 People (${humanActors.length}):`;
    section.appendChild(peopleLabel);

    const peopleContainer = document.createElement('div');
    peopleContainer.className = 'filter-buttons actor-filter-buttons';
    section.appendChild(peopleContainer);

    const MAX_VISIBLE = 15;
    const visibleHumans = humanActors.slice(0, MAX_VISIBLE);
    const hiddenHumans = humanActors.slice(MAX_VISIBLE);

    for (const actor of visibleHumans) {
      peopleContainer.appendChild(makeActorBtn(actor, actorCounts[actor]));
    }

    if (hiddenHumans.length > 0) {
      const expandBtn = document.createElement('button');
      expandBtn.className = 'filter-btn expand-btn';
      expandBtn.textContent = `+${hiddenHumans.length} more`;
      expandBtn.addEventListener('click', () => {
        expandBtn.remove();
        for (const actor of hiddenHumans) {
          peopleContainer.appendChild(makeActorBtn(actor, actorCounts[actor]));
        }
      });
      peopleContainer.appendChild(expandBtn);
    }

    // Bots collapsed by default
    if (botActors.length > 0) {
      const botLabel = document.createElement('span');
      botLabel.className = 'filters-label bot-label';
      botLabel.textContent = `🤖 Bots (${botActors.length}):`;
      section.appendChild(botLabel);

      const botContainer = document.createElement('div');
      botContainer.className = 'filter-buttons actor-filter-buttons';
      section.appendChild(botContainer);

      for (const actor of botActors.slice(0, 5)) {
        botContainer.appendChild(makeActorBtn(actor, actorCounts[actor]));
      }
      if (botActors.length > 5) {
        const expandBtn = document.createElement('button');
        expandBtn.className = 'filter-btn expand-btn';
        expandBtn.textContent = `+${botActors.length - 5} more`;
        expandBtn.addEventListener('click', () => {
          expandBtn.remove();
          for (const actor of botActors.slice(5)) {
            botContainer.appendChild(makeActorBtn(actor, actorCounts[actor]));
          }
        });
        botContainer.appendChild(expandBtn);
      }
    }
  }

  function makeActorBtn(actor, count) {
    const btn = document.createElement('button');
    const isActive = !hiddenActors.has(actor);
    btn.className = `filter-btn actor-btn ${isActive ? 'active' : ''}`;
    btn.innerHTML = `${escapeHtml(actor)} <span class="actor-count">${count}</span>`;
    btn.title = `${actor}: ${count} events`;
    btn.addEventListener('click', () => {
      if (hiddenActors.has(actor)) { hiddenActors.delete(actor); btn.classList.add('active'); }
      else { hiddenActors.add(actor); btn.classList.remove('active'); }
      updateEventVisibility();
    });
    return btn;
  }

  function updateEventVisibility() {
    document.querySelectorAll('.event-marker').forEach(el => {
      const type = el.dataset.eventType;
      const actor = el._eventData?.actor;
      const typeHidden = hiddenEventTypes.has(type);
      const actorHidden = actor && hiddenActors.has(actor);
      if (typeHidden || actorHidden) el.classList.add('hidden');
      else el.classList.remove('hidden');
    });
    document.querySelectorAll('.idle-gap').forEach(el => {
      if (hiddenEventTypes.has('idle_gap')) el.classList.add('hidden');
      else el.classList.remove('hidden');
    });
  }

  /* ── Gap Compaction ─────────────────────────────────────── */

  function buildSegments() {
    const allPRs = DataLoader.getAllPRs(data);
    const ts = new Set();

    for (const pr of allPRs) {
      if (!pr.createdAt) continue;
      ts.add(new Date(pr.createdAt).getTime());
      if (pr.mergedAt) ts.add(new Date(pr.mergedAt).getTime());
      if (pr.closedAt) ts.add(new Date(pr.closedAt).getTime());
      for (const ev of (pr.events || [])) {
        ts.add(new Date(ev.timestamp).getTime());
        if (ev.endTimestamp) ts.add(new Date(ev.endTimestamp).getTime());
      }
    }

    const sorted = [...ts].sort((a, b) => a - b);
    segments = [];

    if (sorted.length < 2) {
      segments = [{ type: 'active', startMs: timeRange.start.getTime(), endMs: timeRange.end.getTime() }];
      assignPixelRanges();
      return;
    }

    let cStart = sorted[0], cEnd = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - cEnd > GAP_THRESHOLD_MS) {
        segments.push({ type: 'active', startMs: cStart, endMs: cEnd });
        segments.push({
          type: 'gap', startMs: cEnd, endMs: sorted[i],
          durationDays: Math.round((sorted[i] - cEnd) / 86400000 * 10) / 10
        });
        cStart = sorted[i];
      }
      cEnd = sorted[i];
    }
    segments.push({ type: 'active', startMs: cStart, endMs: cEnd });

    // Pad active segments
    for (const seg of segments) {
      if (seg.type === 'active') {
        const dur = Math.max(seg.endMs - seg.startMs, 3600000);
        const pad = Math.max(4 * 3600000, Math.min(dur * 0.06, 24 * 3600000));
        seg.startMs -= pad;
        seg.endMs += pad;
      }
    }

    // Clamp gap boundaries
    for (let i = 1; i < segments.length - 1; i++) {
      if (segments[i].type === 'gap') {
        segments[i].startMs = segments[i - 1].endMs;
        segments[i].endMs = segments[i + 1].startMs;
      }
    }

    assignPixelRanges();
  }

  function assignPixelRanges() {
    const activeSegs = segments.filter(s => s.type === 'active');
    const gapCount = segments.filter(s => s.type === 'gap').length;

    const minNeeded = padding.left + padding.right +
      activeSegs.length * MIN_SEGMENT_PX + gapCount * COMPRESSED_GAP_PX;
    if (contentWidth < minNeeded) contentWidth = minNeeded;

    const usable = contentWidth - padding.left - padding.right;
    const activePixels = usable - gapCount * COMPRESSED_GAP_PX;

    let totalDuration = 0;
    for (const s of activeSegs) totalDuration += Math.max(s.endMs - s.startMs, 1);

    let px = padding.left;
    for (const seg of segments) {
      seg.startPx = px;
      if (seg.type === 'active') {
        const frac = Math.max(seg.endMs - seg.startMs, 1) / totalDuration;
        seg.endPx = px + Math.max(frac * activePixels, MIN_SEGMENT_PX);
      } else {
        seg.endPx = px + COMPRESSED_GAP_PX;
      }
      px = seg.endPx;
    }
    contentWidth = segments[segments.length - 1].endPx + padding.right;
  }

  function timeToX(timestamp) {
    const t = new Date(timestamp).getTime();
    for (const seg of segments) {
      if (t >= seg.startMs && t <= seg.endMs) {
        const range = seg.endMs - seg.startMs;
        const frac = range === 0 ? 0.5 : (t - seg.startMs) / range;
        return seg.startPx + frac * (seg.endPx - seg.startPx);
      }
    }
    if (t < segments[0].startMs) return segments[0].startPx;
    return segments[segments.length - 1].endPx;
  }

  /* ── Zoom Controls ──────────────────────────────────────── */

  function renderZoomControls() {
    const spacer = document.querySelector('.timeline-labels .lane-label-spacer');
    if (!spacer) return;
    let controls = document.getElementById('zoom-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.id = 'zoom-controls';
      controls.className = 'zoom-controls';
      spacer.appendChild(controls);
    }
    controls.innerHTML = `
      <button class="zoom-btn" data-action="out" title="Zoom out">−</button>
      <span class="zoom-level">${Math.round(zoomLevel * 100)}%</span>
      <button class="zoom-btn" data-action="in" title="Zoom in">+</button>
      <button class="zoom-btn" data-action="reset" title="Reset">↺</button>
    `;
    controls.querySelectorAll('.zoom-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'reset') { zoomLevel = 1; renderTimeline(); }
        else adjustZoom(action === 'in' ? 1 : -1);
      });
    });
  }

  function adjustZoom(direction) {
    const steps = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5];
    let idx = steps.findIndex(s => Math.abs(s - zoomLevel) < 0.01);
    if (idx === -1) idx = 2;
    idx = Math.max(0, Math.min(steps.length - 1, idx + direction));
    zoomLevel = steps[idx];
    renderTimeline();
  }

  /* ── Timeline Rendering ─────────────────────────────────── */

  function renderTimeline() {
    const lanesContainer = document.getElementById('lanes');
    const labelsContainer = document.getElementById('lane-labels');
    lanesContainer.innerHTML = '';
    labelsContainer.innerHTML = '';

    const scrollEl = document.querySelector('.timeline-scroll');
    const availWidth = scrollEl.clientWidth;
    contentWidth = Math.max(availWidth * zoomLevel, 800);

    buildSegments();
    lanesContainer.style.minWidth = contentWidth + 'px';

    renderZoomControls();
    renderTimeAxis('time-axis');
    renderTimeAxis('time-axis-bottom');

    // Spec PRs lane (all spec PRs in one lane)
    renderMultiPRLane(lanesContainer, labelsContainer, 'Spec PRs', 'spec', data.specPRs, true);

    // SDK PR lanes per language
    const langOrder = ['Python', 'Java', 'Go', '.NET', 'JavaScript'];
    for (const lang of langOrder) {
      const prs = data.sdkPRs[lang];
      if (!prs || prs.length === 0) continue;
      renderMultiPRLane(lanesContainer, labelsContainer, lang, lang.toLowerCase().replace('.', ''), prs, false);
    }
    // Any remaining languages not in standard order
    for (const [lang, prs] of Object.entries(data.sdkPRs)) {
      if (langOrder.includes(lang) || prs.length === 0) continue;
      renderMultiPRLane(lanesContainer, labelsContainer, lang, lang.toLowerCase(), prs, false);
    }

    addGridlines(lanesContainer);
    highlightWindow();
  }

  function renderTimeAxis(elementId) {
    const axis = document.getElementById(elementId);
    axis.innerHTML = '';
    axis.style.width = contentWidth + 'px';

    for (const seg of segments) {
      if (seg.type === 'active') {
        const segDays = (seg.endMs - seg.startMs) / 86400000;
        let intervalDays;
        if (segDays <= 7) intervalDays = 1;
        else if (segDays <= 30) intervalDays = 7;
        else if (segDays <= 90) intervalDays = 14;
        else intervalDays = 30;

        const tickDate = new Date(seg.startMs);
        tickDate.setUTCHours(0, 0, 0, 0);
        while (tickDate.getTime() < seg.startMs) {
          tickDate.setUTCDate(tickDate.getUTCDate() + intervalDays);
        }
        while (tickDate.getTime() <= seg.endMs) {
          const x = timeToX(tickDate.toISOString());
          const tick = document.createElement('div');
          tick.className = 'time-tick';
          if (tickDate.getUTCDate() === 1 || intervalDays >= 14) tick.classList.add('major');
          tick.style.left = x + 'px';
          tick.textContent = DataLoader.formatDate(tickDate.toISOString());
          axis.appendChild(tick);
          tickDate.setUTCDate(tickDate.getUTCDate() + intervalDays);
        }
      } else {
        const midPx = (seg.startPx + seg.endPx) / 2;
        const breakEl = document.createElement('div');
        breakEl.className = 'time-break';
        breakEl.style.left = midPx + 'px';
        breakEl.textContent = `⋯ ${seg.durationDays}d`;
        breakEl.title = `${seg.durationDays} day gap (compressed)`;
        axis.appendChild(breakEl);
      }
    }
  }

  /* ── Multi-PR Lane ──────────────────────────────────────── */

  function renderMultiPRLane(container, labelsContainer, langName, langClass, prs, isSpec) {
    const laneIndex = container.children.length;

    // Label
    const label = document.createElement('div');
    label.className = `lane-label ${isSpec ? 'spec-lane' : ''} service-lane-label`;
    label.dataset.laneIndex = laneIndex;

    const prCount = prs.length;
    const mergedCount = prs.filter(p => p.state === 'merged').length;
    const openCount = prs.filter(p => p.state === 'open').length;

    label.innerHTML = `
      <div class="lane-repo">
        <span class="lane-language ${langClass}">${escapeHtml(langName)}</span>
      </div>
      <div class="lane-meta">
        <span>${prCount} PRs</span>
        <span class="pr-counts">${mergedCount}✓ ${openCount > 0 ? openCount + '⏳' : ''}</span>
      </div>
    `;
    labelsContainer.appendChild(label);

    // Lane
    const lane = document.createElement('div');
    lane.className = `lane ${isSpec ? 'spec-lane' : ''} service-lane`;
    lane.dataset.laneIndex = laneIndex;

    // Hover sync
    lane.addEventListener('mouseenter', () => label.classList.add('hover'));
    lane.addEventListener('mouseleave', () => label.classList.remove('hover'));
    label.addEventListener('mouseenter', () => { lane.classList.add('hover'); label.classList.add('hover'); });
    label.addEventListener('mouseleave', () => { lane.classList.remove('hover'); label.classList.remove('hover'); });

    const content = document.createElement('div');
    content.className = 'lane-content';
    content.style.width = contentWidth + 'px';

    // Gap break indicators
    for (const seg of segments) {
      if (seg.type === 'gap') {
        const breakEl = document.createElement('div');
        breakEl.className = 'lane-break';
        breakEl.style.left = seg.startPx + 'px';
        breakEl.style.width = (seg.endPx - seg.startPx) + 'px';
        content.appendChild(breakEl);
      }
    }

    // Sort PRs by creation date
    const sorted = [...prs].sort((a, b) => {
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    // Render each PR as a bar with events
    for (const pr of sorted) {
      if (!pr.createdAt) continue;
      renderPRBar(content, pr, isSpec);
    }

    lane.appendChild(content);
    container.appendChild(lane);
  }

  function renderPRBar(content, pr, isSpec) {
    const barStart = timeToX(pr.createdAt);
    const barEnd = timeToX(pr.mergedAt || pr.closedAt || data.endDate);

    // PR duration bar
    const bar = document.createElement('div');
    bar.className = `pr-bar pr-bar-multi ${pr.state === 'merged' ? 'merged' : ''} ${pr.state === 'open' ? 'open' : ''} ${pr.state === 'closed' && !pr.mergedAt ? 'closed' : ''}`;
    bar.dataset.prNumber = pr.number;
    bar.style.left = barStart + 'px';
    bar.style.width = Math.max(barEnd - barStart, 4) + 'px';

    // Tooltip with PR summary on hover
    const days = pr.mergedAt ? DataLoader.computeDurationDays(pr.createdAt, pr.mergedAt) : null;
    bar.title = `#${pr.number}: ${(pr.title || '').slice(0, 60)}${days ? ` (${days}d)` : pr.state === 'open' ? ' (open)' : ''}`;

    // Subtle PR number label inside bar if wide enough
    if (barEnd - barStart > 40) {
      const numLabel = document.createElement('span');
      numLabel.className = 'pr-bar-label';
      numLabel.textContent = `#${pr.number}`;
      bar.appendChild(numLabel);
    }

    content.appendChild(bar);

    // Event markers on the bar
    for (const event of (pr.events || [])) {
      if (hiddenEventTypes.has(event.type)) continue;
      if (event.type === 'idle_gap') {
        renderIdleGap(content, event);
        continue;
      }
      const x = timeToX(event.timestamp);
      const marker = document.createElement('div');
      const info = DataLoader.getEventTypeInfo(event.type);
      marker.className = `event-marker ${event.type}`;
      marker.dataset.eventType = event.type;
      marker.style.left = x + 'px';
      marker.textContent = info.icon;
      marker._eventData = event;
      marker._prData = pr;

      marker.addEventListener('mouseenter', (e) => UI.showTooltip(e, event, pr));
      marker.addEventListener('mouseleave', () => UI.hideTooltip());
      marker.addEventListener('click', () => UI.showDetail(event, pr));

      content.appendChild(marker);
    }
  }

  function renderIdleGap(content, event) {
    if (!event.timestamp || !event.endTimestamp) return;
    const x1 = timeToX(event.timestamp);
    const x2 = timeToX(event.endTimestamp);
    const width = Math.max(x2 - x1, 2);

    const gap = document.createElement('div');
    gap.className = `idle-gap ${event.details?.durationHours > 48 ? 'warning' : ''}`;
    gap.style.left = x1 + 'px';
    gap.style.width = width + 'px';
    gap.title = `Idle: ${DataLoader.formatDuration(event.details?.durationHours || 0)}`;
    content.appendChild(gap);
  }

  function addGridlines(container) {
    for (const seg of segments) {
      if (seg.type !== 'active') continue;
      const segDays = (seg.endMs - seg.startMs) / 86400000;
      const intervalDays = segDays <= 7 ? 1 : segDays <= 30 ? 7 : segDays <= 90 ? 14 : 30;

      const tickDate = new Date(seg.startMs);
      tickDate.setUTCHours(0, 0, 0, 0);
      while (tickDate.getTime() < seg.startMs) {
        tickDate.setUTCDate(tickDate.getUTCDate() + intervalDays);
      }
      while (tickDate.getTime() <= seg.endMs) {
        const x = timeToX(tickDate.toISOString());
        const line = document.createElement('div');
        line.className = 'gridline';
        line.style.left = x + 'px';
        container.appendChild(line);
        tickDate.setUTCDate(tickDate.getUTCDate() + intervalDays);
      }
    }
  }

  /* ── Insights ───────────────────────────────────────────── */

  function renderInsights() {
    const container = document.getElementById('insights-list');
    if (!container) return;
    container.innerHTML = '';

    const insights = data.insights || [];
    if (insights.length === 0) {
      container.innerHTML = '<div class="insight-item info">No specific insights detected.</div>';
      return;
    }

    for (const insight of insights) {
      const el = document.createElement('div');
      el.className = `insight-item ${insight.severity || 'info'}`;
      const icon = insight.severity === 'warning' ? '⚠️' : insight.severity === 'critical' ? '🔴' : 'ℹ️';
      el.innerHTML = `<span class="insight-icon">${icon}</span> ${escapeHtml(insight.description)}`;
      container.appendChild(el);
    }
  }

  /* ── Utilities ──────────────────────────────────────────── */

  function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
  function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { render, escapeHtml, selectWindow };
})();
