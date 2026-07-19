# RELAUNCH.md — Phase 4 (2026-07-12 ~10:30Z)

Relaunch executed after a full verification pass of the Jul-12 audit
(INTEGRITY.md, ANALYSIS.md, IMPROVEMENTS.md §10–12). Historical data was NOT
wiped; baselines snapshotted for later comparison.

## What is running

| Component | How | Identity at relaunch |
|---|---|---|
| Dashboard + MAIN + GEORGE | `node src/index.js`, detached (nohup), port :3004, holds the `deltaforge-bot-runner` advisory lock | pid 30500 |
| BORG collector + shadow engine | launchd `com.borg.recon` (KeepAlive + RunAtLoad), runs from `~/.borg-runtime` | pid at deploy 30486; respawned by final deploy — identity changes on every crash/restart by design |
| BORG scorer | launchd `com.borg.score`, one-shot every 300 s | transient by design |

PIDs are point-in-time; the durable invariants are: **exactly one** `node
src/index.js` (enforced by the advisory lock + unique indexes), launchd owns
BORG, and `bash borg/recon/deploy.sh` is the only correct way to ship code
under `borg/` (edits do nothing until deployed).

Ordered restart performed: prune verified (tape bounded at 6 h) → collector →
scorer → server (bots auto-adopt open positions; none were open). Stale
processes: none found (single server since the Phase-1 triple-process kill).

## Verification gauntlet — all passed, evidence inline

1. **Served HTML == disk**: sha256 `da216eab42577619…` identical for
   `curl :3004/` and `public/index.html`.
2. **/api/health**: `status ok`, `dbWritable true`, `writeErrors 0`,
   all four components fresh (`main_bot` 3 s, `george_bot` 0 s,
   `borg_scorer` 49 s, `borg_collector` green after WS warm-up). The new
   feed-degraded detector correctly flagged the collector's CLOB WS during
   its warm-up window and cleared itself — the alive-but-blind state is now
   visible.
3. **Signal cycles**: 35 signals + 13 gate-skips logged in the 10 min after
   restart (MAIN); George heartbeat ticking with oracle-age logging active;
   BORG A_maker + A2 both quoting (`ORDERS_FLOWING`).
4. **Scorer latency**: zero orders older than 7 min unscored
   (`SCORER_CURRENT`); 5-min cadence intact.
5. **Dashboard numbers**: served from the deduplicated tables (dupes deleted,
   archived in `dup_archive`; unique indexes prevent recurrence). Caveats
   that remain by design: the George tab's all-time P&L includes the
   mirror-era +$268 (historical fact; per-source split lives in ANALYSIS.md),
   and BORG aggregates include the 9 flagged 17:44Z fills (+$15.08 — with/
   without both reported in INTEGRITY.md §2).
6. **DB size & growth**: 278 MB of 512. Tape tables bounded at 6 h retention
   (~258 MB steady state). Unbounded growth measured at ~8.8 MB/day →
   ~26 days-to-full, BELOW the >30 bar — fixed in this relaunch: scorer
   hygiene now drops fully-scored pilot cancel rows >48 h and strips feature
   blobs >7 d, cutting the dominant term (`borg_shadow_orders`, 5.4 MB/day)
   to roughly its third. **Projected days-to-full ≈ 45+.** Re-check the
   projection in 48 h against `relaunch_baseline.db_size_mb` (278 at
   2026-07-12T10:09Z).

## Baseline at relaunch (`relaunch_baseline`, label `2026-07-12-verify-relaunch`)

| Bot | Closed/fills | Wins | P&L |
|---|---|---|---|
| MAIN | 91 | 57 | +$126.90 |
| GEORGE (own signal only) | 42 | 19 | **−$87.28** |
| BORG A_maker | 662 fills | 360 | **−$546.64** |
| BORG A2_maker_capped | 10 fills | — | +$11.74 |
| BORG F_yield (retired) | 38 | 35 | −$9.72 |
| BORG D_consistency (retired) | 18 | 9 | +$6.44 |

