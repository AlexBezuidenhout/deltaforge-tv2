#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) {
  require('dotenv').config({ path: serviceEnv });
}
const { createResearchPool } = require('./lib/research-pool');
const {
  buildEdgeDataCatalog,
  markdownCatalog,
} = require('../borg/research/edge-data-catalog');

function arg(name, fallback = null) {
  const equal = process.argv.find((value) => value.startsWith(`${name}=`));
  if (equal) return equal.slice(name.length + 1);
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

function atomicWrite(file, contents) {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o644, flag: 'wx' });
  fs.renameSync(temporary, absolute);
}

async function currentEvidenceBoundary(pool) {
  try {
    const { rows } = await pool.query(`
      SELECT r.epoch_id id,e.started_at,r.run_id,r.code_version
        FROM borg_collector_runs r
        JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
       WHERE r.status='RUNNING'
       ORDER BY r.started_at DESC
       LIMIT 1`);
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      startedAt: new Date(rows[0].started_at).toISOString(),
      runId: rows[0].run_id,
      codeVersion: rows[0].code_version,
    };
  } catch (_) {
    return null;
  }
}

async function main() {
  const skipDb = process.argv.includes('--skip-db');
  const pool = skipDb ? null : createResearchPool({
    applicationName: 'deltaforge-edge-data-catalog',
    statementTimeoutMs: Number(arg('--statement-timeout-ms', 5000)),
    lockTimeoutMs: 250,
    max: 1,
  });
  try {
    const evidenceBoundary = pool ? await currentEvidenceBoundary(pool) : null;
    const catalog = await buildEdgeDataCatalog({
      pool,
      evidenceBoundary,
      walRoot: arg('--wal-root', undefined),
      archiveRoot: arg('--archive-root', undefined),
      parquetRoot: arg('--parquet-root', undefined),
      parquetLakeStateFile: arg('--parquet-lake-state', undefined),
      offhostStateFile: arg('--offhost-state', undefined),
      receiptFile: arg('--receipt', undefined),
      maxBoundaryQueries: Number(arg('--max-boundary-queries', 80)),
    });
    const json = `${JSON.stringify(catalog, null, 2)}\n`;
    const markdown = markdownCatalog(catalog);
    const jsonOut = arg('--json-out');
    const markdownOut = arg('--markdown-out');
    if (jsonOut) atomicWrite(jsonOut, json);
    if (markdownOut) atomicWrite(markdownOut, markdown);
    if (process.argv.includes('--json')) process.stdout.write(json);
    else if (process.argv.includes('--markdown')) process.stdout.write(markdown);
    else {
      process.stdout.write(`${JSON.stringify({
        format: catalog.format,
        generatedAt: catalog.generatedAt,
        catalogSha256: catalog.catalogSha256,
        evidenceBoundary: catalog.evidenceBoundary,
        databaseBytes: catalog.database?.bytes || null,
        databaseTables: catalog.database?.tables?.length || 0,
        walFiles: catalog.storage.wal.files,
        walBytes: catalog.storage.wal.bytes,
        offhostFiles: catalog.storage.offhost?.files || 0,
        offhostVerified: catalog.storage.offhost?.verified || 0,
        offhostBytes: catalog.storage.offhost?.bytes || 0,
        parquetFiles: catalog.storage.parquetLake?.files
          || catalog.storage.parquet.groups.reduce((sum, group) => sum + group.parquetFiles, 0),
        parquetRows: catalog.storage.parquetLake?.rows || 0,
        warnings: catalog.warnings,
        jsonOut: jsonOut ? path.resolve(jsonOut) : null,
        markdownOut: markdownOut ? path.resolve(markdownOut) : null,
      }, null, 2)}\n`);
    }
  } finally {
    if (pool) await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = { atomicWrite, currentEvidenceBoundary };
