# Oracle/Resolver Arbitrage Audit — RTDS vs CEX latency, divergence signal, mainnet spread, tie rule
**Date:** 2026-07-18 · **Analyst:** Oracle/Resolver Arbitrage Analyst (TV2) · **Access:** read-only SELECT on deltaforge VPS
**Data window:** RTDS + book snaps 2026-07-17 00:53 → 2026-07-18 17:55 UTC (~41h). Chronological half cut: **2026-07-17 23:00 UTC** (median window_end of eval universe).
**Fee model:** taker fee/share = 0.07·p·(1−p), stressed at 1x and 2x. Independent-market units throughout (one observation/trade per market).

## Checkpoint reconciliation
| Step | Rows / n |
|---|---|
| borg_rtds_ticks exported | 1,155,486 (4 assets × {binance_rtds, chainlink_rtds}, ~1 tick/s each) |
| borg_binance_1s / borg_coinbase_1s | 587,401 / 225,094 |
| Late-window snaps (ts ∈ [window_end−200s, window_end], resolved direction markets) | 768,845 rows, 4,067 markets (3,416 direction_5m + 651 direction_1h) |
| Chainlink-resolved universe with RTDS-derived true opens | 2,443 markets (1,952 × 5m + 491 × 15m) |
| Eval snaps (book_src='ws', non-null asks + rtds_chainlink) | 394,865 |

Data pulled via `ssh deltaforge-vps`, `sudo -u postgres psql -d deltaforge -c "COPY (SELECT ...) TO STDOUT WITH CSV HEADER"`; analysis scripts in session scratchpad (`t1_latency.py`, `t2_core.py`, `t4_diag*.py`, `t2_trade.py`, `t3_rest.py`, `t5_tie.py`, `t6_cluster.py`).

---

## Ranked findings

### F1. `direction_1h` is two different products and the platform's reference price is corrupted for one of them — **ACTIONABLE (pipeline fix, not a trade)**

The `direction_1h` bucket (811 resolved, RTDS-covered assets) mixes:

- **280 legacy hourlies** (slug `bitcoin-up-or-down-july-15-2026-1pm-et`, window_end at :00). Resolution verified = **Binance 1h candle**: outcome matches `binance_close >= binance_open` in **99.6%** (n=276; repaired-kline subset 99.6%, n=236). Binance-RTDS 1h path matches 98.8% vs Chainlink path 95.6% — Binance-resolved, not Chainlink.
- **535 fifteen-minute markets** (slug `btc-updown-15m-<epoch>`, question "1:30PM–1:45PM ET"). **Stored `window_start` is wrong by 45 minutes** (stored duration 1h; true window = [window_end−15min, window_end]; slug epoch = true start). Resolution verified = **Chainlink RTDS path close ≥ open over the true 15m window**: 96.1% match (residual mismatches median 0.63bp displacement = 1s-sampling boundary noise; with the stored 1h window, match is only 73.7%).

Consequences measured on the 15m product (one snap/market, tte 20–60s, n=487):
- `btc_ref` is ~**15.6bps** median off the true open (it reflects the wrong 45-min-earlier reference).
- `sign(btc_price − btc_ref)` predicts outcome only **62.4%**, vs **95.7%** using the true open from RTDS.
- `phi_fair` Brier = **0.359** (worse than constant-0.5 = 0.25); book mid Brier = 0.036.

Every frozen "hourly" arm (H22–H25, H44, H52) and any fair-value logic touching `direction_1h` is computing φ against a broken ref, and the taxonomy conflates a Binance-resolved product with a Chainlink-resolved one. This also invalidates naive use of `rtds_divergence_bps`/`cl_mainnet` columns on hourly markets (resolver there is Binance, not Chainlink).

Reproduction SQL:
```sql
-- product split
SELECT extract(minute FROM window_end) AS m_end, count(*),
       count(*) FILTER (WHERE slug LIKE '%-updown-15m-%') AS n_15m
FROM borg_markets WHERE market_type='direction_1h' GROUP BY 1 ORDER BY 1;
-- hourly = binance candle resolution
SELECT avg(((binance_close>=binance_open) = (outcome='UP'))::int)
FROM borg_markets WHERE market_type='direction_1h' AND outcome IS NOT NULL
  AND extract(minute FROM window_end)=0 AND binance_open IS NOT NULL;
```
15m Chainlink verification requires joining `borg_rtds_ticks` (source='chainlink_rtds') asof `window_end - interval '15 min'` and `window_end` (see `t4_diag4.py`).

