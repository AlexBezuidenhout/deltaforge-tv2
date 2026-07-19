# Cross-venue identity review packet — 7 STRONG_CANDIDATE pairs
**Prepared 2026-07-19 for operator review.** Approval is a human act: read both rule
texts, decide per pair, tell the session your verdicts. Approvals get frozen into
`borg/crossvenue/matches.json` bound to the current rule hashes (any later rule edit
self-invalidates the approval).

---

## Group A — PGA Corales Puntacana Championship winner props (5 pairs)

Verified live at review time: Polymarket legs still `acceptingOrders` (Del Rey 5c).
Same 2026 edition both venues (COPC26 ✓ / "2026" in Poly question ✓).

**Polymarket rule (identical for all 5, per-player):**
> Resolves to the listed player who wins the 2026 Corales Puntacana Championship.
> Player eliminated from contention → immediately "No". Unlisted player wins →
> "Other". Tie → official winner per PGA Tour rules; if multiple winners announced,
> alphabetical by last name. **If no winner announced by July 25, 2026 8:00PM ET →
> "Other".** Source: pgatour.com.

**Kalshi rule (identical for all 5, per-player):**
> "If <player> wins the Corales Puntacana Championship, then the market resolves to
> Yes." Withdrawal/forfeit/no-show before teeing off → **Tournament Winner resolves
> No.** (Close time 2026-08-02.)

**Differences that matter:**
1. **No-winner deadline asymmetry (the real one):** Poly resolves "Other" (= No for
   each player) if no winner by Jul 25; Kalshi stays open until Aug 2. A weather-
   suspended tournament finishing Jul 26–Aug 2 → Poly No / Kalshi Yes for the actual
   winner. Probability small but not zero — this is exactly the annulment-window class
   that burned NCSEN.
2. **Multi-winner tiebreak:** Poly alphabetical-by-last-name; Kalshi text doesn't
   specify (official PGA winner presumed; PGA playoffs virtually always produce one
   winner). Negligible but nonzero.
3. Withdrawal handling: equivalent for winner markets (both → No).

**My recommendation:** APPROVE all 5 *if* you accept difference #1 as tolerable basis
risk for paper research (the episode engine measures convergence, it never locks
capital); REJECT if you want the first approvals to be difference-free. There is no
wrong answer at $0 at risk — the pipeline value is identical either way.

| Pair | match_id (prefix) | Kalshi ticker |
|---|---|---|
| Del Rey | cv:0x5ebbffc2… | KXPGATOUR-COPC26-ADEL |
| Robinson-Thompson | cv:0xc2c6bbd9… | KXPGATOUR-COPC26-BROB |
| Skov Olesen | cv:0x139ce0e4… | KXPGATOUR-COPC26-JOLE |
| Norgaard Moller | cv:0xe4d656eb… | KXPGATOUR-COPC26-NNOR |
| Von Dellingshausen | cv:0xb57f7097… | KXPGATOUR-COPC26-NVON |

## Group B — People's Sexiest Man Alive 2026 (2 pairs)

**Polymarket:** resolves to the named person; multiple named → alphabetical first;
**no announcement by Dec 31 2026 11:59PM ET → "Other"**; source People or credible
reporting consensus.

**Kalshi:** "If <person> is People's Sexiest Man Alive in 2026 → Yes." Secondary
rules are only a People-trademark disclaimer — **no explicit no-announcement or
multi-winner clause in the captured text.**

**Differences that matter:**
1. **No-announcement path is unspecified on Kalshi** in captured rules (Poly: No via
   "Other"; Kalshi: presumably No at close, but the text doesn't say). People has
   announced every year, so the practical risk is tiny; the textual gap is real.
2. Multi-winner: Poly alphabetical; Kalshi silent. Same shape as #1.

**My recommendation:** APPROVE both for paper research with the same caveat, or
reject on textual-completeness grounds. Long-dated (resolves ~Nov 2026) — these two
give the episode pipeline months of forward life, unlike the golf pairs which
resolve this week.

| Pair | match_id (prefix) | Kalshi ticker |
|---|---|---|
| Connor Storrie | cv:0xe10fc4d1… | KXSEXYMAN-26-CON |
| Hudson Williams | cv:0x34f68494… | KXSEXYMAN-26-HUD |

---

**To act:** reply with verdicts, e.g. "approve all 7", "approve golf only", or
per-pair. Rejections should name the reason (it gets frozen as the rationale).
The session will write matches.json with rule-hash bindings + your review
timestamp, run tests, deploy, and confirm episodes arm.
