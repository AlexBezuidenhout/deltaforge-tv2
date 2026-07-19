# Polymarket × Kalshi contract-identity review — 2026-07-16

## Decision

The initially visible queue contained **250 candidate pairs across 42 event-family mappings**. Every row was reviewed against the live Polymarket Gamma description and the live Kalshi market/event rules. A full-universe pass then exposed 11,444 permissive title candidates. Strict participant, predicate, sport, rank, geography, threshold-operator, and explicit fallback screening reduced that noise to **22 plausible residual pairs across 10 additional families**. Those 22 also received full manual rule review. **Zero pairs qualify for payoff-identity approval.** The 52 reviewed families are frozen as `MANUALLY_REJECTED`; none may be labelled lockable or consume a cross-venue monitoring slot.

This is not a claim that the ordinary outcomes are always different. Several Netflix, golf, election, award, and same-team sports rows have the same ordinary-case winner. They still are not risk-neutral contracts because at least one reachable edge state pays differently: cancellation, postponement, missing publication, no-result deadline, tie, recount/projection, source hierarchy, rank, geography, participant, or threshold operator.

Family-level rejection is safe because the mismatch applies to every outcome in the mapped event family. Family-level approval is prohibited in code. A future approval must name one exact Polymarket condition id and one exact Kalshi ticker and contain a complete resolution audit.

## Review standard

For each mapping, the audit compared:

- the exact underlying event, participant, side, geography, chart, rank, and predicate;
- observation time, timezone, expected expiration, latest expiration, and no-result deadline;
- strict versus inclusive threshold operators;
- official source agency and any credible-reporting fallback;
- cancellation, postponement, makeup, withdrawal, tie, runoff, correction, and early-determination rules;
- whether either venue can settle at `Other`, 50-50, or fair market value while the other pays binary Yes/No.

The title score was treated only as candidate discovery. Polymarket explicitly says market rules—not the title—define resolution. Kalshi likewise states that determination follows each contract's rules and source agency. The final source snapshot was taken at `2026-07-16T19:54:02Z`.

## Complete queue coverage

