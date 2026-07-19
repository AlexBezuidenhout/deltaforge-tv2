'use strict';

/**
 * Frozen capital assumptions for forward paper/shadow experiments.
 *
 * This module has no wallet or execution dependency. It controls research
 * sizing and cohort attribution only; displayed depth can always reduce the
 * intended order below the target stake.
 */
const RESEARCH_CAPITAL_VERSION = '500usd-v1';
const STARTING_BANKROLL_USD = 500;
const RISK_PER_TRADE_PCT = 0.02;
const TARGET_STAKE_USD = +(STARTING_BANKROLL_USD * RISK_PER_TRADE_PCT).toFixed(2);
const MAX_GROSS_EXPOSURE_PCT = 0.06;

module.exports = Object.freeze({
  RESEARCH_CAPITAL_VERSION,
  STARTING_BANKROLL_USD,
  RISK_PER_TRADE_PCT,
  TARGET_STAKE_USD,
  MAX_GROSS_EXPOSURE_PCT,
});
