# Board review implementation — 18 July 2026

This note records the code-level response to the 17 July board strategy review.
It is an implementation ledger, not a profitability claim. All new arms remain
paper/shadow only and have no wallet, signer, authenticated trading client or
order-posting path.

## Evidence governance

- H43 now has a fresh, unchanged evaluation identity. Its earlier discovery
  rows are excluded; the clock starts at zero and requires 300 independent
  markets, 14 calendar days, positive 2×-cost PnL in both chronological halves,
  and market- and UTC-day-clustered lower confidence bounds above zero.
- Strategies rejected in the board review are encoded in an immutable
  governance manifest. They can remain running as controls or protocol
  completions, but the dashboard may not present them as alpha candidates.
- The promotion report recognizes manifest-named 2× metrics, aggregates orders
  to independent markets before splitting halves, and reports both market and
  day clustering. Passing remains a review trigger, never an automatic live
  promotion.

## Wider structural measurement

- Daily crypto capture now deterministically covers BTC, ETH, SOL and XRP, with
  five near-spot thresholds and four near-spot ranges per asset event over a
  seven-day discovery horizon. This is a new capture-only pilot; it does not
  import legacy PnL or select assets from results.
- The structural scanner adds an explicit Sports-tag universe, generic binary
  complements, ordered sports totals and ordered sports spreads. Every sports
  relation requires matching event, scope/period, participant/statistic and a
  normalized resolution-rule fingerprint. Ambiguity fails closed.
- The full bounded proved catalog is persisted, while only a deterministic
  family-balanced subset consumes realtime sockets. Each candidate still has
  to survive stale-leg checks, full ask-depth walking, 2× fees, displayed
  capacity and non-atomic orphan stress.

## Cross-venue measurement

- Polymarket/Kalshi observations now have a stable relation-event lifecycle.
  Repeated quote updates inside one continuous dislocation do not inflate the
  sample size.
- Episodes retain appearance/disappearance, duration, best executable
  quantity/cost/profit, and worst immediate-unwind orphan stress for either
  venue. Unavailable unwind depth is counted rather than silently discarded.
- These are paper counterfactuals. They do not make cross-venue legs atomic and
  do not turn an unapproved text match into a contract identity.

## Honest acceptance rule

No strategy described above is ready for live capital today. The implemented
changes improve falsification, opportunity-rate measurement and execution
honesty. A valid outcome after the next 300+ independent markets may still be
that post-cost edge is approximately zero.
