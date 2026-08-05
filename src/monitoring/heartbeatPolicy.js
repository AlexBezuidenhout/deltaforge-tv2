'use strict';

const FAST_MAX_AGE_SEC = 120;
const TIMER_MAX_AGE_SEC = 660;

function enabled(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function researchFleetRequired(instanceId, explicitValue) {
  if (explicitValue != null && String(explicitValue).trim() !== '') {
    return enabled(explicitValue, false);
  }
  return ['tv2', 'tv2-dashboard'].includes(String(instanceId || '').trim());
}

function heartbeatRowFresh(row, maxAgeSec = FAST_MAX_AGE_SEC) {
  const parsedAge = parseFloat(row?.age_sec ?? row?.ageSec);
  return Number.isFinite(parsedAge)
    && parsedAge >= 0
    && parsedAge <= maxAgeSec
    && row?.stale !== true;
}

function activeFleetBotComponents(heartbeats = {}, settings = {}) {
  const candidates = [
    ['main_bot', enabled(settings.is_active, true)],
    ['george_bot', enabled(settings.george_is_active, false)],
  ];
  return candidates
    .filter(([component, configuredActive]) => configuredActive
      && heartbeatRowFresh(heartbeats[component], heartbeats[component]?.maxAgeSec))
    .map(([component]) => component);
}

function parsedMeta(value) {
  if (value == null || typeof value === 'object') return value || {};
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function failureDetail(meta) {
  const firstError = Array.isArray(meta.errors) ? meta.errors[0] : null;
  const value = meta.reason || meta.error || firstError?.error || firstError?.message;
  return value == null ? null : String(value).slice(0, 300);
}

function heartbeatPolicies(settings = {}, options = {}) {
  const researchRequired = options.researchRequired !== false;
  const runnerRequired = options.runnerRequired !== false;
  const policy = {
    main_bot: {
      required: enabled(settings.is_active, true),
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    george_bot: {
      required: enabled(settings.george_is_active, false),
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    bot_runner_owner: {
      required: runnerRequired,
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    borg_collector: {
      required: researchRequired,
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    polymarket_flow: {
      required: researchRequired,
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    allmarket_lab: {
      required: researchRequired,
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    options_surface: {
      required: researchRequired,
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    pyth_boundary: {
      required: researchRequired,
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    structural_scanner: {
      required: researchRequired,
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    crossvenue_lab: {
      required: researchRequired,
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    borg_scorer: {
      required: researchRequired,
      maxAgeSec: TIMER_MAX_AGE_SEC,
    },
    hot_partition_manager: {
      required: researchRequired,
      maxAgeSec: TIMER_MAX_AGE_SEC,
    },
    raw_archiver: {
      required: researchRequired,
      maxAgeSec: TIMER_MAX_AGE_SEC,
    },
    public_info_collector: {
      required: researchRequired,
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    paired_maker_lab: {
      required: researchRequired && enabled(options.pairedMakerRequired, false),
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    gla_live: {
      required: enabled(settings.live_gla_enabled, false),
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    h53_live: {
      required: enabled(settings.live_h53_enabled, false),
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    eth_g_late_live: {
      required: enabled(settings.live_eth_g_late_enabled, false),
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
    flow_boundary_canary: {
      required: enabled(settings.live_flow_boundary_enabled, false),
      maxAgeSec: FAST_MAX_AGE_SEC,
    },
  };
  return policy;
}

function classifyHeartbeats(rows = [], policies = {}) {
  const observed = new Map(rows.map((row) => [row.component, row]));
  const components = new Set([...Object.keys(policies), ...observed.keys()]);
  const heartbeats = {};

  for (const component of components) {
    const row = observed.get(component);
    const configured = Object.prototype.hasOwnProperty.call(policies, component);
    const policy = policies[component] || {
      required: false,
      maxAgeSec: FAST_MAX_AGE_SEC,
    };
    const parsedAge = parseFloat(row?.age_sec);
    const ageSec = Number.isFinite(parsedAge) ? parsedAge : null;
    const meta = parsedMeta(row?.meta);
    const reportedStatus = String(meta.status || '').trim().toUpperCase();
    const reportedFailure = policy.required === true
      && (['BLOCKED', 'DEGRADED', 'FAIL', 'FAILED'].includes(reportedStatus)
        || parseFloat(meta.errorCount) > 0);
    const feedDegraded = component === 'borg_collector'
      && row?.msg != null && row.msg !== 'ok';
    const missing = row == null || ageSec == null;
    const stale = policy.required === true
      && (missing || ageSec > policy.maxAgeSec || feedDegraded || reportedFailure);

    let reason = null;
    if (stale && missing) reason = 'heartbeat_missing';
    else if (stale && feedDegraded) reason = 'feed_degraded';
    else if (stale && reportedFailure) reason = 'component_reported_failure';
    else if (stale) reason = 'heartbeat_stale';

    heartbeats[component] = {
      ageSec,
      maxAgeSec: policy.maxAgeSec,
      required: policy.required === true,
      monitored: configured,
      stale,
      state: policy.required === true
        ? (stale ? 'degraded' : 'healthy')
        : 'inactive',
      ...(reason ? { reason } : {}),
      ...(feedDegraded ? { feedStatus: row.msg } : {}),
      ...(reportedFailure ? {
        reportedStatus: reportedStatus || 'ERROR',
        detail: failureDetail(meta),
      } : {}),
    };
  }
  return heartbeats;
}

module.exports = {
  FAST_MAX_AGE_SEC,
  TIMER_MAX_AGE_SEC,
  activeFleetBotComponents,
  classifyHeartbeats,
  enabled,
  failureDetail,
  heartbeatRowFresh,
  heartbeatPolicies,
  parsedMeta,
  researchFleetRequired,
};