| Rows | Polymarket family | Kalshi event | Decision | Controlling mismatch |
|---:|---|---|---|---|
| 92 | PGA Tour: Corales Puntacana Championship Winner | `KXPGATOUR-COPC26` | Reject | July 25 `Other`, multiple-winner, and source fallbacks are not mirrored by Kalshi's August 2 contract |
| 16 | Kansas City Current–San Diego exact score | `KXNWSLGAME-26JUL17KCSAN` | Reject | Exact score/draw is not match winner |
| 16 | PGA Tour: The Open Championship Winner | `KXPGATOUR-THOC26` | Reject | July 25 `Other`, multiple-winner, and source fallbacks are not mirrored by Kalshi's August 2 contract |
| 7 | South Carolina Republican Senate special primary | `KXSCRSENS-26` | Reject | Nominee fallback and deadline differ from accelerated media-projection determination |
| 6 | Beijing Guoan–Liaoning Tieren | `KXCHNSLGAME-26JUL17BJGLIT` | Reject | Cancellation/postponement versus fair-value settlement |
| 6 | EC Vitória–Vasco da Gama | `KXBRASILEIROGAME-26JUL16VITVDG` | Reject | Cancellation/postponement versus fair-value settlement |
| 6 | Henan–Qingdao Hainiu | `KXCHNSLGAME-26JUL17HENQIN` | Reject | Cancellation/postponement versus fair-value settlement |
| 6 | Kansas City Current–San Diego Wave | `KXNWSLGAME-26JUL17KCSAN` | Reject | Cancellation/postponement versus fair-value settlement |
| 6 | Dinamo Tbilisi–Mondorf | `KXUECLADVANCE-26JUL16TBIMLB` | Reject | Single-match winner versus advancement from a qualifying tie |
| 4 | Virtus–Dila Gori | `KXUECLADVANCE-26JUL16VIRGOR` | Reject | Single-match winner versus advancement from a qualifying tie |
| 4 | San Luis–Cruz Azul | `KXLIGAMXGAME-26JUL17ASLCRA` | Reject | Cancellation/postponement versus fair-value settlement |
| 4 | Bay FC–North Carolina Courage | `KXNWSLGAME-26JUL18BAYNCC` | Reject | Cancellation/postponement versus fair-value settlement |
| 4 | Botafogo–Santos | `KXBRASILEIROGAME-26JUL16BOTSAN` | Reject | Cancellation/postponement versus fair-value settlement |
| 4 | Montréal–Toronto | `KXMLSGAME-26JUL16MTLTOR` | Reject | Cancellation/postponement versus fair-value settlement |
| 4 | Chicago Fire–Vancouver | `KXMLSGAME-26JUL16CHIVAN` | Reject | Cancellation/postponement versus fair-value settlement |
| 4 | Dalian Yingbo–Shandong Taishan | `KXCHNSLGAME-26JUL18DALSHT` | Reject | Cancellation/postponement versus fair-value settlement |
| 4 | Denver Summit–Portland Thorns | `KXNWSLGAME-26JUL18DENPTH` | Reject | Cancellation/postponement versus fair-value settlement |
| 4 | Derry City–CSKA Sofia | `KXUELADVANCE-26JUL16DERCSK` | Reject | Single-match winner versus advancement from a qualifying tie |
| 4 | Ferencvárosi–Vojvodina | `KXUELADVANCE-26JUL16FTCVOJ` | Reject | Single-match winner versus advancement from a qualifying tie |
| 4 | Ferencvárosi–Vojvodina | `KXUELGAME-26JUL16FTCVOJ` | Reject | Cancellation/postponement and source rules differ |
| 4 | Kansas City Current–San Diego Wave | `KXMLBGAME-26JUL172010SDKC` | Reject | NWSL event incorrectly matched to an MLB event |
| 4 | Shanghai Shenhua–Beijing Guoan | `KXCHNSLGAME-26JUL11SHSBJG` | Reject | Cancellation/postponement versus fair-value settlement |
| 3 | Jeju–Pohang Steelers | `KXKLEAGUEGAME-26JUL18JEJPOH` | Reject | Cancellation/postponement versus fair-value settlement |
| 3 | Mets–Phillies first five innings | `KXMLBF5-26JUL161910NYMPHI` | Reject | Unlimited makeup/50-50 cancellation versus two-day reschedule rule |
| 3 | Querétaro–América | `KXLIGAMXGAME-26JUL18QUEAME` | Reject | Cancellation/postponement versus fair-value settlement |
| 3 | Global Netflix movie | `KXNETFLIXRANKMOVIE-26JUL20` | Reject | Global chart versus US chart |
| 3 | US Netflix movie | `KXNETFLIXRANKMOVIE-26JUL20` | Reject | Polymarket's July 24 missing-update `Other` rule is not mirrored by Kalshi's July 27 latest expiration |
| 2 | The Odyssey Rotten Tomatoes score | `KXRT-ODY` | Reject | Polymarket `>=` versus Kalshi `>`, plus missing-data fallback |
| 2 | Arizona Secretary of State Republican primary | `KXAZSOSR-26` | Reject | Source, accelerated projection, and no-nominee deadline differ |
| 2 | Arizona Treasurer Republican primary | `KXAZTREASR-26` | Reject | Source, accelerated projection, and no-nominee deadline differ |
| 2 | Monterrey–Santos Laguna | `KXLIGAMXGAME-26JUL18MONSLA` | Reject | Cancellation/postponement versus fair-value settlement |
| 2 | People's Sexiest Man Alive | `KXSEXYMAN-26` | Reject | Multiple-honoree, no-announcement, and source fallbacks differ |
| 2 | President Trump attends World Cup final | `KXWCATTEND-26JUL20` | Reject | Donald Trump incorrectly matched to Melania or Ivanka Trump |
| 2 | Global Netflix movie | `KXNETFLIXRANKMOVIEGLOBAL-26JUL20` | Reject | Missing-publication deadline/fallback differs |
| 1 | Emmy supporting actor in a comedy | `KXEMMYCSACTO-26SEP14` | Reject | Alphabetical tie/cancellation/no-result fallback versus distinct Tie strike and later close |
| 1 | Global Netflix movie | `KXNETFLIXRANKMOVIEGLOBAL2-26JUL20` | Reject | Rank #1 versus rank #2 |
| 1 | Global Netflix show | `KXNETFLIXRANKSHOW-26JUL20` | Reject | Global chart versus US chart |
| 1 | Global Netflix show | `KXNETFLIXRANKSHOWGLOBAL-26JUL20` | Reject | Missing-publication deadline/fallback differs |
| 1 | US Netflix movie | `KXNETFLIXRANKMOVIEGLOBAL-26JUL20` | Reject | US chart versus global chart |
| 1 | US Netflix show | `KXNETFLIXRANKSHOW-26JUL20` | Reject | Missing-publication deadline/fallback differs |
| 1 | US Netflix show | `KXNETFLIXRANKSHOWGLOBAL-26JUL20` | Reject | US chart versus global chart |
| 1 | US Netflix show | `KXNETFLIXRANKSHOWRUNNERUP-26JUL20` | Reject | Rank #1 versus rank #2 |

