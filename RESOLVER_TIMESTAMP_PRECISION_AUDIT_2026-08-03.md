# Resolver timestamp-precision audit

Evidence read: 2026-08-03 14:49 UTC. Experiment: `resolver-timestamp-precision-audit-v1`. This is a frozen, read-only falsification lane with no paper or live order authorization.

## Result

The proposed deterministic timestamp-precision edge is **not currently tradeable from the captured rules**. The bounded 30-day scan read 87,729 source-filtered rule documents; 87,646 were relevant price/resolver rules, but zero uniquely specified all of:

- one authoritative resolver;
- observation timestamp and timezone;
- source timestamp precision;
- terminal source-report selection policy; and
- inclusive/exclusive cutoff semantics.

Accordingly, there were zero statewise-proved episodes, zero positive doubled-cost episodes and **$0.00 certified executable capacity**. This is a falsification result, not evidence that the collector failed.

| Rule status | Count |
|---|---:|
| Certified | 0 |
| Unknown | 78,550 |
| Conflict | 9,096 |
| Not relevant after source prefilter | 83 |

| Missing or conflicting dimension | Count |
|---|---:|
| Source timestamp precision missing | 87,729 |
| Cutoff inclusion missing | 87,360 |
| Terminal tick policy missing | 87,360 |
| Ambiguous resolver source | 9,096 |
| Observation timezone missing | 999 |
| Resolver source missing | 77 |

## Why this matters

An ISO `endDate` records the application's nominal boundary; it does not prove whether resolution uses the last oracle report at or before that boundary, the first report after it, the closest report, a candle close or an average. Likewise, “price at the end” is not a machine-readable terminal-tick policy. Treating either as exact would turn oracle ambiguity into fake certainty.

The input feed itself is suitable for a future replay: the trailing hot-tier RTDS rows for Binance and Chainlink across BTC, ETH, SOL and XRP had 100% population of source timestamp, local monotonic timestamp and event sequence. Complete event provenance cannot repair ambiguous contract wording, however.

## Implemented guardrail

The R07 kernel now selects a terminal tick only when immutable text explicitly defines source-clock precision and one of the supported boundary policies. It also requires the tick's source time, local receive time, monotonic time, connection epoch and sequence, and refuses to use information received after the simulated decision. Generic or conflicting rules fail closed.

Re-run with:

```bash
npm run research:resolver-precision -- --days=30
```

R07 should remain a dormant scanner. Reopen it only if a new contract family publishes precise terminal-report semantics; then it must still demonstrate executable winning-token asks below certain payout after doubled fees, slippage, latency and failure reserve.
