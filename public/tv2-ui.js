'use strict';

(() => {
  const PAGE_META = {
    dashboard: ['Monitor', 'Overview', 'System state, evidence integrity and current paper operations.'],
    trades: ['Monitor', 'Trades & decisions', 'Executions, signals and the exact gate reason behind every skip.'],
    george: ['Monitor', 'George', 'Independent split-test state and paper performance.'],
    borg: ['Research', 'Strategy fleet', 'Frozen hypotheses, lifecycle decisions and promotion evidence.'],
    pyth: ['Research', 'Resolver lab', 'Exact resolver-source identities and near-expiry forward measurement.'],
    crossvenue: ['Research', 'Cross-venue', 'Rule-aware Polymarket and Kalshi identities, depth and convergence.'],
    booklab: ['Research', 'Market structure', 'All-market order books and certified payoff relationships.'],
    flow: ['Research', 'Flow capture', 'Broad public trade tape; strategy authority is paused.'],
    backtest: ['Tools', 'Replay lab', 'Retrospective scenarios and deterministic latency replays.'],
    lab: ['Tools', 'Bot settings', 'Main strategy, paper execution and connection configuration.'],
    claude: ['Tools', 'Research assistant', 'Stored analysis and operator-initiated research review.'],
    admin: ['Tools', 'Administration', 'Users, services and audit operations.'],
  };

  const HELP_BY_HEADER = [
    [/ALL BOTS/i, 'Auto-discovered runtime state. “Running” means the process is active; it does not prove that its evidence is valid or profitable.'],
    [/STRATEGY EVIDENCE LEDGER/i, 'Fresh evidence is kept separate from discovery results. Open any row for its premise, failure reason and promotion gate.'],
    [/FROZEN TEN-LANE EDGE INCUBATOR/i, 'A bounded hypothesis register. A lane may collect data without being eligible for paper execution or live capital.'],
    [/EXECUTABLE TWO-LEG SCOREBOARD/i, 'Control arithmetic is not arbitrage proof. “Proved” requires exact rules, synchronized executable depth, fees and orphan-risk stress.'],
    [/CONTRACT.IDENTITY|CONTRACT IDENTITY/i, 'Similarity scores only rank manual review. They do not certify identical settlement predicates.'],
    [/SYSTEM|HEALTH/i, 'Runtime health and research validity are separate. The evidence ribbon is the authoritative global integrity view.'],
    [/PAPER/i, 'Paper results use simulated fills and cannot be assumed to transfer to authenticated live execution.'],
  ];

  let tooltip;
  let refreshInFlight = false;
  let lastPageId = null;

  function compact(value, max = 54) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function setRail(id, state, primary, secondary) {
    const node = document.getElementById(id);
    if (!node) return;
    node.dataset.state = state;
    const strong = node.querySelector('strong');
    const small = node.querySelector('small');
    if (strong) strong.textContent = primary;
    if (small) small.textContent = secondary;
  }

  function requestHeaders() {
    try {
      return typeof window.authHeaders === 'function' ? window.authHeaders() : {};
    } catch (_) {
      const token = localStorage.getItem('token');
      return token ? { Authorization: `Bearer ${token}` } : {};
    }
  }

  async function json(path, authenticated = false, acceptErrorJson = false) {
    const response = await fetch((window.API_BASE || '') + path, {
      headers: authenticated ? requestHeaders() : {},
      cache: 'no-store',
    });
    if (!response.ok && !acceptErrorJson) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function refreshGlobalRail() {
    if (refreshInFlight || document.hidden) return;
    refreshInFlight = true;
    try {
      const [healthResult, evidenceResult, botResult] = await Promise.allSettled([
        // A degraded health response intentionally uses HTTP 503 but still
        // carries the component-level diagnosis needed by this ribbon.
        json('/api/health', false, true),
        json('/api/borg/research/evidence-epoch', true),
        json('/api/bot/status', true),
      ]);

      if (healthResult.status === 'fulfilled') {
        const health = healthResult.value;
        const stale = Array.isArray(health.staleComponents) ? health.staleComponents.length : 0;
        const writeErrors = Number(health.writeErrors || health.failedDbWrites || 0);
        const healthy = health.dbWritable === true && stale === 0 && writeErrors === 0;
        setRail('globalSystemState', healthy ? 'ok' : 'failed',
          healthy ? 'Operational' : 'Degraded',
          healthy ? `${Number(health.activeBots || 0)} active bots · database writable`
            : `${stale} stale component${stale === 1 ? '' : 's'} · ${writeErrors} write errors`);
      } else {
        setRail('globalSystemState', 'failed', 'Unreachable', 'Health API did not respond');
      }

      if (evidenceResult.status === 'fulfilled') {
        const evidence = evidenceResult.value || {};
        const failed = evidence.status === 'FAILED';
        const passed = evidence.promotionEligible === true || evidence.status === 'PASSED_24H_CLEAN';
        const epochId = evidence.epoch?.id || 'No active epoch';
        const blockers = Array.isArray(evidence.critical) ? evidence.critical : [];
        const remaining = Array.isArray(evidence.warnings) ? evidence.warnings[0] : null;
        const laneValues = Object.values(evidence.lanes || {});
        const healthyLanes = laneValues.filter((lane) => lane.healthy === true).length;
        setRail('globalEvidenceState', failed ? 'failed' : passed ? 'ok' : 'warning',
          failed ? 'Invalid' : passed ? '24h clean' : 'Collecting',
          failed ? `${compact(epochId, 24)} · ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}`
            : `${compact(epochId, 24)} · ${healthyLanes}/${laneValues.length || 0} lanes valid${remaining ? ` · ${compact(remaining, 20)}` : ''}`);

        const free = Number(evidence.metrics?.disk?.freeGiB);
        const storageState = Number.isFinite(free) ? (free < 30 ? 'failed' : free < 40 ? 'warning' : 'ok') : 'failed';
        setRail('globalStorageState', storageState,
          Number.isFinite(free) ? `${free.toFixed(1)} GiB free` : 'Unknown',
          Number.isFinite(free) ? `${free < 30 ? 'Below' : 'Above'} 30 GiB reserve` : 'Disk telemetry missing');

        const archive = evidence.metrics?.offhostArchive || {};
        const parquet = evidence.metrics?.parquet || {};
        const archiveOk = archive.reportStatus === 'verified' && parquet.healthy === true;
        const batches = Number(parquet.verifiedBatches || 0);
        const pendingRaw = Number(archive.rawBacklog?.pendingFiles || 0);
        setRail('globalArchiveState', archiveOk ? 'ok' : 'failed',
          archiveOk ? 'Verified' : 'Attention',
          archiveOk ? `Drive receipt · ${batches} Parquet batches · ${pendingRaw} raw pending`
            : compact(parquet.critical?.[0] || 'Archive or Parquet verification missing', 50));
      } else {
        setRail('globalEvidenceState', 'warning', 'Sign in', 'Evidence report requires dashboard access');
        setRail('globalStorageState', 'loading', 'Unavailable', 'Waiting for evidence report');
        setRail('globalArchiveState', 'loading', 'Unavailable', 'Waiting for evidence report');
      }

      if (botResult.status === 'fulfilled') {
        const bot = botResult.value || {};
        const paper = bot.paperTrading !== false && bot.paper_trading !== false;
        const lock = document.querySelector('.paper-lock');
        if (lock) {
          lock.textContent = paper ? 'Main paper' : 'Main live';
          lock.dataset.tooltip = paper
            ? 'The MAIN bot is configured for paper trading. Individual research canaries are reported separately in the strategy fleet.'
            : 'MAIN reports live mode. Confirm its execution controls before changing any setting.';
          lock.classList.toggle('is-live', !paper);
        }
      }
    } finally {
      refreshInFlight = false;
    }
  }

  function updateClock() {
    const node = document.getElementById('globalClock');
    if (!node) return;
    node.textContent = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Dublin', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date());
  }

  function activePageId() {
    return document.querySelector('.page.active')?.id || 'dashboard';
  }

  function updateContext() {
    const id = activePageId();
    if (id !== lastPageId) {
      // The legacy shell scrolls <body>, not window. Reset both roots so a
      // page switch never opens halfway down a different research screen.
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      lastPageId = id;
    }
    const [section, title, note] = PAGE_META[id] || ['TV2', id, ''];
    const sectionNode = document.getElementById('appContextSection');
    const titleNode = document.getElementById('appContextTitle');
    const noteNode = document.getElementById('appContextNote');
    if (sectionNode) sectionNode.textContent = section;
    if (titleNode) titleNode.textContent = title;
    if (noteNode) noteNode.textContent = note;
    document.title = `${title} — TV2`;
  }

  function closeNav() {
    document.body.classList.remove('nav-open');
    tooltip?.classList.remove('visible');
    const toggle = document.getElementById('mobileNavToggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  function setupNavigation() {
    const toggle = document.getElementById('mobileNavToggle');
    toggle?.addEventListener('click', () => {
      const open = document.body.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.getElementById('navScrim')?.addEventListener('click', closeNav);
    document.querySelector('.nav-links')?.addEventListener('click', (event) => {
      if (event.target.closest('.nav-link')) closeNav();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeNav();
    });

    const observer = new MutationObserver(updateContext);
    document.querySelectorAll('.page').forEach((page) => {
      observer.observe(page, { attributes: true, attributeFilter: ['class'] });
    });
    updateContext();
  }

  function placeTooltip(target) {
    if (!tooltip || !target) return;
    tooltip.textContent = target.dataset.tooltip || '';
    if (!tooltip.textContent) return;
    tooltip.classList.add('visible');
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    const targetRect = target.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    let left = targetRect.left + targetRect.width / 2 - tipRect.width / 2;
    let top = targetRect.bottom + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    if (top + tipRect.height > window.innerHeight - 8) top = targetRect.top - tipRect.height - 8;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.max(8, Math.round(top))}px`;
  }

  function setupTooltips() {
    tooltip = document.createElement('div');
    tooltip.className = 'ui-tooltip';
    tooltip.id = 'uiTooltip';
    tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltip);

    document.querySelectorAll('[title]').forEach((node) => {
      if (!node.dataset.tooltip && !['INPUT', 'TEXTAREA'].includes(node.tagName)) {
        node.dataset.tooltip = node.getAttribute('title');
        node.removeAttribute('title');
      }
    });

    document.querySelectorAll('.panel-header').forEach((header) => {
      if (header.querySelector('.ui-info')) return;
      const match = HELP_BY_HEADER.find(([pattern]) => pattern.test(header.textContent));
      if (!match) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ui-info';
      button.textContent = '?';
      button.dataset.tooltip = match[1];
      button.setAttribute('aria-label', 'More information');
      const first = header.firstElementChild;
      if (first) first.appendChild(button); else header.appendChild(button);
    });

    const show = (event) => {
      const target = event.target.closest?.('[data-tooltip]');
      if (target) placeTooltip(target);
    };
    const hide = (event) => {
      const target = event.target.closest?.('[data-tooltip]');
      if (target && (!event.relatedTarget || !target.contains(event.relatedTarget))) {
        tooltip?.classList.remove('visible');
      }
    };
    document.addEventListener('mouseover', show);
    document.addEventListener('focusin', show);
    document.addEventListener('mouseout', hide);
    document.addEventListener('focusout', hide);
    window.addEventListener('scroll', () => tooltip?.classList.remove('visible'), true);
    window.addEventListener('resize', () => tooltip?.classList.remove('visible'));
  }

  function init() {
    setupNavigation();
    setupTooltips();
    updateClock();
    refreshGlobalRail();
    setInterval(updateClock, 1000);
    setInterval(refreshGlobalRail, 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshGlobalRail();
    });
    window.tv2UiRefresh = refreshGlobalRail;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
