# INTEGRITY.md — Phase 1 Data-Integrity Audit (2026-07-12)

Everything below was verified against the live Neon DB on 2026-07-12 ~01:30–02:00Z.
All timestamps UTC. Queries inline so every number is reproducible via `node scripts/q.js "<sql>"`.

---

## 1. Root cause of the duplicate-trade saga: THREE server processes

The `forceTakeTrade` mutex fix (commit d9d8890) was correct but insufficient. The
post-fix duplicates arrived **milliseconds apart** — impossible for two code paths
inside one single-threaded Node process to produce. `ps` + `lsof` showed three
`node src/index.js` processes, each auto-starting both bots on boot:

| PID | Port | Started | Code version |
|---|---|---|---|
| 30688 | :3004 | Jul 11 3:01pm (nohup, NEXT.md item) | pre-mutex-fix |
| 77583 | :47001 | Jul 11 8:23pm (stale termato restart) | pre-mutex-fix |
| 6628 | :47000 | Jul 11 11:38pm (current) | fixed |

Every signal fired up to 3× → pairs 1 ms apart, and one **triple** (george ids
85/86/87, market 2876782, 01:15:55.539/.540/:56.988). MAIN was equally affected
from 22:40Z (ids 202/203, 210/211, 214/215, 227/228 — the last pair was an OPEN
duplicate at audit time).

**Fixes applied:**
- Killed PIDs 30688 and 77583. One server process remains (6628, :47000).
- Archived + deleted duplicate rows (kept `MIN(id)` per group) into `dup_archive`
  (13 george_trades rows, 4 trades rows — nothing destroyed, all in `dup_archive.row_data`).