### F2. RTDS latency structure: Binance leads the resolver by ~1s event-time / ~2s bot-clock; catch-up is ~1s; a stable +7.8bp basis dominates `rtds_divergence_bps` — **structure real, not tradeable alone (see F3)**

- Delivery latency (received_at − source_ts), p50/p90: `binance_rtds` 0.44s/0.97s; `chainlink_rtds` **1.35s/2.08s** — the resolver print reaches the box ~0.9s later.
- Event-time cross-correlation of 1s log-returns, peak at **k=+1s (Binance leads)** for all 4 assets: corr 0.68 (btc), 0.75 (eth), 0.47 (sol), 0.53 (xrp). On the received-at clock the peak shifts to **k=+2s**.
- Catch-up: after Binance moves ≥ max(3σ, 2bp) (n=968–3,596/asset), Chainlink RTDS reaches ≥50% of the move within 10s in 84–95% of cases, **median 1.0s**. No lag-lengthening in high vol (k1 corr 0.55 lowvol → 0.68 hivol; the lead gets cleaner, not longer).
- Venue ordering: Chainlink RTDS sits closest to **Coinbase** (peak k=+1, corr 0.61–0.66) vs Binance 1s (peak k=+2, 0.42–0.51). The `-HL` (Hyperliquid) series in `borg_binance_1s` is stale/slow (peak k=−2..−3, corr ~0.24) — do not use it as a lead indicator; this likely handicaps H50.
- Basis: binance_rtds vs chainlink_rtds level spread is **+7.6 to +8.0 bps** (sd 1.3–1.5) on all assets (USDT premium + aggregation). `rtds_divergence_bps` ≡ `(btc_price/rtds_chainlink − 1)·1e4` (verified exact), so its raw value is ~basis, not signal. **Any divergence conditioning must subtract a rolling basis.**

