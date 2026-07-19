# BORG — Microstructure Recon

**STATUS: ADJUDICATED 2026-07-13** (see table at bottom). Caveat that applies
to every tape-based finding below: multi-asset ingest forced tape retention
down to a **2-hour rolling window** (Neon 512MB cap), so Q1/Q6/F-calibration
ran on a 2h × 7-asset snapshot (~36k book snaps, ~27k taker prints), NOT the
originally-planned 24-48h archive. Q3 uses the full 2,176-market resolution
history (resolutions are never pruned). Q2/Q4/Q5 required JS tape-replay
tooling that was never built and cannot run retroactively on pruned tape.

Original preamble follows for the record: **DATA COLLECTION IN PROGRESS.** Collector launched 2026-07-11 (see
`recon/collector.log` and `node borg/recon/status.js`). This file currently
pre-registers the analysis methodology for each question; findings will be
filled in ONLY from data collected after launch. Target: 24–48h minimum
(288 markets/day), longer for the counterparty-pattern questions.

Analysis queries live in `recon/analysis/` and are written before the data
exists — the methodology is fixed so the answers can't be shopped.

---

## Q1. Spread and depth by time-to-resolution

**Method.** From `borg_book_snaps` (1s cadence): bucket by `tte_sec` in 15s
bins; per bin report median/p25/p75 of spread, top-of-book size, and depth
within 5¢ of mid (USD), split by book source (ws/rest). Cross-side consistency
(Thesis D) falls out of the same table: distribution of
`up_best_ask + down_best_ask` and `up_best_bid + down_best_bid`, flagging
snapshots where buying (selling) both sides locks a profit after 1× fees.

**Finding (2026-07-13, 2h × 7-asset window, n≈36k snaps).** Books are TIGHT:
median spread is 1¢ across the entire window, widening only in the last
15–30s (2¢ at 15s, 4¢ at 0–15s). Depth within 5¢ of mid runs ~$50–90/side
mid-window, collapsing to ~$5 in the final seconds. Median cross-ask sum is
1.01 at every bucket — the book is consistently priced ~1¢ *rich*, and
D-arb windows occurred in **7 of ~36,000 snapshots (~0.02%)**. Implication
for makers: with a 1¢ spread there is no spread to earn — the maker's gross
margin is a single tick against adversely-selected flow, which matches the
A_maker/A2 empirical losses exactly.

## Q2. Fair-value tracking efficiency and lag

**Method.** Compute Φ-fair offline from `borg_binance_1s` (frozen σ estimator:
EWMA of 1s log-returns, 60s time constant, scaled to remaining window; ref =
`binance_open` captured live at window start; tie-goes-UP handled by using
P(end ≥ start)). Cross-correlate Δfair vs Δtoken-mid at lags 0–30s per
tte-bucket; report the lag that maximizes correlation and the distribution of
token mispricing (token − fair) after ≥3σ 10-second BTC moves, with time to
50% correction. This directly measures Thesis C's window: if median correction
< 1.5s, C is dead.

*Methodology note (2026-07-11, smoke test, before collection proper):* the
online `phi_fair`/`sigma5m_ewma` columns are convenience series only. In a
dead-quiet period the 1s-return EWMA produced σ far below what the market was
pricing (token 0.28 vs online Φ ≈ 1e-11) — quiet-period realized vol is not
the market's forward vol. Canonical Q2 analysis recomputes fair value offline
from `borg_binance_1s` under several σ estimators (1s EWMA, 1m-return EWMA,
5m realized, and a jump-diffusion-robust variant) and reports how conclusions
depend on the choice. No σ estimator is selected by its Q2 performance and
then reused for evaluation on the same window (that would be in-sample
selection); the evaluation-window estimator is frozen per EVAL_PROTOCOL.md.

**Finding.** NOT RUN — the offline σ-replay tooling was never built, and the
raw 1s-bar archive it needed has since been pruned to a 2h rolling window.
Retroactively unrunnable as designed. If Thesis C-style work is ever revived,
this must be re-instrumented FIRST (the live `phi_fair` column stays
convenience-only). Marked STARVED, not DEAD: absence of tooling, not
absence of effect.

## Q3. Settlement divergence: does the outcome ever disagree with Binance?

**Method.** Established pre-collection: resolution is Chainlink **Data
Streams** (not the mainnet push feed — the George premise is wrong; ties go
UP). The original collector did not capture the stream, so it measured the *effective*
disagreement: per resolved market, predict outcome by sign(binance_close −
binance_open) (ties → UP) and compare to realized outcome from Gamma. Report
disagreement rate overall and conditional on |move| buckets (<1, 1–2, 2–5,
5–10, >10 bps) and on σ. Also: mainnet Chainlink round path (borg_chainlink_rounds)
as a sanity control. If disagreement concentrates in near-flat windows,
quantify whether final-seconds token prices misprice those windows (Thesis B's
surviving micro-form).

