'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { pool } = require('../src/models/db');
const {
  authMiddleware,
  adminMiddleware,
  isRegistrationAllowed,
  isReadOnlyMethod,
  getViewerTargetUserId,
} = require('../src/middleware/auth');

const JWT_SECRET = 'test-secret-that-is-at-least-thirty-two-characters';

test.after(async () => {
  await pool.end();
});

async function runMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; resolve({ next: false, req, res: this }); },
    };
    Promise.resolve(middleware(req, response, () => resolve({ next: true, req, res: response })))
      .catch(reject);
  });
}

test('viewer policy only treats GET, HEAD and OPTIONS as read-only', () => {
  assert.equal(isReadOnlyMethod('GET'), true);
  assert.equal(isReadOnlyMethod('head'), true);
  assert.equal(isReadOnlyMethod('OPTIONS'), true);
  assert.equal(isReadOnlyMethod('POST'), false);
  assert.equal(isReadOnlyMethod('PUT'), false);
  assert.equal(isReadOnlyMethod('DELETE'), false);
});

test('registration is closed by default and viewer target is explicit', () => {
  const oldAllow = process.env.ALLOW_REGISTRATION;
  const oldViewer = process.env.VIEWER_TARGET_USER_ID;
  const oldDefault = process.env.DEFAULT_USER_ID;
  delete process.env.ALLOW_REGISTRATION;
  process.env.VIEWER_TARGET_USER_ID = '7';
  process.env.DEFAULT_USER_ID = '2';
  assert.equal(isRegistrationAllowed(), false);
  assert.equal(getViewerTargetUserId(), 7);
  process.env.ALLOW_REGISTRATION = 'true';
  assert.equal(isRegistrationAllowed(), true);
  if (oldAllow == null) delete process.env.ALLOW_REGISTRATION; else process.env.ALLOW_REGISTRATION = oldAllow;
  if (oldViewer == null) delete process.env.VIEWER_TARGET_USER_ID; else process.env.VIEWER_TARGET_USER_ID = oldViewer;
  if (oldDefault == null) delete process.env.DEFAULT_USER_ID; else process.env.DEFAULT_USER_ID = oldDefault;
});

test('viewer reads operator data but cannot POST', async (t) => {
  const oldQuery = pool.query;
  const oldSecret = process.env.JWT_SECRET;
  const oldDisabled = process.env.DISABLE_AUTH;
  const oldTarget = process.env.VIEWER_TARGET_USER_ID;
  t.after(() => {
    pool.query = oldQuery;
    if (oldSecret == null) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
    if (oldDisabled == null) delete process.env.DISABLE_AUTH; else process.env.DISABLE_AUTH = oldDisabled;
    if (oldTarget == null) delete process.env.VIEWER_TARGET_USER_ID; else process.env.VIEWER_TARGET_USER_ID = oldTarget;
  });

  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DISABLE_AUTH = 'false';
  process.env.VIEWER_TARGET_USER_ID = '1';
  pool.query = async () => ({ rows: [{ id: 42, role: 'viewer', is_admin: false }] });
  const token = jwt.sign({ userId: 42 }, JWT_SECRET);
  const headers = { authorization: `Bearer ${token}` };

  const read = await runMiddleware(authMiddleware, { method: 'GET', headers, query: {} });
  assert.equal(read.next, true);
  assert.equal(read.req.authUserId, 42);
  assert.equal(read.req.userId, 1);
  assert.equal(read.req.userRole, 'viewer');
  assert.equal(read.req.readOnly, true);

  const write = await runMiddleware(authMiddleware, { method: 'POST', headers, query: {} });
  assert.equal(write.next, false);
  assert.equal(write.res.statusCode, 403);
  assert.equal(write.res.body.code, 'READ_ONLY_VIEWER');
});

test('mapped viewer identity never passes admin authorization', async (t) => {
  const oldQuery = pool.query;
  t.after(() => { pool.query = oldQuery; });
  pool.query = async (_sql, params) => {
    assert.deepEqual(params, [42]);
    return { rows: [{ role: 'viewer', is_admin: false }] };
  };
  const result = await runMiddleware(adminMiddleware, {
    method: 'GET',
    authUserId: 42,
    userId: 1,
    userRole: 'viewer',
    readOnly: true,
  });
  assert.equal(result.next, false);
  assert.equal(result.res.statusCode, 403);
});
