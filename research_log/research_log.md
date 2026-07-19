# DeltaForge central research log

One actionable lesson per file in this directory; each file carries a one-line
summary at the top. This index lists every lesson, newest first. Evidence
standards for anything entered here: independent-market n (never snapshot
pseudo-replication), 1× and 2× fee stress (crypto taker fee/share =
0.07·p·(1−p)), chronological-half stability, and a reproduction query. Label
retrospective vs forward evidence explicitly.

## Index

- [2026-07-18 H52 hourly near-even favorite](lesson-2026-07-18-h52-hourly-favorite.md) —
  only positive executable cell found across all universes; frozen forward eval running
- [2026-07-18 1h kline poisoning](lesson-2026-07-18-1h-kline-poisoning.md) —
  offset 1h windows carried the wrong Binance candle; repair + fix shipped
- [2026-07-18 dead ends](lesson-2026-07-18-dead-ends.md) —
  UP/tie bias, hour-of-day, ask-sum conditioning, deep 1h longshots: all ≤ 0 after fees

## Session checkpoints (2026-07-18 PM orchestration)

| Checkpoint | Status |
|---|---|
| Forward-test health (flow V2, H43, H41) | verified accruing / alive / firing |
| 1h calibration scan row reconciliation | 787 resolved markets, 643 with snaps — matches borg_markets counts |
| H52 deployment | live 16:55Z, first order 17:00:15Z, eval identity stamped |
| Subagent fan-out (backtest / oracle / cross-market / verifier) | launched this session |
