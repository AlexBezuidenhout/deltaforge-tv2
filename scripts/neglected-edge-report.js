#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) {
  require('dotenv').config({ path: serviceEnv });
}
const { Pool } = require('pg');
const { buildNeglectedEdgeReport } = require('../borg/research/neglected-edge-report');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 2,
  });
  try {
    const report = await buildNeglectedEdgeReport(pool, {
      limit: Math.min(250, Math.max(1, Number(arg('--limit', 50)))),
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
