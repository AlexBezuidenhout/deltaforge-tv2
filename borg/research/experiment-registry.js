'use strict';

const fs = require('fs');
const path = require('path');
const { sha256, stableStringify } = require('./contracts');

const DEFAULT_MANIFEST_DIR = path.join(__dirname, '..', 'experiments');

function manifestBindings(manifest) {
  const bindings = [];
  const defaults = manifest.minimum_read || manifest.evaluation || {};

  if (Array.isArray(manifest.strategy_bindings)) {
    for (const item of manifest.strategy_bindings) {
      bindings.push({
        strategy: item.strategy,
        family: item.family || manifest.family || manifest.experiment_id,
        arm: item.arm || 'baseline',
        phase: item.phase || manifest.phase || 'pilot',
        minIndependentMarkets: Number(item.min_independent_markets || defaults.independent_markets || defaults.min_independent_markets || defaults.minimum_independent_market_events || defaults.independent_signaled_markets_per_strategy_arm || 300),
        minDays: Number(item.min_days || defaults.days || defaults.min_days || defaults.minimum_calendar_days || 30),
        primaryMetric: item.primary_metric || manifest.primary_metric || 'net_pnl_1x',
      });
    }
  }

  const strategies = manifest.strategies && typeof manifest.strategies === 'object'
    ? Object.entries(manifest.strategies)
    : [];
  for (const [strategy, config] of strategies) {
    const base = {
      strategy,
      family: config.family || manifest.family || manifest.experiment_id,
      arm: config.arm || 'baseline',
      phase: config.phase || manifest.phase || 'pilot',
      minIndependentMarkets: Number(config.min_independent_markets || defaults.independent_markets || defaults.min_independent_markets || defaults.minimum_independent_market_events || defaults.independent_signaled_markets_per_strategy_arm || 300),
      minDays: Number(config.min_days || defaults.days || defaults.min_days || defaults.minimum_calendar_days || 30),
      primaryMetric: config.primary_metric || manifest.primary_metric || 'net_pnl_1x',
    };
    bindings.push(base);
    const arms = Array.isArray(config.arms)
      ? config.arms
      : (manifest.arms && typeof manifest.arms === 'object' ? Object.keys(manifest.arms) : []);
    if (arms.length) {
      for (const arm of arms) bindings.push({ ...base, strategy: `${strategy}__${arm}`, arm });
    }
  }

  if (Array.isArray(manifest.hypotheses)) {
    for (const hypothesis of manifest.hypotheses) {
      const strategy = hypothesis.strategy || hypothesis.id || hypothesis.name;
      if (!strategy) continue;
      bindings.push({
        strategy,
        family: hypothesis.family || manifest.family || manifest.experiment_id,
        arm: hypothesis.arm || 'baseline',
        phase: hypothesis.phase || manifest.phase || 'pilot',
        minIndependentMarkets: Number(hypothesis.min_independent_markets || defaults.independent_markets || defaults.minimum_independent_market_events || 300),
        minDays: Number(hypothesis.min_days || defaults.days || defaults.minimum_calendar_days || 30),
        primaryMetric: hypothesis.primary_metric || manifest.primary_metric || 'net_pnl_1x',
      });
    }
  }

  return bindings.filter((item) => item.strategy);
}

function readExperimentManifests(directory = DEFAULT_MANIFEST_DIR) {
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  const manifests = files.map((file) => {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    parsed.experiment_id = parsed.experiment_id || parsed.manifest_id;
    parsed.frozen_at = parsed.frozen_at || parsed.frozen_at_utc || parsed.created_at;
    if (!parsed.experiment_id) throw new Error(`${file}: experiment_id or manifest_id is required`);
    const canonical = stableStringify(parsed);
    return {
      ...parsed,
      _file: file,
      _hash: sha256(canonical),
      _bindings: manifestBindings(parsed),
    };
  });

  const byId = new Map(manifests.map((manifest) => [manifest.experiment_id, manifest]));
  for (const manifest of manifests) {
    if (!manifest._bindings.length && manifest.supersedes && byId.has(manifest.supersedes)) {
      manifest._bindings = byId.get(manifest.supersedes)._bindings.map((binding) => ({ ...binding }));
    }
  }
  return manifests;
}

