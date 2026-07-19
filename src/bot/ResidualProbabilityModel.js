'use strict';

const FEATURE_NAMES = Object.freeze([
  'heuristic_logit_residual',
  'phi_logit_residual',
  'phi_missing',
  'time_fraction_centered',
  'log_sigma_ratio',
]);

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const sigmoid = (value) => value >= 0
  ? 1 / (1 + Math.exp(-value))
  : Math.exp(value) / (1 + Math.exp(value));
const logit = (probability) => {
  const p = clamp(Number(probability), 1e-5, 1 - 1e-5);
  return Math.log(p / (1 - p));
};

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rawFeatures(row) {
  const market = finite(row.marketProbability ?? row.yes_price);
  const heuristic = finite(row.heuristicProbability ?? row.p_heur);
  const phi = finite(row.phiProbability ?? row.p_phi);
  const remaining = finite(row.remainingSec ?? row.remaining_sec);
  const sigma = finite(row.sigma5min ?? row.sigma_5min);
  if (!(market > 0 && market < 1) || !(heuristic > 0 && heuristic < 1)) return null;
  return {
    marketProbability: market,
    values: [
      clamp(logit(heuristic) - logit(market), -4, 4),
      phi > 0 && phi < 1 ? clamp(logit(phi) - logit(market), -4, 4) : 0,
      phi > 0 && phi < 1 ? 0 : 1,
      clamp((remaining ?? 150) / 300, 0, 1) - 0.5,
      Math.log(clamp(sigma ?? 0.0028, 1e-5, 0.02) / 0.0028),
    ],
  };
}

function solve(matrix, vector) {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let j = column; j <= n; j += 1) augmented[column][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const multiple = augmented[row][column];
      for (let j = column; j <= n; j += 1) augmented[row][j] -= multiple * augmented[column][j];
    }
  }
  return augmented.map((row) => row[n]);
}

function trainingRows(rows) {
  return rows.map((row) => {
    const built = rawFeatures(row);
    const outcome = Number(row.outcome);
    return built && (outcome === 0 || outcome === 1) ? { ...built, outcome } : null;
  }).filter(Boolean);
}

/**
 * Offset-logistic residual model. Market log-odds are the offset; slopes can
 * only learn a regularized correction. The fixed penalties are priors, not
 * thresholds selected from PnL.
 */
function fit(rows, options = {}) {
  const usable = trainingRows(rows);
  if (usable.length < 100) throw new Error(`residual model requires >=100 markets; got ${usable.length}`);
  const means = FEATURE_NAMES.map((_, j) => usable.reduce((sum, row) => sum + row.values[j], 0) / usable.length);
  const scales = FEATURE_NAMES.map((_, j) => {
    const variance = usable.reduce((sum, row) => sum + (row.values[j] - means[j]) ** 2, 0) / usable.length;
    return Math.sqrt(variance) > 1e-8 ? Math.sqrt(variance) : 1;
  });
  const prepared = usable.map((row) => ({
    offset: logit(row.marketProbability),
    x: [1, ...row.values.map((value, j) => (value - means[j]) / scales[j])],
    outcome: row.outcome,
  }));
  const slopePenalty = Number(options.slopePenalty ?? 16);
  const interceptPenalty = Number(options.interceptPenalty ?? 4);
  const penalties = [interceptPenalty, ...FEATURE_NAMES.map(() => slopePenalty)];
  const beta = Array(FEATURE_NAMES.length + 1).fill(0);
  let iterations = 0;
  for (; iterations < 80; iterations += 1) {
    const gradient = beta.map((value, j) => -penalties[j] * value);
    const hessian = beta.map((_, j) => beta.map((__, k) => (j === k ? penalties[j] : 0)));
    for (const row of prepared) {
      const eta = row.offset + row.x.reduce((sum, value, j) => sum + value * beta[j], 0);
      const probability = sigmoid(eta);
      const weight = Math.max(1e-8, probability * (1 - probability));
      for (let j = 0; j < beta.length; j += 1) {
        gradient[j] += row.x[j] * (row.outcome - probability);
        for (let k = 0; k < beta.length; k += 1) {
          hessian[j][k] += weight * row.x[j] * row.x[k];
        }
      }
    }
    const delta = solve(hessian, gradient);
    if (!delta) throw new Error('residual model Hessian is singular');
    let largest = 0;
    for (let j = 0; j < beta.length; j += 1) {
      beta[j] += delta[j];
      largest = Math.max(largest, Math.abs(delta[j]));
    }
    if (largest < 1e-8) break;
  }
  return {
    featureNames: FEATURE_NAMES,
    means,
    scales,
    coefficients: beta,
    slopePenalty,
    interceptPenalty,
    trainingMarkets: usable.length,
    iterations: iterations + 1,
  };
}

function predict(model, row) {
  const built = rawFeatures(row);
  if (!built || !model || !Array.isArray(model.coefficients)) return null;
  if (model.coefficients.length !== FEATURE_NAMES.length + 1) return null;
  const standardized = built.values.map((value, j) =>
    (value - Number(model.means[j])) / Number(model.scales[j] || 1));
  const eta = logit(built.marketProbability)
    + Number(model.coefficients[0])
    + standardized.reduce((sum, value, j) => sum + value * Number(model.coefficients[j + 1]), 0);
  return clamp(sigmoid(eta), 0.01, 0.99);
}

function metrics(rows, probabilityFor) {
  let count = 0;
  let brier = 0;
  let logLoss = 0;
  for (const row of rows) {
    const probability = probabilityFor(row);
    const outcome = Number(row.outcome);
    if (!Number.isFinite(probability) || (outcome !== 0 && outcome !== 1)) continue;
    const p = clamp(probability, 1e-6, 1 - 1e-6);
    count += 1;
    brier += (p - outcome) ** 2;
    logLoss -= outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p);
  }
  return count ? { n: count, brier: brier / count, logLoss: logLoss / count } : { n: 0, brier: null, logLoss: null };
}

module.exports = { FEATURE_NAMES, fit, logit, metrics, predict, rawFeatures };
