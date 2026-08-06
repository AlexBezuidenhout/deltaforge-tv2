# H43 causal full-depth execution replay

**Audit date:** 6 August 2026  
**Strategy:** `H43_resolution_boundary_buffer`  
**Experiment:** `research-h43-forward-v1`  
**Authority:** read-only paper research; the frozen signal, sizing, paper scores and all live-order paths were unchanged

## Outcome first

H43 does **not** currently show a profitable executable edge. The new raw-book replay finds negative doubled-cost PnL at every requested order-latency profile on the entire cohort for which immutable depth actually exists:

| Order latency | Markets | Exact fills | Proven non-fills | Invalid/unscoreable | Wins / losses among fills | Exact PnL at 1x costs | Exact PnL at 2x costs | One-tick 2x counterfactual |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 ms | 37 | 26 | 11 | 0 | 19 / 7 | -$6.19 | **-$9.36** | -$1.57 |
| 250 ms | 37 | 28 | 9 | 0 | 21 / 7 | -$7.19 | **-$10.32** | -$12.13 |
| 500 ms | 37 | 28 | 8 | 1 redundant-path disagreement | 21 / 7 | -$7.59 | **-$10.99** | -$13.18 |

The apparently attractive win rates do not overcome entry price, payoff asymmetry and fees. This is the exact failure mode warned about in the wider audit: predicting the eventual side correctly is insufficient when the executable token price already embeds that probability.

The one-tick column is a separate fill-set counterfactual, not an extra fee added to the exact fills. At 100 ms it removes several exact-limit fills, including losses, and therefore looks less negative. It is still below zero and reverses at 250/500 ms. It cannot be selected after observing outcomes or represented as evidence of profit.

## Evidence boundary

The database contains 97 resolved first-in-market H43 intents from 19 July through 6 August. Immutable raw `polymarket-clob` WAL begins on Google Drive on 26 July:

- 37 markets have raw-depth archive coverage;
- 60 earlier markets have no archived raw book and remain explicitly unscoreable;
- no midpoint, later snapshot or current book was substituted for those missing observations.

The existing broad H43 headline of roughly +$11.68 at doubled costs therefore cannot be treated as execution-validated. It is dominated by a period for which full-depth arrival evidence is unavailable and uses the older primary fill model.

On the exact 37-market covered cohort, that older `latency_1s` primary scorer recorded 17 fills and **-$11.35** at doubled costs. Its jointly A/B slice was +$1.79, but contained only five fills. The new replay reconstructs more executable fills and remains negative. The old and new PnLs are comparator arms and are never pooled.

## What was implemented

### Deterministic L4 taker replay

`borg/research/full-depth-wal-replay.js` reconstructs every CLOB connection shard independently from a full `book` frame plus subsequent `price_change` deltas. It:

- parses every numeric field, including PostgreSQL values, before arithmetic;
- selects the correct UP/DOWN asset without mixing BTC-native and token-price units;
- applies only frames whose local receive time is at or before hypothetical venue arrival;
- preserves source time, receive wall time, receive monotonic time, sequence, connection epoch, shard and WAL event identity;
- clears state on a real sequence gap, collector-run change or connection-epoch change;
- requires a fresh transport and a full-book base;
- reconstructs redundant shards independently and fails closed if their exact or stressed fills disagree;
- walks all displayed depth through the original limit and retains partial fills;
- reports a genuine non-fill only when a valid reconstructed book proves the limit was not executable;
- charges the shared Polymarket crypto taker-fee model at 1x and 2x;
- runs a separate pessimistic one-tick-per-level fill counterfactual;
- labels the result L4, while explicitly retaining the limitation that only authenticated exchange acknowledgement/fill telemetry would be L5.

Missing archives, stale transports, path disagreement, malformed state and provenance failures contribute zero PnL and are not reclassified as non-fills.

### Bounded archive orchestration

`scripts/h43-full-depth-replay.js` is a read-only command-line audit. It:

- selects the frozen first H43 intent per independent market by default;
- supports 100/250/500 ms profiles, bounded dates, one order, latest-N and plan-only reads;
- lists local and Google Drive WAL without restoring the complete archive;
- checks an explicit transfer-size ceiling and a 20 GiB disk reserve;
- downloads selected remote objects in one checksummed batch;
- verifies file size and gzip integrity while parsing;
- removes its temporary cache in a `finally` path;
- separates intentionally omitted intervals between target windows from genuine raw sequence gaps;
- compares the exact cohort with stored primary paper scores;
- writes an atomic JSON result when requested.

The reproducible command is:

```bash
npm run replay:h43-full-depth -- \
  --since 2026-07-26T00:00:00Z \
  --lookback-ms 60000 \
  --profiles 100,250,500 \
  --source auto \
  --json-out /var/lib/deltaforge/research-tools/h43-l4-v1/available-60s.json
```

The completed VPS pass read 95 compressed segments (488,343,886 bytes), 5,219,528 NDJSON lines and 5,219,433 event envelopes. It found zero malformed lines, payload parse errors, segment read failures or wall-clock regressions. The temporary cache was removed after the result was written.

The first bounded run conservatively cleared state across 24 intentionally omitted intervals but labelled those resets as sequence gaps in diagnostics. That label did not affect any fill because every later interval had to rebuild from a new full book. The implementation now records these as `selectionWindowResets`; genuine within-window sequence gaps remain fail-closed. A regression test covers this distinction.

## Interpretation and decision

This replay repairs the measurement path; it does not improve H43's economics. The covered forward cohort says:

1. the older paper fill model was not the sole reason for poor performance;
2. lower order latency does not turn the observed H43 rule positive;
3. displayed depth was often sufficient, so widespread non-fill is not a rescue explanation;
4. high raw win rate is being offset by the prices paid, losses and taker fees;
5. the historical positive aggregate is not robust enough to justify tuning or live capital.

H43 should remain an unchanged paper control, not a live candidate. No threshold, asset filter, direction, price band or size should be selected from these 37 outcomes. H43-X is a separately registered hypothesis and must not inherit H43's historical rows.

The next valid evidence step is prospective: replay every newly resolved H43 intent from raw WAL, retain A/B execution evidence at all three latency profiles, and require the frozen 300-independent-market/14-day protocol. Promotion still requires positive doubled-cost PnL in both chronological halves, clustered lower confidence bounds above zero, multiple-testing correction, realistic shared-$500 capacity and no dominant asset/day. Based on the evidence above, H43 presently fails before those later gates.

## Verification

- Focused full-depth replay tests: 11 passed, 0 failed.
- Full repository suite after the final diagnostic-label patch: 736 passed, 0 failed.
- `git diff --check`: passed.
- VPS dashboard health remained `ok`, PostgreSQL remained ready with zero recent write errors, and the production TV2 service remained active throughout the read-only replay.
- No service restart, evidence-epoch change, database migration, score overwrite or authenticated order action occurred.
