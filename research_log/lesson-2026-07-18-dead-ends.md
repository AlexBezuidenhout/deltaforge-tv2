# Lesson: four plausible mechanisms measured dead on 2026-07-18

**Summary:** UP-bias/tie-rule, hour-of-day seasonality, ask-sum-conditioned
favorite buying on 5m, and 1h deep longshots are all ≤ 0 after fees. Do not
revisit without materially new data.

1. **UP base rate / resolver tie rule:** p(UP) 0.46–0.51 across all assets and
   both timeframes. doge/sol/xrp carry 4–6% exact-tie mass (coarse ticks;
   ties resolve UP by the ≥ rule) but late books already price it
   (doge disp<1bp: truth 0.605 vs UP ask 0.600). No cell.
2. **Hour-of-day:** 5m taker EV by 4h UTC bucket is uniformly −2.4 to −2.9¢
   (n=666–1,332 per bucket).
3. **Ask-sum conditioning (5m, tte 60–180s):** favorite EV ≈ 0 at best in the
   1.00–1.02 sum bucket; the >1.05 bucket is the *worst* (−11.4¢) — wide books
   signal toxicity, not cheap favorites.
4. **1h deep longshots (ask <0.10):** +1.2¢/share at 1×, ≈0 at 2×; pennies per
   market. Not worth an arm.
