# Semantic condition-graph proposer audit

Run: 3 August 2026, 15:10 UTC. Experiment `semantic-condition-graph-proposer-v1`; discovery tool only, with no database write, wallet, quote or order path.

The first bounded scan read 19,848 immutable Polymarket rule snapshots and typed 18,832 threshold nodes. The lexical baseline proposed 998 abstract ordered-threshold implications. All 998 passed the finite-state Boolean proof but remained blocked on deterministic venue-rule review. **Zero were cross-event relationships, zero became rule-certified and zero became executable candidates.**

This is useful negative evidence: the baseline rediscovered within-event threshold families that the existing structural scanner already covers, but did not expand the graph into novel cross-event relationships. Those 998 rows are proposal recall diagnostics, not 998 arbitrage opportunities.

The proposer accepts only existing immutable rule hashes and an allow-listed relation type. It independently recomputes implication orientation and the abstract worst-state payoff. Model-provided confidence, certification, wallet or order fields cannot bypass the verifier. Even a valid abstract proof remains non-tradeable until exact resolver/time/fallback scope is certified and the existing synchronized-depth, doubled-fee and orphan-reserve scanner shows positive dollars.

Next read: evaluate up to 100 genuinely cross-event model/human proposals against the same verifier. Continue only if it adds correctly certifiable relationships with zero false payoff proofs; otherwise retire N09 as redundant to the deterministic within-event graph.

Reproduce with:

```bash
npm run research:semantic-proposer -- --days=30 --limit=100000
```
