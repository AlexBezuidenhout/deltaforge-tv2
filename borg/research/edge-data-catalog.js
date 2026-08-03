'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');

const CLOCK_FIELD_GROUPS = Object.freeze({
  sourceTime: [
    'source_timestamp', 'source_timestamp_ms', 'source_ts', 'exchange_timestamp',
    'exchange_ts', 'event_timestamp', 'event_ts', 'trade_timestamp', 'trade_ts',
    'published_at', 'round_updated_at',
  ],
  receiveWallTime: [
    'receive_wall_timestamp', 'receive_wall_timestamp_ms', 'received_at',
    'local_received_at', 'ingested_at', 'observed_at',
  ],
  receiveMonotonicTime: [
    'receive_monotonic_timestamp', 'receive_monotonic_ns', 'monotonic_ns',
    'received_monotonic_ns',
  ],
  sequence: [
    'sequence_id', 'event_sequence', 'sequence', 'seq', 'update_id',
    'last_update_id',
  ],
  connectionEpoch: ['connection_epoch', 'connection_id', 'connection_run_id'],
  collectionEpoch: ['collection_epoch_id', 'collector_run_id', 'run_id', 'epoch_id'],
});

const CONTENT_FIELD_GROUPS = Object.freeze({
  fullDepth: [
    'bids', 'asks', 'bid_levels', 'ask_levels', 'book', 'depth', 'levels',
    'book_json', 'raw_book',
  ],
  touch: ['best_bid', 'best_ask', 'bid_price', 'ask_price', 'bid_size', 'ask_size'],
  trades: ['trade_id', 'trade_price', 'trade_size', 'side', 'maker_address'],
  fees: ['fee', 'fees', 'fee_rate', 'fee_paid', 'taker_fee', 'maker_fee'],
  funding: ['funding', 'funding_rate', 'next_funding_at'],
  resolver: [
    'resolver', 'resolver_source', 'oracle', 'round_id', 'answer', 'price_to_beat',
    'resolution_source',
  ],
  outcome: ['outcome', 'resolved_outcome', 'resolution', 'terminal_value', 'winner'],
  ruleText: ['rules', 'rule_text', 'description', 'settlement_rules', 'rule_hash'],
  queue: ['queue_ahead', 'queue_position', 'cancel_ack_at', 'order_ack_at'],
  latency: ['latency_ms', 'information_latency_ms', 'order_latency_ms', 'available_at'],
  options: ['strike', 'expiry', 'option_type', 'bid_iv', 'ask_iv', 'delta'],
});

const TIME_COLUMN_PRIORITY = Object.freeze([
  'available_at', 'source_timestamp', 'source_ts', 'received_at', 'observed_at',
  'ts', 'created_at', 'updated_at', 'started_at', 'opened_at', 'closed_at',
  'settled_at', 'resolved_at', 'captured_at', 'timestamp',
]);

