#!/usr/bin/env node
// scripts/q.js — run a SQL query (arg or stdin) against DATABASE_URL, print rows as aligned table.
process.removeAllListeners('warning');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  let sql = process.argv[2];
  if (!sql || sql === '-') {
    sql = require('fs').readFileSync(0, 'utf8');
  }
  const res = await pool.query(sql);
  const rowsets = Array.isArray(res) ? res : [res];
  for (const r of rowsets) {
    if (!r.rows || r.rows.length === 0) { console.log(`(${r.command}: ${r.rowCount ?? 0} rows)`); continue; }
    const cols = Object.keys(r.rows[0]);
    const fmt = v => v === null ? 'NULL' : v instanceof Date ? v.toISOString() : String(v);
    const widths = cols.map(c => Math.max(c.length, ...r.rows.map(row => fmt(row[c]).length)));
    console.log(cols.map((c, i) => c.padEnd(widths[i])).join(' | '));
    console.log(widths.map(w => '-'.repeat(w)).join('-+-'));
    for (const row of r.rows) console.log(cols.map((c, i) => fmt(row[c]).padEnd(widths[i])).join(' | '));
    console.log(`(${r.rows.length} rows)`);
  }
  await pool.end();
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