## What to check after ≥300 new trades/fills per bot

| Bot | Metric (pre-registered in IMPROVEMENTS.md) | Confirms | Kills |
|---|---|---|---|
| MAIN | Brier(model_prob) == Brier(p_heur) and < Brier(yes_price) on ≥300 resolved TRADE signals **counted from commit `07b3c15`** (the phi-mute only became real then) | heuristic carries signal | Brier(p_heur) ≥ Brier(yes_price) → no probability edge, stop tuning gates |
| MAIN | strict-fill paper fill rate ≈ 60–65% and time-to-fill ≈ 90–100 s; P&L of strict-fill entries | fill sim honest | materially positive sim P&L that a tape replay contradicts |
| GEORGE | own-signal win rate ≥100 trades, Wilson 95% CI | independent edge exists | CI upper bound < 55% → retire or re-derive |
| GEORGE | loss rate for oracle_age_sec >120 vs ≤120 (Fisher, α=0.05) | staleness skip justified | no separation → don't add the skip |
| BORG | A2 ≥300 fills: mean pnl_1x/fill bootstrap 95% CI vs 0 and vs A_maker same-window | cap+band ≥ breakeven | CI < 0 → A2 dead and Thesis A with it |
| SYSTEM | days-to-full projection at +48 h; any component-down event red within 2 min | monitoring works | a silent outage >2 min |

## Executive summary — edge verdicts, plainly

**MAIN: no demonstrated edge net of honest fills.** The +$126.90 headline is
an instant-fill artifact: the only tape-verified replay available (n=25
before the tape window was pruned) flipped it to −$54, mechanism structural
(resting buys fill preferentially when the signal is wrong). What survives is
a candidate probability edge in the *heuristic alone* — Brier 0.2176 vs price
0.2354 on n=242, ≈1.2σ, not significant. Estimated honest edge today:
**$0/trade, CI spanning negative**. Falsifier for the optimistic branch:
Brier(p_heur) ≥ Brier(price) on the next 300 signals. The strict-fill sim
(actually in effect since `07b3c15`+restart) is the ongoing honest test.

**GEORGE: no independent edge, high confidence.** Own signal 19W/23L,
−$87.28 (win rate 45%, Wilson 95% CI ≈ [31%, 60%] — needs >55% upper bound
to survive its kill criterion at n=100). The mirror-era profit (+$268,
12W/1L) was MAIN's top-confidence subset double-staked, and its wins were
precisely the trades a resting order wouldn't have filled. Mirror is off;
George is now a clean experiment on the divergence anchor with oracle-age
logged. Expectation: retirement at the n=100 checkpoint unless the signal
sharpens.

**BORG: no viable strategy yet — and the only honest measurement stack.**
A_maker is dead (−$546.64 over 662 back-of-queue fills, mean −$0.83/fill;
the earlier +$287 was luck-on-unbounded-inventory, confirmed by the cap
counterfactual collapsing it to +$7.56). F_yield is dead by arithmetic
(breakeven 97% at 1× fees vs 92.1% achieved). D_consistency is dead as
parameterized (minEdge < round-trip fees). A2_maker_capped is the one live
hypothesis: honest expectation ≈ breakeven (+$11.74/10 fills is noise);
judged at ≥300 fills. BORG's real asset is the eval protocol itself — it is
the reason none of these mirages survived.

**System: the three historical silent failures are now loud.** DB-full →
write probe + 503 within one poll; dead process → heartbeat red ≤2 min;
alive-but-blind feed → `feedStatus` red ≤2 min + collector self-restart
after ~5 min of a wedged feed.

**Honest bottom line:** nothing in this system has yet demonstrated a real,
fill-adjusted edge. The relaunched configuration is the first one whose
numbers can be believed — strict fills, muted Φ (actually muted now),
quarantined mirror, capped inventory, tape-verified scoring, bounded DB, and
monitoring that fails loudly. The next 300 trades/fills per bot decide, on
pre-registered metrics, which — if any — of the three survives.