Initial visible queue total: **250 reviewed, 250 rejected, 0 approved**.

## Plausible residual review after structural screening

| Rows | Polymarket family | Kalshi event | Decision | Controlling mismatch |
|---:|---|---|---|---|
| 6 | GA-13 Special Election Winner | `KXGA13S-26` | Reject | Runoff and January `Other` fallback versus accelerated projection and July 2027 close |
| 3 | Taiwanese Local Elections: Party Winner | `KXTAIWANLOCAL-26NOV28` | Reject | Explicit election universe, alphabetical tie, and missing-results rules are not mirrored by Kalshi's accelerated resolution |
| 3 | World Cup: Most Player Goals Record Broken | `KXWCCLUBGOALS-26` | Reject | One player's 13-goal record versus aggregate goals by players from one club at 20/22/24 thresholds |
| 3 | World Cup: Player to score | `KXWCSOA-26JUL19ESPARG` | Reject | Goal in any World Cup match versus goal-or-assist in one match, with fair-value DNP handling |
| 2 | Reno Mayoral Election Winner | `KXRENOMAYOR-26` | Reject | April `Other` and source hierarchy versus accelerated projection and November 2027 close |
| 1 | Women’s US Open Winner | `KXWTA-26USO` | Reject | Polymarket cancellation/postponement/no-winner `Other` rule is not mirrored by Kalshi |
| 1 | Trump Speech to the Nation duration | `KXTRUMPMENTIONDURATION-JUL1726` | Reject | Different start/end measurement and cancellation/delay fallback |
| 1 | First World Cup Halftime Show song | `KXWCFIRSTSONG-SHA26JUL20` | Reject | Any official performer/lyrics versus Shakira/melody-or-lyrics, plus different fallback handling |
| 1 | Closest Senate Race | `KXMOVGANCSEN-26NOV03` | Reject | Smallest margin among all Senate races versus largest margin among Georgia and North Carolina only |
| 1 | Top Spotify artist in July | `KXTOPMONTHLY-26JUL` | Reject | Ordinary metric matches, but tie and Spotify-outage settlement rules do not |

Residual total: **22 reviewed, 22 rejected, 0 approved**. Combined manual review: **272 queue/residual rows, 52 rule families, 0 approvals**. Clear structural false positives outside those rows are rejected mechanically and can never be auto-approved.

## Operational consequence

The rejected rows remain visible as an audit trail but are excluded from monitoring and evidence. They cannot produce `LOCKABLE_NONATOMIC` observations. New, previously unseen candidates remain eligible for review and may be monitored as unapproved diagnostics until reviewed. A later exact approval must still pass executable depth, all fees, stale-leg checks, orphan-risk stress, and the non-atomic execution warning.

Authoritative background:

- Polymarket: <https://help.polymarket.com/en/articles/13364548-how-are-markets-clarified>
- Kalshi market rules: <https://help.kalshi.com/en/articles/13823822-market-rules>
- Kalshi lifecycle/time fields: <https://docs.kalshi.com/getting_started/market_lifecycle>
