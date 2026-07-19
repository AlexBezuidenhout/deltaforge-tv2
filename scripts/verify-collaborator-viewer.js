#!/usr/bin/env node
'use strict';

const fs = require('fs');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function main() {
  const accessPath = arg('access');
  const baseOverride = arg('base-url');
  if (!accessPath) throw new Error('--access /path/to/collaborator-access.json is required');
  const access = JSON.parse(fs.readFileSync(accessPath, 'utf8'));
  const base = String(baseOverride || access.tv2.url).replace(/\/$/, '');

  const login = await request(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: access.tv2.email, password: access.tv2.password }),
  });
  if (!login.response.ok || !login.body?.token) {
    throw new Error(`Viewer login failed with HTTP ${login.response.status}`);
  }
  const headers = { authorization: `Bearer ${login.body.token}` };

  const me = await request(`${base}/api/auth/me`, { headers });
  if (!me.response.ok || me.body?.user?.role !== 'viewer' || me.body?.user?.readOnly !== true) {
    throw new Error('Authenticated account is not an enforced read-only viewer');
  }

  const read = await request(`${base}/api/bots`, { headers });
  if (!read.response.ok || !Array.isArray(read.body?.bots)) {
    throw new Error(`Viewer dashboard read failed with HTTP ${read.response.status}`);
  }

  const write = await request(`${base}/api/bot/start`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  });
  if (write.response.status !== 403 || write.body?.code !== 'READ_ONLY_VIEWER') {
    throw new Error(`Write boundary failed closed: HTTP ${write.response.status}`);
  }

  const admin = await request(`${base}/api/admin/analytics`, { headers });
  if (admin.response.status !== 403) {
    throw new Error(`Admin boundary failed closed: HTTP ${admin.response.status}`);
  }

  console.log(JSON.stringify({
    ok: true,
    role: me.body.user.role,
    readOnly: me.body.user.readOnly,
    visibleBots: read.body.bots.length,
    writeStatus: write.response.status,
    adminStatus: admin.response.status,
  }));
}

main().catch((error) => {
  console.error(`Viewer verification failed: ${error.message}`);
  process.exitCode = 1;
});
