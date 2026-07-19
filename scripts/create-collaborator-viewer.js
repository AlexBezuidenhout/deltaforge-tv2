#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
require('dotenv').config({ path: process.env.TV2_ENV_FILE || '.env' });

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function configuredId(value) {
  const id = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function main() {
  const output = path.resolve(arg('output', 'collaborator-access.json'));
  const hashOutput = path.resolve(arg('hash-output', `${output}.bcrypt`));
  const email = String(arg('email', 'friend.viewer@deltaforge.local')).trim().toLowerCase();
  const tv2Url = arg('tv2-url', 'https://tv2.107.174.203.197.sslip.io');
  const df2Url = arg('df2-url', 'https://df2.107.174.203.197.sslip.io');
  const targetUserId = configuredId(process.env.VIEWER_TARGET_USER_ID)
    ?? configuredId(process.env.DEFAULT_USER_ID);

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!targetUserId) throw new Error('VIEWER_TARGET_USER_ID or DEFAULT_USER_ID is required');
  if (!email.includes('@')) throw new Error('Viewer email is invalid');

  const ssl = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'
    ? { rejectUnauthorized: true }
    : (process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false });
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl });
  const password = crypto.randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 12);

  await client.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query(
      'SELECT id, role FROM users WHERE id = $1 FOR SHARE',
      [targetUserId]
    );
    if (!target.rows[0]) throw new Error(`Viewer target user ${targetUserId} does not exist`);
    if (target.rows[0].role === 'viewer') throw new Error('Viewer target cannot itself be a viewer');

    const result = await client.query(
      `INSERT INTO users (email, password_hash, role, is_admin)
       VALUES ($1, $2, 'viewer', false)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         role = 'viewer',
         is_admin = false,
         updated_at = NOW()
       RETURNING id`,
      [email, passwordHash]
    );
    await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [result.rows[0].id]);
    await client.query('COMMIT');

    const access = {
      generatedAt: new Date().toISOString(),
      handling: 'Confidential. Send separately from source code. Never commit this file.',
      tv2: {
        url: tv2Url,
        email,
        password,
        access: 'read-only application viewer',
      },
      df2: {
        url: df2Url,
        username: 'friend-viewer',
        password,
        access: 'read-only HTTPS proxy',
      },
    };
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(output, 0o600);
    fs.writeFileSync(hashOutput, `${passwordHash}\n`, { mode: 0o600 });
    fs.chmodSync(hashOutput, 0o600);
    console.log(`Viewer ${result.rows[0].id} provisioned for data owner ${targetUserId}`);
    console.log(`Access sheet written to ${output}`);
    console.log(`Proxy hash written to ${hashOutput}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Provisioning failed: ${error.message}`);
  process.exitCode = 1;
});
