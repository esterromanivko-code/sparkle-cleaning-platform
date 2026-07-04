'use strict';
// middleware/security.js
// Comprehensive security layer for Sparkle
// Covers: input sanitization, SQL injection prevention,
// brute force protection, account enumeration prevention, suspicious activity.

const rateLimit   = require('express-rate-limit');
const { validationResult } = require('express-validator');

// ══════════════════════════════════════════════════════
//  REDIS STORE SETUP
//  SECURITY: In-memory rate limiters are bypassed when:
//   - Multiple server instances run (Railway auto-scales)
//   - Server restarts (counters reset to 0)
//   - Attacker rotates IPs across instances
//  Redis shares counters across ALL instances.
//  Install: npm install rate-limit-redis ioredis
//  Set:     REDIS_URL=redis://... in Railway Variables
// ══════════════════════════════════════════════════════
let redisStore = null;
if (process.env.REDIS_URL) {
  try {
    const RedisStore = require('rate-limit-redis');
    const Redis = require('ioredis');
    const redisClient = new Redis(process.env.REDIS_URL, {
      enableOfflineQueue: false,  // Don't queue commands if Redis is down
      maxRetriesPerRequest: 1,
    });
    redisClient.on('error', (err) => console.warn('[REDIS] Rate limit store error:', err.message));
    redisStore = new RedisStore({ sendCommand: (...args) => redisClient.call(...args) });
    console.log('✅  Rate limiters using Redis store (distributed)');
  } catch (e) {
    console.warn('[SECURITY] rate-limit-redis/ioredis not installed — falling back to in-memory store.');
    console.warn('           Run: npm install rate-limit-redis ioredis');
  }
} else {
  if (process.env.NODE_ENV === 'production') {
    console.warn('\n⚠️  WARNING: REDIS_URL not set. Rate limiters are in-memory only.');
    console.warn('   Multiple server instances will NOT share rate limit counters.\n');
  }
}

// ══════════════════════════════════════════════════════
//  1. RATE LIMITERS — prevent brute force & abuse
// ══════════════════════════════════════════════════════

// Strict limiter for auth endpoints (login, register, 2FA, password reset)
// Prevents brute-forcing passwords — 10 failures per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  skipSuccessfulRequests: true,
  store:           redisStore || undefined,
  message: {
    error: 'Too many attempts. Please wait 15 minutes before trying again.',
    retry_after: '15 minutes'
  },
});

// Background check limiter
const bgCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  store:    redisStore || undefined,
  message:  { error: 'Slow down — too many requests per minute.' }
});

// Limiter for cashout requests
const cashoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      5,
  store:    redisStore || undefined,
  message:  { error: 'Too many cashout requests. Please wait before trying again.' }
});

// Limiter for message sending (prevent spam)
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  store:    redisStore || undefined,
  message:  { error: 'Sending too fast. Slow down.' }
});

// Admin action limiter
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  store:    redisStore || undefined,
  message:  { error: 'Too many admin actions. Slow down.' }
});

// General API limiter
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      200,
  store:    redisStore || undefined,
  message:  { error: 'Too many requests. Please slow down.' }
});

// Support ticket limiter — prevent contact-form/ticket spam (anonymous endpoint)
const supportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      10,
  store:    redisStore || undefined,
  message:  { error: 'Too many support requests. Please wait before submitting again.' }
});

// ══════════════════════════════════════════════════════
//  2. INPUT SANITIZATION — strip dangerous characters
//     Prevents XSS (cross-site scripting) attacks
// ══════════════════════════════════════════════════════

function sanitizeInput(req, res, next) {
  function cleanValue(val) {
    if (typeof val !== 'string') return val;
    return val
      // Remove script tags
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // Remove HTML tags
      .replace(/<[^>]+>/g, '')
      // Remove null bytes
      .replace(/\0/g, '')
      // Trim excessive whitespace
      .trim()
      // Limit length to prevent memory attacks
      .substring(0, 10000);
  }

  function cleanObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const cleaned = {};
    for (const [key, val] of Object.entries(obj)) {
      if (Array.isArray(val)) {
        cleaned[key] = val.map(v => typeof v === 'string' ? cleanValue(v) : v);
      } else if (typeof val === 'object') {
        cleaned[key] = cleanObject(val);
      } else {
        cleaned[key] = cleanValue(val);
      }
    }
    return cleaned;
  }

  if (req.body && typeof req.body === 'object') req.body = cleanObject(req.body);
  // Do not mutate req.query (read-only in Node 22) — validate in routes via express-validator
  // Note: params are handled by express-validator in each route
  next();
}

