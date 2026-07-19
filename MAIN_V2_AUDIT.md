# MAIN V2 reconstruction audit

Date: 2026-07-16  
Status: paper/shadow forward evaluation; no live order path

## Executive conclusion

The profitable-looking legacy Main history is not evidence that the strategy is
profitable. Before the executable-book repair, 470 closed trades showed
+$805.94, but entries were contaminated by synthetic liquidity. At the
reconstruction cutoff, the untouched post-repair Dublin cohort had lost
$110.02 over 82 independent markets (40.2% wins), and 73 resolution exits had
lost $90.79. This locates the current failure in entry
selection rather than stop-loss behavior. Claimed EV has almost no relationship
to realized return (`r=0.053`), and the executed model's current Brier score
(0.2377) is economically indistinguishable from its selected-cohort base-rate
baseline (0.2378). There is currently
no statistically defensible evidence that legacy Main has exploitable alpha.

Main V2 therefore starts a new strategy ID and a zero-observation evidence
cohort. It does not inherit legacy, residual-model, or H49 PnL. Profitability is
not promised; the valid research outcome may be that edge is approximately
zero.

## Past-trade autopsy

The table is the frozen audit snapshot at 09:01 UTC. BORG pilots continue to
score after that timestamp; `node scripts/main-v2-report.js` is authoritative
for the current rolling counts and makes their instability visible.

| Evidence set | Independent markets | Net PnL | Reading |
|---|---:|---:|---|
| Legacy pre-repair | 457 | +$805.94 | Invalid for promotion: synthetic entry-book contamination |
| Executable-book Dublin forward cohort | 82 | -$110.02 | Honest negative out-of-sample evidence |
| Residual challenger untouched holdout | 47 | -$56.20 at 2× costs | Rejected as an execution replacement |
| H49 developmental precursor | 146 valid fills | +$28.52 at 2× costs | Unproven: only 77.8% non-F coverage; clustered CI [-$0.67,+$1.05] includes zero |

The executable cohort was negative for both directions (YES -$41.14, NO
-$68.88). BTC (-$56.45) and ETH (-$56.65) were the largest losses; post-hoc
asset exclusion is not allowed. Most trades entered between 0.45 and 0.55 and
that band lost $79.10. The evidence does not support repairing legacy Main by
changing a confidence, EV, direction, asset, or price threshold on this same
sample.

## Root cause

The legacy heuristic is quote-relative: it constructs
`pHeur = marketPrice ± (btcEdge + microEdge)`. This mechanically manufactures a
probability/price divergence when BTC moves, whether or not Polymarket is
mispriced. Gate 2 then treats that constructed divergence as economic edge.
Across 7,702 trade signals, `corr(|btcDelta|, claimed EV)=0.440`, but across 548
closed trades `corr(claimed EV, realized ROI)=0.053`. The model's EV units are
therefore useful as a ranking feature at best, not a calibrated return forecast.

The current honest cohort mostly held to resolution, so replacing the exit
policy cannot fix the observed loss. The residual-logit challenger was also
tested on data after its training cutoff and failed; it remains telemetry-only.

## Frozen Main V2 mechanism

`MAIN_V2_resolver_quorum` is an event-driven, resolver-aware hypothesis for BTC,
ETH, SOL and XRP five-minute direction markets:

1. Require 60–300 seconds remaining and a Chainlink RTDS tick no older than
   3,000 ms.
2. Require Coinbase and Chainlink 10-second returns to have the same sign, each
   at least 2.5 bps, and differ by no more than 2.5 bps.
3. Require the quorum-minus-direct-Binance residual to have the quorum sign and
   magnitude of at least 2.5 bps.
4. Convert only the BTC/asset spot displacement to a binary probability; token
   asks remain on the 0–1 scale.
5. Cross the real side-specific CLOB ask only when at least 2 cents per share
   remains after **2×** taker fees.
6. Cap an order at $10 from the frozen $500 research bankroll and 20% of
   displayed top-level size. Score quote survival after 250 ms.
7. Hold to terminal resolution. One intent is allowed per independent market.

These values are mechanism/data-quality constraints inherited from the frozen
cross-network pilot, not a fit to Main's 79 losses. The entire specification is
**PROVISIONAL** until fresh forward evidence completes.

## Architecture and safety

- Main V2 runs in BORG's keyless shadow engine. It cannot sign or post an order.
- Legacy Main remains a signal/telemetry control, but its paper executor is off
  by default through `main_legacy_execution_enabled=false`.
- That cutoff is paper-only. No live-order call site was modified.
- `paper_trading` remains default `true`.
- Gate 1 remains informational and Gate 2 semantics in the legacy control are
  unchanged.
- The manifest freezes the hypothesis, evidence start, costs, sample rule and
  zero-edge disclosure. Prior H49 rows do not count as Main V2 evidence.

## Forward decision rule

Run `node scripts/main-v2-report.js`. Do not inspect a threshold and edit the
strategy during evaluation. After at least 500 independent markets and 14
calendar days, require all of the following before even reviewing a separately
capped live canary:

- at least 90% non-F data-quality coverage;
- positive 2×-cost PnL in both chronological halves;
- a multiple-testing-adjusted market-clustered lower confidence bound above
  zero;
- non-negative 5-second and 30-second adverse selection;
- no dependence on one asset, direction, day, or latency anomaly.

Failure of any condition means reject the frozen version or formulate a new
mechanism under a new strategy ID. A positive dashboard balance alone is not a
promotion criterion.
