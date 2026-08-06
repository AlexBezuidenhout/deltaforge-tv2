'use strict';

const STRUCTURAL_BASE_EXPERIMENT_ID = 'structural-certified-payoff-graph-v5-orphan-reserve';
const ORDERED_STRIKE_EXPERIMENT_ID = 'structural-ordered-strike-orphan-safe-v1';
const ORDERED_STRIKE_EVIDENCE_START = '2026-08-03T12:40:00.000Z';
const SPORTS_PHYSICAL_EXPERIMENT_ID = 'structural-sports-physical-floor-v1';
const SPORTS_PHYSICAL_UNIVERSE_ID = 'sports-physical-payoff-graph-v1';
const STRUCTURAL_VISIBLE_UNIVERSE_IDS = Object.freeze([
  STRUCTURAL_BASE_EXPERIMENT_ID,
  SPORTS_PHYSICAL_UNIVERSE_ID,
]);

function structuralExperimentId(structureType) {
  if (structureType === 'nested_threshold') return ORDERED_STRIKE_EXPERIMENT_ID;
  if (structureType === 'sports_exact00_over05_floor') return SPORTS_PHYSICAL_EXPERIMENT_ID;
  return STRUCTURAL_BASE_EXPERIMENT_ID;
}

module.exports = {
  ORDERED_STRIKE_EVIDENCE_START,
  ORDERED_STRIKE_EXPERIMENT_ID,
  SPORTS_PHYSICAL_EXPERIMENT_ID,
  SPORTS_PHYSICAL_UNIVERSE_ID,
  STRUCTURAL_BASE_EXPERIMENT_ID,
  STRUCTURAL_VISIBLE_UNIVERSE_IDS,
  structuralExperimentId,
};
