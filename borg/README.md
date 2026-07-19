# BORG

A from-scratch research program for Polymarket BTC 5-minute binary markets.
Objective: **determine whether any exploitable structural edge exists at
retail-achievable latency, and prove it either way.** A rigorous "no" is a
successful outcome. BORG's defining feature is that it cannot lie to its
operator — every claim traces to forward-collected data scored under
pessimistic assumptions.

The legacy bot in `../src` is prior art and cautionary tale only. Its
infrastructure knowledge (SDK quirks, Gamma discovery, price-scale rules,
UMA windows) is harvested; its strategy assumptions are inherited nowhere.

## Safety invariants

- **The recon collector and shadow engine have no order credentials or order
  methods.** The separately isolated historical `live/` executor is outside
  the research process and is never invoked by recon or replay tooling.
- Zero lookahead: evaluation only on data collected after the evaluated
  logic was frozen. See `EVAL_PROTOCOL.md` (pre-registered).

## Layout

```
borg/
  THESES.md         strategy theses, pre-registered BEFORE data (who pays us and why)
  EVAL_PROTOCOL.md  pre-registered evaluation rules — sample sizes, costs, pass bars
  RECON.md          Phase 1 questions + frozen methodology; findings land here
  SHADOW.md         Phase 3 shadow-execution harness — status, pilot strategies
  recon/            standalone 24-48h+ microstructure collector (Phase 1)
    collector.js    orchestrator — event feeds + 1s research snapshots
    binance.js      multi-asset aggTrade + bookTicker + depth10@100ms
    coinbase.js     independent public venue control for resolver-proxy tests
    chainlink.js    mainnet BTC/USD push feed (CONTROL series — see below)
    markets.js      Gamma discovery, live boundary capture, resolution tracking
    clob.js         event-driven CLOB books + paced REST hash recovery
    rtds.js         Polymarket RTDS Chainlink resolver-risk telemetry
    wal.js          append-before-parse raw event write-ahead log
    db.js           borg_* schema + batched writes
    status.js       data-quality dashboard (run anytime)
    deploy.sh       sync code to ~/.borg-runtime + restart the launchd job
    run.sh          manual supervised launch (dev only — see deploy.sh)
    analysis/       pre-registered queries for RECON questions
  shadow/           Phase 3 harness (EVAL_PROTOCOL §1) — runs inside collector
    engine.js       shadow order logger: feature vectors, queue-ahead, halt rule
    strategies.js   pilot modules: A_maker, D_consistency, F_yield
    score.js        offline tape-replay scorer: back-of-queue fills, cost grid
    archive.js      loss-safe gzip archive before raw Postgres rows are pruned
  experiments/      immutable split-test and latency manifests
```

## Key facts (verified 2026-07-11, before design)

- Resolution source is **Chainlink Data Streams** (`data.chain.link/streams/btc-usd`),
  low-latency multi-exchange aggregate — NOT the mainnet push feed (0.5%
  deviation / 1h heartbeat) the legacy George bot models. The push feed is
  recorded as a control series only.
- **Ties resolve UP** ("greater than or equal"). Fair value = P(end ≥ start).
- One market per 5-min window, 24/7, slug `btc-updown-5m-<epochSec>`;
  windows align to epoch-time 300s boundaries.

## Running

```bash
bash borg/recon/deploy.sh             # deploy code changes + (re)start launchd job
node borg/recon/status.js             # row counts, freshness, gaps, warnings
node borg/shadow/score.js             # score shadow orders, print scoreboard
node scripts/infra-benchmark.js        # read-only DB/feed/route benchmark
node scripts/borg-latency-replay.js    # 100ms..2s quote-survival replay
tail -f ~/Library/Logs/borg-recon.log # live log
```

The collector runs as launchd job `com.borg.recon` (KeepAlive + RunAtLoad —
survives crashes, logout, and reboot) from a mirror at `~/.borg-runtime`,
because launchd agents cannot read `~/Desktop` (macOS TCC). **Edits under
`borg/` do nothing until `deploy.sh` is run.**

