# H53 live dry-run canary stopped; shadow eval continues to its frozen clock

**2026-07-19 ~16:30Z.** `h53-live.service` (dry-run mirror of
`H53_5m_neareven_favorite_live_v1`, operator-directed unproven override) stopped and
disabled on the VPS; `~deltaforge/.deltaforge-live/H53_KILL` set for defense in depth.
No real capital was ever at risk (heartbeat `dryRun:true`, `balanceUsdc:null` throughout).

Evidence at stop time (scored shadow, 2026-07-18 → 07-19): **906 independent markets**
(3x past the 300-market minimum), 738 fills, **−$149.42 @1x, −$263.97 @2x**
(−$0.20/fill). The frozen promotion criteria (both chronological halves positive AND
2x-stress positive AND clustered lower bounds above zero) are already unreachable.
This replicates the discovery-time retrospective (identical 5m cell n=1698,
−$0.034/share): quoting attention on the five-minute series prices the near-even
favorite fairly or worse.

Per pre-registration discipline the **shadow arm keeps running untouched** to its
14-calendar-day mark (2026-08-01); no threshold changes, no early shadow kill —
the manifest registered no early-kill line, so none is invented post hoc. The
formal verdict entry belongs to that read. The live mirror was never part of the
eval protocol and needed no clock: its purpose was execution-fidelity measurement
for a rule that now has no path to promotion.

Restart (if ever justified by the 14-day read, which current data makes implausible):
remove H53_KILL, `sudo systemctl enable --now h53-live.service`, and re-satisfy the
five independent gates in borg/live/H53_RUNBOOK.md.
