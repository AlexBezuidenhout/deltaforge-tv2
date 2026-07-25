# Cross-Venue Lab: Polymarket × Kalshi

This is a live-data, paper-only contract-arbitrage laboratory. It has no wallet,
signer, exchange trading client, private key, or order-submission path.

## What it tests

Universe discovery scans Kalshi's cursor-paginated open **events** with nested
binary markets rather than stopping after a fixed `/markets` page cap. Event
titles, categories and settlement sources are retained for matching. The
dashboard reports whether that scan completed or fell back to a truncated
legacy sweep. Candidate generation is indexed by informative tokens, so this
is a roughly linear retrieval pass rather than a 66,000-by-37,000 brute-force
comparison. Run `node scripts/crossvenue-universe-rescan.js` for a read-only
coverage audit. Neither a high score nor shared wording proves equal payoff.

For a manually resolution-audited binary pair, the two possible locks are:

```text
Polymarket YES ask + Kalshi NO ask + fees < $1
Polymarket NO ask  + Kalshi YES ask + fees < $1
```

The engine walks full displayed depth at 1/5/10/25/50/100 contracts, uses the
Polymarket market's fee schedule, applies Kalshi's current general quadratic
taker fee, and reports both raw and stressed profit. Stress charges fees a
second time plus one adverse tick per leg. This is a frozen mechanism hurdle,
not a value fitted to observed PnL.

The displayed opportunity row is then sized over every relevant depth
breakpoint, not merely the fixed probes. It buys equal **share quantities** on
the complementary outcomes, while allowing the dollar stakes to differ, and
maximizes stressed dollars subject to $500 total capital, $250 available on
each venue, order minimums and displayed depth. The dashboard reports return
on deployed cash (`profit / entry cost`), capacity and immediate orphan-leg
unwind loss. These are the useful mechanics demonstrated in the July 2026
Arbs.xyz video; no performance claim from that affiliate video is treated as
evidence.

`economic` means the displayed books imply a positive total after current fees.
It does not mean the contracts are identical. `lockable_after_both_fills`
requires a frozen manual identity approval, fresh books and positive stressed
profit. `atomic` is always false: two exchanges cannot execute as one order.

Forward evidence is counted as **one lifecycle row per manually approved
relation event**, not one trade per quote update. An episode opens when a safe
direction first becomes economically executable, accumulates its best
displayed capacity and stress result while the dislocation persists, and is
marked disappeared when a later valid two-venue book no longer supports the
edge. Quote flicker inside one episode therefore cannot inflate `n`.

For each episode the collector also records the worst immediate-unwind loss if
only either leg filled, plus cases where the orphan could not be unwound at
displayed depth. This is a conservative paper stress test—not a claim that a
live orphan fill occurred. Feed outages remain data-quality gaps rather than
being mislabeled as economic convergence.

## Terminal lock versus convergence

These are reported separately. If an approved complementary pair costs less
than $1 after entry fees, the terminal payoff is already locked after both
non-atomic legs fill. Price convergence does not create that edge; it can
release the split venue capital before resolution.

The collector therefore records a fixed-size basis probe at each fresh book
state: five contracts or the Polymarket order minimum, whichever is larger.
Entry walks both asks. A hypothetical early liquidation walks both
bids and charges both venue fees again. The convergence report measures the
first future time that this four-leg round trip has non-negative PnL. Open
observations are right-censored rather than counted as failures or silently
discarded. Entry-capable books are retained even when immediate exit depth is
missing, so illiquidity becomes measured waiting time rather than selection
bias. It reports 1m/5m/30m/1h/6h/24h/7d/30d Kaplan-Meier probabilities.
Only manually approved contract identities belong in the evidence cohort;
unapproved text matches remain a diagnostic row.

If entry asks plus fees already sum to less than the guaranteed common payout,
the position is a terminal lock after both legs fill and no convergence is
required. If that sum is at least the payout, buying opposite directions is
not an arbitrage: profit then depends on later convergence and enough bid depth
to exit both legs after four total fees. The convergence cohort therefore
measures basis risk, time-to-capital-release and right-censoring separately
from certified terminal locks.