class ExperimentRegistry {
  constructor(manifests = readExperimentManifests()) {
    this.manifests = manifests;
    this.byStrategy = new Map();
    const ordered = [...manifests].sort((a, b) => String(a.frozen_at || '').localeCompare(String(b.frozen_at || '')));
    for (const manifest of ordered) {
      for (const binding of manifest._bindings) {
        this.byStrategy.set(binding.strategy, {
          ...binding,
          experimentId: manifest.experiment_id,
          manifestHash: manifest._hash,
          strategyVersion: manifest.strategy_version || manifest.version || 'v1',
        });
      }
    }
  }

  resolve(strategy) {
    if (this.byStrategy.has(strategy)) return this.byStrategy.get(strategy);
    const base = String(strategy).split('__')[0];
    return this.byStrategy.get(base) || null;
  }
}

async function syncExperimentRegistry(pool, directory = DEFAULT_MANIFEST_DIR) {
  const registry = new ExperimentRegistry(readExperimentManifests(directory));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const manifest of registry.manifests) {
      const existing = await client.query(
        'SELECT manifest_hash FROM borg_experiments WHERE experiment_id = $1',
        [manifest.experiment_id],
      );
      if (existing.rows.length && existing.rows[0].manifest_hash !== manifest._hash) {
        throw new Error(`Frozen experiment ${manifest.experiment_id} changed: create a new experiment_id instead`);
      }

      const stored = { ...manifest };
      delete stored._file;
      delete stored._hash;
      delete stored._bindings;
      await client.query(
        `INSERT INTO borg_experiments
          (experiment_id, manifest_format, manifest_hash, manifest, status, phase, family,
           frozen_at, paper_only, live_order_path, supersedes)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (experiment_id) DO NOTHING`,
        [
          manifest.experiment_id,
          manifest.manifest_format || 'borg-experiment-v1',
          manifest._hash,
          JSON.stringify(stored),
          manifest.status || 'frozen',
          manifest.phase || 'pilot',
          manifest.family || null,
          manifest.frozen_at || new Date().toISOString(),
          manifest.paper_only !== false,
          manifest.live_order_path === false ? 'disabled' : (manifest.live_order_path || 'disabled'),
          manifest.supersedes || null,
        ],
      );

      for (const binding of manifest._bindings) {
        await client.query(
          `INSERT INTO borg_experiment_strategies
            (experiment_id, strategy, family, arm, phase, manifest_hash,
             min_independent_markets, min_days, primary_metric)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (experiment_id, strategy, arm) DO NOTHING`,
          [manifest.experiment_id, binding.strategy, binding.family, binding.arm, binding.phase,
            manifest._hash, binding.minIndependentMarkets, binding.minDays, binding.primaryMetric],
        );
        await client.query(
          `INSERT INTO borg_trial_ledger
            (experiment_id, strategy, variant, family, phase, status, primary_metric,
             min_independent_markets, min_days, manifest_hash, frozen_at)
           VALUES ($1,$2,$3,$4,$5,'COLLECTING',$6,$7,$8,$9,$10)
           ON CONFLICT (experiment_id, strategy, variant) DO NOTHING`,
          [manifest.experiment_id, binding.strategy, binding.arm, binding.family, binding.phase,
            binding.primaryMetric, binding.minIndependentMarkets, binding.minDays,
            manifest._hash, manifest.frozen_at || new Date().toISOString()],
        );
      }
    }

    // Governance decisions are immutable, separate manifests. They never
    // delete observations or change strategy bindings; they only make a
    // previously attempted specification explicitly non-promotable. Apply in
    // chronological order so a later governance manifest can supersede an
    // earlier disposition without editing either file.
    const governance = registry.manifests
      .filter((manifest) => Array.isArray(manifest.dispositions))
      .sort((left, right) => String(left.frozen_at || '').localeCompare(String(right.frozen_at || '')));
    for (const manifest of governance) {
      for (const disposition of manifest.dispositions) {
        if (!disposition.strategy || !disposition.status || !disposition.reason) {
          throw new Error(`${manifest.experiment_id}: every disposition requires strategy, status and reason`);
        }
        await client.query(`
          UPDATE borg_trial_ledger
             SET status=$1, status_reason=$2, status_decided_at=$3,
                 status_manifest_id=$4
           WHERE strategy=$5
        `, [
          disposition.status,
          disposition.reason,
          manifest.frozen_at || new Date().toISOString(),
          manifest.experiment_id,
          disposition.strategy,
        ]);
      }
    }
    await client.query('COMMIT');
    return registry;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  DEFAULT_MANIFEST_DIR,
  ExperimentRegistry,
  manifestBindings,
  readExperimentManifests,
  syncExperimentRegistry,
};
