#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function read(flag, expectedLocation) {
  const file = arg(flag);
  if (!file) return null;
  const report = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return {
    location: report.location || expectedLocation,
    file: path.resolve(file),
    measuredAt: report.measured_at,
    dbP95Ms: report.database?.rtt?.p95_ms ?? null,
    clobHttpP95Ms: report.public_http_rtt?.polymarket_clob_time?.p95_ms ?? null,
    binanceHttpP95Ms: report.public_http_rtt?.binance_time?.p95_ms ?? null,
    clobFeedFreshnessP95Ms: report.websocket?.polymarket_clob?.freshness_corrected?.p95_ms ?? null,
    binanceFeedFreshnessP95Ms: report.websocket?.binance_aggTrade?.freshness_corrected?.p95_ms ?? null,
    rtdsFeedFreshnessP95Ms: report.websocket?.polymarket_chainlink_rtds?.freshness_corrected?.p95_ms ?? null,
    orderAckMeasured: report.order_acknowledgement?.status === 'MEASURED',
    suggestedOrderLatencyMs: report.suggested_order_latency_ms ?? null,
  };
}

function score(host) {
  const metrics = [host.clobHttpP95Ms, host.clobFeedFreshnessP95Ms, host.binanceFeedFreshnessP95Ms]
    .filter(Number.isFinite);
  return metrics.length === 3 ? metrics.reduce((sum, value) => sum + value, 0) : Infinity;
}

function main() {
  const hosts = [read('--mac', 'measured-mac'), read('--dublin', 'measured-dublin'), read('--us-east', 'measured-us-east')].filter(Boolean);
  if (!hosts.length) throw new Error('provide at least one of --mac, --dublin, or --us-east benchmark JSON files');
  const ranked = [...hosts].sort((a, b) => score(a) - score(b));
  console.log(JSON.stringify({
    format: 'borg-host-comparison-v1', createdAt: new Date().toISOString(), hosts,
    empiricalWinner: ranked[0] && Number.isFinite(score(ranked[0])) ? ranked[0].location : null,
    deployDecision: hosts.length < 3
      ? 'INSUFFICIENT_LOCATIONS: run the identical benchmark on Mac, Dublin, and us-east before choosing.'
      : 'Replay strategies using each measured latency profile; choose only if post-fee quote-survival PnL improves, not from ping marketing.',
    caveat: 'Read-only tests do not measure signed order acknowledgement. Database RTT is reported separately because a remote Neon dependency can erase a feed-location gain.',
  }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exit(1); }
}
