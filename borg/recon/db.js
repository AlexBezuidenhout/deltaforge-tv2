/**
 * BORG recon — persistence layer.
 * Own tables (borg_*), shared Postgres instance with the legacy bot.
 * All writes are batched; a failed batch is logged and dropped (recon must
 * never crash on a transient DB error — gaps are recorded, not fatal).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS borg_markets (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  gamma_id TEXT,
  condition_id TEXT,
  question TEXT,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  up_token_id TEXT,
  down_token_id TEXT,
  binance_open NUMERIC,      -- live-captured Binance price at window_start
  binance_open_src TEXT,     -- 'live' | 'kline_backfill' | NULL
  binance_close NUMERIC,     -- live-captured at window_end
  binance_close_src TEXT,    -- 'live' | 'kline_backfill' | 'kline_repair' | NULL
  chainlink_open NUMERIC,    -- mainnet push-feed round in force at start (control only)
  discovered_at TIMESTAMPTZ DEFAULT now(),
  outcome TEXT,              -- 'UP' | 'DOWN'
  outcome_prices TEXT,
  resolved_at TIMESTAMPTZ,   -- when WE first observed the resolution
  raw JSONB
);
CREATE TABLE IF NOT EXISTS borg_book_snaps (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  market_id INT,
  tte_sec REAL,
  up_bids JSONB, up_asks JSONB, down_bids JSONB, down_asks JSONB,
  up_best_bid REAL, up_best_ask REAL, up_mid REAL, up_spread REAL,
  down_best_bid REAL, down_best_ask REAL,
  bid_depth_usd REAL, ask_depth_usd REAL,
  book_src TEXT,
  gamma_up REAL,
  btc_price NUMERIC, btc_ref NUMERIC,
  sigma5m_ewma NUMERIC,
  phi_fair REAL,
  cl_mainnet NUMERIC,
  rtds_chainlink NUMERIC,
  rtds_divergence_bps REAL
);
CREATE INDEX IF NOT EXISTS borg_book_snaps_market_ts ON borg_book_snaps (market_id, ts);
CREATE INDEX IF NOT EXISTS borg_book_snaps_ts_brin ON borg_book_snaps USING BRIN (ts);
CREATE TABLE IF NOT EXISTS borg_clob_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  market_id INT,
  asset_id TEXT,
  event_type TEXT,
  price REAL, size REAL, side TEXT,
  raw JSONB
);
CREATE INDEX IF NOT EXISTS borg_clob_events_market_ts ON borg_clob_events (market_id, ts);
CREATE TABLE IF NOT EXISTS borg_clob_touch (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  source_ts TIMESTAMPTZ,
  market_id INT,
  asset_id TEXT NOT NULL,
  best_bid REAL, bid_size REAL,
  best_ask REAL, ask_size REAL,
  receive_monotonic_ns NUMERIC(30,0),
  connection_epoch INT,
  connection_shard INT,
  event_sequence BIGINT,
  wal_event_id TEXT,
  book_hash TEXT,
  event_type TEXT
);
CREATE INDEX IF NOT EXISTS borg_clob_touch_market_asset_ts ON borg_clob_touch (market_id, asset_id, ts);
CREATE INDEX IF NOT EXISTS borg_clob_touch_ts_brin ON borg_clob_touch USING BRIN (ts);
CREATE TABLE IF NOT EXISTS borg_binance_1s (
  ts TIMESTAMPTZ PRIMARY KEY,
  open NUMERIC, high NUMERIC, low NUMERIC, close NUMERIC,
  n_trades INT, buy_vol NUMERIC, sell_vol NUMERIC,
  best_bid NUMERIC, best_ask NUMERIC,
  depth_imb REAL
);
CREATE TABLE IF NOT EXISTS borg_chainlink_rounds (
  round_id TEXT PRIMARY KEY,
  answer NUMERIC NOT NULL,
  oracle_updated_at TIMESTAMPTZ NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  btc_at_receipt NUMERIC
);
CREATE INDEX IF NOT EXISTS borg_chainlink_rounds_seen_at ON borg_chainlink_rounds (seen_at DESC);
CREATE TABLE IF NOT EXISTS borg_rtds_ticks (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  symbol TEXT,
  asset TEXT NOT NULL,
  source_ts TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL,
  receive_monotonic_ns NUMERIC(30,0),
  value NUMERIC NOT NULL,
  connection_epoch INT,
  event_sequence BIGINT,
  wal_event_id TEXT,
  raw JSONB
);
CREATE INDEX IF NOT EXISTS borg_rtds_ticks_asset_ts ON borg_rtds_ticks (asset, received_at);
CREATE TABLE IF NOT EXISTS borg_coinbase_1s (
  product TEXT NOT NULL,
  asset TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  price NUMERIC NOT NULL,
  best_bid NUMERIC,
  best_ask NUMERIC,
  PRIMARY KEY (product, ts)
);
-- Executable external-venue state for cross-network hypotheses. These rows do
-- not imply atomic arbitrage; they make spread, displayed capacity and adverse
-- selection measurable at the same source/receive clocks as Polymarket.
CREATE TABLE IF NOT EXISTS borg_external_book_touch (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  product TEXT NOT NULL,
  asset TEXT,
  source_ts TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL,
  receive_monotonic_ns NUMERIC(30,0),
  best_bid NUMERIC,
  bid_size NUMERIC,
  best_ask NUMERIC,
  ask_size NUMERIC,
  connection_epoch INT,
  event_sequence BIGINT,
  wal_event_id TEXT
);
CREATE INDEX IF NOT EXISTS borg_external_book_touch_source_product_ts
  ON borg_external_book_touch (source, product, received_at);
CREATE INDEX IF NOT EXISTS borg_external_book_touch_received_brin
  ON borg_external_book_touch USING BRIN (received_at);
CREATE TABLE IF NOT EXISTS borg_external_trades (
  id BIGSERIAL PRIMARY KEY,
  dedup_key TEXT UNIQUE,
  source TEXT NOT NULL,
  product TEXT NOT NULL,
  asset TEXT,
  source_ts TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL,
  receive_monotonic_ns NUMERIC(30,0),
  price NUMERIC NOT NULL,
  size NUMERIC,
  side TEXT,
  connection_epoch INT,
  event_sequence BIGINT,
  wal_event_id TEXT
);
CREATE INDEX IF NOT EXISTS borg_external_trades_source_product_ts
  ON borg_external_trades (source, product, received_at);
CREATE INDEX IF NOT EXISTS borg_external_trades_received_brin
  ON borg_external_trades USING BRIN (received_at);
CREATE UNIQUE INDEX IF NOT EXISTS borg_external_trades_dedup_received_uq
  ON borg_external_trades (dedup_key, received_at);
CREATE TABLE IF NOT EXISTS borg_taker_trades (
  id BIGSERIAL PRIMARY KEY,
  dedup_key TEXT UNIQUE,
  condition_id TEXT,
  asset_id TEXT,
  ts TIMESTAMPTZ,
  side TEXT, price REAL, size REAL,
  wallet TEXT,
  raw JSONB
);
CREATE INDEX IF NOT EXISTS borg_taker_trades_cond ON borg_taker_trades (condition_id, ts);
-- Public-flow scalp laboratory. This subsystem is deliberately separate from
-- borg_shadow_* because its positions exit after a fixed markout horizon rather
-- than at binary resolution. It contains no wallet or order-submission fields.
CREATE TABLE IF NOT EXISTS pm_flow_markets (
  condition_id TEXT PRIMARY KEY,
  gamma_id TEXT,
  slug TEXT,
  question TEXT,
  event_slug TEXT,
  outcomes JSONB NOT NULL,
  token_ids JSONB NOT NULL,
  liquidity NUMERIC,
  volume_24h NUMERIC,
  fees_enabled BOOLEAN NOT NULL DEFAULT false,
  fee_rate NUMERIC,
  recent_trade_count INT,
  recent_notional NUMERIC,
  active BOOLEAN NOT NULL DEFAULT true,
  selected_realtime BOOLEAN NOT NULL DEFAULT false,
  raw JSONB,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pm_flow_markets_selected
  ON pm_flow_markets (selected_realtime, volume_24h DESC);
ALTER TABLE pm_flow_markets ADD COLUMN IF NOT EXISTS recent_trade_count INT;
ALTER TABLE pm_flow_markets ADD COLUMN IF NOT EXISTS recent_notional NUMERIC;
CREATE TABLE IF NOT EXISTS pm_flow_trades (
  id BIGSERIAL PRIMARY KEY,
  dedup_key TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  source_ts TIMESTAMPTZ,
  source_latency_ms INT,
  condition_id TEXT,
  asset_id TEXT NOT NULL,
  outcome TEXT,
  side TEXT,
  price NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  notional NUMERIC NOT NULL,
  tx_hash TEXT,
  wallet TEXT,
  connection_epoch INT,
  connection_shard INT,
  event_sequence BIGINT,
  wal_event_id TEXT,
  data_quality_grade TEXT NOT NULL,
  raw JSONB
);
CREATE INDEX IF NOT EXISTS pm_flow_trades_observed ON pm_flow_trades (observed_at DESC);
CREATE INDEX IF NOT EXISTS pm_flow_trades_market ON pm_flow_trades (condition_id, observed_at DESC);
CREATE TABLE IF NOT EXISTS pm_flow_touches (
  id BIGSERIAL PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL,
  source_ts TIMESTAMPTZ,
  condition_id TEXT,
  asset_id TEXT NOT NULL,
  best_bid NUMERIC,
  bid_size NUMERIC,
  best_ask NUMERIC,
  ask_size NUMERIC,
  connection_epoch INT,
  connection_shard INT,
  event_sequence BIGINT,
  wal_event_id TEXT,
  book_hash TEXT,
  event_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pm_flow_touches_asset_time
  ON pm_flow_touches (asset_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS pm_flow_touches_observed_brin
  ON pm_flow_touches USING BRIN (observed_at);
CREATE TABLE IF NOT EXISTS pm_flow_connection_events (
  id BIGSERIAL PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  connection_shard INT,
  connection_epoch INT,
  event TEXT NOT NULL,
  detail JSONB
);
CREATE INDEX IF NOT EXISTS pm_flow_connection_events_time
  ON pm_flow_connection_events (observed_at DESC);
CREATE TABLE IF NOT EXISTS pm_flow_signals (
  id BIGSERIAL PRIMARY KEY,
  trigger_key TEXT NOT NULL,
  trigger_trade_id BIGINT REFERENCES pm_flow_trades(id),
  decision_at TIMESTAMPTZ NOT NULL,
  condition_id TEXT NOT NULL,
  trigger_asset_id TEXT NOT NULL,
  target_asset_id TEXT NOT NULL,
  target_outcome TEXT,
  arm TEXT NOT NULL,
  latency_ms INT NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  entry_limit NUMERIC NOT NULL,
  requested_size NUMERIC NOT NULL,
  fee_rate NUMERIC NOT NULL DEFAULT 0,
  data_quality_grade TEXT NOT NULL,
  features JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  UNIQUE (trigger_key, arm, latency_ms)
);
CREATE INDEX IF NOT EXISTS pm_flow_signals_available
  ON pm_flow_signals (status, available_at);
CREATE INDEX IF NOT EXISTS pm_flow_signals_trigger_trade
  ON pm_flow_signals (trigger_trade_id)
  WHERE trigger_trade_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS pm_flow_scores (
  signal_id BIGINT PRIMARY KEY REFERENCES pm_flow_signals(id),
  filled BOOLEAN NOT NULL,
  entry_at TIMESTAMPTZ,
  entry_price NUMERIC,
  fill_size NUMERIC,
  pnl_1s NUMERIC,
  pnl_2s NUMERIC,
  pnl_5s NUMERIC,
  pnl_10s NUMERIC,
  markouts JSONB NOT NULL,
  data_quality_grade TEXT NOT NULL,
  execution_fidelity_grade TEXT NOT NULL,
  fidelity_level TEXT NOT NULL,
  fee_model_version TEXT NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pm_flow_boundary_intents (
  id BIGSERIAL PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  borg_market_id BIGINT,
  token_id TEXT NOT NULL,
  target_outcome TEXT,
  signal_decision_at TIMESTAMPTZ NOT NULL,
  signal_available_at TIMESTAMPTZ NOT NULL,
  boundary_at TIMESTAMPTZ NOT NULL,
  tte_ms INT NOT NULL,
  decision_observed_at TIMESTAMPTZ,
  decision_state_age_ms INT,
  decision_bid NUMERIC,
  decision_bid_size NUMERIC,
  decision_ask NUMERIC,
  decision_ask_size NUMERIC,
  decision_connection_epoch INT,
  decision_connection_shard INT,
  confirmation JSONB NOT NULL,
  order_latency_ms INT NOT NULL,
  intended_arrival_at TIMESTAMPTZ NOT NULL,
  arrival_captured_at TIMESTAMPTZ,
  arrival_scheduler_lag_ms INT,
  arrival_observed_at TIMESTAMPTZ,
  arrival_state_age_ms INT,
  arrival_bid NUMERIC,
  arrival_bid_size NUMERIC,
  arrival_ask NUMERIC,
  arrival_ask_size NUMERIC,
  arrival_connection_epoch INT,
  arrival_connection_shard INT,
  minimum_order_size NUMERIC,
  target_stake_usd NUMERIC NOT NULL,
  max_touch_participation NUMERIC NOT NULL,
  requested_size NUMERIC,
  requested_notional NUMERIC,
  fee_rate NUMERIC NOT NULL DEFAULT 0,
  entry_fee NUMERIC,
  data_quality_grade TEXT,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, condition_id)
);
CREATE INDEX IF NOT EXISTS pm_flow_boundary_intents_status
  ON pm_flow_boundary_intents (status, intended_arrival_at DESC);
CREATE INDEX IF NOT EXISTS pm_flow_boundary_intents_condition
  ON pm_flow_boundary_intents (condition_id, created_at DESC);
CREATE TABLE IF NOT EXISTS flow_boundary_canary_orders (
  id BIGSERIAL PRIMARY KEY,
  intent_id BIGINT UNIQUE NOT NULL REFERENCES pm_flow_boundary_intents(id),
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  target_outcome TEXT,
  dry_run BOOLEAN NOT NULL,
  requested_notional NUMERIC NOT NULL,
  worst_price NUMERIC NOT NULL,
  status TEXT NOT NULL,
  clob_order_id TEXT,
  response JSONB,
  acknowledged_at TIMESTAMPTZ,
  acknowledgement_latency_ms INT,
  matched_shares NUMERIC,
  matched_notional NUMERIC,
  average_fill_price NUMERIC,
  resolved_outcome TEXT,
  realized_pnl NUMERIC,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_boundary_canary_orders_created
  ON flow_boundary_canary_orders (created_at DESC);
ALTER TABLE bot_settings
  ADD COLUMN IF NOT EXISTS live_flow_boundary_enabled BOOLEAN DEFAULT false;
ALTER TABLE bot_settings
  ADD COLUMN IF NOT EXISTS live_h53_enabled BOOLEAN DEFAULT false;
CREATE TABLE IF NOT EXISTS borg_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  level TEXT, source TEXT, message TEXT, data JSONB
);
CREATE INDEX IF NOT EXISTS borg_events_source_id ON borg_events (source, id DESC);
-- Collection epochs are immutable cohort boundaries. They separate data made
-- under materially different infrastructure/data contracts without deleting
-- or rewriting any historical observation.
CREATE TABLE IF NOT EXISTS borg_collection_epochs (
  epoch_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  location TEXT NOT NULL,
  host TEXT NOT NULL,
  code_version TEXT NOT NULL,
  data_contract_version TEXT NOT NULL,
  reason TEXT NOT NULL,
  benchmark JSONB,
  metadata JSONB,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS borg_collector_runs (
  run_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL REFERENCES borg_collection_epochs(epoch_id),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  pid INT,
  host TEXT NOT NULL,
  code_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  metadata JSONB
);
CREATE TABLE IF NOT EXISTS borg_evidence_health_samples (
  id BIGSERIAL PRIMARY KEY,
  epoch_id TEXT NOT NULL REFERENCES borg_collection_epochs(epoch_id),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL,
  critical JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS borg_evidence_health_epoch_time
  ON borg_evidence_health_samples (epoch_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS borg_collector_runs_epoch_started
  ON borg_collector_runs (epoch_id, started_at DESC);
-- One row per registered strategy and collector process. This is runtime
-- evidence, not a trading result: quiet strategies still prove that their
-- evaluate() function is being called when an eligible market is present.
CREATE TABLE IF NOT EXISTS borg_strategy_runtime (
  collector_run_id TEXT NOT NULL REFERENCES borg_collector_runs(run_id),
  epoch_id TEXT NOT NULL REFERENCES borg_collection_epochs(epoch_id),
  strategy TEXT NOT NULL,
  cadence TEXT NOT NULL,
  market_types JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  last_evaluated_at TIMESTAMPTZ,
  evaluations BIGINT NOT NULL DEFAULT 0,
  halted_evaluations BIGINT NOT NULL DEFAULT 0,
  actions BIGINT NOT NULL DEFAULT 0,
  errors BIGINT NOT NULL DEFAULT 0,
  last_action_at TIMESTAMPTZ,
  diagnostics JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collector_run_id, strategy)
);
ALTER TABLE borg_strategy_runtime ADD COLUMN IF NOT EXISTS diagnostics JSONB;
CREATE INDEX IF NOT EXISTS borg_strategy_runtime_epoch_strategy
  ON borg_strategy_runtime (epoch_id, strategy, updated_at DESC);
-- shadow execution (EVAL_PROTOCOL.md §1): intended orders + offline scores.
-- 'place' rows are the orders; 'cancel' rows end a maker quote's life
-- (matched by client_order_id). phase='pilot' rows are machinery-tuning
-- data, discarded from evaluation (§3).
CREATE TABLE IF NOT EXISTS borg_shadow_orders (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  strategy TEXT NOT NULL,
  phase TEXT NOT NULL,
  market_id INT,
  tte_sec REAL,
  action TEXT NOT NULL,          -- 'place' | 'cancel'
  side TEXT, token TEXT, price REAL, size REAL,
  order_kind TEXT,               -- 'maker' | 'taker'
  queue_ahead REAL,              -- displayed size at our level when placed
  client_order_id TEXT,
  features JSONB
);
CREATE INDEX IF NOT EXISTS borg_shadow_orders_mkt ON borg_shadow_orders (market_id, ts);
CREATE INDEX IF NOT EXISTS borg_shadow_orders_coid ON borg_shadow_orders (client_order_id);
CREATE TABLE IF NOT EXISTS borg_shadow_scores (
  order_id BIGINT PRIMARY KEY,
  scored_at TIMESTAMPTZ DEFAULT now(),
  strategy TEXT, phase TEXT, market_id INT,
  filled BOOLEAN, fill_ts TIMESTAMPTZ, fill_price REAL, fill_size REAL,
  fair_5s REAL, fair_30s REAL,   -- adverse-selection marks (Φ-fair after fill)
  outcome TEXT,
  pnl_gross REAL, pnl_05x REAL, pnl_1x REAL, pnl_2x REAL,
  detail JSONB
);
-- Frozen quote-survival counterfactuals are persisted while the high-rate
-- event tape is still in the PostgreSQL hot tier. They never alter the
-- strategy's signal or primary paper score; promotion uses them only to prove
-- that a result is not dependent on one assumed order latency.
CREATE TABLE IF NOT EXISTS borg_shadow_latency_scores (
  order_id BIGINT NOT NULL REFERENCES borg_shadow_orders(id),
  latency_ms INT NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  filled BOOLEAN NOT NULL,
  fill_ts TIMESTAMPTZ,
  fill_price REAL,
  fill_size REAL,
  pnl_gross REAL NOT NULL DEFAULT 0,
  pnl_1x REAL NOT NULL DEFAULT 0,
  pnl_2x REAL NOT NULL DEFAULT 0,
  data_quality_grade TEXT NOT NULL,
  execution_fidelity_grade TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (order_id, latency_ms)
);
CREATE INDEX IF NOT EXISTS borg_shadow_latency_scores_profile
  ON borg_shadow_latency_scores (latency_ms, order_id);
CREATE TABLE IF NOT EXISTS h53_live_orders (
  id BIGSERIAL PRIMARY KEY,
  shadow_order_id BIGINT UNIQUE NOT NULL REFERENCES borg_shadow_orders(id),
  market_id INT NOT NULL REFERENCES borg_markets(id),
  condition_id TEXT,
  token_id TEXT NOT NULL,
  token TEXT NOT NULL,
  signal_price NUMERIC NOT NULL,
  signal_size NUMERIC NOT NULL,
  requested_notional NUMERIC NOT NULL,
  worst_price NUMERIC NOT NULL,
  dry_run BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  clob_order_id TEXT,
  response JSONB,
  acknowledged_at TIMESTAMPTZ,
  acknowledgement_latency_ms INT,
  matched_shares NUMERIC,
  matched_notional NUMERIC,
  average_fill_price NUMERIC,
  fee_paid NUMERIC,
  fee_rate NUMERIC,
  fee_exponent NUMERIC,
  tick_size NUMERIC,
  resolved_outcome TEXT,
  realized_pnl NUMERIC,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE h53_live_orders
  ADD COLUMN IF NOT EXISTS fee_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS fee_exponent NUMERIC,
  ADD COLUMN IF NOT EXISTS tick_size NUMERIC;
CREATE UNIQUE INDEX IF NOT EXISTS h53_live_orders_one_live_market
  ON h53_live_orders(market_id) WHERE NOT dry_run;
CREATE INDEX IF NOT EXISTS h53_live_orders_created
  ON h53_live_orders(created_at DESC);
-- Immutable research governance. A manifest hash is never updated in place:
-- changing a hypothesis, arm, simulator, or primary metric requires a new
-- experiment_id, so old evidence cannot silently leak into a new trial.
CREATE TABLE IF NOT EXISTS borg_experiments (
  experiment_id TEXT PRIMARY KEY,
  manifest_format TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest JSONB NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  family TEXT,
  frozen_at TIMESTAMPTZ NOT NULL,
  paper_only BOOLEAN NOT NULL DEFAULT true,
  live_order_path TEXT NOT NULL DEFAULT 'disabled',
  supersedes TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS borg_experiment_strategies (
  experiment_id TEXT NOT NULL REFERENCES borg_experiments(experiment_id),
  strategy TEXT NOT NULL,
  family TEXT NOT NULL,
  arm TEXT NOT NULL DEFAULT 'baseline',
  phase TEXT NOT NULL DEFAULT 'pilot',
  manifest_hash TEXT NOT NULL,
  min_independent_markets INT NOT NULL DEFAULT 300,
  min_days INT NOT NULL DEFAULT 30,
  primary_metric TEXT NOT NULL DEFAULT 'net_pnl_1x',
  PRIMARY KEY (experiment_id, strategy, arm)
);
CREATE TABLE IF NOT EXISTS borg_experiment_runs (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES borg_experiments(experiment_id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  code_version TEXT,
  dataset_hash TEXT,
  config_hash TEXT,
  latency_profile TEXT,
  simulator_version TEXT,
  fee_model_version TEXT,
  random_seed TEXT,
  host_profile JSONB,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  data_quality_grade TEXT,
  execution_fidelity_grade TEXT,
  metrics JSONB
);
CREATE TABLE IF NOT EXISTS borg_trial_ledger (
  id BIGSERIAL PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES borg_experiments(experiment_id),
  strategy TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT 'baseline',
  family TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'pilot',
  status TEXT NOT NULL DEFAULT 'COLLECTING',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  frozen_at TIMESTAMPTZ NOT NULL,
  evidence_started_at TIMESTAMPTZ DEFAULT now(),
  primary_metric TEXT NOT NULL,
  min_independent_markets INT NOT NULL DEFAULT 300,
  min_days INT NOT NULL DEFAULT 30,
  manifest_hash TEXT NOT NULL,
  UNIQUE (experiment_id, strategy, variant)
);
CREATE TABLE IF NOT EXISTS borg_adapter_checkpoints (
  adapter TEXT PRIMARY KEY,
  last_id BIGINT NOT NULL,
  initialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail JSONB
);
ALTER TABLE borg_trial_ledger ADD COLUMN IF NOT EXISTS status_reason TEXT;
ALTER TABLE borg_trial_ledger ADD COLUMN IF NOT EXISTS status_decided_at TIMESTAMPTZ;
ALTER TABLE borg_trial_ledger ADD COLUMN IF NOT EXISTS status_manifest_id TEXT;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS binance_close_src TEXT;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS asset TEXT DEFAULT 'btc';
-- Generic crypto research markets (H22-H31). The legacy up/down column names
-- intentionally remain the positive/negative token slots so old 5m readers do
-- not need a destructive migration. Labels make YES/NO scoring unambiguous.
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS market_type TEXT DEFAULT 'direction_5m';
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS timeframe_sec INT DEFAULT 300;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS event_id TEXT;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS event_slug TEXT;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS strike NUMERIC;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS lower_bound NUMERIC;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS upper_bound NUMERIC;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS positive_label TEXT DEFAULT 'UP';
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS negative_label TEXT DEFAULT 'DOWN';
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS positive_outcome_index INT DEFAULT 0;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS negative_outcome_index INT DEFAULT 1;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS resolution_source TEXT;
ALTER TABLE borg_markets ADD COLUMN IF NOT EXISTS accepting_orders BOOLEAN DEFAULT true;
CREATE INDEX IF NOT EXISTS borg_markets_event_type_end
  ON borg_markets (event_id, market_type, window_end);
ALTER TABLE borg_book_snaps ADD COLUMN IF NOT EXISTS rtds_chainlink NUMERIC;
ALTER TABLE borg_book_snaps ADD COLUMN IF NOT EXISTS rtds_divergence_bps REAL;
-- Event provenance (source clock and local monotonic clock are deliberately
-- separate so replay can model information latency without wall-clock jumps).
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS source_ts TIMESTAMPTZ;
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS receive_monotonic_ns NUMERIC(30,0);
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS connection_epoch INT;
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS connection_shard INT;
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS event_sequence BIGINT;
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS wal_event_id TEXT;
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS book_hash TEXT;
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS best_bid REAL;
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS bid_size REAL;
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS best_ask REAL;
ALTER TABLE borg_clob_events ADD COLUMN IF NOT EXISTS ask_size REAL;
ALTER TABLE borg_clob_touch ADD COLUMN IF NOT EXISTS connection_shard INT;
-- Canonical intent and evidence provenance. Existing rows remain readable but
-- are explicitly unregistered/ungraded until a new forward observation.
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS intent_id TEXT;
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS experiment_id TEXT;
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS manifest_hash TEXT;
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS decision_at TIMESTAMPTZ;
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ;
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS source_event_id TEXT;
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS strategy_version TEXT;
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS execution_model_version TEXT;
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS latency_profile TEXT;
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS trial_family TEXT;
ALTER TABLE borg_shadow_orders ADD COLUMN IF NOT EXISTS arm TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS borg_shadow_orders_intent
  ON borg_shadow_orders (intent_id) WHERE intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS borg_shadow_orders_experiment
  ON borg_shadow_orders (experiment_id, strategy, available_at);
ALTER TABLE borg_shadow_scores ADD COLUMN IF NOT EXISTS data_quality_grade TEXT;
ALTER TABLE borg_shadow_scores ADD COLUMN IF NOT EXISTS execution_fidelity_grade TEXT;
ALTER TABLE borg_shadow_scores ADD COLUMN IF NOT EXISTS fidelity_level TEXT;
ALTER TABLE borg_shadow_scores ADD COLUMN IF NOT EXISTS simulator_version TEXT;
ALTER TABLE borg_shadow_scores ADD COLUMN IF NOT EXISTS fee_model_version TEXT;
-- Multi-asset bars: PK (ts) -> (symbol, ts). Idempotent swap.
ALTER TABLE borg_binance_1s ADD COLUMN IF NOT EXISTS symbol TEXT NOT NULL DEFAULT 'BTCUSDT';
DO $mig$
BEGIN
  IF (SELECT count(*) FROM information_schema.key_column_usage
      WHERE constraint_name = 'borg_binance_1s_pkey' AND table_name = 'borg_binance_1s') = 1 THEN
    ALTER TABLE borg_binance_1s DROP CONSTRAINT borg_binance_1s_pkey;
    ALTER TABLE borg_binance_1s ADD PRIMARY KEY (symbol, ts);
  END IF;
END
$mig$;
-- Multi-asset registry (2026-07-12): one row per Polymarket updown-5m asset.
-- Seeded with the verified matrix (Gamma slugs probed live; Binance symbols
-- confirmed; Chainlink feeds verified on-chain via description()). HYPE has
-- no Binance listing (priced from Hyperliquid) and no ETH-mainnet CL feed;
-- DOGE/XRP CL feeds exist only on BNB Chain, so George skips them.
CREATE TABLE IF NOT EXISTS asset_config (
  asset TEXT PRIMARY KEY,
  slug_prefix TEXT NOT NULL,
  binance_symbol TEXT,
  price_source TEXT NOT NULL DEFAULT 'binance',
  hl_coin TEXT,
  chainlink_feed TEXT,
  enabled_main BOOLEAN DEFAULT true,
  enabled_george BOOLEAN DEFAULT true,
  enabled_borg BOOLEAN DEFAULT true
);
INSERT INTO asset_config (asset, slug_prefix, binance_symbol, price_source, hl_coin, chainlink_feed, enabled_main, enabled_george, enabled_borg) VALUES
  ('btc',  'btc-updown-5m',  'BTCUSDT',  'binance', NULL,  '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', true,  true,  true),
  ('eth',  'eth-updown-5m',  'ETHUSDT',  'binance', NULL,  '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', true,  true,  true),
  ('sol',  'sol-updown-5m',  'SOLUSDT',  'binance', NULL,  '0x4ffC43a60e009B551865A93d232E33Fce9f01507', true,  true,  true),
  ('bnb',  'bnb-updown-5m',  'BNBUSDT',  'binance', NULL,  '0x14e613AC84a31f709eadbdF89C6CC390fDc9540A', true,  true,  true),
  ('doge', 'doge-updown-5m', 'DOGEUSDT', 'binance', NULL,  NULL, true,  false, true),
  ('xrp',  'xrp-updown-5m',  'XRPUSDT',  'binance', NULL,  NULL, true,  false, true),
  ('hype', 'hype-updown-5m', NULL,       'hyperliquid', 'HYPE', NULL, false, false, true)
ON CONFLICT (asset) DO NOTHING;
`;

async function migrate() {
  await pool.query(SCHEMA);
}

// The legacy all-in-one migration also contains historical ALTER/DO blocks
// that need broad locks. Independent collectors must not reacquire those locks
// on every start, so Flow Lab applies only its additive, namespaced schema.
const FLOW_SCHEMA_START = '-- Public-flow scalp laboratory.';
const FLOW_SCHEMA_END = 'CREATE TABLE IF NOT EXISTS borg_events';
const FLOW_SCHEMA = SCHEMA.slice(SCHEMA.indexOf(FLOW_SCHEMA_START), SCHEMA.indexOf(FLOW_SCHEMA_END));

async function migrateFlow() {
  if (!FLOW_SCHEMA.includes('CREATE TABLE IF NOT EXISTS pm_flow_scores')) {
    throw new Error('Flow schema markers are invalid');
  }
  await pool.query(FLOW_SCHEMA);
}

const STRUCTURAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS borg_structural_rule_snapshots (
  rule_hash TEXT PRIMARY KEY,
  event_id TEXT,
  gamma_id TEXT,
  condition_id TEXT,
  rule_document JSONB NOT NULL,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS borg_structural_rule_snapshots_market
  ON borg_structural_rule_snapshots (event_id, gamma_id, condition_id);
CREATE TABLE IF NOT EXISTS borg_structural_candidates (
  candidate_id TEXT PRIMARY KEY,
  structure_type TEXT NOT NULL,
  event_id TEXT,
  event_slug TEXT,
  event_title TEXT,
  end_date TIMESTAMPTZ,
  complete BOOLEAN NOT NULL,
  atomic BOOLEAN NOT NULL DEFAULT false,
  guaranteed_min_payout NUMERIC NOT NULL,
  states JSONB NOT NULL,
  payoff_vector JSONB NOT NULL,
  payoff_proof JSONB,
  rule_certification_hash TEXT,
  rule_certified BOOLEAN NOT NULL DEFAULT false,
  legs JSONB NOT NULL,
  universe_id TEXT,
  universe_class TEXT,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  active BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS borg_structural_candidates_event
  ON borg_structural_candidates (event_id, structure_type, end_date);
ALTER TABLE borg_structural_candidates ADD COLUMN IF NOT EXISTS payoff_proof JSONB;
ALTER TABLE borg_structural_candidates ADD COLUMN IF NOT EXISTS rule_certification_hash TEXT;
ALTER TABLE borg_structural_candidates ADD COLUMN IF NOT EXISTS rule_certified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE borg_structural_candidates ADD COLUMN IF NOT EXISTS universe_id TEXT;
ALTER TABLE borg_structural_candidates ADD COLUMN IF NOT EXISTS universe_class TEXT;
CREATE INDEX IF NOT EXISTS borg_structural_candidates_universe
  ON borg_structural_candidates (universe_id, universe_class, structure_type, active);
CREATE TABLE IF NOT EXISTS borg_structural_evaluations (
  id BIGSERIAL PRIMARY KEY,
  dedup_key TEXT UNIQUE NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES borg_structural_candidates(candidate_id),
  trigger_token TEXT,
  trigger_source_ts TIMESTAMPTZ,
  trigger_received_at TIMESTAMPTZ,
  trigger_wal_event_id TEXT,
  latency_ms INT NOT NULL DEFAULT 0,
  reaction_us NUMERIC,
  structure_type TEXT NOT NULL,
  guaranteed_min_payout NUMERIC,
  cost_per_bundle NUMERIC,
  fees_2x_per_bundle NUMERIC,
  residual_2x_per_bundle NUMERIC,
  target_notional_usd NUMERIC,
  target_shares NUMERIC,
  displayed_bundle_shares NUMERIC,
  displayed_notional_usd NUMERIC,
  displayed_profit_2x_usd NUMERIC,
  pass_proof BOOLEAN NOT NULL DEFAULT false,
  payoff_proof_hash TEXT,
  pass_rule_certification BOOLEAN NOT NULL DEFAULT false,
  rule_certification_hash TEXT,
  pass_stale BOOLEAN NOT NULL,
  pass_quotes BOOLEAN NOT NULL,
  pass_fees_2x BOOLEAN NOT NULL,
  pass_fok BOOLEAN NOT NULL,
  pass_capacity BOOLEAN NOT NULL,
  pass_orphan_risk BOOLEAN NOT NULL,
  orphan_loss_stress_usd NUMERIC,
  economic_candidate BOOLEAN NOT NULL,
  qualified BOOLEAN NOT NULL,
  detail JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS borg_structural_evaluations_candidate_ts
  ON borg_structural_evaluations (candidate_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS borg_structural_evaluations_positive
  ON borg_structural_evaluations (evaluated_at DESC)
  WHERE economic_candidate OR qualified;
CREATE INDEX IF NOT EXISTS borg_structural_evaluations_evaluated_brin
  ON borg_structural_evaluations USING BRIN (evaluated_at);
CREATE UNIQUE INDEX IF NOT EXISTS borg_structural_evaluations_dedup_evaluated_uq
  ON borg_structural_evaluations (dedup_key, evaluated_at);
ALTER TABLE borg_structural_evaluations ADD COLUMN IF NOT EXISTS trigger_received_at TIMESTAMPTZ;
ALTER TABLE borg_structural_evaluations ADD COLUMN IF NOT EXISTS latency_ms INT NOT NULL DEFAULT 0;
ALTER TABLE borg_structural_evaluations ADD COLUMN IF NOT EXISTS reaction_us NUMERIC;
ALTER TABLE borg_structural_evaluations ADD COLUMN IF NOT EXISTS pass_proof BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE borg_structural_evaluations ADD COLUMN IF NOT EXISTS payoff_proof_hash TEXT;
ALTER TABLE borg_structural_evaluations ADD COLUMN IF NOT EXISTS pass_rule_certification BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE borg_structural_evaluations ADD COLUMN IF NOT EXISTS rule_certification_hash TEXT;
`;

async function migrateStructural() {
  await pool.query(STRUCTURAL_SCHEMA);
}

// Public Deribit option-surface capture and Polymarket binary-value marks.
// This namespace intentionally contains no credentials, account identifiers,
// order IDs, or live execution state. Full-rate raw frames live in the WAL;
// PostgreSQL is the compact one-second hot research tier.
const OPTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS borg_deribit_instruments (
  instrument_name TEXT PRIMARY KEY,
  currency TEXT NOT NULL,
  option_type TEXT NOT NULL,
  strike NUMERIC NOT NULL,
  expiration_at TIMESTAMPTZ NOT NULL,
  contract_size NUMERIC,
  tick_size NUMERIC,
  maker_commission NUMERIC,
  taker_commission NUMERIC,
  settlement_period TEXT,
  raw JSONB NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS borg_deribit_instruments_surface
  ON borg_deribit_instruments (currency, expiration_at, strike);

CREATE TABLE IF NOT EXISTS borg_deribit_option_touch (
  id BIGSERIAL PRIMARY KEY,
  sample_at TIMESTAMPTZ NOT NULL,
  source_ts TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL,
  receive_monotonic_ns NUMERIC(30,0),
  instrument_name TEXT NOT NULL,
  currency TEXT NOT NULL,
  option_type TEXT NOT NULL,
  strike NUMERIC NOT NULL,
  expiration_at TIMESTAMPTZ NOT NULL,
  best_bid_price NUMERIC,
  best_ask_price NUMERIC,
  mark_price NUMERIC,
  bid_iv NUMERIC,
  ask_iv NUMERIC,
  mark_iv NUMERIC,
  underlying_price NUMERIC,
  index_price NUMERIC,
  open_interest NUMERIC,
  delta NUMERIC,
  gamma NUMERIC,
  vega NUMERIC,
  theta NUMERIC,
  connection_epoch INT NOT NULL,
  event_sequence BIGINT NOT NULL,
  wal_event_id TEXT,
  UNIQUE (instrument_name, sample_at)
);
CREATE INDEX IF NOT EXISTS borg_deribit_option_touch_surface_time
  ON borg_deribit_option_touch (currency, expiration_at, strike, sample_at DESC);
CREATE INDEX IF NOT EXISTS borg_deribit_option_touch_sample_brin
  ON borg_deribit_option_touch USING BRIN (sample_at);

CREATE TABLE IF NOT EXISTS borg_option_shadow_marks (
  id BIGSERIAL PRIMARY KEY,
  dedup_key TEXT UNIQUE NOT NULL,
  experiment_id TEXT NOT NULL DEFAULT 'options-implied-binary-v1',
  observed_at TIMESTAMPTZ NOT NULL,
  market_id INT NOT NULL,
  condition_id TEXT,
  asset TEXT NOT NULL,
  strike NUMERIC NOT NULL,
  target_expiry_at TIMESTAMPTZ NOT NULL,
  trigger_source TEXT NOT NULL,
  side TEXT NOT NULL,
  poly_ask NUMERIC,
  poly_ask_size NUMERIC,
  model_fair NUMERIC,
  fair_lower NUMERIC,
  fair_upper NUMERIC,
  fee_rate NUMERIC,
  fee_per_share_2x NUMERIC,
  edge_lower_2x NUMERIC,
  target_shares NUMERIC,
  expected_profit_lower_usd NUMERIC,
  hedge_base NUMERIC,
  hedge_cost_stress_usd NUMERIC,
  net_edge_stress_usd NUMERIC,
  residual_cvar95_usd NUMERIC,
  surface_fidelity TEXT NOT NULL,
  data_quality_grade TEXT NOT NULL,
  executable BOOLEAN NOT NULL DEFAULT false,
  detail JSONB NOT NULL
);
ALTER TABLE borg_option_shadow_marks ADD COLUMN IF NOT EXISTS experiment_id TEXT
  NOT NULL DEFAULT 'options-implied-binary-v1';
CREATE INDEX IF NOT EXISTS borg_option_shadow_marks_market_time
  ON borg_option_shadow_marks (market_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS borg_option_shadow_marks_experiment_time
  ON borg_option_shadow_marks (experiment_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS borg_option_shadow_marks_positive
  ON borg_option_shadow_marks (observed_at DESC) WHERE executable;
CREATE UNIQUE INDEX IF NOT EXISTS borg_option_shadow_marks_dedup_observed_uq
  ON borg_option_shadow_marks (dedup_key, observed_at);

CREATE TABLE IF NOT EXISTS borg_options_runtime (
  run_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  host TEXT NOT NULL,
  pid INT NOT NULL,
  paper_only BOOLEAN NOT NULL DEFAULT true,
  wallet_loaded BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL,
  targets INT NOT NULL DEFAULT 0,
  subscribed_instruments INT NOT NULL DEFAULT 0,
  subscribed_poly_tokens INT NOT NULL DEFAULT 0,
  raw_frames BIGINT NOT NULL DEFAULT 0,
  ticker_events BIGINT NOT NULL DEFAULT 0,
  stored_touches BIGINT NOT NULL DEFAULT 0,
  shadow_marks BIGINT NOT NULL DEFAULT 0,
  persistence_queue INT NOT NULL DEFAULT 0,
  last_event_at TIMESTAMPTZ,
  last_mark_at TIMESTAMPTZ,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function migrateOptions() {
  await pool.query(OPTIONS_SCHEMA);
}

// Pyth resolver-source boundary transfer laboratory. Raw RTDS and CLOB frames
// live in append-before-parse WALs; these tables are the compact, paper-only
// evidence ledger. No account, signer, API-secret, or live-order state exists.
const PYTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS borg_pyth_rule_snapshots (
  rule_hash TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  event_id TEXT,
  gamma_id TEXT,
  condition_id TEXT,
  rule_document JSONB NOT NULL,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS borg_pyth_rule_market
  ON borg_pyth_rule_snapshots (condition_id, first_observed_at DESC);

CREATE TABLE IF NOT EXISTS borg_pyth_markets (
  condition_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  gamma_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  question TEXT,
  symbol TEXT NOT NULL,
  price_to_beat NUMERIC NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  up_token_id TEXT NOT NULL,
  down_token_id TEXT NOT NULL,
  minimum_order_size NUMERIC NOT NULL,
  fees_enabled BOOLEAN NOT NULL,
  fee_rate NUMERIC NOT NULL,
  fee_exponent NUMERIC NOT NULL,
  rule_hash TEXT NOT NULL REFERENCES borg_pyth_rule_snapshots(rule_hash),
  rule_certified BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  accepting_orders BOOLEAN NOT NULL DEFAULT true,
  terminal_outcome TEXT,
  terminal_observed_at TIMESTAMPTZ,
  raw JSONB NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS borg_pyth_markets_active
  ON borg_pyth_markets (experiment_id, active, window_end, symbol);

CREATE TABLE IF NOT EXISTS borg_pyth_ticks (
  id BIGSERIAL PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  source_ts TIMESTAMPTZ,
  provider_received_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL,
  receive_monotonic_ns NUMERIC(30,0),
  value NUMERIC NOT NULL,
  carried_forward BOOLEAN NOT NULL,
  historical BOOLEAN NOT NULL,
  connection_epoch INT,
  event_sequence BIGINT,
  wal_event_id TEXT,
  raw JSONB NOT NULL,
  UNIQUE (wal_event_id)
);
CREATE INDEX IF NOT EXISTS borg_pyth_ticks_symbol_time
  ON borg_pyth_ticks (symbol, received_at DESC);
CREATE INDEX IF NOT EXISTS borg_pyth_ticks_received_brin
  ON borg_pyth_ticks USING BRIN (received_at);

CREATE TABLE IF NOT EXISTS borg_pyth_signals (
  signal_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  condition_id TEXT NOT NULL REFERENCES borg_pyth_markets(condition_id),
  observed_at TIMESTAMPTZ NOT NULL,
  trigger_kind TEXT NOT NULL,
  checkpoint_sec INT,
  side TEXT,
  resolver_price NUMERIC,
  price_to_beat NUMERIC NOT NULL,
  distance_bps NUMERIC,
  tte_sec NUMERIC NOT NULL,
  prior_side TEXT,
  source_ts TIMESTAMPTZ,
  provider_received_at TIMESTAMPTZ,
  receive_monotonic_ns NUMERIC(30,0),
  connection_epoch INT,
  event_sequence BIGINT,
  wal_event_id TEXT,
  carried_forward BOOLEAN NOT NULL,
  historical BOOLEAN NOT NULL,
  valid BOOLEAN NOT NULL,
  invalid_reason TEXT,
  rule_hash TEXT NOT NULL,
  detail JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS borg_pyth_signals_market_time
  ON borg_pyth_signals (condition_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS borg_pyth_arrivals (
  arrival_id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL REFERENCES borg_pyth_signals(signal_id),
  experiment_id TEXT NOT NULL,
  latency_ms INT NOT NULL,
  intended_arrival_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  token_id TEXT,
  side TEXT,
  book_received_at TIMESTAMPTZ,
  book_age_ms NUMERIC,
  executable BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  shares NUMERIC,
  entry_vwap NUMERIC,
  entry_gross NUMERIC,
  entry_fee NUMERIC,
  entry_total NUMERIC,
  displayed_ask_shares NUMERIC,
  data_quality_grade TEXT NOT NULL,
  execution_fidelity_grade TEXT NOT NULL,
  detail JSONB NOT NULL,
  UNIQUE (signal_id, latency_ms)
);
CREATE INDEX IF NOT EXISTS borg_pyth_arrivals_time
  ON borg_pyth_arrivals (observed_at DESC, latency_ms, executable);

CREATE TABLE IF NOT EXISTS borg_pyth_markouts (
  markout_id TEXT PRIMARY KEY,
  arrival_id TEXT NOT NULL REFERENCES borg_pyth_arrivals(arrival_id),
  experiment_id TEXT NOT NULL,
  horizon_sec INT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  book_received_at TIMESTAMPTZ,
  book_age_ms NUMERIC,
  scored BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  exit_vwap NUMERIC,
  exit_gross NUMERIC,
  exit_fee NUMERIC,
  net_proceeds NUMERIC,
  pnl NUMERIC,
  data_quality_grade TEXT NOT NULL,
  execution_fidelity_grade TEXT NOT NULL,
  detail JSONB NOT NULL,
  UNIQUE (arrival_id, horizon_sec)
);
CREATE INDEX IF NOT EXISTS borg_pyth_markouts_horizon_time
  ON borg_pyth_markouts (horizon_sec, observed_at DESC, scored);

CREATE TABLE IF NOT EXISTS borg_pyth_terminal_scores (
  score_id TEXT PRIMARY KEY,
  arrival_id TEXT UNIQUE NOT NULL REFERENCES borg_pyth_arrivals(arrival_id),
  experiment_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL,
  terminal_outcome TEXT NOT NULL,
  won BOOLEAN NOT NULL,
  gross_payout NUMERIC NOT NULL,
  pnl NUMERIC NOT NULL,
  detail JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS borg_pyth_runtime (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  host TEXT NOT NULL,
  pid INT NOT NULL,
  paper_only BOOLEAN NOT NULL DEFAULT true,
  wallet_loaded BOOLEAN NOT NULL DEFAULT false,
  live_order_path BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL,
  markets INT NOT NULL DEFAULT 0,
  symbols INT NOT NULL DEFAULT 0,
  subscribed_tokens INT NOT NULL DEFAULT 0,
  raw_frames BIGINT NOT NULL DEFAULT 0,
  ticks BIGINT NOT NULL DEFAULT 0,
  signals BIGINT NOT NULL DEFAULT 0,
  arrivals BIGINT NOT NULL DEFAULT 0,
  markouts BIGINT NOT NULL DEFAULT 0,
  terminal_scores BIGINT NOT NULL DEFAULT 0,
  persistence_queue INT NOT NULL DEFAULT 0,
  last_tick_at TIMESTAMPTZ,
  last_signal_at TIMESTAMPTZ,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function migratePyth() {
  await pool.query(PYTH_SCHEMA);
}

// All-market pre-trade L2 and passive-maker laboratory. This schema is
// deliberately namespaced and additive so the service can migrate without
// reacquiring the legacy collector's broad ALTER locks. There are no wallet,
// signer, API-secret, or exchange-order identifiers in these tables.
const ALLMARKET_SCHEMA = `
CREATE TABLE IF NOT EXISTS am_markets (
  condition_id TEXT PRIMARY KEY,
  gamma_id TEXT,
  event_id TEXT,
  event_slug TEXT,
  slug TEXT,
  question TEXT,
  category TEXT NOT NULL,
  end_date TIMESTAMPTZ,
  outcomes JSONB NOT NULL,
  token_ids JSONB NOT NULL,
  tick_size NUMERIC NOT NULL,
  order_min_size NUMERIC NOT NULL,
  liquidity NUMERIC,
  volume_24h NUMERIC,
  fees_enabled BOOLEAN NOT NULL DEFAULT false,
  fee_rate NUMERIC NOT NULL DEFAULT 0,
  fee_exponent NUMERIC NOT NULL DEFAULT 1,
  fee_taker_only BOOLEAN NOT NULL DEFAULT true,
  rebate_rate NUMERIC NOT NULL DEFAULT 0,
  rewards_daily_rate NUMERIC NOT NULL DEFAULT 0,
  rewards_min_size NUMERIC NOT NULL DEFAULT 0,
  rewards_max_spread NUMERIC NOT NULL DEFAULT 0,
  toxicity_5s_per_share NUMERIC NOT NULL DEFAULT 0,
  selection_score NUMERIC,
  selection_reason TEXT,
  selected_realtime BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  accepting_orders BOOLEAN NOT NULL DEFAULT true,
  raw JSONB,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS am_markets_selected_score
  ON am_markets (selected_realtime, selection_score DESC);
ALTER TABLE am_markets ADD COLUMN IF NOT EXISTS fee_exponent NUMERIC NOT NULL DEFAULT 1;
ALTER TABLE am_markets ADD COLUMN IF NOT EXISTS fee_taker_only BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS am_panel_memberships (
  collection_epoch_id TEXT NOT NULL,
  panel_version TEXT NOT NULL,
  panel_hash TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  panel_rank INT NOT NULL,
  selection_reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_epoch_id, panel_version, condition_id)
);
CREATE INDEX IF NOT EXISTS am_panel_memberships_epoch_rank
  ON am_panel_memberships (collection_epoch_id, panel_version, panel_rank);

CREATE TABLE IF NOT EXISTS am_book_touches (
  id BIGSERIAL PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL,
  source_ts TIMESTAMPTZ,
  condition_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  outcome TEXT,
  best_bid NUMERIC,
  bid_size NUMERIC,
  best_ask NUMERIC,
  ask_size NUMERIC,
  midpoint NUMERIC,
  microprice NUMERIC,
  imbalance NUMERIC,
  spread NUMERIC,
  state_age_ms NUMERIC,
  reaction_us NUMERIC,
  data_quality_grade TEXT NOT NULL,
  event_type TEXT NOT NULL,
  connection_epoch INT,
  connection_shard INT,
  event_sequence BIGINT,
  wal_event_id TEXT,
  book_hash TEXT
);
CREATE INDEX IF NOT EXISTS am_book_touches_asset_time
  ON am_book_touches (asset_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS am_book_touches_market_time
  ON am_book_touches (condition_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS am_book_touches_observed_brin
  ON am_book_touches USING BRIN (observed_at);
-- The BRIN index is compact for replay scans, but a heavily recycled hot tier
-- can leave sparse old pages that make bounded deletes recheck gigabytes of
-- heap. This btree gives retention a causal, index-only starting point.
CREATE INDEX IF NOT EXISTS am_book_touches_observed_id
  ON am_book_touches (observed_at, id);

CREATE TABLE IF NOT EXISTS am_order_intents (
  intent_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  arm TEXT NOT NULL,
  action TEXT NOT NULL,
  parent_intent_id TEXT,
  decision_at TIMESTAMPTZ NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  condition_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  outcome TEXT,
  side TEXT NOT NULL,
  order_kind TEXT NOT NULL,
  post_only BOOLEAN NOT NULL,
  price NUMERIC,
  size NUMERIC,
  latency_ms INT NOT NULL,
  queue_ahead NUMERIC,
  source_event_id TEXT,
  reaction_us NUMERIC,
  data_quality_grade TEXT NOT NULL,
  status TEXT NOT NULL,
  features JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS am_order_intents_strategy_time
  ON am_order_intents (strategy, decision_at DESC);
CREATE INDEX IF NOT EXISTS am_order_intents_market_time
  ON am_order_intents (condition_id, decision_at DESC);

CREATE TABLE IF NOT EXISTS am_execution_scores (
  intent_id TEXT PRIMARY KEY REFERENCES am_order_intents(intent_id),
  filled BOOLEAN NOT NULL,
  fill_at TIMESTAMPTZ,
  fill_price NUMERIC,
  fill_size NUMERIC,
  fill_reason TEXT,
  queue_ahead_initial NUMERIC,
  printed_volume NUMERIC,
  mark_1s NUMERIC,
  mark_5s NUMERIC,
  mark_30s NUMERIC,
  pnl_1s NUMERIC,
  pnl_5s NUMERIC,
  pnl_30s NUMERIC,
  rebate_estimate NUMERIC,
  reward_estimate NUMERIC,
  data_quality_grade TEXT NOT NULL,
  execution_fidelity_grade TEXT NOT NULL,
  fidelity_level TEXT NOT NULL,
  simulator_version TEXT NOT NULL,
  fee_model_version TEXT NOT NULL,
  detail JSONB NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS am_execution_scores_filled_time
  ON am_execution_scores (filled, scored_at DESC);

CREATE TABLE IF NOT EXISTS am_inventory (
  run_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  outcome TEXT,
  shares NUMERIC NOT NULL,
  cost NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  detail JSONB NOT NULL,
  PRIMARY KEY (run_id, condition_id, asset_id)
);

CREATE TABLE IF NOT EXISTS am_runtime (
  run_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  host TEXT NOT NULL,
  pid INT NOT NULL,
  paper_only BOOLEAN NOT NULL DEFAULT true,
  wallet_loaded BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL,
  selected_markets INT NOT NULL DEFAULT 0,
  subscribed_tokens INT NOT NULL DEFAULT 0,
  events BIGINT NOT NULL DEFAULT 0,
  discarded_stale BIGINT NOT NULL DEFAULT 0,
  discarded_sequence BIGINT NOT NULL DEFAULT 0,
  decisions BIGINT NOT NULL DEFAULT 0,
  fills BIGINT NOT NULL DEFAULT 0,
  persistence_queue INT NOT NULL DEFAULT 0,
  last_event_at TIMESTAMPTZ,
  last_decision_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb
);
`;

async function migrateAllMarket() {
  await pool.query(ALLMARKET_SCHEMA);
}

// Complementary-outcome paired-maker laboratory. This is a paper-only,
// condition-level accounting namespace: completed sets and residual orphan
// inventory are persisted separately so a spread-capture mark cannot conceal
// a directional binary loss.
const PAIRED_MAKER_SCHEMA = `
CREATE TABLE IF NOT EXISTS pmm_markets (
  condition_id TEXT PRIMARY KEY,
  gamma_id TEXT,
  event_id TEXT,
  event_slug TEXT,
  slug TEXT,
  question TEXT,
  category TEXT NOT NULL,
  end_date TIMESTAMPTZ,
  outcomes JSONB NOT NULL,
  token_ids JSONB NOT NULL,
  tick_size NUMERIC NOT NULL,
  order_min_size NUMERIC NOT NULL,
  liquidity NUMERIC,
  volume_24h NUMERIC,
  fee_rate NUMERIC NOT NULL DEFAULT 0,
  fee_exponent NUMERIC NOT NULL DEFAULT 1,
  fee_taker_only BOOLEAN NOT NULL DEFAULT true,
  rewards_daily_rate NUMERIC NOT NULL DEFAULT 0,
  rewards_min_size NUMERIC NOT NULL DEFAULT 0,
  rewards_max_spread NUMERIC NOT NULL DEFAULT 0,
  rewards_start_at TIMESTAMPTZ,
  rewards_end_at TIMESTAMPTZ,
  game_start_at TIMESTAMPTZ,
  selected_realtime BOOLEAN NOT NULL DEFAULT false,
  selection_score NUMERIC,
  selection_reason TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pmm_markets ADD COLUMN IF NOT EXISTS rewards_min_size NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pmm_markets ADD COLUMN IF NOT EXISTS rewards_max_spread NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pmm_markets ADD COLUMN IF NOT EXISTS rewards_start_at TIMESTAMPTZ;
ALTER TABLE pmm_markets ADD COLUMN IF NOT EXISTS rewards_end_at TIMESTAMPTZ;
ALTER TABLE pmm_markets ADD COLUMN IF NOT EXISTS game_start_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS pmm_markets_selected
  ON pmm_markets (selected_realtime, selection_score DESC);

CREATE TABLE IF NOT EXISTS pmm_pair_observations (
  id BIGSERIAL PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL,
  source_ts TIMESTAMPTZ,
  condition_id TEXT NOT NULL,
  best_bid_sum NUMERIC,
  best_ask_sum NUMERIC,
  midpoint_sum NUMERIC,
  gross_pair_edge NUMERIC,
  book_skew_ms NUMERIC,
  max_state_age_ms NUMERIC,
  one_cent_eligible BOOLEAN NOT NULL,
  two_cent_eligible BOOLEAN NOT NULL,
  data_quality_grade TEXT NOT NULL,
  source_event_id TEXT,
  reaction_us NUMERIC,
  detail JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS pmm_pair_observations_market_time
  ON pmm_pair_observations (condition_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS pmm_pair_observations_time_brin
  ON pmm_pair_observations USING BRIN (observed_at);

CREATE TABLE IF NOT EXISTS pmm_cycles (
  cycle_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  arm TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  first_fill_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  target_shares NUMERIC NOT NULL,
  min_pair_edge NUMERIC NOT NULL,
  initial_pair_cost NUMERIC NOT NULL,
  leg0_asset_id TEXT NOT NULL,
  leg0_outcome TEXT,
  leg0_quote_price NUMERIC NOT NULL,
  leg0_filled_shares NUMERIC NOT NULL DEFAULT 0,
  leg0_residual_shares NUMERIC NOT NULL DEFAULT 0,
  leg0_residual_cost NUMERIC NOT NULL DEFAULT 0,
  leg1_asset_id TEXT NOT NULL,
  leg1_outcome TEXT,
  leg1_quote_price NUMERIC NOT NULL,
  leg1_filled_shares NUMERIC NOT NULL DEFAULT 0,
  leg1_residual_shares NUMERIC NOT NULL DEFAULT 0,
  leg1_residual_cost NUMERIC NOT NULL DEFAULT 0,
  merged_shares NUMERIC NOT NULL DEFAULT 0,
  locked_pnl NUMERIC NOT NULL DEFAULT 0,
  orphan_exit_price NUMERIC,
  orphan_exit_proceeds NUMERIC NOT NULL DEFAULT 0,
  orphan_exit_fees NUMERIC NOT NULL DEFAULT 0,
  orphan_pnl NUMERIC NOT NULL DEFAULT 0,
  total_pnl NUMERIC,
  reward_daily_rate NUMERIC NOT NULL DEFAULT 0,
  reward_min_size NUMERIC NOT NULL DEFAULT 0,
  reward_max_spread NUMERIC NOT NULL DEFAULT 0,
  reward_qualified_ms NUMERIC NOT NULL DEFAULT 0,
  reward_own_score_seconds NUMERIC NOT NULL DEFAULT 0,
  reward_competitor_upper_score_seconds NUMERIC NOT NULL DEFAULT 0,
  modeled_reward_accrual NUMERIC NOT NULL DEFAULT 0,
  modeled_reward_adjusted_pnl NUMERIC,
  data_quality_grade TEXT NOT NULL,
  execution_fidelity_grade TEXT NOT NULL,
  detail JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pmm_cycles ADD COLUMN IF NOT EXISTS reward_daily_rate NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pmm_cycles ADD COLUMN IF NOT EXISTS reward_min_size NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pmm_cycles ADD COLUMN IF NOT EXISTS reward_max_spread NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pmm_cycles ADD COLUMN IF NOT EXISTS reward_qualified_ms NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pmm_cycles ADD COLUMN IF NOT EXISTS reward_own_score_seconds NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pmm_cycles ADD COLUMN IF NOT EXISTS reward_competitor_upper_score_seconds NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pmm_cycles ADD COLUMN IF NOT EXISTS modeled_reward_accrual NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pmm_cycles ADD COLUMN IF NOT EXISTS modeled_reward_adjusted_pnl NUMERIC;
CREATE INDEX IF NOT EXISTS pmm_cycles_arm_time
  ON pmm_cycles (strategy, arm, opened_at DESC);
CREATE INDEX IF NOT EXISTS pmm_cycles_market_time
  ON pmm_cycles (condition_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS pmm_cycles_open
  ON pmm_cycles (opened_at DESC) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS pmm_events (
  event_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  asset_id TEXT,
  outcome TEXT,
  price NUMERIC,
  size NUMERIC,
  source_event_id TEXT,
  status TEXT,
  detail JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS pmm_events_cycle_time
  ON pmm_events (cycle_id, observed_at);
CREATE INDEX IF NOT EXISTS pmm_events_type_time
  ON pmm_events (event_type, observed_at DESC);

CREATE TABLE IF NOT EXISTS pmm_runtime (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  host TEXT NOT NULL,
  pid INT NOT NULL,
  paper_only BOOLEAN NOT NULL DEFAULT true,
  wallet_loaded BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL,
  selected_markets INT NOT NULL DEFAULT 0,
  subscribed_tokens INT NOT NULL DEFAULT 0,
  open_cycles INT NOT NULL DEFAULT 0,
  events BIGINT NOT NULL DEFAULT 0,
  pair_observations BIGINT NOT NULL DEFAULT 0,
  eligible_one_cent BIGINT NOT NULL DEFAULT 0,
  eligible_two_cent BIGINT NOT NULL DEFAULT 0,
  maker_fills BIGINT NOT NULL DEFAULT 0,
  completed_cycles BIGINT NOT NULL DEFAULT 0,
  orphan_exits BIGINT NOT NULL DEFAULT 0,
  persistence_queue INT NOT NULL DEFAULT 0,
  last_event_at TIMESTAMPTZ,
  last_cycle_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb
);
`;

async function migratePairedMaker() {
  await pool.query(PAIRED_MAKER_SCHEMA);
}

// Polymarket/Kalshi contract-identity and executable cross-venue research.
// PAPER ONLY: no exchange credentials or live order identifiers are stored.
const CROSSVENUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cv_rule_snapshots (
  rule_hash TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  rule_document JSONB NOT NULL,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cv_rule_snapshots_contract
  ON cv_rule_snapshots (venue, contract_id);
CREATE TABLE IF NOT EXISTS cv_contract_matches (
  match_id TEXT PRIMARY KEY,
  poly_condition_id TEXT NOT NULL,
  poly_gamma_id TEXT,
  poly_question TEXT,
  poly_yes_token TEXT NOT NULL,
  poly_no_token TEXT NOT NULL,
  kalshi_ticker TEXT NOT NULL,
  kalshi_event_ticker TEXT,
  kalshi_title TEXT,
  match_score NUMERIC NOT NULL,
  title_similarity NUMERIC NOT NULL,
  identity_status TEXT NOT NULL,
  identity_approved BOOLEAN NOT NULL DEFAULT false,
  identity_snapshot_hash TEXT,
  identity_certification JSONB,
  relation_type TEXT NOT NULL DEFAULT 'UNREVIEWED',
  relation_approved BOOLEAN NOT NULL DEFAULT false,
  relation_status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  relation_proof JSONB,
  relation_resolution_audit JSONB,
  state_evidence JSONB,
  paper_eval_approved BOOLEAN NOT NULL DEFAULT false,
  paper_eval_status TEXT NOT NULL DEFAULT 'NOT_APPROVED',
  paper_eval_source TEXT,
  paper_eval_approved_at TIMESTAMPTZ,
  paper_eval_score_at_approval NUMERIC,
  paper_eval_threshold NUMERIC,
  approval_source TEXT,
  resolution_audit JSONB,
  mismatch_reasons JSONB NOT NULL,
  end_delta_hours NUMERIC,
  monitored BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS relation_type TEXT NOT NULL DEFAULT 'UNREVIEWED';
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS identity_snapshot_hash TEXT;
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS identity_certification JSONB;
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS relation_approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS relation_status TEXT NOT NULL DEFAULT 'PENDING_REVIEW';
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS relation_proof JSONB;
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS relation_resolution_audit JSONB;
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS state_evidence JSONB;
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS paper_eval_approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS paper_eval_status TEXT NOT NULL DEFAULT 'NOT_APPROVED';
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS paper_eval_source TEXT;
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS paper_eval_approved_at TIMESTAMPTZ;
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS paper_eval_score_at_approval NUMERIC;
ALTER TABLE cv_contract_matches ADD COLUMN IF NOT EXISTS paper_eval_threshold NUMERIC;
CREATE INDEX IF NOT EXISTS cv_contract_matches_rank
  ON cv_contract_matches (identity_approved DESC, match_score DESC, refreshed_at DESC);
CREATE INDEX IF NOT EXISTS cv_contract_matches_relation_rank
  ON cv_contract_matches (relation_approved DESC, identity_approved DESC, match_score DESC, refreshed_at DESC);
CREATE INDEX IF NOT EXISTS cv_contract_matches_poly
  ON cv_contract_matches (poly_condition_id);
CREATE INDEX IF NOT EXISTS cv_contract_matches_kalshi
  ON cv_contract_matches (kalshi_ticker);

CREATE TABLE IF NOT EXISTS cv_maker_episodes (
  episode_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  poly_quote NUMERIC NOT NULL,
  kalshi_quote NUMERIC NOT NULL,
  poly_filled_at TIMESTAMPTZ,
  kalshi_filled_at TIMESTAMPTZ,
  requotes INTEGER NOT NULL DEFAULT 0,
  observations INTEGER NOT NULL DEFAULT 0,
  stale_observations INTEGER NOT NULL DEFAULT 0,
  locked_margin NUMERIC,
  orphan_leg TEXT,
  orphan_unwind_pnl NUMERIC,
  fees NUMERIC NOT NULL DEFAULT 0,
  experiment_id TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS cv_maker_episodes_match
  ON cv_maker_episodes (match_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS cv_maker_episodes_status
  ON cv_maker_episodes (status, ended_at DESC);

CREATE TABLE IF NOT EXISTS cv_settlements (
  match_id TEXT PRIMARY KEY,
  kalshi_ticker TEXT NOT NULL,
  poly_condition_id TEXT NOT NULL,
  poly_gamma_id TEXT,
  kalshi_result TEXT,
  kalshi_settled_at TIMESTAMPTZ,
  poly_outcome TEXT,
  poly_resolved_at TIMESTAMPTZ,
  first_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checks INTEGER NOT NULL DEFAULT 0,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS cv_settlements_pending
  ON cv_settlements (last_checked_at) WHERE kalshi_result IS NULL OR poly_outcome IS NULL;

CREATE TABLE IF NOT EXISTS cv_book_snapshots (
  id BIGSERIAL PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL,
  match_id TEXT NOT NULL,
  trigger_venue TEXT NOT NULL,
  poly_book_at TIMESTAMPTZ,
  kalshi_book_at TIMESTAMPTZ,
  poly_age_ms NUMERIC,
  kalshi_age_ms NUMERIC,
  pair_skew_ms NUMERIC,
  poly_yes_bid NUMERIC,
  poly_yes_bid_size NUMERIC,
  poly_yes_ask NUMERIC,
  poly_yes_ask_size NUMERIC,
  poly_no_bid NUMERIC,
  poly_no_bid_size NUMERIC,
  poly_no_ask NUMERIC,
  poly_no_ask_size NUMERIC,
  kalshi_yes_bid NUMERIC,
  kalshi_yes_bid_size NUMERIC,
  kalshi_yes_ask NUMERIC,
  kalshi_yes_ask_size NUMERIC,
  kalshi_no_bid NUMERIC,
  kalshi_no_bid_size NUMERIC,
  kalshi_no_ask NUMERIC,
  kalshi_no_ask_size NUMERIC,
  data_quality_grade TEXT NOT NULL,
  execution_fidelity_grade TEXT NOT NULL,
  book_signature TEXT NOT NULL,
  experiment_id TEXT NOT NULL DEFAULT 'crossvenue-identity-v2',
  synchronized BOOLEAN NOT NULL DEFAULT false,
  causal_cut_at TIMESTAMPTZ,
  detail JSONB NOT NULL
);
ALTER TABLE cv_book_snapshots ADD COLUMN IF NOT EXISTS experiment_id TEXT NOT NULL DEFAULT 'crossvenue-identity-v2';
ALTER TABLE cv_book_snapshots ADD COLUMN IF NOT EXISTS synchronized BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_book_snapshots ADD COLUMN IF NOT EXISTS causal_cut_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS cv_book_snapshots_match_time
  ON cv_book_snapshots (match_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS cv_book_snapshots_observed_id
  ON cv_book_snapshots (observed_at, id);

CREATE TABLE IF NOT EXISTS cv_opportunities (
  opportunity_id TEXT PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL,
  match_id TEXT NOT NULL,
  episode_id TEXT,
  direction TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  poly_outcome TEXT NOT NULL,
  kalshi_outcome TEXT NOT NULL,
  poly_vwap NUMERIC NOT NULL,
  kalshi_vwap NUMERIC NOT NULL,
  poly_fee NUMERIC NOT NULL,
  kalshi_fee NUMERIC NOT NULL,
  total_cost NUMERIC NOT NULL,
  locked_profit_after_both_fills NUMERIC NOT NULL,
  stressed_profit NUMERIC NOT NULL,
  indicative_economic BOOLEAN NOT NULL DEFAULT false,
  economic BOOLEAN NOT NULL,
  paper_eval_approved BOOLEAN NOT NULL DEFAULT false,
  paper_trade_eligible BOOLEAN NOT NULL DEFAULT false,
  identity_approved BOOLEAN NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'UNREVIEWED',
  relation_approved BOOLEAN NOT NULL DEFAULT false,
  guaranteed_min_payout_per_share NUMERIC,
  payoff_proof_hash TEXT,
  books_fresh BOOLEAN NOT NULL,
  full_depth BOOLEAN NOT NULL,
  atomic BOOLEAN NOT NULL DEFAULT false,
  lockable_after_both_fills BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  data_quality_grade TEXT NOT NULL,
  execution_fidelity_grade TEXT NOT NULL,
  experiment_id TEXT NOT NULL DEFAULT 'crossvenue-identity-v2',
  synchronized BOOLEAN NOT NULL DEFAULT false,
  detail JSONB NOT NULL
);
ALTER TABLE cv_opportunities ADD COLUMN IF NOT EXISTS experiment_id TEXT NOT NULL DEFAULT 'crossvenue-identity-v2';
ALTER TABLE cv_opportunities ADD COLUMN IF NOT EXISTS synchronized BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS cv_opportunities_match_time
  ON cv_opportunities (match_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS cv_opportunities_observed_id
  ON cv_opportunities (observed_at, opportunity_id);
CREATE INDEX IF NOT EXISTS cv_opportunities_economic_time
  ON cv_opportunities (observed_at DESC) WHERE economic;
CREATE UNIQUE INDEX IF NOT EXISTS cv_opportunities_id_observed_uq
  ON cv_opportunities (opportunity_id, observed_at);
ALTER TABLE cv_opportunities ADD COLUMN IF NOT EXISTS indicative_economic BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_opportunities ADD COLUMN IF NOT EXISTS paper_eval_approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_opportunities ADD COLUMN IF NOT EXISTS paper_trade_eligible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_opportunities ADD COLUMN IF NOT EXISTS relation_type TEXT NOT NULL DEFAULT 'UNREVIEWED';
ALTER TABLE cv_opportunities ADD COLUMN IF NOT EXISTS relation_approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_opportunities ADD COLUMN IF NOT EXISTS guaranteed_min_payout_per_share NUMERIC;
ALTER TABLE cv_opportunities ADD COLUMN IF NOT EXISTS payoff_proof_hash TEXT;

-- Prospective relation-event ledger. This is the independent-sample table:
-- many synchronized quote observations update one row per approved relation,
-- state activation and safe bundle direction. Disappearances and orphan-loss
-- stress remain visible instead of retaining only the best quote.
CREATE TABLE IF NOT EXISTS cv_relation_episodes (
  episode_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL DEFAULT 'crossvenue-identity-v2',
  match_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  payoff_proof_hash TEXT,
  state_active_from TIMESTAMPTZ,
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  first_economic_at TIMESTAMPTZ,
  last_economic_at TIMESTAMPTZ,
  disappeared_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  lifecycle_status TEXT NOT NULL,
  observations BIGINT NOT NULL DEFAULT 0,
  economic_observations BIGINT NOT NULL DEFAULT 0,
  disappearances INT NOT NULL DEFAULT 0,
  reappearances INT NOT NULL DEFAULT 0,
  max_quantity NUMERIC,
  max_total_cost NUMERIC,
  max_raw_profit NUMERIC,
  max_stressed_profit NUMERIC,
  worst_orphan_unwind_pnl NUMERIC,
  orphan_stress_loss_observations BIGINT NOT NULL DEFAULT 0,
  orphan_unwind_unavailable_observations BIGINT NOT NULL DEFAULT 0,
  first_opportunity_id TEXT,
  last_opportunity_id TEXT,
  last_data_quality_grade TEXT,
  last_execution_fidelity_grade TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (match_id, relation_id, direction, state_active_from)
);
ALTER TABLE cv_relation_episodes ADD COLUMN IF NOT EXISTS experiment_id TEXT NOT NULL DEFAULT 'crossvenue-identity-v2';
-- The original natural key omitted experiment_id. A frozen successor trial
-- therefore generated a different deterministic episode_id but collided with
-- the historical trial's row. Keep cohorts isolated and make NULL active
-- states deterministic as well; episode_id remains the upsert target.
ALTER TABLE cv_relation_episodes
  DROP CONSTRAINT IF EXISTS cv_relation_episodes_match_id_relation_id_direction_state_a_key;
CREATE UNIQUE INDEX IF NOT EXISTS cv_relation_episodes_experiment_relation_state
  ON cv_relation_episodes (
    experiment_id,match_id,relation_id,direction,
    COALESCE(state_active_from,'-infinity'::timestamptz)
  );
CREATE INDEX IF NOT EXISTS cv_relation_episodes_status_time
  ON cv_relation_episodes (lifecycle_status, last_observed_at DESC);
CREATE INDEX IF NOT EXISTS cv_relation_episodes_relation
  ON cv_relation_episodes (relation_id, first_observed_at);

-- Fixed-size executable basis marks for measuring time to early capital
-- release. Entry uses asks; liquidation uses bids; both venue fees are charged
-- on both sides of the round trip. These are observations, never live orders.
CREATE TABLE IF NOT EXISTS cv_basis_samples (
  sample_id TEXT PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL,
  match_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  poly_outcome TEXT NOT NULL,
  kalshi_outcome TEXT NOT NULL,
  poly_entry_vwap NUMERIC NOT NULL,
  kalshi_entry_vwap NUMERIC NOT NULL,
  poly_exit_vwap NUMERIC,
  kalshi_exit_vwap NUMERIC,
  poly_entry_fee NUMERIC NOT NULL,
  kalshi_entry_fee NUMERIC NOT NULL,
  poly_exit_fee NUMERIC,
  kalshi_exit_fee NUMERIC,
  entry_total_cost NUMERIC NOT NULL,
  gross_liquidation_proceeds NUMERIC,
  net_liquidation_proceeds NUMERIC,
  terminal_locked_profit NUMERIC NOT NULL,
  immediate_round_trip_pnl NUMERIC,
  indicative_entry_economic BOOLEAN NOT NULL DEFAULT false,
  entry_economic BOOLEAN NOT NULL,
  paper_eval_approved BOOLEAN NOT NULL DEFAULT false,
  paper_entry_eligible BOOLEAN NOT NULL DEFAULT false,
  identity_approved BOOLEAN NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'UNREVIEWED',
  relation_approved BOOLEAN NOT NULL DEFAULT false,
  guaranteed_min_payout_per_share NUMERIC,
  payoff_proof_hash TEXT,
  books_fresh BOOLEAN NOT NULL,
  full_entry_depth BOOLEAN NOT NULL,
  full_exit_depth BOOLEAN NOT NULL,
  data_quality_grade TEXT NOT NULL,
  execution_fidelity_grade TEXT NOT NULL,
  book_signature TEXT NOT NULL,
  experiment_id TEXT NOT NULL DEFAULT 'crossvenue-identity-v2',
  synchronized BOOLEAN NOT NULL DEFAULT false,
  detail JSONB NOT NULL
);
ALTER TABLE cv_basis_samples ADD COLUMN IF NOT EXISTS experiment_id TEXT NOT NULL DEFAULT 'crossvenue-identity-v2';
ALTER TABLE cv_basis_samples ADD COLUMN IF NOT EXISTS synchronized BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS cv_basis_samples_pair_time
  ON cv_basis_samples (match_id, direction, quantity, observed_at);
CREATE INDEX IF NOT EXISTS cv_basis_samples_observed_id
  ON cv_basis_samples (observed_at, sample_id);
CREATE INDEX IF NOT EXISTS cv_basis_samples_entry_time
  ON cv_basis_samples (observed_at DESC) WHERE entry_economic;
CREATE UNIQUE INDEX IF NOT EXISTS cv_basis_samples_id_observed_uq
  ON cv_basis_samples (sample_id, observed_at);
ALTER TABLE cv_basis_samples ALTER COLUMN poly_exit_vwap DROP NOT NULL;
ALTER TABLE cv_basis_samples ALTER COLUMN kalshi_exit_vwap DROP NOT NULL;
ALTER TABLE cv_basis_samples ALTER COLUMN poly_exit_fee DROP NOT NULL;
ALTER TABLE cv_basis_samples ALTER COLUMN kalshi_exit_fee DROP NOT NULL;
ALTER TABLE cv_basis_samples ALTER COLUMN gross_liquidation_proceeds DROP NOT NULL;
ALTER TABLE cv_basis_samples ALTER COLUMN net_liquidation_proceeds DROP NOT NULL;
ALTER TABLE cv_basis_samples ALTER COLUMN immediate_round_trip_pnl DROP NOT NULL;
ALTER TABLE cv_basis_samples ADD COLUMN IF NOT EXISTS indicative_entry_economic BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_basis_samples ADD COLUMN IF NOT EXISTS paper_eval_approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_basis_samples ADD COLUMN IF NOT EXISTS paper_entry_eligible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_basis_samples ADD COLUMN IF NOT EXISTS relation_type TEXT NOT NULL DEFAULT 'UNREVIEWED';
ALTER TABLE cv_basis_samples ADD COLUMN IF NOT EXISTS relation_approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cv_basis_samples ADD COLUMN IF NOT EXISTS guaranteed_min_payout_per_share NUMERIC;
ALTER TABLE cv_basis_samples ADD COLUMN IF NOT EXISTS payoff_proof_hash TEXT;

CREATE TABLE IF NOT EXISTS cv_runtime (
  run_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  host TEXT NOT NULL,
  pid INT NOT NULL,
  paper_only BOOLEAN NOT NULL DEFAULT true,
  wallet_loaded BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL,
  poly_markets INT NOT NULL DEFAULT 0,
  kalshi_markets INT NOT NULL DEFAULT 0,
  candidates INT NOT NULL DEFAULT 0,
  approved_matches INT NOT NULL DEFAULT 0,
  monitored_matches INT NOT NULL DEFAULT 0,
  snapshots BIGINT NOT NULL DEFAULT 0,
  evaluations BIGINT NOT NULL DEFAULT 0,
  economic_leads BIGINT NOT NULL DEFAULT 0,
  lockable_nonatomic BIGINT NOT NULL DEFAULT 0,
  persistence_queue INT NOT NULL DEFAULT 0,
  last_market_at TIMESTAMPTZ,
  last_evaluation_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE cv_runtime ADD COLUMN IF NOT EXISTS experiment_id TEXT NOT NULL DEFAULT 'crossvenue-identity-v2';
`;

async function migrateCrossVenue() {
  await pool.query(CROSSVENUE_SCHEMA);
}

function parameterSafeChunks(cols, rows, maxParameters = 60000) {
  if (!cols.length) throw new Error('insertRows requires at least one column');
  const rowsPerChunk = Math.max(1, Math.floor(maxParameters / cols.length));
  const chunks = [];
  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    chunks.push(rows.slice(start, start + rowsPerChunk));
  }
  return chunks;
}

function insertStatement(table, cols, rows, conflict = '') {
  const params = [];
  const tuples = rows.map((row) => {
    if (row.length !== cols.length) {
      throw new Error(`${table}: row has ${row.length} values for ${cols.length} columns`);
    }
    const ph = row.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `(${ph.join(',')})`;
  });
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${conflict}`;
  return { sql, params };
}

/** Multi-row insert helper: transactionally chunks below PG's parameter cap. */
async function insertRows(table, cols, rows, conflict = '') {
  if (!rows.length) return 0;
  const chunks = parameterSafeChunks(cols, rows);
  if (chunks.length === 1) {
    const statement = insertStatement(table, cols, chunks[0], conflict);
    const res = await pool.query(statement.sql, statement.params);
    return res.rowCount;
  }
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const chunk of chunks) {
      const statement = insertStatement(table, cols, chunk, conflict);
      const res = await client.query(statement.sql, statement.params);
      inserted += res.rowCount;
    }
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function logEvent(level, source, message, data = null) {
  try {
    await pool.query(
      'INSERT INTO borg_events (level, source, message, data) VALUES ($1,$2,$3,$4)',
      [level, source, message, data ? JSON.stringify(data) : null]
    );
  } catch (_) { /* event logging must never throw */ }
  const line = `[${new Date().toISOString()}] [${level}] [${source}] ${message}`;
  if (level === 'ERROR' || level === 'WARN') console.warn(line);
  else console.log(line);
}