const TABLE_PROFILES = Object.freeze([
  {
    match: /^(borg_book_snaps|borg_clob_events|borg_clob_touch|am_book_touches|pm_flow_touches)$/,
    family: 'polymarket_clob', tier: 'normalized_raw', venue: 'Polymarket',
    universe: 'Captured Polymarket CLOB token books',
    canTest: [
      'causal executable-price and walked-depth replay',
      'public queue-ahead and adverse-selection diagnostics',
      'latency sensitivity when receive clocks and provenance are complete',
    ],
    cannotTest: [
      'authenticated queue position or cancel acknowledgement',
      'markets not present in the frozen capture panel',
    ],
  },
  {
    match: /^(borg_binance_1s|borg_coinbase_1s|borg_taker_trades|borg_external_book_touch|borg_external_trades)$/,
    family: 'external_crypto_market', tier: 'normalized_raw', venue: 'CEX/perpetual venues',
    universe: 'BTC, ETH, SOL and XRP spot/perpetual market data where captured',
    canTest: [
      'cross-asset lead-lag and error-correction signals',
      'external price discovery and resolver residual features',
      'causal information-latency replay',
    ],
    cannotTest: [
      'funding carry without a versioned funding-rate series',
      'cross-exchange execution without venue-specific depth and fee records',
    ],
  },
  {
    match: /^(borg_rtds_ticks|borg_chainlink_rounds|borg_pyth_ticks|borg_pyth_arrivals)$/,
    family: 'resolver_feeds', tier: 'normalized_raw', venue: 'Resolver/oracle feeds',
    universe: 'Captured Chainlink/Pyth resolver symbols',
    canTest: [
      'resolver-source divergence and boundary transfer',
      'source freshness, outage and timestamp-risk barriers',
    ],
    cannotTest: [
      'a contract whose authoritative resolver is a different source',
      'missing source ticks merely because a socket heartbeat exists',
    ],
  },
  {
    match: /^cv_/,
    family: 'crossvenue_prediction', tier: 'normalized_or_gold',
    venue: 'Polymarket and Kalshi',
    universe: 'Discovered and reviewed cross-venue contract pairs',
    canTest: [
      'typed-rule pair coverage and risky convergence episodes',
      'synchronized 5/10/25-share depth replays where snapshots exist',
      'terminal carry only for rule-certified identities',
    ],
    cannotTest: [
      'risk-free arbitrage when any rule dimension is UNKNOWN',
      'atomic two-venue execution',
    ],
  },
  {
    match: /^(borg_deribit_|borg_option_|borg_options_runtime)/,
    family: 'options_surface', tier: 'normalized_or_derived', venue: 'Deribit/Polymarket',
    universe: 'Captured Deribit option surfaces and mapped prediction contracts',
    canTest: [
      'exact-expiry or bounded surface diagnostics when bid/ask IV exists',
      'options-implied binary residual collection',
    ],
    cannotTest: [
      'executable exact-expiry alpha when only term interpolation exists',
      'hedged P&L without executable perpetual hedge costs',
    ],
  },
  {
    match: /^borg_structural_/,
    family: 'structural_payoff', tier: 'gold_fact', venue: 'Polymarket',
    universe: 'Certified logical bundles, ordered strikes and passive quote episodes',
    canTest: [
      'finite-state worst-payoff proof',
      'orphan-reserved executable economics',
    ],
    cannotTest: [
      'authenticated passive fill probability from public prints alone',
      'bundles whose rule hashes or resolver identity are incomplete',
    ],
  },
  {
    match: /^(pm_flow_|pmm_|am_)/,
    family: 'market_making_and_flow', tier: 'normalized_or_gold', venue: 'Polymarket',
    universe: 'All-market, public-flow and paired-maker capture panels',
    canTest: [
      'public-print markouts and diagnostic queue replay',
      'adverse-selection and orphan-loss attribution',
    ],
    cannotTest: [
      'A-grade maker fills without authenticated user-channel evidence',
      'a fair-value edge when the only reference is midpoint or imbalance',
    ],
  },
  {
    match: /^(borg_shadow_.*|borg_trial_ledger|borg_experiments|borg_experiment_.*|borg_strategy_runtime)$/,
    family: 'strategy_evidence', tier: 'gold_fact', venue: 'Research layer',
    universe: 'Frozen experiment intents, fills, terminal scores and governance',
    canTest: [
      'forward P&L, concentration, promotion and multiple-testing diagnostics',
      'shared-bankroll portfolio simulation',
    ],
    cannotTest: [
      'market counterfactuals not preserved in source events',
      'live fill fidelity without authenticated orders',
    ],
  },
  {
    match: /^(trades|signals|skipped_signals|george_trades|george_signals|trading_sessions)$/,
    family: 'legacy_bot_evidence', tier: 'derived_legacy', venue: 'Polymarket',
    universe: 'Legacy MAIN/George signals and simulated positions',
    canTest: ['legacy strategy forensics and calibration when fields are populated'],
    cannotTest: [
      'execution-honest replay for contaminated synthetic-book cohorts',
      'causal inference when model probability or executable book was not persisted',
    ],
  },
  {
    match: /^(borg_collection_epochs|borg_collector_runs|borg_evidence_health_samples|borg_events|system_heartbeats|health_probe|.*_runtime)$/,
    family: 'provenance_and_health', tier: 'control', venue: 'Research platform',
    universe: 'Collector epochs, liveness, quality and failure events',
    canTest: ['evidence-window admissibility and restart/gap contamination'],
    cannotTest: ['strategy profitability by itself'],
  },
]);

