const jwt = require('jsonwebtoken');
const { pool } = require('../models/db');

const VIEWER_ROLE = 'viewer';
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isAuthDisabled() {
  const v = process.env.DISABLE_AUTH;
  return v === '1' || v === 'true' || v === 'yes';
}

function isRegistrationAllowed() {
  const v = process.env.ALLOW_REGISTRATION;
  return v === '1' || v === 'true' || v === 'yes';
}

function isReadOnlyMethod(method) {
  return READ_ONLY_METHODS.has(String(method || '').toUpperCase());
}

function parseConfiguredUserId(value) {
  if (value == null || String(value).trim() === '') return null;
  const id = Number.parseInt(String(value), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function getViewerTargetUserId() {
  return parseConfiguredUserId(process.env.VIEWER_TARGET_USER_ID)
    ?? parseConfiguredUserId(process.env.DEFAULT_USER_ID);
}

let _bypassUserIdCache = null;

async function getBypassUserId() {
  if (_bypassUserIdCache != null) return _bypassUserIdCache;
  const raw = process.env.DEFAULT_USER_ID;
  if (raw != null && String(raw).trim() !== '') {
    const id = parseInt(raw, 10);
    if (!Number.isNaN(id)) {
      _bypassUserIdCache = id;
      return id;
    }
  }
  const result = await pool.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
  const id = result.rows[0]?.id;
  if (id == null) return null;
  _bypassUserIdCache = id;
  return id;
}

async function applyAuthenticatedUser(authUserId, req, res, next) {
  const result = await pool.query(
    'SELECT id, role, is_admin FROM users WHERE id = $1',
    [authUserId]
  );
  const user = result.rows[0];
  if (!user) {
    return res.status(401).json({ error: 'User no longer exists' });
  }

  const role = user.role || (user.is_admin ? 'admin' : 'user');
  const readOnly = role === VIEWER_ROLE;
  if (readOnly && !isReadOnlyMethod(req.method)) {
    return res.status(403).json({
      error: 'Read-only viewer accounts cannot change bot or account state',
      code: 'READ_ONLY_VIEWER',
    });
  }

  let dataUserId = user.id;
  if (readOnly) {
    dataUserId = getViewerTargetUserId();
    if (!dataUserId) {
      return res.status(503).json({
        error: 'Viewer access is not configured. Set VIEWER_TARGET_USER_ID.',
      });
    }
  }

  // Keep the login identity separate from the data owner. A viewer reads the
  // operator's dashboard rows but can never inherit the operator's admin role.
  req.authUserId = user.id;
  req.userId = dataUserId;
  req.userRole = role;
  req.readOnly = readOnly;
  next();
}

async function authMiddleware(req, res, next) {
  if (isAuthDisabled()) {
    try {
      const userId = await getBypassUserId();
      if (!userId) {
        return res.status(503).json({
          error:
            'DISABLE_AUTH is on but no user exists. Register once with DISABLE_AUTH off, or set DEFAULT_USER_ID.',
        });
      }
      req.authUserId = userId;
      req.userId = userId;
      req.userRole = 'operator';
      req.readOnly = false;
      next();
    } catch (err) {
      console.error('[Auth] DISABLE_AUTH user resolve failed:', err.message);
      res.status(500).json({ error: 'Auth configuration error' });
    }
    return;
  }

  // SSE clients (EventSource) can't set headers — accept token via query param as fallback
  const authHeader = req.headers.authorization;
  const token = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.split(' ')[1]
    : req.query.token; // ?token=<jwt> for SSE

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const authUserId = parseConfiguredUserId(decoded.userId);
    if (!authUserId) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    await applyAuthenticatedUser(authUserId, req, res, next);
  } catch (err) {
    if (err?.name !== 'JsonWebTokenError' && err?.name !== 'TokenExpiredError') {
      console.error('[Auth] User resolve failed:', err.message);
      return res.status(500).json({ error: 'Auth configuration error' });
    }
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function adminMiddleware(req, res, next) {
  try {
    const actorId = req.authUserId ?? req.userId;
    const result = await pool.query('SELECT role, is_admin FROM users WHERE id = $1', [actorId]);
    if (req.readOnly || result.rows[0]?.role === VIEWER_ROLE || !result.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = {
  authMiddleware,
  adminMiddleware,
  isAuthDisabled,
  isRegistrationAllowed,
  isReadOnlyMethod,
  getViewerTargetUserId,
};
