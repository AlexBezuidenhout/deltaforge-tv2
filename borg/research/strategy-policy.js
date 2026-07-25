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
  return filterStrategiesByDisposition(strategies, rows, {
    includeParked: includeParkedControls(env),
  });
}

module.exports = {
  PARKED_STATUSES,
  filterStrategiesByDisposition,
  includeParkedControls,
  loadActiveStrategies,
};
