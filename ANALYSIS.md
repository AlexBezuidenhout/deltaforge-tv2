# ANALYSIS.md — Phase 2 Per-Bot Deep Dive (2026-07-12)

Data basis: deduplicated, taint-filtered tables per INTEGRITY.md. Tape window =
Jul 11 22:39Z → Jul 12 ~02:00Z (tape before that was truncated in the DB-full
cleanup; only scores computed live during 13:42–17:44Z survive from the earlier
period). BORG aggregates drift as the 5-min scorer runs; figures stamped at query time.

---

## MAIN

### Fill-realism gap: the paper edge inverts under tape-verified fills

Every MAIN closed trade whose order lifetime overlaps the tape was replayed
against `borg_clob_events` prints (`last_trade_price`, same token): a resting GTC
buy limit at the recorded entry price fills only if the tape shows trading at or
through that price before window end.

| (25 trades, Jul 11 22:39Z→) | n | W/L | P&L |
|---|---|---|---|
| Paper (as recorded) | 25 | 14/11 | **+$10.01** |
| Would fill — generous (any print ≤ entry) | 16 | 6/10 | **−$54.34** |
| Would fill — strict (crossing volume > order size) | 15 | 6/9 | **−$64.36** |
| Would NOT fill | 9 | **8/1** | (+$76.85 of paper P&L) |

Avg time-to-fill among fillable trades: 98.6 s (paper fills instantly).

**Mechanism** (structural, not sampling noise): a resting buy limit fills when
someone sells *down through* your price — i.e. disproportionately when the market
is moving against your signal. When the signal is right, price runs and the order
never fills. Win rate among fillable: 37.5%; among unfillable: 89%. The same
asymmetry shows up independently in George's replay and in BORG A_maker's tape
data — three independent measurements of one phenomenon.

**Haircut on the headline +$107.54:** the tape-window sample says the achievable
P&L is not merely smaller — it is likely **negative**. n=25 is small, but the
effect size (sign flip, W/L inversion) and the mechanism's structural nature make
"MAIN's paper P&L is an upper bound" an understatement. Honest-fill simulation is
mandatory before any number from this bot is believed.

### Entry timing (n=50 joinable trades)

| Remaining at entry | n | W | P&L |
|---|---|---|---|
| 242–297 s (first minute) | 23 | 16 | +$74.01 |
| 180–239 s | 12 | 5 | −$29.73 |
| 129–165 s | 7 | 7 | +$60.61 |
| 74–116 s | 7 | 5 | +$16.59 |

No monotone late-entry effect; the "<90 s entries drive wins and wipeouts"
hypothesis is **unconfirmed** on this sample. Fill realism dominates timing.

### Calibration — which component carries the signal (n=231 resolved TRADE signals)

| Estimator | Brier (lower better) |
|---|---|
| Φ-model (`p_phi`) | **0.3132 — worse than a coin (0.25). Anti-informative.** |
| Heuristic (`p_heur`) | **0.2197** — only component beating the price |
| Ensemble (`model_prob`) | 0.2465 — Φ dilutes the heuristic to worse-than-price |
| Market price (`yes_price`) | 0.2372 |
| Coin (0.5) | 0.2500 |

Calibration table: extremes are honest (claimed 0.17 → realized 0.21; 0.83 →
0.84) but the mid-range is anti-calibrated (claimed 0.75 → realized **0.43**;
claimed 0.65 → 0.50). `EV_adj` ↔ realized ROI correlation on 90 executed trades:
**+0.018 ≈ zero** — confirms the prior audit's finding on a larger sample. The
heuristic's 0.0175 Brier advantage over price is suggestive but not significant
at n=231 (z ≈ 1.2); treat as the hypothesis to test, not a conclusion.

**Verdict:** the ensemble that sizes trades is worse than using the market price
as-is. If anything carries signal it is the heuristic alone; Φ (as currently
parameterized) should not touch `modelProb`.

---

## GEORGE

### Signal-source isolation (51 closed, deduplicated)

| Source | n | W/L | P&L | avg/trade |
|---|---|---|---|---|
| George's own divergence signal | 38 | 18/20 | **−$27.48** | −$0.72 |
| Mirrored MAIN 100%-confidence trades | 13 | 12/1 | **+$267.99** | +$20.61 |