- **DB-level guards** so no process count can ever corrupt again:
  - `CREATE UNIQUE INDEX george_trades_one_per_market ON george_trades (user_id, market_id)`
    (George's design is one trade per market ever — all multi-rows were <1.5 s apart, i.e. pure dupes)
  - `CREATE UNIQUE INDEX trades_one_open_per_market ON trades (user_id, market_id) WHERE status='open'`
    (MAIN legitimately re-enters after a close/flip, so only concurrent opens are blocked)

Dedup sweep queries:
```sql
SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id, market_id, direction ORDER BY id) rn
FROM george_trades;             -- rn>1 → duplicate (13 rows)
SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id, market_id, direction, entry_price,
  date_trunc('minute',created_at) ORDER BY id) rn FROM trades;   -- rn>1 (4 rows)
```

## 2. BORG scoring completeness — the +$287 → −$428 story, corrected

**The prior narrative ("backfill of DB-full orders flipped the P&L") is wrong.**
Reconstruction from `borg_events` heartbeats (one per ~60 s; gaps = collector down):

| Window (UTC) | What happened |
|---|---|
| Jul 11 10:49 → 13:37 | Collector down 167 min (before shadow trading began 13:42 — no orders affected) |
| Jul 11 17:44 → 22:38 | **DB full** (`could not extend file... 512 MB`); ALL writes failed: tape, orders, scores, heartbeats |
| Jul 11 22:38–39 | DB freed by truncating tape tables; collector resumed; tape restarts from zero |

Because order placement **also** stopped during the DB-full window (the shadow
engine's flush failed too), there is no scored-during-outage cohort. Hourly P&L:

| Hour (UTC) | placed | fills | pnl_1x |
|---|---|---|---|
| Jul 11 13:00–17:59 (pre-incident) | 1,720 | 333 | **+$286.97** |
| Jul 11 22:00 – Jul 12 01:00 (post-restart, complete tape) | 1,178 | 233 | **−$680.53** |

The flip was **real trading losses on fresh, complete tape** — concentrated in the
00:00Z hour (−$473 on 111 fills). Regime analysis is Phase 2 work.

**Actual taint found (both marked, neither material):**
- **44 orders** placed pre-truncation but scored post-restart against empty tape →
  all `filled=false`, **$0 P&L impact** (biases A_maker's fill rate down ~1.5%, nothing else).
- **9 fills scored 17:44:46–58** — during the exact seconds tape flushes were dropping
  (244–413 rows per flush). Fill confirmations unverifiable. Sum: **+$15.08**.

```sql
-- taint class 1
SELECT COUNT(*), COUNT(*) FILTER (WHERE s.filled) FROM borg_shadow_scores s
JOIN borg_shadow_orders o ON o.id=s.order_id
WHERE s.scored_at > '2026-07-11T22:38Z' AND o.ts < '2026-07-11T22:38Z';  -- 44, 0
-- taint class 2 (fills scored during tape death)
SELECT COUNT(*), SUM(pnl_1x) FROM borg_shadow_scores
WHERE filled AND scored_at BETWEEN '2026-07-11T17:44:30Z' AND '2026-07-11T17:45:10Z'; -- 9, +15.08
```

**Structural findings (worse than the taint):**
- The scorer performs **no tape-coverage check** — a maker order scored against
  missing tape silently becomes `filled=false` and is never rescored
  (`ON CONFLICT (order_id) DO NOTHING`). Fixed: scorer now records
  `detail.tape_events` / `detail.tape_blind` on every maker score.
- **Taker-kind orders are never tape-confirmed at all.** All of D_consistency and
  F_yield "fills" are assumed at the logged displayed ask. Their results are
  paper-quality, not tape-verified evidence (contra what the dashboard implies).
- The 48 h prune added on Jul 12 had two defects, both fixed in `borg/shadow/score.js`:
  (a) wrong column (`open_time`; table uses `ts`) so `borg_binance_1s` never pruned;
  (b) it ran **before** scoring, so any order left unscored >48 h (exactly what a
  DB-full episode causes) would be scored tape-blind. Prune now runs **after**
  scoring and never deletes tape newer than `oldest unscored order − 1 h`.
- Repo `borg/shadow/score.js` and runtime `~/.borg-runtime/.../score.js` had
  diverged (runtime ahead). Repo is canonical again; deploy at Phase 4 relaunch
  via `bash borg/recon/deploy.sh`.

## 3. Write-failure hygiene

- BORG collector already logs every failed flush to `borg_events` with dropped-row
  counts (this audit's reconstruction relied on it) — left as is.
- MAIN/GEORGE/server: instrumented the shared pg pool (`src/models/db.js`).
  Every failed INSERT/UPDATE/DELETE increments `dbHealth.writeErrors`, lands in a
  50-entry ring buffer, and logs loudly.
- `/api/health` (src/index.js) now reports: `dbWritable` (live write probe — a
  1-row INSERT that fails the moment Neon hits its cap), `dbSizeMb`,
  `writeErrors`, `readErrors`, `lastDbErrorAt`, `recentDbErrors`. Returns
  **HTTP 503** when degraded. The next DB-full is detectable in one poll, not 5 hours.

## 4. Recomputed headline stats (deduplicated, taint-aware)

As of 2026-07-12 ~02:00Z:

| Bot | Sample window (UTC) | Closed | W/L | Win rate | P&L |
|---|---|---|---|---|---|
| MAIN | Jul 10 14:46 → Jul 12 01:23 (~35 h) | 87 (+1 open) | 55/32 | 63.2% | **+$107.54** |
| GEORGE | Jul 10 15:15 → Jul 12 01:16 (~34 h) | 51 | 30/21 | 58.8% | **+$240.51** |
| BORG A_maker | Jul 11 13:42 → ongoing | 561 fills / 2,973 orders (19%) | ~300/229 | ~55% | **−$329.76** (−$344.84 excl. 9 tainted fills) |
| BORG D_consistency | same | 18 fills (taker, unverified) | 9/9 | 50% | +$6.44 |
| BORG F_yield | same | 37 fills (taker, unverified) | 32/2 (of 34 at audit) | ~94% | **−$9.71** |

Notes:
- Previous dashboard figures were inflated: George showed ~$287 raw P&L (dupes),
  balance $1,123. Reconciled balances written to `bot_settings`:
  `paper_balance = 584.64` (500 reset + 97.14 closed P&L since session #46 − 12.50 open stake),
  `george_paper_balance = 740.51` (500 + 240.51). In-memory sync happens at the
  Phase 4 restart.
- BORG numbers move every 5 min as the scorer runs; the A_maker CI at audit was
  mean/fill −$0.588, 95% CI [−1.137, −0.035] — significantly negative.
- All BORG data is `phase='pilot'` — by the project's own EVAL_PROTOCOL §3 it
  tunes machinery and is **not evidence** for or against an edge.

## 5. Open integrity risks carried into Phase 2+

1. MAIN paper fills remain optimistic (instant fills; late-window entries) — Phase 2 quantifies with tape replay.
2. D/F taker fills unverified against tape — Phase 3 should score them back-of-queue or at least tape-touch-confirmed.
3. `borg_binance_1s` PK is `ts` — fine, but the table only matters for Q3 analysis; prune now covers it.
4. Session #48+ trades in `trades` have `session_id` from whichever process wrote them — cross-process session rows are muddled pre-cleanup; per-session stats before Jul 12 02:00Z should be treated as approximate. All-time per-market stats are clean post-dedup.
