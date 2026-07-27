'use strict';

// One immutable production identifier prevents an inherited environment
// variable from silently appending new observations to an old evidence cohort.
// Historical reads remain available through the replay CLI's --experiment
// argument; runtime writers and dashboard defaults always use this value.
const CURRENT_CROSSVENUE_EXPERIMENT_ID = 'crossvenue-exact-rule-convergence-v6';

const EXACT_RULE_FORWARD_PROTOCOL = Object.freeze({
  experimentId: CURRENT_CROSSVENUE_EXPERIMENT_ID,
  quantity: 5,
  targetNetRoi: 0.01,
  maxHoldMs: 60 * 60_000,
  independentUnit: 'match_id + direction + UTC entry day',
  minimumFreshUnits: 300,
  minimumCalendarDays: 30,
  paperOnly: true,
});

module.exports = {
  CURRENT_CROSSVENUE_EXPERIMENT_ID,
  EXACT_RULE_FORWARD_PROTOCOL,
};
