#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const makeStrategies = require('../borg/shadow/strategies');
const { riskWindowFloor } = require('../src/bot/PortfolioRiskPolicy');

const CORE_HEARTBEATS = Object.freeze([
  'main_bot', 'george_bot', 'h53_live', 'flow_boundary_canary',
  'paired_maker_lab', 'structural_scanner', 'options_surface', 'pyth_boundary',
  'crossvenue_lab', 'allmarket_lab',
]);
const HEARTBEAT_COMPONENTS = Object.freeze([...CORE_HEARTBEATS, 'gla_live', 'raw_archiver']);

function ageSeconds(value) {
  if (!value) return null;
  return Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
}

function number(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  const critical = [];
  const warnings = [];
  const checks = {};
  try {
    const expected = [...new Set(makeStrategies().map((strategy) => strategy.name))].sort();
    const [
      { rows: settingsRows }, { rows: runRows }, { rows: heartbeatRows },
      { rows: collectorRows }, { rows: flowRows },
    ] = await Promise.all([
      pool.query(`SELECT user_id, paper_trading, is_active, george_is_active,
                         george_own_signal_enabled, george_resurrection_enabled,
                         paper_balance, virtual_paper_balance, george_paper_balance,
                         max_daily_loss, george_max_daily_loss, candidate_portfolio_enabled,
                         portfolio_bankroll_usdc, override_daily_loss,
                         main_exec_honest_anchor, paper_risk_epoch_anchor,
                         paper_risk_limits_enabled, live_h53_enabled,
                         live_gla_enabled, live_flow_boundary_enabled,
                         min_entry_remaining_sec, per_market_cooldown
                    FROM bot_settings ORDER BY user_id LIMIT 1`),
      pool.query(`SELECT r.*, e.started_at epoch_started_at, e.location,
                         e.data_contract_version
                    FROM borg_collector_runs r
                    JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
                   WHERE r.status='RUNNING' ORDER BY r.started_at DESC LIMIT 1`),
      pool.query(`SELECT component, beat_at, meta,
                         EXTRACT(EPOCH FROM now()-beat_at)::int age_sec
                   FROM system_heartbeats
                   WHERE component=ANY($1::text[])`, [HEARTBEAT_COMPONENTS]),
      pool.query(`SELECT ts, message, data,
                         EXTRACT(EPOCH FROM now()-ts)::int age_sec
                    FROM borg_events WHERE source='heartbeat'
                   ORDER BY ts DESC LIMIT 1`),
      pool.query(`SELECT ts,data,EXTRACT(EPOCH FROM now()-ts)::int age_sec
                    FROM borg_events WHERE source='flow_heartbeat'
                   ORDER BY ts DESC LIMIT 1`),
    ]);

    const settings = settingsRows[0];
    if (!settings) critical.push('bot_settings row is missing');
    if (settings) {
      if (settings.paper_trading !== true) critical.push('paper_trading is not true');
      if (settings.is_active !== true) critical.push('Main is not configured active');
      if (settings.george_is_active !== true) critical.push('George is not configured active');
      if (settings.override_daily_loss === true) critical.push('daily-loss operator override is enabled');
      checks.capital = {
        mainPaperBalance: number(settings.paper_balance),
        virtualPaperBalance: number(settings.virtual_paper_balance),
        georgePaperBalance: number(settings.george_paper_balance),
        portfolioBankrollUsd: number(settings.portfolio_bankroll_usdc, 500),
      };
      checks.paperControls = {
        paperTrading: settings.paper_trading,
        mainActive: settings.is_active,
        georgeActive: settings.george_is_active,
        georgeOwnSignalEnabled: settings.george_own_signal_enabled,
        georgeResurrectionEnabled: settings.george_resurrection_enabled,
        paperRiskEpochAnchor: settings.paper_risk_epoch_anchor,
        paperRiskLimitsEnabled: settings.paper_risk_limits_enabled,
        entryGuardSeconds: parseInt(settings.min_entry_remaining_sec, 10),
        perMarketCooldown: settings.per_market_cooldown,
        dailyLossOverride: settings.override_daily_loss,
        h53LiveEnabled: settings.live_h53_enabled,
        glaLiveEnabled: settings.live_gla_enabled,
        flowBoundaryLiveEnabled: settings.live_flow_boundary_enabled,
      };
    }

    const run = runRows[0];
    if (!run) critical.push('no RUNNING BORG collector run is registered');
    const collector = collectorRows[0] || null;
    if (!collector || number(collector.age_sec, Infinity) > 130) critical.push('collector heartbeat is stale or missing');
    const flowCollector = flowRows[0] || null;
    if (!flowCollector || number(flowCollector.age_sec, Infinity) > 130) {
      critical.push('public-flow collector heartbeat is stale or missing');
    }
    checks.collection = run ? {
      epochId: run.epoch_id,
      epochStartedAt: run.epoch_started_at,
      location: run.location,
      dataContractVersion: run.data_contract_version,
      collectorRunId: run.run_id,
      runStartedAt: run.started_at,
      collectorHeartbeatAgeSec: collector ? parseInt(collector.age_sec, 10) : null,
      flowCollectorHeartbeatAgeSec: flowCollector ? parseInt(flowCollector.age_sec, 10) : null,
      flowActiveSockets: flowCollector ? number(flowCollector.data?.activeSockets) : null,
    } : null;

    const beatByName = Object.fromEntries(heartbeatRows.map((row) => [row.component, row]));
    for (const component of CORE_HEARTBEATS) {
      const beat = beatByName[component];
      if (!beat || number(beat.age_sec, Infinity) > 120) critical.push(`${component} heartbeat is stale or missing`);
    }
    if (beatByName.main_bot && number(beatByName.main_bot.meta?.lastTickAgeSec, 0) > 60) {
      critical.push(`Main evaluator tick is ${beatByName.main_bot.meta.lastTickAgeSec}s old`);
    }
    if (beatByName.george_bot && number(beatByName.george_bot.meta?.lastTickAgeSec, 0) > 60) {
      critical.push(`George evaluator tick is ${beatByName.george_bot.meta.lastTickAgeSec}s old`);
    }
    const glaBeat = beatByName.gla_live;
    if (settings?.live_gla_enabled === true) {
      if (!glaBeat || number(glaBeat.age_sec, Infinity) > 120) {
        critical.push('G_late_arb paper mirror is enabled but its heartbeat is stale or missing');
      } else if (glaBeat.meta?.dry !== true) {
        critical.push('G_late_arb mirror is not in its systemd-enforced dry-run paper mode');
      }
    } else if (glaBeat && number(glaBeat.age_sec, Infinity) <= 120) {
      warnings.push('G_late_arb mirror is running while its DB enable switch is off');
    }
    if (beatByName.h53_live) {
      const expectedDry = settings?.live_h53_enabled !== true;
      if (beatByName.h53_live.meta?.dryRun !== expectedDry) {
        critical.push(`H53 mode mismatch: DB expects ${expectedDry ? 'paper observer' : 'live'}, heartbeat reports ${beatByName.h53_live.meta?.dryRun ? 'paper observer' : 'live'}`);
      }
    }
    if (beatByName.flow_boundary_canary) {
      const expectedDry = settings?.live_flow_boundary_enabled !== true;
      if (beatByName.flow_boundary_canary.meta?.dryRun !== expectedDry) {
        critical.push(`Flow canary mode mismatch: DB expects ${expectedDry ? 'paper observer' : 'live'}, heartbeat reports ${beatByName.flow_boundary_canary.meta?.dryRun ? 'paper observer' : 'live'}`);
      }
    }
    if (beatByName.paired_maker_lab
        && (beatByName.paired_maker_lab.meta?.paperOnly !== true
          || beatByName.paired_maker_lab.meta?.walletLoaded !== false
          || beatByName.paired_maker_lab.meta?.liveOrderPath !== false)) {
      critical.push('paired maker lab violated its paper-only runtime contract');
    }
    for (const component of [
      'structural_scanner', 'options_surface', 'pyth_boundary', 'crossvenue_lab',
      'allmarket_lab',
    ]) {
      const beat = beatByName[component];
      if (beat && (beat.meta?.paperOnly !== true || beat.meta?.walletLoaded !== false
          || (['pyth_boundary', 'crossvenue_lab', 'allmarket_lab'].includes(component)
            && beat.meta?.liveOrderPath !== false))) {
        critical.push(`${component} violated its paper-only runtime contract`);
      }
    }
    if (beatByName.options_surface) {
      const lastEventAt = number(beatByName.options_surface.meta?.lastEventAt, 0);
      if (!(lastEventAt > 0) || Date.now() - lastEventAt > 60_000) {
        critical.push('options_surface public feed is stale or missing');
      }
    }
    if (beatByName.pyth_boundary) {
      const feedState = beatByName.pyth_boundary.meta?.feedState;
      if (feedState === 'DISCONNECTED' || beatByName.pyth_boundary.meta?.transportConnected === false) {
        critical.push('pyth_boundary RTDS transport is disconnected');
      } else if (feedState === 'CONNECTED_NO_RECENT_TICK') {
        warnings.push(`pyth_boundary has ${number(beatByName.pyth_boundary.meta?.marketsInWindow)} in-window markets but no recent usable tick`);
      }
    }
    if (beatByName.crossvenue_lab
        && number(beatByName.crossvenue_lab.meta?.approvedMatches) === 0) {
      warnings.push('crossvenue_lab is transport-only: zero rule-certified approved identities');
    }
    const archiver = beatByName.raw_archiver;
    if (!archiver || number(archiver.age_sec, Infinity) > 900) {
      critical.push('verified raw archiver heartbeat is stale or missing');
    } else if (!['PASS', 'SKIPPED_LOCKED'].includes(archiver.meta?.status)) {
      critical.push(`verified raw archiver reports ${archiver.meta?.status || 'unknown status'}`);
    }
    checks.processHeartbeats = Object.fromEntries(Object.entries(beatByName).map(([name, row]) => [name, {
      ageSec: parseInt(row.age_sec, 10), meta: row.meta,
    }]));

    if (run) {
      const { rows: runtimeRows } = await pool.query(`
        SELECT *, EXTRACT(EPOCH FROM now()-updated_at)::int age_sec,
                  EXTRACT(EPOCH FROM now()-last_evaluated_at)::int evaluation_age_sec
          FROM borg_strategy_runtime WHERE collector_run_id=$1 ORDER BY strategy
      `, [run.run_id]);
      const runtime = Object.fromEntries(runtimeRows.map((row) => [row.strategy, row]));
      const missing = expected.filter((strategy) => !runtime[strategy]);
      const unexpected = Object.keys(runtime).filter((strategy) => !expected.includes(strategy));
      if (missing.length) critical.push(`missing runtime registration: ${missing.join(', ')}`);
      if (unexpected.length) warnings.push(`runtime has unrecognized strategies: ${unexpected.join(', ')}`);

      const activeTypes = new Set(String(collector?.data?.active || '')
        .split(',').map((entry) => entry.split(':')[1]).filter(Boolean));
      const stale = [];
      const zeroEligible = [];
      const errored = [];
      for (const row of runtimeRows) {
        const marketTypes = Array.isArray(row.market_types) ? row.market_types : [];
        const eligibleNow = marketTypes.some((marketType) => activeTypes.has(marketType));
        if (number(row.age_sec, Infinity) > 130) stale.push(row.strategy);
        if (eligibleNow && number(row.evaluations) === 0 && ageSeconds(run.started_at) > 120) {
          zeroEligible.push(row.strategy);
        }
        if (eligibleNow && row.last_evaluated_at && number(row.evaluation_age_sec, Infinity) > 130) {
          stale.push(`${row.strategy}(evaluation)`);
        }
        if (number(row.errors) > 0) errored.push(`${row.strategy}:${row.errors}`);
      }
      if (stale.length) critical.push(`stale strategy runtime: ${[...new Set(stale)].join(', ')}`);
      if (zeroEligible.length) critical.push(`eligible strategies never evaluated: ${zeroEligible.join(', ')}`);
      if (errored.length) critical.push(`strategy evaluation errors: ${errored.join(', ')}`);
      checks.strategies = {
        expected: expected.length,
        registered: runtimeRows.length,
        evaluated: runtimeRows.filter((row) => number(row.evaluations) > 0).length,
        currentlyEligible: runtimeRows.filter((row) => {
          const types = Array.isArray(row.market_types) ? row.market_types : [];
          return types.some((marketType) => activeTypes.has(marketType));
        }).length,
        missing, unexpected, stale, zeroEligible, errored,
      };
    }

    if (settings) {
      const riskFloor = riskWindowFloor(Date.now(), settings.paper_risk_epoch_anchor);
      const [{ rows: mainPnl }, { rows: georgePnl }] = await Promise.all([
        pool.query(`SELECT COALESCE(sum(pnl),0) pnl FROM trades
                     WHERE user_id=$1 AND status='closed' AND closed_at>$2
                       AND COALESCE(is_virtual,false)=false
                       AND COALESCE(execution_type,'LIVE')='SIMULATED'`, [settings.user_id, riskFloor]),
        pool.query(`SELECT COALESCE(sum(pnl),0) pnl FROM george_trades
                     WHERE user_id=$1 AND status='closed' AND closed_at>$2`, [settings.user_id, riskFloor]),
      ]);
      const portfolioLimit = settings.candidate_portfolio_enabled === true
        ? number(settings.portfolio_bankroll_usdc, 500) * 0.06
        : Infinity;
      const mainLimit = Math.min(Math.abs(number(settings.max_daily_loss, 50)), portfolioLimit);
      const mainRealized = number(mainPnl[0]?.pnl);
      const georgeRealized = number(georgePnl[0]?.pnl);
      if (settings.paper_risk_limits_enabled === true && mainRealized <= -mainLimit) {
        critical.push(`Main is daily-loss halted at $${mainRealized.toFixed(2)}`);
      }
      if (settings.paper_risk_limits_enabled === true
          && georgeRealized <= -Math.abs(number(settings.george_max_daily_loss, 50))) {
        critical.push(`George is daily-loss halted at $${georgeRealized.toFixed(2)}`);
      }
      checks.riskWindow = {
        floor: riskFloor.toISOString(),
        mainRealizedPnl: +mainRealized.toFixed(2),
        mainDailyLossLimit: +mainLimit.toFixed(2),
        georgeRealizedPnl: +georgeRealized.toFixed(2),
        georgeDailyLossLimit: Math.abs(number(settings.george_max_daily_loss, 50)),
        paperRiskLimitsEnabled: settings.paper_risk_limits_enabled,
        note: settings.paper_risk_limits_enabled === true
          ? 'Paper loss/drawdown/concurrency/exposure cutoffs are enabled.'
          : 'Paper loss/drawdown/balance/concurrency/exposure/cooldown cutoffs are disabled. Per-market duplicate/cycle guards remain for execution validity.',
      };
    }
  } finally {
    await pool.end();
  }

  const status = critical.length ? 'FAIL' : warnings.length ? 'DEGRADED' : 'PASS';
  console.log(JSON.stringify({
    format: 'deltaforge-runtime-audit-v1', checkedAt: new Date().toISOString(),
    status, checks, critical, warnings,
  }, null, 2));
  if (critical.length || (process.argv.includes('--strict') && warnings.length)) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
