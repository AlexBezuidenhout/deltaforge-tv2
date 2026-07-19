/**
 * Forward-only paper comparator for the legacy Main and George bots.
 *
 * This adapter observes newly persisted PAPER fills and emits canonical BORG
 * shadow intents so the same quote-survival/depth/fee scorer can challenge
 * the legacy paper claim. It deliberately has no Polymarket client, keys,
 * signing code, or order method. On first boot it checkpoints the current
 * maxima, so historical trades are never relabelled as prospective evidence.
 */
'use strict';

const { EXECUTION_MODEL_VERSION, createOrderIntent } = require('../research/contracts');

const ADAPTERS = Object.freeze({
  main: {
    checkpoint: 'legacy-main-paper-v1',
    strategy: 'MAIN_paper_fill_shadow_v1',
    table: 'trades',
  },
  george: {
    checkpoint: 'legacy-george-paper-v1',
    strategy: 'GEORGE_paper_fill_shadow_v1',
    table: 'george_trades',
  },
});

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

class LegacyPaperAdapter {
  constructor({ pool, insertRows, logEvent, experimentRegistry }) {
    this.pool = pool;
    this.insertRows = insertRows;
    this.logEvent = logEvent;
    this.experimentRegistry = experimentRegistry;
    this.running = false;
  }

  async _checkpoint(config) {
    const inserted = await this.pool.query(
      `INSERT INTO borg_adapter_checkpoints (adapter, last_id, detail)
       SELECT $1, COALESCE(MAX(id),0), $2::jsonb FROM ${config.table}
       ON CONFLICT (adapter) DO NOTHING
       RETURNING last_id`,
      [config.checkpoint, JSON.stringify({ forward_only: true, strategy: config.strategy })],
    );
    if (inserted.rows.length) {
      await this.logEvent('INFO', 'paper-adapter',
        `${config.strategy} initialized forward-only at source id ${inserted.rows[0].last_id}`);
      return { lastId: parseInt(inserted.rows[0].last_id, 10) || 0, initialized: true };
    }
    const { rows } = await this.pool.query(
      'SELECT last_id FROM borg_adapter_checkpoints WHERE adapter=$1', [config.checkpoint]);
    return { lastId: parseInt(rows[0]?.last_id, 10) || 0, initialized: false };
  }

  async _sourceRows(kind, lastId) {
    if (kind === 'main') {
      const { rows } = await this.pool.query(
        `SELECT t.id, t.user_id, t.market_id, t.direction, t.entry_price, t.trade_size,
                t.created_at, t.token_id, t.asset, t.execution_type, t.is_virtual,
                bs.paper_trading,
                bm.id AS borg_market_id, bm.window_end, bm.positive_label, bm.negative_label
         FROM trades t
         LEFT JOIN bot_settings bs ON bs.user_id=t.user_id
         LEFT JOIN LATERAL (
           SELECT m.* FROM borg_markets m
           WHERE m.gamma_id::text=t.market_id::text
              OR m.condition_id::text=t.market_id::text
              OR m.slug=t.market_id::text
           ORDER BY m.window_end DESC LIMIT 1
         ) bm ON true
         WHERE t.id>$1 ORDER BY t.id LIMIT 500`, [lastId]);
      return rows;
    }
    const { rows } = await this.pool.query(
      `SELECT t.id, t.user_id, t.market_id, t.direction, t.entry_price, t.trade_size,
              t.created_at, t.asset, t.entry_mode, bs.paper_trading,
              bm.id AS borg_market_id, bm.window_end, bm.positive_label, bm.negative_label
       FROM george_trades t
       LEFT JOIN bot_settings bs ON bs.user_id=t.user_id
       LEFT JOIN LATERAL (
         SELECT m.* FROM borg_markets m
         WHERE m.gamma_id::text=t.market_id::text
            OR m.condition_id::text=t.market_id::text
            OR m.slug=t.market_id::text
         ORDER BY m.window_end DESC LIMIT 1
       ) bm ON true
       WHERE t.id>$1 ORDER BY t.id LIMIT 500`, [lastId]);
    return rows;
  }