const WAL_PROFILES = Object.freeze({
  binance: ['CEX lead-lag', 'cross-asset state', 'external price discovery'],
  coinbase: ['CEX lead-lag', 'cross-venue consensus'],
  hyperliquid: ['perpetual price discovery', 'cross-venue OFI diagnostics'],
  'polymarket-clob': ['full CLOB replay', 'depth/capacity', 'latency stress'],
  'polymarket-rtds-chainlink': ['resolver-boundary transfer'],
  'deribit-options': ['options surface reconstruction'],
  'options-polymarket-clob': ['options-to-binary executable mapping'],
  'options-rtds-chainlink': ['options target resolver alignment'],
  'crossvenue-poly': ['Polymarket side of cross-venue replay'],
  'crossvenue-kalshi': ['Kalshi side of cross-venue replay'],
  'crossvenue-decisions': ['pairing and execution-state audit'],
  'structural-scanner': ['payoff graph reconstruction'],
  'strategy-decisions': ['prequential strategy intent reconstruction'],
  'polymarket-flow-clob': ['public-flow and queue diagnostics'],
  'polymarket-global-trades': ['all-market public trade flow'],
  'allmarket-clob': ['neglected-market passive-making prerequisites'],
});

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 3) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function byteText(value) {
  const bytes = finite(value, 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${Math.round(bytes)} B`;
}

function safeIso(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function quoteIdentifier(value) {
  const text = String(value);
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(text)) {
    throw new Error(`unsafe PostgreSQL identifier: ${text}`);
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function classifyTable(tableName) {
  const baseTableName = String(tableName)
    .replace(/_p\d{8}$/i, '')
    .replace(/_(?:retained|default)$/i, '');
  const profile = TABLE_PROFILES.find((candidate) => candidate.match.test(baseTableName));
  if (profile) return {
    ...profile,
    match: undefined,
    partitionOf: baseTableName === tableName ? null : baseTableName,
  };
  return {
    family: 'application_or_uncatalogued',
    tier: 'application',
    venue: 'Application',
    universe: 'Operational/application data; inspect before research use',
    canTest: [],
    cannotTest: ['No causal research contract is registered for this table'],
    partitionOf: baseTableName === tableName ? null : baseTableName,
  };
}

function normalizedColumnMap(columns) {
  return new Map(columns.map((column) => [String(column.column_name).toLowerCase(), column]));
}

function groupCoverage(columns, names) {
  const byName = normalizedColumnMap(columns);
  const present = names.filter((name) => byName.has(name));
  const fractions = present.map((name) => {
    const nullFraction = finite(byName.get(name).null_frac);
    return nullFraction == null ? null : Math.max(0, Math.min(1, 1 - nullFraction));
  }).filter((value) => value != null);
  return {
    present,
    estimatedNonNullFraction: fractions.length ? round(Math.max(...fractions), 4) : null,
  };
}

function fieldCoverage(columns) {
  return {
    clocks: Object.fromEntries(Object.entries(CLOCK_FIELD_GROUPS)
      .map(([key, names]) => [key, groupCoverage(columns, names)])),
    contents: Object.fromEntries(Object.entries(CONTENT_FIELD_GROUPS)
      .map(([key, names]) => [key, groupCoverage(columns, names)])),
  };
}

function chooseTimeColumn(columns, indexedColumns = new Set()) {
  const timestampColumns = columns.filter((column) =>
    /timestamp|date/i.test(String(column.data_type || '')));
  for (const name of TIME_COLUMN_PRIORITY) {
    const found = timestampColumns.find((column) => column.column_name === name);
    if (found && indexedColumns.has(name)) return { name, indexed: true };
  }
  const indexed = timestampColumns.find((column) => indexedColumns.has(column.column_name));
  if (indexed) return { name: indexed.column_name, indexed: true };
  for (const name of TIME_COLUMN_PRIORITY) {
    const found = timestampColumns.find((column) => column.column_name === name);
    if (found) return { name, indexed: false };
  }
  return timestampColumns.length
    ? { name: timestampColumns[0].column_name, indexed: false }
    : null;
}

function causalReplayGrade(table) {
  const clocks = table.fieldCoverage.clocks;
  const contents = table.fieldCoverage.contents;
  const has = (group) => group?.present?.length > 0;
  const source = has(clocks.sourceTime);
  const receive = has(clocks.receiveWallTime);
  const monotonic = has(clocks.receiveMonotonicTime);
  const epoch = has(clocks.connectionEpoch) && has(clocks.collectionEpoch);
  const sequence = has(clocks.sequence);
  const executable = has(contents.fullDepth) || has(contents.touch);
  let dataGrade = 'D';
  if (source && receive && monotonic && epoch && sequence) dataGrade = 'A';
  else if (receive && (source || monotonic) && (epoch || sequence)) dataGrade = 'B';
  else if (receive || source) dataGrade = 'C';
  let executionGrade = 'F';
  if (has(contents.fullDepth) && has(contents.fees)) executionGrade = 'A';
  else if (has(contents.fullDepth)) executionGrade = 'B';
  else if (executable) executionGrade = 'C';
  else if (table.tier === 'gold_fact') executionGrade = 'DERIVED';
  return {
    dataGrade,
    executionGrade,
    replayProfiles: dataGrade === 'A'
      ? ['20ms', '50ms', '100ms', '250ms', '500ms', '1s', '2s']
      : dataGrade === 'B'
        ? ['100ms', '250ms', '500ms', '1s', '2s']
        : dataGrade === 'C' ? ['1s', '2s'] : [],
    caveat: executable
      ? 'Public executable state only; authenticated order lifecycle is a separate grade.'
      : 'No contemporaneous executable book is proven by this table alone.',
  };
}

async function queryDatabaseCatalog(pool, options = {}) {
  const schema = options.schema || 'public';
  const maxBoundaryQueries = Number.isInteger(options.maxBoundaryQueries)
    ? options.maxBoundaryQueries : 80;
  const [{ rows: tableRows }, { rows: columnRows }, { rows: indexRows }, dbResult] = await Promise.all([
    pool.query(`
      SELECT s.relname table_name,
             s.n_live_tup::text estimated_rows,
             s.n_dead_tup::text estimated_dead_rows,
             s.last_analyze,s.last_autoanalyze,
             pg_total_relation_size(c.oid)::text total_bytes,
             pg_relation_size(c.oid)::text heap_bytes,
             pg_indexes_size(c.oid)::text index_bytes
        FROM pg_stat_user_tables s
        JOIN pg_class c ON c.relname=s.relname
        JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=s.schemaname
       WHERE s.schemaname=$1
       ORDER BY pg_total_relation_size(c.oid) DESC,s.relname`, [schema]),
    pool.query(`
      SELECT c.table_name,c.column_name,c.data_type,c.udt_name,c.is_nullable,
             st.null_frac
        FROM information_schema.columns c
        LEFT JOIN pg_stats st
          ON st.schemaname=c.table_schema
         AND st.tablename=c.table_name
         AND st.attname=c.column_name
       WHERE c.table_schema=$1
       ORDER BY c.table_name,c.ordinal_position`, [schema]),
    pool.query(`
      SELECT t.relname table_name,a.attname column_name
        FROM pg_index i
        JOIN pg_class t ON t.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord) ON true
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
       WHERE n.nspname=$1 AND i.indisvalid`, [schema]),
    pool.query(`
      SELECT current_database() database_name,
             pg_database_size(current_database())::text database_bytes,
             current_setting('server_version') server_version`),
  ]);
  const columnsByTable = new Map();
  for (const column of columnRows) {
    const list = columnsByTable.get(column.table_name) || [];
    list.push(column);
    columnsByTable.set(column.table_name, list);
  }
  const indexesByTable = new Map();
  for (const index of indexRows) {
    const set = indexesByTable.get(index.table_name) || new Set();
    set.add(index.column_name);
    indexesByTable.set(index.table_name, set);
  }
  const tables = tableRows.map((row) => {
    const columns = columnsByTable.get(row.table_name) || [];
    const profile = classifyTable(row.table_name);
    const coverage = fieldCoverage(columns);
    const table = {
      name: row.table_name,
      ...profile,
      estimatedRows: finite(row.estimated_rows, 0),
      rowCountKind: 'postgres_statistics_estimate',
      estimatedDeadRows: finite(row.estimated_dead_rows, 0),
      bytes: finite(row.total_bytes, 0),
      heapBytes: finite(row.heap_bytes, 0),
      indexBytes: finite(row.index_bytes, 0),
      lastAnalyze: safeIso(row.last_analyze || row.last_autoanalyze),
      columns: columns.map((column) => ({
        name: column.column_name,
        type: column.data_type,
        nullable: column.is_nullable === 'YES',
        estimatedNonNullFraction: finite(column.null_frac) == null
          ? null : round(1 - finite(column.null_frac), 4),
      })),
      fieldCoverage: coverage,
      timeColumn: chooseTimeColumn(columns, indexesByTable.get(row.table_name) || new Set()),
      firstTimestamp: null,
      lastTimestamp: null,
      timestampBoundaryStatus: 'not_attempted',
    };
    table.replay = causalReplayGrade(table);
    return table;
  });
  let attempted = 0;
  for (const table of tables) {
    if (!table.timeColumn || attempted >= maxBoundaryQueries) continue;
    // Avoid accidental sort/scan pressure on large hot tables without a time
    // index. PostgreSQL statistics still expose size and row estimates.
    if (!table.timeColumn.indexed && table.estimatedRows > 100_000) {
      table.timestampBoundaryStatus = 'skipped_unindexed_hot_table';
      continue;
    }
    attempted += 1;
    const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(table.name)}`;
    const column = quoteIdentifier(table.timeColumn.name);
    try {
      const { rows } = await pool.query(`
        SELECT
          (SELECT ${column}::text FROM ${relation}
            WHERE ${column} IS NOT NULL ORDER BY ${column} ASC LIMIT 1) first_ts,
          (SELECT ${column}::text FROM ${relation}
            WHERE ${column} IS NOT NULL ORDER BY ${column} DESC LIMIT 1) last_ts`);
      table.firstTimestamp = safeIso(rows[0]?.first_ts);
      table.lastTimestamp = safeIso(rows[0]?.last_ts);
      table.timestampBoundaryStatus = 'measured';
    } catch (error) {
      table.timestampBoundaryStatus = `unavailable:${String(error.code || error.name || 'query_error')}`;
    }
  }
  const db = dbResult.rows[0] || {};
  return {
    name: db.database_name || null,
    bytes: finite(db.database_bytes, 0),
    serverVersion: db.server_version || null,
    rowCountsAreEstimates: true,
    timestampBoundaryQueries: attempted,
    tables,
  };
}

