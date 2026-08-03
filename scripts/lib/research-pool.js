'use strict';

const { Pool } = require('pg');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isLocalDatabase(connectionString) {
  const value = String(connectionString || '');
  try {
    const parsed = new URL(value);
    const hostname = String(parsed.hostname || '').toLowerCase();
    const socketHost = parsed.searchParams.get('host');
    return !hostname || ['localhost', '127.0.0.1', '::1'].includes(hostname)
      || String(socketHost || '').startsWith('/');
  } catch (_) {
    return /(?:^|[@/])(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(value);
  }
}

/**
 * Reports must never be able to queue behind DDL or hold the ingestion database
 * hostage.  ANALYTICS_DATABASE_URL should point at a read replica or restored
 * Parquet/PostgreSQL research copy.  DATABASE_URL remains a bounded fallback so
 * an operator can still run a small report before that replica exists.
 */
function buildResearchPoolConfig(options = {}, env = process.env) {
  const connectionString = options.connectionString
    || env.ANALYTICS_DATABASE_URL
    || env.RESEARCH_DATABASE_URL
    || env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('ANALYTICS_DATABASE_URL or DATABASE_URL is required');
  }
  const statementTimeoutMs = positiveInteger(
    options.statementTimeoutMs ?? env.RESEARCH_STATEMENT_TIMEOUT_MS,
    30_000,
  );
  const lockTimeoutMs = positiveInteger(
    options.lockTimeoutMs ?? env.RESEARCH_LOCK_TIMEOUT_MS,
    500,
  );
  const idleTransactionTimeoutMs = positiveInteger(
    options.idleTransactionTimeoutMs ?? env.RESEARCH_IDLE_TX_TIMEOUT_MS,
    30_000,
  );
  const applicationName = String(
    options.applicationName || env.RESEARCH_APPLICATION_NAME || 'deltaforge-research-report',
  ).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 63);
  return {
    connectionString,
    ssl: isLocalDatabase(connectionString) ? false : { rejectUnauthorized: false },
    max: Math.min(2, positiveInteger(options.max, 1)),
    application_name: applicationName,
    statement_timeout: statementTimeoutMs,
    lock_timeout: lockTimeoutMs,
    idle_in_transaction_session_timeout: idleTransactionTimeoutMs,
    options: '-c default_transaction_read_only=on',
  };
}

function createResearchPool(options = {}, env = process.env) {
  return new Pool(buildResearchPoolConfig(options, env));
}

module.exports = {
  buildResearchPoolConfig,
  createResearchPool,
  isLocalDatabase,
};