// ══════════════════════════════════════════════════════
//  3. ACCOUNT ENUMERATION PREVENTION
//     Prevents attackers from discovering which emails exist
//     by making login errors identical whether email exists or not
// ══════════════════════════════════════════════════════
// Usage: always return this same message on login failure
const LOGIN_FAIL_MSG = 'Invalid email or password';
// Both "email not found" and "wrong password" return the same error
// so attackers can't tell which emails are registered

// ══════════════════════════════════════════════════════
//  4. SECURITY HEADERS
//     helmet() in server.js handles most of these, but
//     here are the critical ones we set explicitly
// ══════════════════════════════════════════════════════
function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Force HTTPS in production
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  // Don't send referrer info
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Content Security Policy — restrict what can run on your pages
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; object-src 'none';");
  // Hide that you're using Express
  res.removeHeader('X-Powered-By');
  next();
}

// ══════════════════════════════════════════════════════
//  5. SUSPICIOUS ACTIVITY DETECTOR
//     Flags and logs unusual patterns
// ══════════════════════════════════════════════════════
const suspiciousPatterns = [
  // SQL injection attempts
  /(\bUNION\b|\bSELECT\b|\bDROP\b|\bINSERT\b|\bDELETE\b|\bUPDATE\b).+(\bFROM\b|\bWHERE\b|\bTABLE\b)/gi,
  // Script injection
  /<script|javascript:|on\w+\s*=/gi,
  // Path traversal
  /\.\.\//g,
  // Null byte injection
  /\%00/g,
];

function detectSuspiciousActivity(req, res, next) {
  const checkString = JSON.stringify({
    body:   req.body,
    query:  req.query,
    params: req.params,
  });

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(checkString)) {
      console.warn(`⚠️  SUSPICIOUS REQUEST detected:
        IP:      ${req.ip}
        Path:    ${req.method} ${req.path}
        Pattern: ${pattern.toString().substring(0, 50)}
        Time:    ${new Date().toISOString()}
      `);
      // Don't reveal why — just 400
      return res.status(400).json({ error: 'Invalid request' });
    }
  }
  next();
}

// ══════════════════════════════════════════════════════
//  6. OWNERSHIP GUARD
//     Makes sure users can only access their own data
//     Usage: add to routes that return user-specific data
// ══════════════════════════════════════════════════════
function requireOwnership(getResourceOwnerId) {
  return async (req, res, next) => {
    // Admins can access anything
    if (req.user.role === 'admin') return next();

    try {
      const ownerId = await getResourceOwnerId(req);
      if (!ownerId) return res.status(404).json({ error: 'Resource not found' });
      if (ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Access denied — this is not your resource' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ══════════════════════════════════════════════════════
//  7. REQUEST SIZE LIMITS
//     Prevents memory exhaustion (denial of service)
// ══════════════════════════════════════════════════════
// These are set in server.js: express.json({ limit: '1mb' })
// File uploads should use multer with size limits

// ══════════════════════════════════════════════════════
//  8. VALIDATION RESULT HANDLER
//     Standardizes express-validator error output
// ══════════════════════════════════════════════════════
function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      error:  'Validation failed',
      fields: errors.array().map(e => ({ field: e.path, message: e.msg }))
    });
  }
  next();
}

// ══════════════════════════════════════════════════════
//  9. AUDIT LOGGER
//     Logs sensitive actions to a trail for compliance
// ══════════════════════════════════════════════════════
function auditLog(action) {
  return (req, res, next) => {
    // In production, write to a proper audit log (CloudWatch, Datadog, etc.)
    console.log(`[AUDIT] ${new Date().toISOString()} | Action: ${action} | User: ${req.user?.id || 'anon'} | IP: ${req.ip}`);
    next();
  };
}

module.exports = {
  authLimiter,
  adminLimiter,
  bgCheckLimiter,
  cashoutLimiter,
  messageLimiter,
  apiLimiter,
  supportLimiter,
  sanitizeInput,
  securityHeaders,
  detectSuspiciousActivity,
  requireOwnership,
  handleValidation,
  auditLog,
  LOGIN_FAIL_MSG,
};