  _toOrder(config, source) {
    const price = finite(source.entry_price);
    const stake = finite(source.trade_size);
    const marketId = parseInt(source.borg_market_id, 10);
    if (!(price > 0 && price < 1) || !(stake > 0) || !Number.isFinite(marketId)) return null;
    if (source.paper_trading !== true) return null;
    if (config.table === 'trades'
        && (source.execution_type !== 'SIMULATED' || source.is_virtual === true)) return null;

    const decisionAt = new Date(source.created_at);
    if (Number.isNaN(decisionAt.getTime())) return null;
    const direction = String(source.direction || '').toUpperCase();
    const token = ['YES', 'UP'].includes(direction) ? (source.positive_label || 'UP')
      : ['NO', 'DOWN'].includes(direction) ? (source.negative_label || 'DOWN') : null;
    if (!token) return null;

    const binding = this.experimentRegistry?.resolve(config.strategy) || null;
    const sourceEventId = `${config.table}:${source.id}`;
    const intent = createOrderIntent({
      strategy: config.strategy,
      strategyVersion: binding?.strategyVersion || 'v1',
      experimentId: binding?.experimentId || null,
      manifestHash: binding?.manifestHash || null,
      trialFamily: binding?.family || 'legacy_execution_parity',
      arm: binding?.arm || 'baseline',
      action: 'PLACE',
      marketId,
      token,
      side: 'BUY',
      orderKind: 'TAKER',
      price,
      size: stake / price,
      decisionAt,
      availableAt: decisionAt,
      sourceEventId,
      executionModelVersion: EXECUTION_MODEL_VERSION,
      latencyProfile: 'latency_1s',
      metadata: { sourcePaperFill: true, sourceTable: config.table, sourceId: source.id },
    });
    const tteSec = source.window_end
      ? (new Date(source.window_end).getTime() - decisionAt.getTime()) / 1000
      : null;
    const features = {
      source_paper_execution: true,
      source_table: config.table,
      source_trade_id: source.id,
      source_entry_mode: source.entry_mode || null,
      source_recorded_stake_usd: stake,
      execution_model: 'latency_1s',
      experiment_id: intent.experimentId,
      manifest_hash: intent.manifestHash,
      research_capital_version: '500usd-v1',
      comparator_warning: 'forward legacy paper claim; independently rescored, never a live order',
    };
    return [
      decisionAt, config.strategy, binding?.phase || 'pilot', marketId, tteSec,
      'place', 'BUY', token, price, stake / price, 'taker', null,
      `${config.checkpoint}-${source.id}`, JSON.stringify(features),
      intent.intentId, intent.experimentId, intent.manifestHash, decisionAt, decisionAt,
      sourceEventId, intent.strategyVersion, intent.executionModelVersion,
      intent.latencyProfile, intent.trialFamily, intent.arm,
    ];
  }

  async _pollOne(kind) {
    const config = ADAPTERS[kind];
    const checkpoint = await this._checkpoint(config);
    if (checkpoint.initialized) return 0;
    const sourceRows = await this._sourceRows(kind, checkpoint.lastId);
    if (!sourceRows.length) return 0;

    const orders = sourceRows.map((source) => this._toOrder(config, source)).filter(Boolean);
    if (orders.length) {
      await this.insertRows('borg_shadow_orders', [
        'ts', 'strategy', 'phase', 'market_id', 'tte_sec',
        'action', 'side', 'token', 'price', 'size',
        'order_kind', 'queue_ahead', 'client_order_id', 'features',
        'intent_id', 'experiment_id', 'manifest_hash', 'decision_at', 'available_at',
        'source_event_id', 'strategy_version', 'execution_model_version',
        'latency_profile', 'trial_family', 'arm',
      ], orders, 'ON CONFLICT (intent_id) WHERE intent_id IS NOT NULL DO NOTHING');
    }

    const lastId = Math.max(...sourceRows.map((row) => parseInt(row.id, 10) || 0));
    await this.pool.query(
      `UPDATE borg_adapter_checkpoints SET last_id=$2, updated_at=now(),
         detail=jsonb_build_object(
           'forward_only', true,
           'strategy', $3::text,
           'last_emitted', $4::integer
         )
       WHERE adapter=$1`, [config.checkpoint, lastId, config.strategy, orders.length]);
    return orders.length;
  }

  async poll() {
    if (this.running) return 0;
    this.running = true;
    try {
      return (await this._pollOne('main')) + (await this._pollOne('george'));
    } catch (error) {
      await this.logEvent('ERROR', 'paper-adapter', `poll failed: ${error.message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { ADAPTERS, LegacyPaperAdapter };
