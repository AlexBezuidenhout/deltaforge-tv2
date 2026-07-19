'use strict';

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * probability)));
  return sorted[index];
}

function seededRandom(seed = 0x5eed1234) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function wilsonInterval(successes, trials, z = 1.959963984540054) {
  if (!(trials > 0)) return [null, null];
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function clusterValues(records, clusterKey, valueKey) {
  const groups = new Map();
  for (const record of records) {
    const key = typeof clusterKey === 'function' ? clusterKey(record) : record[clusterKey];
    const value = finite(typeof valueKey === 'function' ? valueKey(record) : record[valueKey]);
    if (key == null || value == null) continue;
    const group = groups.get(String(key)) || { sum: 0, n: 0 };
    group.sum += value;
    group.n += 1;
    groups.set(String(key), group);
  }
  return [...groups.values()];
}

function clusteredBootstrap(records, clusterKey, valueKey, { iterations = 10000, alpha = 0.05, seed = 0x5eed1234 } = {}) {
  const groups = clusterValues(records, clusterKey, valueKey);
  const totalN = groups.reduce((sum, group) => sum + group.n, 0);
  const observed = totalN ? groups.reduce((sum, group) => sum + group.sum, 0) / totalN : null;
  if (groups.length < 2) return { clusters: groups.length, mean: observed, ci: [null, null] };
  const random = seededRandom(seed);
  const means = new Array(iterations);
  for (let draw = 0; draw < iterations; draw += 1) {
    let sum = 0; let n = 0;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[Math.floor(random() * groups.length)];
      sum += group.sum; n += group.n;
    }
    means[draw] = n ? sum / n : 0;
  }
  return {
    clusters: groups.length,
    mean: observed,
    ci: [quantile(means, alpha / 2), quantile(means, 1 - alpha / 2)],
  };
}

function clusterSignFlipPValue(records, clusterKey, valueKey, { iterations = 20000, seed = 0x51a1f00d } = {}) {
  const groups = clusterValues(records, clusterKey, valueKey);
  if (!groups.length) return 1;
  const observed = groups.reduce((sum, group) => sum + group.sum, 0);
  if (!(observed > 0)) return 1;
  const random = seededRandom(seed);
  let atLeast = 1;
  for (let draw = 0; draw < iterations; draw += 1) {
    let value = 0;
    for (const group of groups) value += (random() < 0.5 ? -1 : 1) * group.sum;
    if (value >= observed - 1e-12) atLeast += 1;
  }
  return atLeast / (iterations + 1);
}

function holmAdjust(pValues) {
  const indexed = pValues.map((value, index) => ({ value: Math.max(0, Math.min(1, finite(value) ?? 1)), index }))
    .sort((a, b) => a.value - b.value);
  const adjusted = new Array(pValues.length).fill(1);
  let running = 0;
  for (let rank = 0; rank < indexed.length; rank += 1) {
    running = Math.max(running, (indexed.length - rank) * indexed[rank].value);
    adjusted[indexed[rank].index] = Math.min(1, running);
  }
  return adjusted;
}

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let covariance = 0; let varX = 0; let varY = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = xs[index] - meanX; const dy = ys[index] - meanY;
    covariance += dx * dy; varX += dx * dx; varY += dy * dy;
  }
  return varX > 0 && varY > 0 ? covariance / Math.sqrt(varX * varY) : null;
}

module.exports = {
  clusterSignFlipPValue,
  clusteredBootstrap,
  holmAdjust,
  pearson,
  quantile,
  seededRandom,
  wilsonInterval,
};
