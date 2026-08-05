#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildCoverage, STATUSES } = require('../borg/research/free-edge-test-coverage');

const ROOT = path.join(__dirname, '..');

function esc(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function render(report) {
  const c = report.statusCounts;
  const rows = report.rows.map((row) => `| ${row.id} | ${esc(row.title)} | ${row.family} | ${row.status} | ${esc(row.screen)} | ${esc(row.evidence)} |`).join('\n');
  return `# Free and currently testable edge falsification — 5 August 2026

Evidence cutoff: **${report.evidenceAsOf}**. Registry coverage: **${report.hypothesisCount}/${report.hypothesisCount} hypotheses assigned to an explicit screen or blocker**.

## Investment conclusion

No strategy currently demonstrates deployable positive expected value. The broad free-data screens reject generic crypto lead/lag, common-factor mean reversion, funding-regime momentum/reversal, cross-venue funding dispersion, present exact-rule Polymarket/Kalshi convergence, ordered-strike execution and the current resolver-boundary cohort after realistic costs. One five-leg Polymarket complete-set episode is a legitimate mechanism lead, but it is one approximately 1.2-second event with only about **$0.14** remaining after the full orphan reserve. XTracker is the only newly launched public-information forward lane and has produced zero intents so far. This is progress in falsification, not proof that the project cannot find edge.

## Coverage outcome

| Outcome | Hypotheses | Meaning |
| --- | ---: | --- |
| Screened negative | ${c[STATUSES.SCREENED_NEGATIVE]} | A causal/coarse executable screen failed current cost and stability criteria. |
| Screened zero unit | ${c[STATUSES.SCREENED_ZERO_UNIT]} | The required certified relationship or signal did not occur; no PnL was fabricated. |
| Promising but unvalidated | ${c[STATUSES.PROMISING_UNVALIDATED]} | Mechanism-level lead only; insufficient independent events. |
| Forward collecting | ${c[STATUSES.FORWARD_COLLECTING]} | Free collector/scanner exists; evidence clock is still running or currently negative. |
| Free collector required | ${c[STATUSES.FREE_COLLECTOR_REQUIRED]} | Source is free, but causal source-to-book history does not yet exist. |
| Blocked by current data | ${c[STATUSES.BLOCKED_CURRENT_DATA]} | Honest backtest is impossible with current causal/execution data. |
| Rejected mechanism | ${c[STATUSES.REJECTED_MECHANISM]} | No defensible payer, prohibited/stale mechanism, or decisive negative control. |
| Non-alpha infrastructure | ${c[STATUSES.NON_ALPHA_INFRASTRUCTURE]} | Useful governance/allocation tooling; cannot create gross edge. |

## Fresh empirical screens

- **CEX lead/lag and Markov:** 43,199 aligned one-minute observations showed high contemporaneous correlation but near-zero lag correlation. Frozen rules produced almost no eligible episodes.
- **CEX common-factor residual:** over 4,319 aligned hourly bars, SOL lost **$144.17** and XRP lost **$44.31** after doubled costs at the $500 scenario. Both halves were negative.
- **Funding regimes:** every populated 180-day arm failed. SOL momentum's **+$0.50** came from four signals and had a negative second half; it is noise, not a successor candidate.
- **Cross-venue funding:** the causal Binance/Hyperliquid arm was negative under stress for BTC, ETH and SOL. Static HYPE funding carry is only about **$8.07 stressed over 180 days** on $250 notional before basis/custody/liquidation reality.
- **Cross-venue prediction markets:** exact-rule V7 generated zero entries. Terminal carry had four settlements, **+$1.09** at doubled fees but **−$21.05** at the full hurdle.
- **Options:** the free exact-expiry probe saw 1,524 listed BTC/ETH instruments and 36 candidate prediction markets, but zero exact-expiry certified targets. No PnL is scoreable.
- **Structural payoff graph:** one unique orphan-safe episode survived. The old dashboard count of 18 represented overlapping ticks/latency arms, not 18 independent trades.
- **Public information:** XTracker's historical boundary proxy was usually too late; the live L2 paper lane is healthy with 175 public events and zero intents at the cutoff.

## What should actually run now

1. Keep the deterministic payoff scanner and XTracker/H43/Pyth collectors running unchanged.
2. Do not launch a new CEX statistical bot from these results; every free-data CEX screen failed or produced too few signals.
3. Build bounded official-source collectors next for SEC filings, macro releases, court dockets, governance and weather **only when an exact active market mapper exists**. Collecting every headline without a target rule would create data volume, not edge.
4. Keep options collection, but suppress expensive derived marks until exact-expiry targets exist.
5. Preserve the ten-lane forward cap. A blocked or zero-signal hypothesis is not repaired by creating parameter variants.

## Full 118-hypothesis disposition

| ID | Hypothesis | Family | Current disposition | Screen | Evidence / blocker |
| --- | --- | --- | --- | --- | --- |
${rows}

## Reproduction

\`node scripts/free-cex-mechanism-backtest.js --days=180\` runs the free hourly CEX screen. \`node scripts/regime-leadlag-research.js --days=30\` runs the minute/Markov diagnostic. \`node scripts/funding-carry-backtest.js --days=180 --capital=500 --json\` and \`node scripts/cross-venue-funding-backtest.js --days=180 --capital=500 --json\` reproduce funding screens. Database-backed reports remain read-only and use the V34 evidence epoch beginning 2026-08-04T08:55:02.890Z.
`;
}

function writeAtomic(file, body) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, body, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function main() {
  const report = buildCoverage(ROOT);
  const jsonFile = path.join(ROOT, 'FREE_EDGE_TEST_COVERAGE_2026-08-05.json');
  const markdownFile = path.join(ROOT, 'FREE_EDGE_FALSIFICATION_2026-08-05.md');
  writeAtomic(jsonFile, `${JSON.stringify(report, null, 2)}\n`);
  writeAtomic(markdownFile, render(report));
  process.stdout.write(`${JSON.stringify({ jsonFile, markdownFile,
    hypothesisCount: report.hypothesisCount, statusCounts: report.statusCounts }, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { render };
