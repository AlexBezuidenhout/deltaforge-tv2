# BORG — Strategy Theses (pre-registered)

**Written 2026-07-11, BEFORE any recon data was collected or examined.**
This document is the pre-registration. Each thesis states its mechanism, its
counterparty, why the edge should survive professional competition, and the
recon evidence that would kill it. A thesis with no credible answer to "who is
paying us and why" does not get built, no matter how good a backtest looks.

Rule inherited from the prior project's failure: the old bot *manufactured*
its claimed EV by construction (`pHeur = price ± totalEdge`) and reported 25%
EV against a 45–49% realized win rate for weeks. Every thesis below therefore
names the observable, out-of-sample quantity that must move before we believe
anything.

---

## Facts established before registration (verification, not data mining)

1. **Resolution source is Chainlink Data Streams** (`data.chain.link/streams/btc-usd`),
   per the market description fetched live on 2026-07-11. This is the low-latency,
   pull-based, multi-exchange aggregate — **not** the Ethereum mainnet push feed
   (0.5% deviation / 1h heartbeat) that the legacy George bot models. George's
   deviation-band mechanism is founded on the wrong feed and its thesis is
   considered structurally refuted pending recon confirmation (Q3 measures the
   *effective* divergence between Binance sign and realized outcomes).
2. **Ties resolve UP**: "resolve to Up if the end price is greater than or equal
   to the start price." A zero-move window is an UP. Any fair-value model must
   use P(end ≥ start), not P(end > start).
3. Markets run continuously, 24/7, one 5-minute window at a time, slug
   `btc-updown-5m-<epochSec>`; sample market showed ~$14.8k posted liquidity and
   ~$224 volume with ~4h to listing-end — real books appear to exist now (the
   2025-era "boundary-only book" claim in CLAUDE.md may be stale; Q1 verifies).

---

## Thesis A — MAKER: two-sided quoting around fair value

- **Mechanism.** Quote both sides of the UP token at fair ± δ during the
  mid-window (roughly 240s→60s remaining), where fair = Φ-model on live BTC.
  Earn the spread when uninformed flow crosses; manage inventory by leaning
  quotes; flatten or stop quoting near resolution.
- **Counterparty.** Retail takers betting directionally on 5-minute BTC moves —
  gambling flow, price-insensitive, arriving via market orders. They pay the
  spread the way roulette players pay the house edge.
- **Why not competed away?** It partially is — this is the seat professional
  MMs occupy, and posted liquidity (~$15k) says someone is quoting. The
  residual question is whether the *quoted spread minus adverse selection* pool
  still has room for a small participant, especially in hours/regimes where the
  incumbent MM widens or pulls (recon Q1/Q5). Capacity for a marginal quoter is
  small but the edge is structural, not informational.
- **Capacity estimate (prior).** Sample market volume ~$200–500/window ⇒ if
  takers lose 2–4% of notional on average (Q6 measures this), the whole pool is
  ~$5–20/window across ALL makers. We'd capture a minority slice. This is a
  $50–200/day strategy at best. Register that now so nobody extrapolates.
- **Decay risk.** Incumbent MM tightens; Polymarket fee changes; flow migrates.
- **Kill criteria.** (i) Q4 shows adverse-selection cost ≥ quoted half-spread
  at every δ; (ii) fill simulation at realistic queue position shows <30% of
  the naive fill rate; (iii) shadow expectancy after pessimistic costs ≤ 0 over
  the pre-registered sample.
- **Recon evidence required before build:** Q1 (spread/depth by tte), Q4
  (maker fill economics), Q5 (quote-puller behavior), Q6 (taker loss pool).

## Thesis B — RESOLUTION BASIS: settlement-feed vs Binance divergence

- **Mechanism (as originally proposed).** Fade token prices that overreact to
  Binance wicks the settlement feed won't print.
- **Status: PRE-REGISTERED AS LIKELY DEAD.** The original mechanism assumed the
  mainnet push feed. Data Streams follows spot at sub-second latency with a
  multi-exchange aggregate, so the exploitable basis shrinks to (a) aggregation
  differences (Binance vs the index — a few bps), and (b) the tie-goes-UP rule
  interacting with near-zero moves. The surviving micro-thesis: **near-flat
  windows systematically resolve UP more often than Binance-sign predicts**,
  and the market may misprice windows where |move| < ~2bps.
- **Counterparty.** Traders pricing P(UP) off Binance's sign on near-zero moves.
- **Kill criteria.** Q3 shows outcome-vs-Binance-sign disagreement < 2% of
  windows AND disagreements are unpredictable from observables (|move|, vol).
  If disagreement is concentrated in |move| < X bps windows and the market
  prices those at fair-by-sign, a niche edge exists; otherwise dead.
- **Recon evidence required:** Q3 (divergence/disagreement distribution,
  conditional on |move| and vol).

## Thesis C — STALE QUOTE SNIPE

- **Mechanism.** After a fast BTC move, resting orders on the token book are
  briefly mispriced; lift them before the quoter repricess.
- **Counterparty.** The slow quoter (an MM's stale quote, or retail limit
  orders left unattended).