async function walkFiles(root, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const groups = new Map();
  let totalFiles = 0;
  let totalBytes = 0;
  let firstMtime = null;
  let lastMtime = null;
  async function visit(directory, depth) {
    if (depth > maxDepth) return;
    let handle;
    try { handle = await fs.promises.opendir(directory); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') return;
      throw error;
    }
    for await (const entry of handle) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = await fs.promises.stat(full); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const relative = path.relative(root, full);
      const source = relative.split(path.sep)[0] || '_root';
      const current = groups.get(source) || {
        source, files: 0, bytes: 0, openFiles: 0, gzipFiles: 0,
        parquetFiles: 0, manifestFiles: 0, firstMtime: null, lastMtime: null,
        _newestClosedWalFile: null,
      };
      current.files += 1;
      current.bytes += stat.size;
      const mtime = stat.mtime.toISOString();
      if (entry.name.endsWith('.open')) current.openFiles += 1;
      if (entry.name.endsWith('.gz')) current.gzipFiles += 1;
      if (entry.name.endsWith('.ndjson.gz')
        && (!current._newestClosedWalFile || mtime > current._newestClosedWalFile.mtime)) {
        current._newestClosedWalFile = { file: full, mtime };
      }
      if (entry.name.endsWith('.parquet')) current.parquetFiles += 1;
      if (entry.name.endsWith('.manifest.json')) current.manifestFiles += 1;
      if (!current.firstMtime || mtime < current.firstMtime) current.firstMtime = mtime;
      if (!current.lastMtime || mtime > current.lastMtime) current.lastMtime = mtime;
      groups.set(source, current);
      totalFiles += 1;
      totalBytes += stat.size;
      if (!firstMtime || mtime < firstMtime) firstMtime = mtime;
      if (!lastMtime || mtime > lastMtime) lastMtime = mtime;
    }
  }
  await visit(root, 0);
  const outputGroups = [...groups.values()].sort((left, right) => right.bytes - left.bytes);
  if (options.inspectWalContracts) {
    await Promise.all(outputGroups.map(async (group) => {
      group.contract = group._newestClosedWalFile
        ? await inspectWalContract(group._newestClosedWalFile.file, group.source)
        : null;
    }));
  }
  for (const group of outputGroups) delete group._newestClosedWalFile;
  return {
    root,
    exists: fs.existsSync(root),
    files: totalFiles,
    bytes: totalBytes,
    firstMtime,
    lastMtime,
    groups: outputGroups,
  };
}

