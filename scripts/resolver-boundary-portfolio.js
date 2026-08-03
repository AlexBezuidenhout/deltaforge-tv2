#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) require('dotenv').config({ path: serviceEnv });
const { createResearchPool } = require('./lib/research-pool');
const { buildResolverBoundaryPortfolio } = require('../borg/research/resolver-boundary-portfolio');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = createResearchPool({ applicationName: 'resolver-boundary-report' });
  try {
    const report = await buildResolverBoundaryPortfolio(pool);
    console.log(JSON.stringify(report, null, 2));
  } finally { await pool.end(); }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message); process.exit(1);
});