- **Why not competed away?** Almost certainly it is — this is a latency race
  and we are a Node process on a laptop hitting a public REST/WS endpoint. The
  professionals doing this colocate. Pre-registered expectation: **dead**.
  Build only if Q2 shows repricing windows ≥ 1500ms at ≥ 3σ BTC moves AND
  resting size within those windows is economically meaningful after fees.
- **Kill criteria.** Median repricing lag < 1500ms, or lifted size EV < fees.
- **Recon evidence required:** Q2 (token-vs-fair lag distribution), Q5
  (quote-pull latency after BTC moves).

## Thesis D — CONSISTENCY ARB

- **Mechanism.** (i) UP + DOWN ask sum < $1 − fees (buy both, guaranteed
  profit); (ii) UP + DOWN bid sum > $1 + fees (sell both); each is
  near-riskless when present.
- **Counterparty.** Whoever posted the inconsistent quotes — an operational
  error or a quoter managing one leg only.
- **Why not competed away?** On liquid venues it is. On a small venue with one
  active market and shallow books, brief windows may appear. Frequency ×
  capturable size is an empirical question; prior expectation is "rare and
  tiny" but measurement is cheap (it falls out of the book snapshots).
- **Kill criteria.** Occurrence < 1/day or median capturable profit < $0.50
  after fees ⇒ dead.
- **Recon evidence required:** Q1 snapshots (cross-side sums over time).
- **Note.** Adjacent-window path-consistency arb (5-min windows implying
  inconsistent cumulative paths) requires simultaneous liquid books in two
  windows; recon logs whether the next window's book even exists pre-open.

## Thesis E — FLOW FADE

- **Mechanism.** Retail market-order bursts (news candles, round numbers,
  liquidation cascades) push the token away from fair; fade the burst, revert
  to fair.
- **Counterparty.** The burst itself — momentum-chasing takers overpaying for
  immediacy.
- **Why not competed away?** It's the same seat as Thesis A viewed
  event-wise; a taker version only makes sense if reversion exceeds
  crossing costs (two spreads + fees). Prior: weak — crossing costs on a
  wide book eat most burst reversion.
- **Kill criteria.** Q5/Q6 show post-burst reversion (token price vs fair,
  30–120s horizon) < 2× crossing cost.
- **Recon evidence required:** Q5 (burst identification and reversion), Q6
  (which entry-time buckets lose).

## Thesis F — NEAR-CERTAINTY YIELD (registered to be attacked)

- **Mechanism.** In the final 30–60s, buy the near-certain side at 0.95–0.98
  when Φ-fair > 0.995; harvest the residual.
- **Counterparty.** Sellers of near-certain tokens = holders taking certain
  small profit early — plus, adversely, informed sellers who see reversal risk.
- **Why registered.** This is the classic retail-magnet strategy and the one
  every naive analysis of this market "discovers." It is registered so recon
  can kill it properly: the question is whether the 2–5% tail (a late BTC jump
  through the strike) occurs more often than the price implies — i.e. whether
  0.97 tokens win more or less than 97% of the time.
- **Kill criteria.** Calibration of final-minute prices shows realized ≤
  implied (no premium), or the premium < taker fees. Fat-tail minutes (vol
  regime) must be analyzed separately — an average masking a blow-up regime is
  a kill, not a pass.
- **Recon evidence required:** Q6 + final-minute price calibration table.

---

## Thesis V — VASILI: mid-window momentum-follow (post-registered 2026-07-13)

- **Origin.** External simulator screenshot claiming +13,264%/30d betting a
  window's direction from its first decisive sub-bar at a FIXED $0.50 fill.
  The fill is fiction; the mechanism ("decisive first half predicts the
  close") is testable honestly. Vasili is that test at real displayed asks.
- **Mechanism.** Once per market, 90–150s remaining: if |move from window
  open| ≥ 3bp (above Q3's 2bp coin-flip floor), buy the leading side at the
  displayed ask, ask ∈ [0.35, 0.85], $10, taker, hold to resolution.
- **Counterparty.** Mean-reversion bettors and stale quotes selling the
  leading side below its conditional probability mid-window.
- **Why it may already be competed away.** Q3/LAG_EDGE evidence says these
  books track the underlying within seconds — the ask at 150s likely already
  prices the lead. **Registered prediction: direction accuracy high
  (~75–90%), per-fill profit ≈ $0 or negative.** If wrong, CONFIRM is earned.
- **Distinct from G.** Different seat (90–150s vs 5–75s), different signal
  (raw 3bp lead vs Φ ≥ 0.88 near-certainty), different price band (≤0.85 vs
  G's late asks).
- **Kill criteria** (frozen in `scripts/vasili-verdict.js` at registration):
  core n≥300 — CONFIRM if mean > $0.40/fill AND worst market > −$30; KILL if
  mean < $0.10; else re-read at 500. 1× forever; hype separate.

## Adjudication rule

Each thesis gets a verdict in RECON.md: **BUILD** (evidence supports, proceed
to Phase 3), **DEAD** (kill criteria met — documented and closed), or
**STARVED** (evidence insufficient — extend collection, do not build on hope).
Only BUILD theses get code in `borg/src`. The number of BUILD verdicts may be
zero; per the mission, a rigorous zero is a success.