async function firstNdjsonRecords(file, maximum = 64) {
  const input = fs.createReadStream(file);
  const gunzip = zlib.createGunzip();
  const lines = readline.createInterface({
    input: input.pipe(gunzip),
    crlfDelay: Infinity,
  });
  const records = [];
  try {
    for await (const line of lines) {
      if (!line) continue;
      records.push(JSON.parse(line));
      if (records.length >= maximum + 1) break;
    }
  } finally {
    lines.close();
    input.destroy();
    gunzip.destroy();
  }
  return records;
}

async function inspectWalContract(file, source) {
  try {
    const records = await firstNdjsonRecords(file);
    const header = records.shift()?._borg_wal || null;
    const events = records;
    const fields = [...new Set(events.flatMap((event) => Object.keys(event)))].sort();
    const coverage = Object.fromEntries(fields.map((field) => [field, round(
      events.filter((event) => event[field] != null).length / Math.max(1, events.length), 4,
    )]));
    const complete = (field) => coverage[field] != null && coverage[field] >= 0.95;
    const baseComplete = [
      'receive_wall_timestamp_ms', 'receive_monotonic_ns', 'connection_epoch',
      'event_sequence', 'collection_epoch_id', 'collector_run_id',
    ].every(complete);
    const sourceComplete = complete('source_timestamp_ms');
    const dataGrade = baseComplete && sourceComplete ? 'A' : baseComplete ? 'B' : 'C';
    const clobLike = /clob|kalshi|poly/i.test(source);
    return {
      format: header?.format || null,
      schemaVersion: header?.schema_version ?? null,
      sampledEvents: events.length,
      fields,
      estimatedNonNullFraction: coverage,
      dataGrade,
      executionGrade: clobLike && complete('raw') ? 'B_PUBLIC_BOOK' : 'NOT_EXECUTION_ALONE',
      replayProfiles: dataGrade === 'A'
        ? ['20ms', '50ms', '100ms', '250ms', '500ms', '1s', '2s']
        : dataGrade === 'B' ? ['100ms', '250ms', '500ms', '1s', '2s'] : ['1s', '2s'],
      caveat: sourceComplete
        ? null
        : 'The sampled source did not provide a non-null venue/source timestamp on at least 95% of events; local receive-time replay remains causal but cannot estimate feed transit separately.',
    };
  } catch (error) {
    return {
      format: null,
      sampledEvents: 0,
      dataGrade: 'UNVERIFIED',
      executionGrade: 'UNVERIFIED',
      replayProfiles: [],
      error: `${error.code || error.name || 'ERROR'}:${error.message}`,
    };
  }
}

function aggregateOffhostState(state) {
  const groups = new Map();
  let files = 0;
  let bytes = 0;
  let verified = 0;
  let invalidChecksums = 0;
  let firstMtime = null;
  let lastMtime = null;
  for (const entry of Object.values(state?.objects || {})) {
    const namespace = String(entry.namespace || 'unknown');
    const relative = String(entry.relative || '');
    const source = relative.split('/')[0] || '_root';
    const key = `${namespace}:${source}`;
    const current = groups.get(key) || {
      namespace, source, files: 0, bytes: 0, verified: 0,
      invalidChecksums: 0, firstMtime: null, lastMtime: null,
    };
    const size = finite(entry.size, 0);
    const mtime = safeIso(entry.mtimeMs);
    const checksumValid = /^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''));
    current.files += 1;
    current.bytes += size;
    files += 1;
    bytes += size;
    if (entry.verified === true && checksumValid) {
      current.verified += 1;
      verified += 1;
    } else {
      current.invalidChecksums += 1;
      invalidChecksums += 1;
    }
    if (mtime && (!current.firstMtime || mtime < current.firstMtime)) current.firstMtime = mtime;
    if (mtime && (!current.lastMtime || mtime > current.lastMtime)) current.lastMtime = mtime;
    if (mtime && (!firstMtime || mtime < firstMtime)) firstMtime = mtime;
    if (mtime && (!lastMtime || mtime > lastMtime)) lastMtime = mtime;
    groups.set(key, current);
  }
  return {
    format: state?.format || null,
    updatedAt: safeIso(state?.updatedAt),
    destination: 'Google Drive/VPS Data',
    files,
    bytes,
    verified,
    invalidChecksums,
    firstMtime,
    lastMtime,
    verification: invalidChecksums === 0
      ? 'all indexed objects carry uploader verification and SHA-256 metadata'
      : 'one or more indexed objects lack valid verification metadata',
    groups: [...groups.values()].sort((left, right) => right.bytes - left.bytes),
  };
}

