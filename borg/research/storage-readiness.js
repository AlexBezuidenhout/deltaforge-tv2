'use strict';

const fs = require('node:fs');
const {
  googleDriveClientPolicy, parseIniSection,
} = require('../../scripts/google-drive-archive');
const { readReceipt } = require('./evidence-epoch');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function numeric(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function oauthPolicy(configFile, remote) {
  try {
    const values = parseIniSection(fs.readFileSync(configFile, 'utf8'), remote);
    return googleDriveClientPolicy(values);
  } catch (error) {
    return {
      mode: 'UNAVAILABLE', migrationRequired: true,
      customClientIdConfigured: false, customClientSecretConfigured: false,
      warning: `Google Drive OAuth configuration cannot be audited: ${error.message}`,
    };
  }
}

function buildStorageReadiness(options = {}) {
  const archiveReport = readJson(options.archiveReportFile
    || '/var/lib/deltaforge/google-drive-archive/last-report.json');
  const parquetReport = readJson(options.parquetReportFile
    || '/var/lib/deltaforge/parquet-lake/last-report.json');
  const receipt = readReceipt(options.parquetReceiptFile
    || '/var/lib/deltaforge/parquet-lake/receipt');
  const globalPending = numeric(
    receipt?.pending_source_files
      ?? parquetReport?.pendingSourceFiles
      ?? parquetReport?.pending,
    0,
  );
  const continuousPending = numeric(
    receipt?.pending_scope_source_files
      ?? parquetReport?.pendingScopeSourceFiles
      ?? parquetReport?.pendingSourceFiles
      ?? parquetReport?.pending,
    0,
  );
  const bronzeRetained = numeric(
    receipt?.unmaterialized_bronze_source_files
      ?? parquetReport?.unmaterializedBronzeSourceFiles,
    Math.max(0, globalPending - continuousPending),
  );
  const oauth = oauthPolicy(
    options.rcloneConfigFile
      || '/var/lib/deltaforge/google-drive-archive/rclone.conf',
    options.rcloneRemote || process.env.GDRIVE_RCLONE_REMOTE || 'deltaforge-gdrive',
  );
  const rawBacklog = archiveReport?.rawBacklog || null;
  const warnings = [];
  if (oauth.migrationRequired) warnings.push(oauth.warning);
  if (numeric(rawBacklog?.pendingFiles, 0) > 0) {
    warnings.push(`${numeric(rawBacklog.pendingFiles, 0)} immutable raw file(s) await off-host verification`);
  }
  if (continuousPending > 0) {
    warnings.push(`${continuousPending} continuously selected decision/proof file(s) await Parquet compaction`);
  }
  return {
    format: 'deltaforge-storage-readiness-v1',
    generatedAt: options.now ? new Date(options.now).toISOString() : new Date().toISOString(),
    rawArchive: {
      status: archiveReport?.status || 'MISSING',
      checkedAt: archiveReport?.checkedAt || null,
      backlog: rawBacklog,
      receiptPublished: archiveReport?.receiptPublished === true,
    },
    parquet: {
      status: parquetReport?.status || 'MISSING',
      continuousPendingFiles: continuousPending,
      unmaterializedBronzeFiles: bronzeRetained,
      legacyGlobalPendingFiles: globalPending,
      interpretation: 'continuousPendingFiles is the operational research backlog; unmaterializedBronzeFiles is retained raw authority materialized only for an explicit hypothesis.',
    },
    googleDriveOauth: oauth,
    warnings: warnings.filter(Boolean),
  };
}

module.exports = { buildStorageReadiness, oauthPolicy };
