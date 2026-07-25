# DeltaForge collaborator handoff

Snapshot date: 17 July 2026. This is a research platform, not a claim of a
profitable production trading system. The live dashboards expose current paper,
shadow and collector state. No wallet key, exchange credential, database URL,
VPS login or live-order authorization is included in the repository.

## Start here

Read these in order:

1. This document for orientation and access boundaries.
2. [`THEORY_PRIMER.md`](THEORY_PRIMER.md) for the required market and research concepts.
3. [`../BOARD_STRATEGY_REVIEW_2026-07-17.md`](../BOARD_STRATEGY_REVIEW_2026-07-17.md) for the explicit opportunity decisions.
4. [`../DATA_BACKTEST_CATALOG_2026-07-17.md`](../DATA_BACKTEST_CATALOG_2026-07-17.md) for what the stored data can and cannot prove.
5. [`../CROSSVENUE_RELATION_REVIEW_2026-07-17.md`](../CROSSVENUE_RELATION_REVIEW_2026-07-17.md) for the Polymarket/Kalshi payoff analysis.
6. [`../CLAUDE.md`](../CLAUDE.md) for code-level architecture, parameter tables and known bug history.
7. [`OPERATIONS_AND_ACCESS.md`](OPERATIONS_AND_ACCESS.md) before running or deploying anything.

## What the two applications are

| Application | Purpose | Default mode | Live dashboard |
|---|---|---|---|
| TV2 | Main research terminal: MAIN, George, BORG, Flow Lab, Book Lab, structural and Polymarket/Kalshi research | Paper/shadow | `https://tv2.107.174.203.197.sslip.io` |
| DF2 | Separate Axiom/legacy signal bot and exit-policy experiment | Paper | `https://df2.107.174.203.197.sslip.io` |

The access sheet supplied separately contains a read-only TV2 account and a
read-only web credential for DF2. Those credentials can inspect current results
but cannot start or stop bots, change settings, run write endpoints, access the
admin panel or retrieve configured wallet/proxy metadata.

## Architecture in one page

TV2 has three distinct layers:

1. **Capture:** event-driven Binance, Coinbase, Hyperliquid, Chainlink and
   Polymarket feeds append raw events to a local durable WAL before processing.
2. **Research/execution kernel:** deterministic strategies consume in-memory
   state. Paper and shadow fills use executable prices, displayed depth, fees,
   staleness, queue assumptions and adverse-selection marks.
3. **Persistence/presentation:** local PostgreSQL stores the hot research tier;
   Parquet/off-host copies are the archive tier; Express serves the dashboard.

The decision path must not wait for PostgreSQL. The database is research and
observability infrastructure, not the clock that determines whether an order
is timely.

The bot families differ:

- **MAIN** is the directional five-minute framework and its frozen successors.
- **George** is a Chainlink/resolver-oriented split test; its legacy source is retired.
- **BORG** is an auto-discovered portfolio of shadow strategies evaluated on one shared execution contract.
- **Flow Lab** studies all-market order-flow reactions and adverse selection.
- **Book Lab / paired maker** studies passive complete-set making, queue position and orphan legs.
- **Structural scanner** proves payoff identities in nested thresholds, disjoint ranges and complete event sets.
- **Cross-venue lab** matches Polymarket and Kalshi rules, books and public prints; it does not assume title similarity means identical settlement.
- **DF2** is kept separate so its legacy assumptions and exit-policy experiments do not contaminate TV2 cohorts.

## Honest current strategy status

There is currently no strategy with selection-adjusted, forward, live-ready
positive expectancy. The strict promotion ledger inspected 120 registered arms
and promoted zero. The recommended live allocation to the existing fleet in the
17 July board review was zero.

The opportunities worth continued work are explicit:

| Priority | Research line | Why it remains interesting | Why it is not live-ready |
|---:|---|---|---|
| 1 | State-conditioned Polymarket/Kalshi payoff implications | One rules-proved historical event showed $55.59 stressed modeled profit on $253.40 deployed | One retrospectively selected event; non-atomic legs; zero forward episodes |
| 2 | Same-venue structural bundles | Terminal payoff algebra can create a true lock without cross-venue settlement mismatch | Repaired scanner has not yet observed a qualified executable bundle |
| 3 | H43 resolution-boundary buffer | Discovery cohort was +$12.49 after 2× costs over 22 markets | Tiny sample and wide interval |
| 4 | H41 cross-asset dispersion reversion | Discovery cohort was +$12.83 after 2× costs over 161 markets | Chronological halves disagree; fresh arm began negative |
| 5 | Reward-aware complete-set making | Coherent market-making mechanism and measurable rewards | No completed merges yet; orphan-inclusive economics are negative |

MAIN V2–V4, G late-arb evaluation, the T-240 residual, George resurrection and
most H1–H51 predictors are negative after executable prices and doubled costs.
The high historical win rates are not enough: paying too much for winners and
rare full binary losses dominate the P&L.

## Evidence rules

A dashboard balance, high win rate or large number of quote rows is not proof of
edge. Promotion requires a frozen mechanism before the test cohort, at least 300
fresh independent markets and 14 calendar days, positive results in both
chronological halves, a market-clustered lower confidence bound above zero,
family-wise correction across inspected variants, and survival under 2× costs.

Multi-leg strategies additionally require full-depth capacity, partial/non-fill
modeling, stale-leg rejection and orphan unwind accounting. No result should be
annualized when it comes from one event or a few days.

## Repository boundaries

The private source snapshot contains code, tests, experiment manifests and
written reports. It intentionally excludes:

- `.env` and every runtime secret;
- wallet/private-key files and live executor gates;
- VPS/RDP/SSH credentials;
- PostgreSQL dumps, raw WAL, Parquet archives and local caches;
- local Claude/Codex/MCP permission state;
- historical Git objects that once contained a local credential-bearing command.

The supplied GitHub repository therefore starts from a clean audited root
commit. This is deliberate source hygiene, not missing application code.

## How to collaborate

- Use a branch and pull request for code changes.
- Keep experiment IDs and manifests immutable after a cohort begins.
- Never tune a threshold on the same outcomes used to claim improvement.
- Keep paper trading as the default and do not alter live-order call sites as a research shortcut.
- Run `npm test` before opening a pull request.
- Put large data artifacts in the archive tier, never Git.
- Treat any credential appearing in chat, an issue or a commit as compromised and rotate it.

The owner can revoke live dashboard access by deleting or disabling the viewer
account without changing the operator account or any bot state.
