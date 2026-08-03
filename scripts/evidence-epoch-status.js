#!/usr/bin/env node
'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { assessEvidenceEpoch } = require('../borg/research/evidence-epoch');

async function main() {
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(process.env.DATABASE_URL || '');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 1,
  });
  try {
    const report = await assessEvidenceEpoch(pool, {
      record: process.argv.includes('--record'),
      minHours: Number(process.env.BORG_MIN_CLEAN_EVIDENCE_HOURS || 24),
      minimumFreeGiB: Number(process.env.BORG_EVIDENCE_MIN_FREE_GIB || 30),
      parquetMinHours: Number(process.env.BORG_PARQUET_MIN_CLEAN_HOURS || 24),
      maxParquetAgeSec: Number(process.env.BORG_PARQUET_MAX_AGE_SEC || 5400),
      minimumParquetVerifiedBatches: Number(
        process.env.BORG_PARQUET_MIN_VERIFIED_BATCHES || 2,
      ),
      parquetStateFile: process.env.PARQUET_LAKE_STATE_FILE,
      parquetReceiptFile: process.env.PARQUET_LAKE_RECEIPT,
      parquetReportFile: process.env.PARQUET_LAKE_REPORT,
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'FAILED') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