**George has no independent edge.** The divergence anchor is a small net loser;
the entire +$240.51 headline is the mirror path — i.e. George is MAIN's
top-confidence subset with a second stake. And that subset does not survive
honest fills: of the 4 mirror trades inside the tape window (3 paper wins,
+$52.73), the **only one that would have filled is the loss** (−$25.00). The
mirror wins are precisely the run-away-price trades a resting order never catches.

### Oracle staleness

Retro-computed from `borg_chainlink_rounds` (oracle_updated_at nearest below
entry): 36/39 measurable entries had oracle age >120 s — normal for a
deviation-threshold feed in calm markets — and losses do **not** cluster on stale
entries on this sample. Inconclusive; per-trade oracle age should be logged at
entry going forward (Phase 3) rather than reconstructed.

---

## BORG

### A_maker adverse-selection autopsy — the hypothesis was wrong, and the truth is worse

Conditioning 578 tape-verified fills on placement/fill features:

1. **Taker-aggressiveness/toxicity hypothesis REFUTED — inverted.** Post-restart
   fills during calm BTC (10s velocity <1 bp): −$3.54/fill, 38% WR. Fast-move
   fills (3–8 bp): −$0.64/fill. Fills during fast moves are the *least* bad.
2. **Φ-disagreement conditioning:** fills placed while |phi_fair − gamma_up| <
   0.05 run ≈ breakeven (−$0.09/fill, n=64); every disagreement bucket loses
   (−$0.50 to −$0.97/fill). 66% of all fills happened with Φ >15¢ from the
   market — those "quotes" were directional bets at model-chosen prices, and the
   model is anti-informative (Brier 0.31, above).
3. **The dominant mechanism is unbounded inventory, not flow toxicity.**
   Post-restart, 15 of 30 markets were net positive; 9 markets lost >$20 each
   (−$757 of the −$642 net). The killers: 11–21 *same-side* fills in one 5-min
   window (e.g. market 3622: 15 consecutive BUYs, 218 tokens, resolved against →
   −$168; market 3610: 15 SELLs, 205 tokens → −$105) — all in near-strike markets
   with tiny BTC moves (0.01–0.04%). The 5s re-quote loop feeds a one-sided drift
   until resolution takes the whole stack.

**Inventory-cap counterfactual** (first N fills per market+side, all data):

| | uncapped | cap 1 | cap 2 | cap 3 | cap 5 |
|---|---|---|---|---|---|
| Total P&L | −$360.39 | −$94.02 | **−$81.90** | −$125.28 | −$145.85 |
| Pre-incident only | +$281.78 | | **+$7.56** | | |
| Post-restart only | −$642.17 | | **−$89.45** | | |

The cap removes the catastrophe — and also removes the pre-incident "profit":
**+$282 → +$7.56.** The good period was the same uncapped deep-stacking getting
lucky on outcomes, not skill. Capped A_maker is ≈ breakeven-slightly-negative in
both regimes. There is **no configuration in this data where A_maker shows a
positive edge**; the conditioning produces damage control, not alpha. (advsel_5s
≈ +0.09 is computed against phi-fair, which is itself unreliable — do not trust it.)

### F_yield — killed by arithmetic

Buys the favored side at avg 0.9513 in the last 20–60 s. Per token: win nets
(1−p)−fee = +$0.030, loss nets −p−fee = −$0.970.

- Breakeven win rate **gross**: 95.13%
- Breakeven at 1× fees: **97.0%**
- Achieved: **92.1%** (35/38) — and these are unverified taker-assumed fills;
  reality is worse.

Even a 100%-selective version needs near-perfection with zero payoff cushion.
**Verdict: DEAD. Retire.**

### D_consistency — structurally fee-fragile, insufficient data

Buys both sides when ask_UP + ask_DOWN ≤ 0.99 (≥1% gross edge) — but round-trip
taker fees at the protocol's own 1× grid are ~2% of notional, i.e. **minEdge <
costs by construction**. 18 fills, +$6.44 at 1×, +$1.76 at 2×, 50% WR.
**Verdict: insufficient data / dead as parameterized.** Only viable if re-specified
with minEdge > 2× fee and tape-verified leg fills.

---

## Cross-cutting conclusion

One structural fact explains most of this system's paper-vs-reality gap:
**in binary 5-min markets, resting orders fill against you and instant paper
fills assume away exactly that.** MAIN (+$10 → −$54), George mirror (+$53 → −$25),
and BORG A_maker (only tape-honest system: negative from day one) all measure it.
Any strategy evaluated here must be scored back-of-queue against tape — which is
precisely BORG's EVAL_PROTOCOL. The protocol was right; the paper bots weren't
following it.