async function registerCollectionEpoch(epoch) {
  const required = [
    'epochId', 'startedAt', 'location', 'host', 'codeVersion',
    'dataContractVersion', 'reason',
  ];
  for (const key of required) {
    if (epoch[key] == null || epoch[key] === '') throw new Error(`collection epoch missing ${key}`);
  }
  const startedAt = new Date(epoch.startedAt);
  if (!Number.isFinite(startedAt.getTime())) throw new Error('collection epoch startedAt is invalid');
  await pool.query(`
    INSERT INTO borg_collection_epochs (
      epoch_id, started_at, location, host, code_version,
      data_contract_version, reason, benchmark, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (epoch_id) DO NOTHING
  `, [
    epoch.epochId, startedAt, epoch.location, epoch.host, epoch.codeVersion,
    epoch.dataContractVersion, epoch.reason,
    epoch.benchmark == null ? null : JSON.stringify(epoch.benchmark),
    epoch.metadata == null ? null : JSON.stringify(epoch.metadata),
  ]);
  const { rows } = await pool.query(
    `SELECT epoch_id, started_at, location, host, code_version,
            data_contract_version, reason
       FROM borg_collection_epochs WHERE epoch_id=$1`,
    [epoch.epochId],
  );
  const stored = rows[0];
  const expected = {
    epoch_id: epoch.epochId,
    started_at: startedAt.toISOString(),
    location: epoch.location,
    host: epoch.host,
    code_version: epoch.codeVersion,
    data_contract_version: epoch.dataContractVersion,
    reason: epoch.reason,
  };
  const actual = stored && {
    ...stored,
    started_at: new Date(stored.started_at).toISOString(),
  };
  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`immutable collection epoch conflict for ${epoch.epochId}`);
  }
  return actual;
}

