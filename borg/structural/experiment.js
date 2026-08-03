'use strict';

const STRUCTURAL_BASE_EXPERIMENT_ID = 'structural-certified-payoff-graph-v5-orphan-reserve';
const ORDERED_STRIKE_EXPERIMENT_ID = 'structural-ordered-strike-orphan-safe-v1';
const ORDERED_STRIKE_EVIDENCE_START = '2026-08-03T12:40:00.000Z';

function structuralExperimentId(structureType) {
  return structureType === 'nested_threshold'
    ? ORDERED_STRIKE_EXPERIMENT_ID : STRUCTURAL_BASE_EXPERIMENT_ID;
}

module.exports = {
  ORDERED_STRIKE_EVIDENCE_START,
  ORDERED_STRIKE_EXPERIMENT_ID,
  STRUCTURAL_BASE_EXPERIMENT_ID,
  structuralExperimentId,
};
