'use strict';
// middleware/auth.js — JWT authentication & role guards

const jwt = require('jsonwebtoken');

// ── SECURITY: Never allow a fallback secret. Missing JWT_SECRET = server won't start.
if (!process.env.JWT_SECRET) {
  console.error('\n❌  FATAL: JWT_SECRET environment variable is not set.');
  console.error('   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  console.error('   Then add it to your .env or Railway Variables.\n');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

// ── Generate a signed JWT ──────────────────────────────────────────────────
function signToken(payload, expiresIn) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: expiresIn || process.env.JWT_EXPIRES_IN || '365d',
  });
}

// ── Verify & decode a JWT ──────────────────────────────────────────────────
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ── Express middleware: require a valid JWT ────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    req.user = verifyToken(token);   // { id, role, email, name }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Role guard factory ─────────────────────────────────────────────────────
// Usage: requireRole('admin')  or  requireRole('cleaner','admin')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(' or ')}`,
      });
    }
    next();
  };
}

module.exports = { signToken, verifyToken, requireAuth, requireRole };