async function startCollectorRun(run) {
  await pool.query(`
    UPDATE borg_collector_runs
       SET status='ABANDONED', completed_at=COALESCE(completed_at, $1)
     WHERE epoch_id=$2 AND host=$3 AND status='RUNNING' AND run_id<>$4
  `, [run.startedAt, run.epochId, run.host, run.runId]);
  await pool.query(`
    INSERT INTO borg_collector_runs (
      run_id, epoch_id, started_at, pid, host, code_version, status, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,'RUNNING',$7)
    ON CONFLICT (run_id) DO NOTHING
  `, [
    run.runId, run.epochId, run.startedAt, run.pid, run.host, run.codeVersion,
    run.metadata == null ? null : JSON.stringify(run.metadata),
  ]);
}

async function finishCollectorRun(runId, status = 'STOPPED', metadata = null) {
  await pool.query(`
    UPDATE borg_collector_runs
       SET completed_at=now(), status=$2,
           metadata=COALESCE(metadata, '{}'::jsonb) || COALESCE($3::jsonb, '{}'::jsonb)
     WHERE run_id=$1
  `, [runId, status, metadata == null ? null : JSON.stringify(metadata)]);
}

async function upsertStrategyRuntime(epochId, runId, rows) {
  if (!rows.length) return 0;
  return insertRows('borg_strategy_runtime', [
    'collector_run_id', 'epoch_id', 'strategy', 'cadence', 'market_types',
    'started_at', 'last_evaluated_at', 'evaluations', 'halted_evaluations',
    'actions', 'errors', 'last_action_at', 'updated_at',
    'diagnostics',
  ], rows.map((row) => [
    runId, epochId, row.strategy, row.cadence, JSON.stringify(row.marketTypes),
    row.startedAt, row.lastEvaluatedAt, row.evaluations, row.haltedEvaluations,
    row.actions, row.errors, row.lastActionAt, new Date(),
    row.diagnostics == null ? null : JSON.stringify(row.diagnostics),
  ]), `ON CONFLICT (collector_run_id, strategy) DO UPDATE SET
    cadence=EXCLUDED.cadence,
    market_types=EXCLUDED.market_types,
    last_evaluated_at=EXCLUDED.last_evaluated_at,
    evaluations=EXCLUDED.evaluations,
    halted_evaluations=EXCLUDED.halted_evaluations,
    actions=EXCLUDED.actions,
    errors=EXCLUDED.errors,
    last_action_at=EXCLUDED.last_action_at,
    diagnostics=EXCLUDED.diagnostics,
    updated_at=EXCLUDED.updated_at`);
}

module.exports = {
  pool, migrate, migrateFlow, migrateStructural, migrateOptions,
  migratePyth, migrateAllMarket, migratePairedMaker, migrateCrossVenue,
  insertRows, logEvent, parameterSafeChunks,
  registerCollectionEpoch, startCollectorRun, finishCollectorRun, upsertStrategyRuntime,
};
