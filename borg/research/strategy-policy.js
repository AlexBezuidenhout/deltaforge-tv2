'use strict';

const PARKED_STATUSES = new Set([
  'CADENCE_INVALIDATED',
  'COST_FRAGILE_CONTROL',
  'FEATURE_ONLY',
  'NEGATIVE_CONTROL',
  'NO_OBSERVED_OPPORTUNITY',
  'PROTOCOL_COMPLETION_ONLY',
  'REDESIGN_REQUIRED',
  'REJECTED_EARLY_KILL',
  'REJECTED_OUT_OF_SAMPLE',
  'SUPERSEDED',
]);

function includeParkedControls(env = process.env) {
  return String(env.BORG_INCLUDE_PARKED_CONTROLS || 'false').toLowerCase() === 'true';
}

function activeStrategyAllowlist(env = process.env) {
  const names = String(env.BORG_ACTIVE_STRATEGIES || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  return names.length ? new Set(names) : null;
}

function filterStrategiesByAllowlist(strategies, allowlist) {
  if (!allowlist) return { active: [...(strategies || [])], excluded: [] };
  const available = new Set((strategies || []).map((strategy) => strategy.name));
  const unknown = [...allowlist].filter((name) => !available.has(name));
  if (unknown.length) {
    throw new Error(`BORG_ACTIVE_STRATEGIES contains unknown strategies: ${unknown.join(', ')}`);
  }
  const active = []; const excluded = [];
  for (const strategy of strategies || []) {
    if (allowlist.has(strategy.name)) active.push(strategy);
    else excluded.push({ strategy: strategy.name, status: 'NOT_IN_ACTIVE_RESEARCH_ALLOWLIST' });
  }
  return { active, excluded };
}

function filterStrategiesByDisposition(strategies, dispositions, options = {}) {
  if (options.includeParked === true) return { active: [...strategies], parked: [] };
  const statusByStrategy = new Map((dispositions || []).map((row) =>
    [String(row.strategy), String(row.status || '').toUpperCase()]));
  const active = []; const parked = [];
  for (const strategy of strategies || []) {
    const status = statusByStrategy.get(strategy.name);
    if (PARKED_STATUSES.has(status)) parked.push({ strategy: strategy.name, status });
    else active.push(strategy);
  }
  return { active, parked };
}

async function loadActiveStrategies(pool, strategies, env = process.env) {
  const { rows } = await pool.query(`
    SELECT DISTINCT strategy,status
      FROM borg_trial_ledger
     WHERE status=ANY($1::text[])
  `, [[...PARKED_STATUSES]]);
  const disposition = filterStrategiesByDisposition(strategies, rows, {
    includeParked: includeParkedControls(env),
  });
  const allowlist = filterStrategiesByAllowlist(
    disposition.active,
    activeStrategyAllowlist(env),
  );
  return {
    active: allowlist.active,
    parked: [...disposition.parked, ...allowlist.excluded],
  };
}

module.exports = {
  PARKED_STATUSES,
  activeStrategyAllowlist,
  filterStrategiesByAllowlist,
  filterStrategiesByDisposition,
  includeParkedControls,
  loadActiveStrategies,
};