The exploitable-looking window (CEX moved, resolver hasn't) therefore exists for ~1–2s and carries ~1–2bp of displacement — inside the "sub-2bp leads are fiction" regime already established by recon Q3. F3 tests whether the book misprices it anyway.

### F3. The inversion cell (book path vs resolver path straddle the boundary): coin-flip content, book already sides with the resolver, buying the resolver side at ask loses — **NO EDGE / NOISE**

Setup: chainlink-resolved universe (5m + 15m, RTDS assets), true opens from RTDS ticks; bot-visible resolver distance = `rtds_chainlink`/CL-open, CEX distance = `btc_price`/BN-open; inversion = signs differ (ties→UP). One trade/market: first inversion snap in the tte window, buy resolver-side token at best ask, hold to resolution.

| tte window | n mkts | 1x mean/share | 2x | win% | H1 / H2 |
|---|---|---|---|---|---|
| [5,60] | 528 | **−0.023** (t=−1.2) | −0.037 | 51.1% | −0.021 / −0.025 |
| [2,20] | 299 | −0.010 | −0.021 | 56.9% | −0.049 / +0.022 |
| [30,120] | 713 | **−0.052** (t=−2.9) | −0.067 | 48.1% | −0.080 / −0.015 |

Why: at market close, the two feed paths disagree in only 86/1,940 5m markets (4.4%), with median displacement **0.49bp**; the resolver-side-at-snap goes on to win only **45.3%** of the 815 markets that ever showed an inversion — i.e., inversions live at sub-bp displacements where sign is a coin flip (consistent with recon Q3). And the book is **not** naive-CEX: in inversion snaps the mid sides with the resolver 65.8% of the time. Buying the "correct" side just pays the spread.
Consistent with live pilots: H48 chainlink-resolver-basis avg pnl_1x = −0.58/fill (n=925 fills), H49 −0.62, H50 −0.39, H51 −0.21 (all negative at 1x).

Subcell watch-item: inversion & |res_dist| ≥ 5bp at tte[30,120]: **+0.083/share 1x (t=2.6), win 93%, n=30** — but 26/30 cluster in one volatile stretch (Jul 17 13:00–17:00 UTC), all in H1, zero H2 occurrences, n≪100. Mechanically sensible (≥5bp resolver displacement almost never reverses; the book briefly disagrees only in fast tape) but fails halves and the subgroup-n rule. **SUGGESTIVE (PROVISIONAL), likely single-episode artifact; do not act; recheck when ≥100 independent markets have hit the cell.**

### F4. `rtds_divergence_bps` bands on resolved markets — sign is as theory predicts, magnitude is inside spread+fees — **NOISE at taker**

One obs/market (last snap in tte window), basis-adjusted divergence `div_adj = rtds_divergence_bps − median(asset, 2h)`; executable best asks; n_mkts 1,767 (tte 10–30) / 2,380 (tte 30–120).

- tte[10,30], near-boundary (|cex_dist|<5bp): buy-UP at ask nets −0.055 in the neutral band vs **−0.118 (t=−2.3) when div_adj > +1.5bp** (spot above resolver → UP overpriced, as the latency story predicts). But the monetizable side (buy DOWN at ask) still nets **−0.017 (1x)** / −0.024 (2x). n=38 in the extreme band besides.
- All 20 band×side×tte cells ≤ 0 at 1x except statistical zeros (max +0.013, t≈0.3). Both halves negative for every candidate cell.

Verdict: the divergence signal contains real directional information but less than one bid-ask spread's worth. Only conceivable use is as a maker-side skew input, which is outside this (taker, executable-ask) evaluation. **No actionable taker cell.**

### F5. `cl_mainnet` vs `rtds_chainlink` — mainnet rounds are stale and nothing resolves on them — **DEAD (confirms known result)**

- `cl_mainnet` present in 15.8% of late-window snaps (BTC only); within late windows it **never updates** (0% change rate across consecutive snaps).
- |cl_mainnet/rtds_chainlink − 1|: p50 **7.4bp**, p90 26.2bp, p99 40.5bp — pure deviation-threshold staleness.
- `resolution_source` values in DB: {NULL, polymarket_crypto_5m, binance_1h_candle}. **No market type resolves on the mainnet push feed.** The lag is large but attached to nothing tradeable. Reproduction:
```sql
SELECT resolution_source, count(*) FROM borg_markets GROUP BY 1;
SELECT count(*) FILTER (WHERE cl_mainnet IS NOT NULL)::float/count(*) FROM borg_book_snaps
WHERE ts > now() - interval '2 days';
```

### F6. Tie-rule near-boundary cell on true hourlies — cell too thin, and UP is rich, not cheap — **NOISE / insufficient n**

Correction to the target premise: the products where ties are physically possible are the **Binance-candle-resolved hourlies** (the Chainlink-resolved 5m/15m carry ~11-decimal values → P(tie) ≈ 0 by construction; there is no tie premium to buy there). Tick coarseness: BTC 0.002bp, ETH 0.05bp, **SOL 1.33bp, XRP 0.92bp** per tick — only SOL/XRP matter.
Repaired-kline hourlies with late snaps: 108 markets. At tte<120s and |spot−open| ≤ 2 ticks: **n=17 markets** (9 xrp, 7 sol, 1 eth): P(UP)=0.471, up_ask=0.618, up_bid=0.379 (24c spread), buy-UP 1x = **−0.152**. At ≤5 ticks: n=23, buy-UP −0.065. The UP token trades **above** any tie-inclusive fair in this cell, and the boundary books are quoted far too wide to exploit a ≤1bp tie premium. n is ~6x below the house significance floor and cannot grow fast (≈7 hourly markets/day/asset). **Nothing here; do not pursue at current market count.**

---

## Bottom line
No taker-executable oracle/latency edge clears the bar in this dataset. The genuine 1–2s Binance→Chainlink resolver lag exists and is measurable, but it lives at sub-2bp displacements where resolution sign is a coin flip, and the Polymarket book near boundaries already prices the resolver path, not the CEX path. The single highest-value output is **F1**: the `direction_1h` taxonomy/`btc_ref`/`phi_fair` corruption, which silently poisons every hourly-family pilot and any future 15m-market research until the ingestion is fixed (true window = [window_end−15m, window_end]; hourly resolution = Binance candle; 15m resolution = Chainlink RTDS path).

## Caveats
- 41h of RTDS/snap coverage → halves are ~20h each; all "no edge" verdicts are within that regime (one mostly-quiet H2). PROVISIONAL flags noted inline (F3 subcell).
- RTDS-derived opens/closes are 1s-sampled proxies for official Data Streams benchmark reports (explains the ~0.4–4% residual outcome mismatches at sub-bp displacements).
- bnb/doge/hype 5m markets have no RTDS coverage and are excluded from all resolver-path analyses.