**Instrumentation update 2026-07-15:** Polymarket's free RTDS Chainlink topic
is now captured for BTC/ETH/SOL/XRP with source and local receive clocks. New
shadow rows log Binance/Chainlink divergence directly. This does not alter the
historical Q3 cohort and an RTDS tick is not assumed to be the final settlement
tick; it enables a fresh forward resolver-basis analysis.

**Finding (2026-07-13, FULL history: 1,716 live-boundary resolved markets —
this query is unaffected by tape pruning).** The pre-registered micro-thesis
is CONFIRMED as a phenomenon, with a sharp cliff exactly where predicted:

| \|move\| | n | disagree | % |
|---|---|---|---|
| <1bp | 174 | 62 | **35.6%** |
| 1–2bp | 171 | 17 | **9.9%** |
| 2–5bp | 397 | 9 | 2.3% |
| 5–10bp | 440 | 0 | 0.0% |
| >10bp | 534 | 0 | 0.0% |

Overall 88/1,716 ≈ 5.1%, entirely concentrated below 2bp. Binance sign is
near-worthless in flat windows (Chainlink Data Streams is a multi-exchange
aggregate that routinely differs from Binance by ~1bp) and essentially
perfect above 5bp. **Consequence for every model in this repo: any
Binance-anchored probability (Φ included) must be shrunk hard toward 0.5
when the projected move is <2bp — a Φ of 0.9+ built on a sub-2bp move is
fiction.** No *tradeable* edge demonstrated (that would additionally require
the market to misprice flat windows, unmeasured) — model hygiene, not alpha.

## Q4. Maker fill economics

**Method.** Tape-replay simulation over `borg_clob_events` (prints) +
`borg_book_snaps`: for δ ∈ {1, 2, 3, 5}¢ off Φ-fair, place hypothetical
two-sided quotes at each snapshot in tte ∈ [60s, 240s], queue behind displayed
size, fills granted only when tape volume at the level exceeds queue-ahead.
Report: fill rate per side, inventory distribution, adverse selection (fair
5s/30s after fill minus fill price), net capture per $100 quoted after 1×
fees. No strategy code — pure measurement.

**Finding.** NOT RUN as designed (tape-replay simulation never built; tape
pruned). Superseded empirically: the live shadow system measured real maker
economics far better than the planned simulation would have — A_maker
−$1,353 over ~1,100 back-of-queue-scored fills, A2_maker_capped −$0.52/fill
over 605. Maker fill economics are settled by execution data: negative.

## Q5. Counterparty patterns

**Method.** From `borg_taker_trades` (data-api prints with wallet + side) and
`borg_clob_events`: (i) burst detection — ≥3 same-side taker prints within
10s; measure token-vs-fair displacement and reversion at 30/60/120s (Thesis
E). (ii) Quote-pulling — book depth collapse rate in final 60s and after fast
BTC moves (feeds Thesis A risk model and Thesis C). (iii) Wallet-level:
repeat-wallet frequency, size distribution, hour-of-day heatmap of flow,
round-price clustering. (iv) Stale-book incidents: seconds per hour where
token mid is >5¢ from fair while book is live (Thesis C size-of-prize).

**Finding.** NOT RUN (burst/quote-pull tooling never built; tape pruned).
STARVED. The one adjacent datum that exists: A_maker's autopsy REFUTED the
flow-toxicity hypothesis (calm-market fills were the worst, fast-move fills
least bad), which removes Thesis E's core premise on this venue.

## Q6. Where does money change hands?

**Method.** Per resolved market, per taker print: PnL to resolution =
(outcome − price) × size for buys of the winning/losing token. Aggregate
taker PnL by entry-tte bucket, by side, by entry price band, and by hour.
This is the total pool any taker strategy feeds from and the pool makers
harvest. Also produces the final-minute calibration table for Thesis F
(implied vs realized win rate of 0.90–0.99 entries).