function readOffhostState(file) {
  if (!file || !fs.existsSync(file)) return null;
  return aggregateOffhostState(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function parseReceipt(file) {
  if (!file || !fs.existsSync(file)) return null;
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return {
    format: values.format || null,
    scope: values.scope || null,
    completedAt: safeIso(values.completed_at),
    destination: values.destination ? 'Google Drive/VPS Data' : null,
    remoteVerification: values.remote_verification || null,
    latestSize: finite(values.latest_size),
    latestSha256Valid: /^[a-f0-9]{64}$/i.test(String(values.latest_sha256 || '')),
    manifestSize: finite(values.manifest_size),
    manifestSha256Valid: /^[a-f0-9]{64}$/i.test(String(values.manifest_sha256 || '')),
  };
}

function diskSnapshot(root) {
  try {
    const stat = fs.statfsSync(root);
    return {
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
      freeBytes: Number(stat.bavail) * Number(stat.bsize),
    };
  } catch (_) {
    return null;
  }
}

function buildStrategyCoverage(catalog) {
  const tableFamilies = new Set(catalog.database?.tables?.map((table) => table.family) || []);
  const walSources = new Set(catalog.storage?.wal?.groups?.map((group) => group.source) || []);
  const offhostSources = new Set(catalog.storage?.offhost?.groups?.map((group) => group.source) || []);
  const raw = (source) => walSources.has(source) || offhostSources.has(source);
  return [
    {
      programme: 'Resolver-boundary transfer',
      readiness: tableFamilies.has('resolver_feeds') && raw('polymarket-rtds-chainlink')
        ? 'FORWARD_TESTABLE' : 'BLOCKED',
      supports: 'Exact captured resolver symbols with contemporaneous CLOB depth.',
      blocks: 'No substitution for a different contractual resolver; sparse/empty source symbols fail closed.',
    },
    {
      programme: 'Certified payoff graph / ordered strikes',
      readiness: tableFamilies.has('structural_payoff') ? 'SCANNER_READY' : 'BLOCKED',
      supports: 'Rule-hashed deterministic payoff proof and current executable economics.',
      blocks: 'Authenticated passive queue behavior and bundles without complete rule identity.',
    },
    {
      programme: 'Polymarket/Kalshi exact-rule terminal lock',
      readiness: tableFamilies.has('crossvenue_prediction') ? 'COLLECTOR_READY_IDENTITY_BLOCKED' : 'BLOCKED',
      supports: 'Typed rule review, synchronized observations and stored depth replays.',
      blocks: 'No certified-equal pair means no terminal-arbitrage P&L experiment yet.',
    },
    {
      programme: 'Polymarket/Kalshi risky convergence',
      readiness: tableFamilies.has('crossvenue_prediction') ? 'REPLAYABLE_WITH_RULE_RISK' : 'BLOCKED',
      supports: 'Basis dwell/half-life and liquidation-path simulation by rule-risk class.',
      blocks: 'Cannot be labelled risk-free; capital and resolver mismatch must remain charged.',
    },
    {
      programme: 'Deribit options-implied binary residual',
      readiness: tableFamilies.has('options_surface') && raw('deribit-options')
        ? 'COLLECTING_EXACT_EXPIRY_SPARSE' : 'BLOCKED',
      supports: 'Surface reconstruction from raw Deribit frames and mapped CLOB books.',
      blocks: 'Current term interpolation is diagnostic; exact-expiry overlap and hedge-cost data are sparse.',
    },
    {
      programme: 'CEX lead-lag / state-space relative value',
      readiness: raw('binance') && raw('coinbase') && raw('hyperliquid')
        ? 'CAUSAL_REPLAY_READY' : 'PARTIAL',
      supports: 'BTC/ETH/SOL/XRP event-time cross-venue and cross-asset signals.',
      blocks: 'No venue funding/fee/inventory series for a complete executable carry strategy.',
    },
    {
      programme: 'Selective passive making',
      readiness: raw('allmarket-clob') ? 'CAPTURE_ONLY' : 'BLOCKED',
      supports: 'Public queue and adverse-selection diagnostics on the frozen panel.',
      blocks: 'Needs an independently certified fair bound and authenticated tiny-fill evidence.',
    },
    {
      programme: 'News/social/event trading',
      readiness: 'NO_CAUSAL_SOURCE_DATA',
      supports: 'None from the present catalog.',
      blocks: 'Requires publication/edit/receive/model/arrival timestamps and licensed source access.',
    },
    {
      programme: 'DEX/CEX or cross-chain arbitrage',
      readiness: 'NO_EXECUTABLE_ONCHAIN_DATA',
      supports: 'None from the present catalog beyond external CEX references.',
      blocks: 'Requires pool states, blocks, gas/priority fees, inclusion outcomes and inventory paths.',
    },
    {
      programme: 'Sportsbook/prediction-market relative value',
      readiness: 'NO_BOOKMAKER_TAPE',
      supports: 'Structural rule compiler can be reused after capture exists.',
      blocks: 'Requires bookmaker odds histories, limits, vig, rules and causal timestamps.',
    },
  ];
}

function catalogWarnings(catalog) {
  const warnings = [];
  const parquetFiles = catalog.storage?.parquet?.files || 0;
  if (parquetFiles === 0) {
    warnings.push('No Parquet research projection exists on the VPS; Google Drive raw objects are durable but not yet query-efficient.');
  }
  if (catalog.storage?.offhost?.invalidChecksums > 0) {
    warnings.push(`${catalog.storage.offhost.invalidChecksums} off-host object(s) lack valid verification metadata.`);
  }
  if (!catalog.storage?.offhost) warnings.push('Off-host archive state is unavailable.');
  if (catalog.database?.bytes > 40 * 1024 ** 3) {
    warnings.push(`Hot PostgreSQL is ${byteText(catalog.database.bytes)}; analytics must remain bounded/read-only until Parquet or a replica is active.`);
  }
  const disk = catalog.storage?.disk;
  if (disk && disk.freeBytes < 30 * 1024 ** 3) warnings.push('VPS free disk is below the 30 GiB evidence reserve.');
  return warnings;
}

function buildCatalogHash(catalog) {
  const clone = JSON.parse(JSON.stringify(catalog));
  delete clone.catalogSha256;
  return sha256(`${JSON.stringify(clone)}\n`);
}

async function buildEdgeDataCatalog(options = {}) {
  const roots = {
    wal: options.walRoot || process.env.BORG_WAL_DIR || '/var/lib/deltaforge/wal/borg',
    archive: options.archiveRoot || process.env.BORG_ARCHIVE_DIR || '/var/lib/deltaforge/archive/borg-raw',
    parquet: options.parquetRoot || process.env.BORG_PARQUET_MIRROR_DIR || '/var/lib/deltaforge/parquet',
  };
  const [database, wal, archive, parquet] = await Promise.all([
    options.pool ? queryDatabaseCatalog(options.pool, options) : Promise.resolve(null),
    walkFiles(roots.wal, { inspectWalContracts: true }),
    walkFiles(roots.archive),
    walkFiles(roots.parquet),
  ]);
  const offhostStateFile = options.offhostStateFile
    || process.env.GDRIVE_ARCHIVE_STATE_FILE
    || '/var/lib/deltaforge/google-drive-archive/state.json';
  const receiptFile = options.receiptFile
    || process.env.BORG_OFFHOST_ARCHIVE_RECEIPT
    || '/var/lib/deltaforge/offhost-archive.receipt';
  const catalog = {
    format: 'deltaforge-edge-data-catalog-v1',
    generatedAt: new Date().toISOString(),
    host: os.hostname(),
    evidenceBoundary: options.evidenceBoundary || null,
    methodology: {
      rowCounts: 'PostgreSQL planner/statistics estimates; never presented as exact counts.',
      timestampBounds: 'Index-backed or small-table boundary reads only; large unindexed hot tables are skipped.',
      archiveVerification: 'Only uploader-state objects marked verified with valid SHA-256 metadata are counted as checksum-attested.',
      causalRule: 'A stored outcome or derived score does not make a source causally replayable.',
    },
    database,
    storage: {
      disk: diskSnapshot(roots.wal),
      wal,
      normalizedArchive: archive,
      parquet,
      offhost: readOffhostState(offhostStateFile),
      offhostReceipt: parseReceipt(receiptFile),
    },
    replayLatencyProfiles: ['20ms', '50ms', '100ms', '250ms', '500ms', '1s', '2s', 'measured-vps', 'measured-mac'],
  };
  catalog.strategyCoverage = buildStrategyCoverage(catalog);
  catalog.warnings = catalogWarnings(catalog);
  catalog.catalogSha256 = buildCatalogHash(catalog);
  return catalog;
}

function markdownCatalog(catalog) {
  const databaseTables = catalog.database?.tables || [];
  const dbRows = databaseTables.map((table) =>
    `| \`${table.name}\` | ${table.family} | ${table.tier} | ${table.estimatedRows.toLocaleString('en-US')} est. | ${byteText(table.bytes)} | ${table.firstTimestamp || '—'} | ${table.lastTimestamp || '—'} | ${table.replay.dataGrade}/${table.replay.executionGrade} | ${table.replay.replayProfiles.join(', ') || 'none'} |`);
  const walRows = (catalog.storage?.wal?.groups || []).map((group) => {
    const tests = WAL_PROFILES[group.source] || [];
    return `| \`${group.source}\` | ${group.files.toLocaleString('en-US')} | ${byteText(group.bytes)} | ${group.firstMtime || '—'} | ${group.lastMtime || '—'} | ${group.contract ? `${group.contract.dataGrade}/${group.contract.executionGrade}` : '—'} | ${group.contract?.replayProfiles?.join(', ') || 'none'} | ${tests.join('; ') || 'unclassified—review required'} |`;
  });
  const offhostRows = (catalog.storage?.offhost?.groups || []).map((group) =>
    `| ${group.namespace} | \`${group.source}\` | ${group.files.toLocaleString('en-US')} | ${byteText(group.bytes)} | ${group.verified.toLocaleString('en-US')} | ${group.firstMtime || '—'} | ${group.lastMtime || '—'} |`);
  const coverageRows = (catalog.strategyCoverage || []).map((row) =>
    `| ${row.programme} | **${row.readiness}** | ${row.supports} | ${row.blocks} |`);
  return `${[
    '# DeltaForge edge data catalog',
    '',
    `Generated: ${catalog.generatedAt} on \`${catalog.host}\`. Catalog SHA-256: \`${catalog.catalogSha256}\`.`,
    '',
    'This is an evidence map, not a profitability report. PostgreSQL row counts are explicitly estimated. A durable raw archive is not labelled replay-ready until it has causal clocks, executable state and a queryable reconstruction path.',
    '',
    '## Ground-truth snapshot',
    '',
    `- Evidence boundary: ${catalog.evidenceBoundary ? `\`${catalog.evidenceBoundary.id}\` from ${catalog.evidenceBoundary.startedAt}` : 'not supplied'}.`,
    `- Hot PostgreSQL: ${byteText(catalog.database?.bytes || 0)} across ${databaseTables.length} public tables.`,
    `- Local WAL: ${(catalog.storage?.wal?.files || 0).toLocaleString('en-US')} files, ${byteText(catalog.storage?.wal?.bytes || 0)}.`,
    `- Verified off-host index: ${(catalog.storage?.offhost?.verified || 0).toLocaleString('en-US')} / ${(catalog.storage?.offhost?.files || 0).toLocaleString('en-US')} objects, ${byteText(catalog.storage?.offhost?.bytes || 0)}.`,
    `- VPS Parquet projection: ${(catalog.storage?.parquet?.parquetFiles || catalog.storage?.parquet?.groups?.reduce((sum, row) => sum + row.parquetFiles, 0) || 0).toLocaleString('en-US')} files.`,
    '',
    '## Binding warnings',
    '',
    ...(catalog.warnings.length ? catalog.warnings.map((warning) => `- ${warning}`) : ['- None detected by the cataloger.']),
    '',
    '## Strategy/data eligibility',
    '',
    '| Programme | Current readiness | What the stored data supports | What it cannot establish |',
    '|---|---|---|---|',
    ...coverageRows,
    '',
    '## Local append-before-process WAL',
    '',
    '| Source | Files | Compressed/on-disk size | First local object | Latest local object | Sampled data/execution grade | Replay profiles | Causal uses |',
    '|---|---:|---:|---|---|---|---|---|',
    ...walRows,
    '',
    'WAL sizes are physical bytes. Uncompressed size is deliberately left unknown unless a verified segment manifest supplies it; no compression ratio is invented.',
    '',
    '## Google Drive raw/archive index',
    '',
    '| Namespace | Source/table | Objects | Stored size | Checksum-attested | First object time | Latest object time |',
    '|---|---|---:|---:|---:|---|---|',
    ...offhostRows,
    '',
    `Receipt: ${catalog.storage?.offhostReceipt?.completedAt || 'missing'}; remote check: ${catalog.storage?.offhostReceipt?.remoteVerification || 'unknown'}. The state index records uploader verification; any object selected for research must still be downloaded/staged and SHA-256 checked before use.`,
    '',
    '## PostgreSQL hot-tier tables',
    '',
    '| Table | Family | Tier | Rows | Total size | First timestamp | Last timestamp | Data/execution grade | Defensible replay profiles |',
    '|---|---|---|---:|---:|---|---|---|---|',
    ...dbRows,
    '',
    '## Causal interpretation',
    '',
    '- Grade A data requires source time, local receive time, monotonic time, sequence and run/connection identity. Grade B is usable for slower replay with a stated clock limitation. Grade C is coarse diagnostic evidence only.',
    '- Execution grade A additionally requires full contemporaneous depth and effective fee data. Public books never prove authenticated queue position, cancellation acknowledgement or private fills.',
    '- `20–50 ms` replay is a software counterfactual only when event source/receive clocks are complete. It does not retroactively improve a slow or missing source feed.',
    '- Derived strategy rows are gold facts for governance and P&L attribution, not a substitute for raw event reconstruction.',
    '- Current raw storage can test prediction-market and four-asset crypto hypotheses. It cannot honestly backtest news/social, sportsbook or DEX execution strategies until dedicated causal collectors exist.',
    '',
  ].join('\n')}\n`;
}

module.exports = {
  CLOCK_FIELD_GROUPS,
  CONTENT_FIELD_GROUPS,
  WAL_PROFILES,
  aggregateOffhostState,
  buildEdgeDataCatalog,
  buildStrategyCoverage,
  causalReplayGrade,
  chooseTimeColumn,
  classifyTable,
  fieldCoverage,
  firstNdjsonRecords,
  inspectWalContract,
  markdownCatalog,
  quoteIdentifier,
  queryDatabaseCatalog,
  walkFiles,
};