Hot-path capture is event-driven. Every Binance, Coinbase, Polymarket CLOB and
RTDS frame is synchronously appended to a source-partitioned WAL before JSON
parsing or in-memory book mutation. WAL records preserve source payload, local
wall time, monotonic time, connection epoch and event sequence; segments rotate,
gzip, checksum-verify and can mirror to an off-host mounted directory through
`BORG_WAL_MIRROR_DIR`. A 10 GiB disk reserve is enforced.

Storage: the shared Neon database is a ~2-hour rolling derived-tape buffer because
the seven-asset stream is too large for its 512 MB cap. The scorer writes each
expired batch to `~/.deltaforge-archive/borg-raw` as atomic, gzip-compressed,
checksum-verified NDJSON **before** deleting those exact rows from Postgres.
Measured 2026-07-14 archive growth was ~300 MB/day (~9 GB/month); pruning is
refused if archive verification fails or local free space would fall below the
10 GiB reserve. `node borg/recon/status.js` reports archive health and free
space. This preserves raw tape from the archive deployment onward; rows pruned
before it was deployed cannot be recovered.

The H9–H13 provisional portfolio and its developmental replay are documented
in `HYPOTHESIS_PORTFOLIO_V2.md`; run `npm run research:v2`. Coinbase control
and RTDS Chainlink ticks are archived under the same loss-safe policy as the
other derived feeds. Set `BORG_PARQUET_MIRROR_DIR` to an off-host mount and run
`node scripts/parquet-mirror.js`; immutable Parquet outputs and SHA-256 manifests
are never overwritten.

The H14-H21 forward-only shadow portfolio is documented in
`HYPOTHESIS_PORTFOLIO_V3.md`. It includes three robust-volatility experiments
derived from the measurement lessons in Barclays' expected/implied versus
adjusted-realized volatility work plus five independent propagation,
resolver-basis and complement-consistency hypotheses. All begin as pilots;
none has a live path or profitability claim.

The bounded multi-horizon H22-H31 portfolio is documented in
`HYPOTHESIS_PORTFOLIO_V4.md`. It adds hourly Up/Down, daily threshold and daily
range collection without changing the H1-H21 population. These are paper-only
pilots; no pre-deployment backtest exists because the required generic-market
CLOB tape begins with this collector version.

The H32-H51 portfolio is documented in `HYPOTHESIS_PORTFOLIO_V5.md`. Fifteen
pilots test new path, volatility, flow, depth, resilience, cross-sectional and
boundary mechanisms. Five additional event-driven pilots measure dislocations
between direct Binance, Coinbase, Hyperliquid, Chainlink RTDS and Polymarket's
separately transported Binance RTDS path. They are resolver/transport
arbitrage tests, not risk-free locks: no atomic external hedge exists.

The H2/H3/H6 paper pilots now run randomized event-versus-1s-sampled arms. A
stable market-level hash assigns each market to exactly one arm; economic
thresholds and 250ms order latency are identical. The frozen manifest requires
300 independent signaled markets per strategy and arm before a read. This does
not make any profitability claim.

Postgres remains a derived-data convenience layer. CLOB and RTDS failed batches
are retained for retry; the append-before-process WAL is the durable source of
truth during a database outage.

## Phase status

- [x] Phase 0 — prior-art harvest, theses + protocol pre-registered
- [ ] Phase 1 — recon collection (launched 2026-07-11; 24–48h+ of CLEAN data —
      the clock effectively restarted 2026-07-11 ~13:36 UTC after the silent
      Binance-feed outage, see RECON.md data-quality appendix)
- [ ] Phase 2 — thesis adjudication (BUILD / DEAD / STARVED per thesis)
- [~] Phase 3 — shadow harness LIVE in pilot mode (`borg/shadow`, SHADOW.md);
      strategy parameters not frozen — pilot rows are machinery-tuning data,
      not evidence. Verdict-dead strategies will be removed at adjudication.
- [ ] Phase 4 — parameter freeze (tagged commit, phase→'eval'), then
      pre-registered forward evaluation → RESULTS.md, VERDICT.md