Collection is tiered for this slower-capital hypothesis. If read-only Kalshi
credentials are installed, every monitored ticker uses the authenticated
`orderbook_delta` WebSocket: raw snapshots/deltas enter the WAL first, sequence
gaps discard the in-memory book and force a clean resubscription, and
exchange-source and local-receive times are retained separately. With no data
credentials, or whenever that stream is unhealthy, the top six candidates fall
back to two-second batched REST and six additional candidates to a 30-second
broad sampler. A healthy Polymarket WebSocket heartbeat keeps an unchanged book
current; the timestamp of the last actual book change is retained separately.

If manual review leaves no viable pair, up to four rejected pairs are retained
as clearly labelled diagnostic controls. This keeps transport, fee and sizing
instrumentation exercised and quantifies how much fake “arb” title-only
matching would manufacture. A diagnostic control can never become lockable or
enter the approved evidence cohort.

## Using TV2

Open `http://localhost:3004`, then select **⇄ Cross-Venue**.

- **Paper >80 / Proved** shows score-approved paper pairs versus pairs whose
  full rules and terminal payoff mapping have been manually audited. The line
  underneath reports total discovered and total monitored counts.
- **Contract-identity review queue** shows the exact two labels, time delta and
  mismatch flags. Similarity scores are discovery aids only.
- **Recent paper opportunities** shows executable VWAPs, both fees, raw locked
  profit, cash ROI, bankroll/depth-optimal capacity, stressed result and the
  loss from immediately unwinding whichever single leg filled first.
- **Forward relation-event lifecycle** shows independent approved-relation
  episodes, disappearance, duration, best capacity and orphan stress. This is
  the primary sample-count view; opportunity snapshots are diagnostics.
- **Capital release — executable convergence** shows how often and how quickly
  both positions could have been sold profitably after all four fees. The
  approved and unapproved cohorts must never be combined.
- `INDICATIVE_ECONOMIC` is not tradeable evidence. `LOCKABLE_NONATOMIC` means
  the payoff is locked only after both simulated legs fill.

Frozen manual approvals live in `borg/crossvenue/matches.json`. Approval must
compare resolution source, observation time and timezone, threshold/operator,
postponement, cancellation, correction, early-close and void rules. Never
approve from title similarity alone.

The 2026-07-16 manual review covered the initial 250-row queue plus 22 plausible
residual rows left after strict full-universe screening, across 52 event-family
mappings. None established payoff identity, so all were frozen as
`MANUALLY_REJECTED` and excluded from monitoring. See
`borg/crossvenue/IDENTITY_REVIEW_2026-07-16.md`. Family-level records may reject
shared rule templates but are deliberately forbidden from approving them;
approval always requires an exact Polymarket condition id and Kalshi ticker.

## Backtesting

Run:

```bash
node scripts/crossvenue-backtest.js --days=30
node scripts/crossvenue-backtest.js --days=30 --json
```

Kalshi and Polymarket publish historical market/trade or candlestick data, so a
coarse historical convergence study is possible after pairs are mapped.
However, those datasets do not reconstruct synchronized pre-trade L2, queue,
partial fills or the loss from filling only one leg. They cannot establish
executable arbitrage. The authoritative backtest is forward replay of
`cv_book_snapshots`, `cv_basis_samples` and the raw `crossvenue-*` WAL streams.

Do not count every snapshot as a trade. The report uses the forward relation
lifecycle and requires at least 300 independent approved-relation episodes,
14 calendar days, positive 2×-cost economics in both chronological halves,
market- and UTC-day-clustered lower confidence bounds above zero, and an
explicit orphan-leg loss analysis. With no approved identity, the evidence
sample is correctly zero regardless of how many title matches or snapshots
exist.

## Current transport and jurisdiction limit

Polymarket uses its public market WebSocket. Kalshi now has a data-only
WebSocket adapter with batched REST fallback. Configure it with
`KALSHI_READONLY_KEY_ID` and `KALSHI_READONLY_KEY_PATH`; the adapter uses the
key only for the required RSA-PSS WebSocket handshake and exposes no order,
cancel, portfolio or mutation method. No credentials means the existing public
REST collector remains active. REST has no exchange-side event timestamp and
is capped at data-quality B; a fresh source-stamped WebSocket delta may earn A,
while non-atomic paper execution remains at most fidelity B.

The Dublin VPS is data/research only for Kalshi. Current Kalshi terms list
Ireland as restricted. Do not install order credentials or route Kalshi trades
from this host without written confirmation from Kalshi.
