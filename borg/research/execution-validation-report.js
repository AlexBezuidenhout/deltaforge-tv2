'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { EXECUTION_VALIDATION_FORMAT, CLASS_RANK } = require('./execution-validation');

const DEFAULT_REPORT_FILE = '/var/lib/deltaforge/research-reports/borg-execution-validation.json';

function reportFile(env = process.env) {
  return path.resolve(env.BORG_EXECUTION_VALIDATION_REPORT || DEFAULT_REPORT_FILE);
}

function normalizeReport(value, stat, file) {
  if (!value || value.format !== EXECUTION_VALIDATION_FORMAT || !Array.isArray(value.cohorts)) {
    throw new Error(`Unsupported execution-validation report at ${file}`);
  }
  const generatedMs = Date.parse(value.generatedAt);
  const now = Date.now();
  return {
    ...value,
    available: true,
    reportFile: file,
    generatedAgeSec: Number.isFinite(generatedMs)
      ? Math.max(0, Math.round((now - generatedMs) / 1000)) : null,
    fileModifiedAt: stat?.mtime?.toISOString?.() || null,
  };
}

async function readExecutionValidationReport(options = {}) {
  const file = path.resolve(options.file || reportFile(options.env));
  try {
    const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return normalizeReport(JSON.parse(raw), stat, file);
  } catch (error) {
    if (options.strict) throw error;
    return {
      format: EXECUTION_VALIDATION_FORMAT,
      available: false,
      reportFile: file,
      generatedAt: null,
      generatedAgeSec: null,
      counts: {},
      cohorts: [],
      ranking: [],
      error: error.code === 'ENOENT'
        ? 'No fleet full-depth replay has been published yet.'
        : `Execution-validation report is unreadable: ${error.message}`,
    };
  }
}

function latestCohortsByStrategy(report) {
  const selected = new Map();
  for (const cohort of report?.cohorts || []) {
    const strategy = String(cohort.strategy || '');
    if (!strategy) continue;
    const prior = selected.get(strategy);
    const cohortTime = Date.parse(cohort.latestAt) || 0;
    const priorTime = Date.parse(prior?.latestAt) || 0;
    if (!prior || cohortTime > priorTime
      || (cohortTime === priorTime
        && Number(cohort.classRank ?? CLASS_RANK.UNSCOREABLE)
          < Number(prior.classRank ?? CLASS_RANK.UNSCOREABLE))) {
      selected.set(strategy, cohort);
    }
  }
  return selected;
}

function matchesFrozenTrial(cohort, trial = {}) {
  if (!cohort) return false;
  const experimentId = trial.experiment_id ?? trial.current_experiment_id;
  const arm = trial.variant ?? trial.current_trial_variant;
  const phase = trial.phase ?? trial.current_trial_phase;
  return String(cohort.experimentId || '') === String(experimentId || '')
    && String(cohort.arm || 'baseline') === String(arm || 'baseline')
    && String(cohort.phase || 'eval') === String(phase || 'eval');
}

function publicExecutionValidation(report) {
  return {
    ...report,
    reportFile: undefined,
    warning: 'L4 counterfactual execution evidence is not authenticated live-fill proof or authorization for live capital.',
  };
}

module.exports = {
  DEFAULT_REPORT_FILE,
  latestCohortsByStrategy,
  matchesFrozenTrial,
  normalizeReport,
  publicExecutionValidation,
  readExecutionValidationReport,
  reportFile,
};