**Finding (2026-07-13, 2h × 7-asset window, ~27k BUY prints, ~$245k
notional).** Takers lose overall: aggregate ≈ −$2.1k on ~$245k (≈ −0.9%),
with the worst buckets early-window (240s: −17.2% ROI). The exception is
striking and consistent with the one live strategy: the 30–60s bucket is
POSITIVE for takers (+2.04% on the window's largest notional, $69.7k) —
late-window takers as a class are informed. This is precisely the seat
G_late_arb occupies. Final-minute favorite calibration (Thesis F table,
same window): realized ≥ implied in EVERY 0.90+ price bucket (e.g. buys at
avg 0.954 won 99.9% of the time; at 0.971, 99.6%). Near-certain favorites
were *underpriced* in the final minute on this sample.

---

## Thesis adjudication (to be completed after collection)

Adjudicated 2026-07-13. Verdicts below combine the pre-registered queries
(where runnable) with the shadow system's execution data, which in several
cases superseded the planned simulations with strictly better evidence.

| Thesis | Verdict | Evidence |
|---|---|---|
| A — Maker | **DEAD** | Executed, not simulated: A_maker −$1,353/~1,100 fills; A2 (cap+band) still −$0.52/fill at n=605. Q1 explains why: 1¢ median spread = no margin vs adversely-selected flow. Do not revive in any parameterization. |
| B — Resolution basis | **STARVED as strategy; CONFIRMED as model hygiene** | Q3: disagreement 35.6% at <1bp → 0% at ≥5bp. Binance-anchored probabilities must shrink toward 0.5 below ~2bp projected move. Tradability unmeasured. |
| C — Stale quote snipe | **STARVED as registered; mechanism partially vindicated via G** | Q2 tooling never built. G_late_arb — a late-window taker hitting lagging asks — is the mechanism's descendant and is positive in pilot. C as an all-window latency race stays unregistered. |
| D — Consistency arb | **DEAD** | Q1: 7 opportunities in ~36k snapshots (~0.02%); median cross-ask 1.01 (book priced rich). Plus fee arithmetic already fatal (min-edge < round-trip cost). |
| E — Flow fade | **DEAD-adjacent (STARVED, premise refuted)** | Q5 never built, but the A_maker autopsy refuted flow-toxicity on this venue — calm fills were the toxic ones. No burst-fade premise survives that. |
| F — Near-certainty yield | **DEAD as parameterized; evidence flows to G** | F_yield died on execution arithmetic (breakeven 97% at fees vs 92.1% achieved at 0.951 avg entry). BUT the pre-registered calibration table now shows realized ≥ implied in every 0.90+ bucket — the *edge family* is real; G_late_arb (phi≥0.88 gate, better entries at ~0.78 avg, real payoff cushion) is its living refinement, judged separately at its own n=300. |
| G — Late-window taker arb *(post-registered 2026-07-12)* | **PILOT — pending its own pre-registered n=300 read** | Q6: the 30–60s taker bucket is the only positive one (+2.04% ROI) — external corroboration that the seat G occupies is where informed flow wins. |

**One cross-cutting risk flagged for G from Q3:** a Φ ≥ 0.88 signal built on a
sub-2bp projected move is unreliable (B finding). G entries in near-flat
windows should be treated as the weakest cohort — worth a per-cohort split at
the n=300 read, NOT a parameter change now.

## Data-quality appendix

**Incident 2026-07-11 (silent Binance outage + reboot).** The Binance WS
reconnect chain died ~02:00 UTC (~1h after launch): a failed reconnect
attempt hit a dead code path and stopped retrying, and no silent-socket
watchdog existed. The frozen last price (64021.18) kept being stamped into
market boundary captures **labeled 'live'** until the machine rebooted at
10:50 UTC, which also killed the nohup'd supervisor. Consequences and
remediation:

- 107/120 market opens and 108 closes were contaminated; they manufactured a
  46/117 (39%) Q3 "disagreement" rate. `repair-boundaries.js` re-set them
  from official Binance 5m klines using a structural criterion (boundary
  labeled 'live' with no 1s bars within ±10s = feed provably dead), labeled
  `kline_repair`. Post-repair Q3: 7/117 (6.0%) — but kline-repaired
  boundaries are Binance-kline vs our tick-capture definition, so Q3
  conclusions should prefer markets with `binance_open_src='live'` (fresh
  data only) and treat repaired rows as a labeled, second-class sample.
- `borg_binance_1s` has a gap 01:56 → 13:36 UTC; Q2 (fair-value tracking)
  and any σ-dependent analysis must exclude that window entirely. Book
  snaps/tape/taker prints continued until 10:50 UTC (books were live), then
  gap to 13:36 UTC.
- Fixes now live: idempotent reconnect (retry chain cannot die), 30s
  silent-socket watchdog, boundary capture refuses stale prices (kline
  heals, labeled), `binance_close_src` added, launchd supervision
  (crash/logout/reboot-proof) via `~/.borg-runtime` mirror + `deploy.sh`.
- **Effective clean-collection start: 2026-07-11 ~13:36 UTC.** The 24–48h
  recon target counts from there.
