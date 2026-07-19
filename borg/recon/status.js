/**
 * BORG recon — status report. Run: node borg/recon/status.js
 * Row counts, freshness, coverage, and recent warnings — the data-quality
 * dashboard for the collection run.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { pool } = require('./db');

async function main() {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

  const [tables, markets, gaps, warns] = await Promise.all([
    q(`SELECT 'book_snaps' t, count(*) n, max(ts) latest FROM borg_book_snaps
       UNION ALL SELECT 'binance_1s', count(*), max(ts) FROM borg_binance_1s
       UNION ALL SELECT 'coinbase_1s', count(*), max(ts) FROM borg_coinbase_1s
       UNION ALL SELECT 'rtds_chainlink', count(*), max(received_at) FROM borg_rtds_ticks
       UNION ALL SELECT 'clob_events', count(*), max(ts) FROM borg_clob_events
       UNION ALL SELECT 'clob_touch', count(*), max(ts) FROM borg_clob_touch
       UNION ALL SELECT 'taker_trades', count(*), max(ts) FROM borg_taker_trades
       UNION ALL SELECT 'chainlink_rounds', count(*), max(seen_at) FROM borg_chainlink_rounds`),
    q(`SELECT count(*) total,
              count(*) FILTER (WHERE outcome IS NOT NULL) resolved,
              count(*) FILTER (WHERE binance_open_src = 'live') live_opens,
              count(*) FILTER (WHERE outcome IS NOT NULL AND binance_open IS NOT NULL AND binance_close IS NOT NULL
                AND outcome <> CASE WHEN binance_close >= binance_open THEN 'UP' ELSE 'DOWN' END) sign_disagreements
       FROM borg_markets`),
    q(`SELECT count(*) n FROM (
         SELECT ts - lag(ts) OVER (ORDER BY ts) gap FROM borg_book_snaps
         WHERE ts > now() - interval '24 hours') g WHERE gap > interval '5 seconds'`),
    q(`SELECT ts, level, source, message FROM borg_events
       WHERE level IN ('WARN','ERROR') ORDER BY id DESC LIMIT 10`),
  ]);

  console.log('━━━ BORG recon status ━━━');
  for (const r of tables) {
    const age = r.latest ? Math.round((Date.now() - new Date(r.latest).getTime()) / 1000) : null;
    console.log(`  ${r.t.padEnd(18)} ${String(r.n).padStart(9)} rows   latest ${age == null ? 'never' : age + 's ago'}`);
  }
  const m = markets[0];
  console.log(`  markets: ${m.total} discovered, ${m.resolved} resolved, ${m.live_opens} live-captured opens`);
  console.log(`  outcome vs Binance-sign disagreements so far: ${m.sign_disagreements} (recon Q3)`);
  console.log(`  snapshot gaps >5s (24h): ${gaps[0].n}`);
  const provenance = await q(`SELECT count(*) n,
      count(*) FILTER (WHERE source_ts IS NOT NULL) source_clock,
      count(*) FILTER (WHERE receive_monotonic_ns IS NOT NULL) monotonic_clock,
      count(*) FILTER (WHERE best_ask IS NOT NULL) replay_touch,
      count(DISTINCT connection_shard) shards
    FROM borg_clob_touch WHERE ts > now() - interval '1 hour'`).catch(() => []);
  if (provenance[0]) {
    const p = provenance[0];
    console.log(`  CLOB provenance (1h): n=${p.n} source_ts=${p.source_clock} monotonic=${p.monotonic_clock} replay_touch=${p.replay_touch} shards=${p.shards}`);
  }
  if (warns.length) {
    console.log('  recent WARN/ERROR:');
    for (const w of warns) console.log(`    ${new Date(w.ts).toISOString()} [${w.level}] [${w.source}] ${w.message}`);
  } else {
    console.log('  no recent warnings');
  }
  const shadow = await q(`SELECT strategy, phase,
       count(*) FILTER (WHERE action='place') places,
       count(*) FILTER (WHERE action='cancel') cancels,
       max(ts) latest
     FROM borg_shadow_orders GROUP BY strategy, phase ORDER BY strategy`).catch(() => []);
  if (shadow.length) {
    console.log('  shadow orders (score with: node borg/shadow/score.js):');
    for (const s of shadow) {
      const age = Math.round((Date.now() - new Date(s.latest).getTime()) / 1000);
      console.log(`    ${s.strategy.padEnd(14)} [${s.phase}] places=${s.places} cancels=${s.cancels}  latest ${age}s ago`);
    }
  }
  const size = await q(`SELECT pg_size_pretty(sum(pg_total_relation_size(quote_ident(table_name)))::bigint) sz
    FROM information_schema.tables WHERE table_name LIKE 'borg_%'`);
  console.log(`  borg_* storage: ${size[0].sz}`);
  const archiveDir = process.env.BORG_ARCHIVE_DIR || path.join(os.homedir(), '.deltaforge-archive', 'borg-raw');
  try {
    const state = JSON.parse(await fs.readFile(path.join(archiveDir, 'archive-state.json'), 'utf8'));
    const age = Math.round((Date.now() - new Date(state.completed_at).getTime()) / 1000);
    const rows = state.results.reduce((sum, result) => sum + result.rows, 0);
    const freeGiB = state.free_bytes == null ? 'unknown' : (state.free_bytes / 1024 ** 3).toFixed(1);
    console.log(`  raw archive: healthy=${state.errors.length === 0} last_run=${age}s ago rows_last_run=${rows} free=${freeGiB} GiB`);
    console.log(`    ${state.archive_dir}`);
    for (const err of state.errors) console.log(`    ERROR ${err.table}: ${err.error}`);
  } catch (err) {
    console.log(`  raw archive: no state yet (${err.code || err.message})`);
  }
  const walRoot = process.env.BORG_WAL_DIR || path.join(os.homedir(), '.deltaforge-wal', 'borg');
  try {
    const walk = async (dir) => {
      const out = [];
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await walk(full)); else out.push(full);
      }
      return out;
    };
    const files = await walk(walRoot);
    const details = await Promise.all(files.map(async (file) => ({ file, stat: await fs.stat(file) })));
    const bytes = details.reduce((sum, row) => sum + row.stat.size, 0);
    const latest = details.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    console.log(`  raw WAL: files=${files.length} size=${(bytes / 1024 ** 2).toFixed(1)} MiB latest=${latest ? Math.round((Date.now() - latest.stat.mtimeMs) / 1000) + 's ago' : 'never'}`);
    console.log(`    ${walRoot}${process.env.BORG_WAL_MIRROR_DIR ? ` mirror=${process.env.BORG_WAL_MIRROR_DIR}` : ' mirror=NOT_CONFIGURED'}`);
  } catch (err) {
    console.log(`  raw WAL: unavailable (${err.code || err.message})`);
  }
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
