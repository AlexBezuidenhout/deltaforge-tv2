'use strict';

// One immutable production identifier prevents an inherited environment
// variable from silently appending new observations to an old evidence cohort.
// Historical reads remain available through the replay CLI's --experiment
// argument; runtime writers and dashboard defaults always use this value.
const CURRENT_CROSSVENUE_EXPERIMENT_ID = 'crossvenue-rule-aware-convergence-v5';

module.exports = { CURRENT_CROSSVENUE_EXPERIMENT_ID };
