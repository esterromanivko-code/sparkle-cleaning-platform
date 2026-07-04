'use strict';
// server.js — Sparkle main server

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const logger       = require('./lib/logger');

// ── Sentry error monitoring (optional — only activates when SENTRY_DSN is set) ─
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn:         process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 0.1,     // Capture 10% of transactions for perf monitoring
      beforeSend(event) {
        // Strip sensitive data from error reports
        if (event.request?.cookies) delete event.request.cookies;
        if (event.request?.headers?.authorization) {
          event.request.headers.authorization = '[REDACTED]';
        }
        return event;
      },
    });
    console.log('✅  Sentry error monitoring active');
  } catch (e) {
    console.warn('[SENTRY] Not installed — run: npm install @sentry/node');
  }
}
const {
  authLimiter, bgCheckLimiter, cashoutLimiter,
  messageLimiter, apiLimiter, adminLimiter,
  sanitizeInput, securityHeaders, detectSuspiciousActivity,
} = require('./middleware/security');
const authRoutes    = require('./routes/auth');
const jobRoutes     = require('./routes/jobs');
const profileRoutes = require('./routes/profiles');
const bgCheckRoutes = require('./routes/backgroundCheck');
const adminRoutes        = require('./routes/admin');
const authExtendedRoutes  = require('./routes/authExtended');
const bidRoutes           = require('./routes/bids');
const emailVerifyRoutes   = require('./routes/emailVerification');
const mileageRoutes      = require('./routes/mileage');
const supportRoutes      = require('./routes/support');

// ═══════════════════════════════════════════════════
//  STARTUP VALIDATION — refuse to run without critical config
// ═══════════════════════════════════════════════════
const REQUIRED_ENV = ['JWT_SECRET'];
const PROD_REQUIRED = ['STRIPE_SECRET_KEY', 'FRONTEND_URL'];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('\n❌  FATAL: Missing required environment variables:', missing.join(', '));
  console.error('   Add them to your .env file or Railway Variables.\n');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  const missingProd = PROD_REQUIRED.filter(k => !process.env[k]);
  if (missingProd.length > 0) {
    console.error('\n❌  FATAL: Missing required production environment variables:', missingProd.join(', '));
    process.exit(1);
  }
  if (process.env.JWT_SECRET === 'CHANGE_ME_IN_PRODUCTION' || process.env.JWT_SECRET.length < 32) {
    console.error('\n❌  FATAL: JWT_SECRET must be a random string of at least 32 characters in production.');
    process.exit(1);
  }
}

require('./db');
const { startScheduledBackups, listBackups, backupDatabase } = require('./lib/backup');

const app  = express();
const PORT = process.env.PORT || 3001;

// Sentry must be first middleware if active
if (Sentry) app.use(Sentry.Handlers.requestHandler());

// SECURITY FIX #13: Trust exactly 1 proxy hop (Railway / Heroku / Render).
// Without this, req.ip comes from X-Forwarded-For which is spoofable by clients,
// defeating IP-based rate limiting and CAPTCHA IP binding.
// Set TRUSTED_PROXY_HOPS=0 in .env only if you run the server without any proxy.
app.set('trust proxy', process.env.TRUSTED_PROXY_HOPS !== undefined
  ? parseInt(process.env.TRUSTED_PROXY_HOPS, 10)
  : 1
);

app.use(helmet({ hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false }));
app.use(securityHeaders);

// ═══════════════════════════════════════════════════
// MOBILE OPTIMIZATION — Compression, caching, headers
// ═══════════════════════════════════════════════════
app.use(compression({ threshold: 512, level: 6 })); // Gzip responses >512 bytes

// Mobile-friendly caching headers
app.use((req, res, next) => {
  // Set caching for GET requests (mobile apps benefit from local caching)
  if (req.method === 'GET' && req.path.startsWith('/api/')) {
    // Authenticated API responses should never be cached publicly.
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.vary('Authorization');
    res.vary('Cookie');
  } else if (req.method === 'GET' && req.path.match(/\.(js|css|json|image|font)$/i)) {
    res.set('Cache-Control', 'public, max-age=3600'); // Cache static resources for 1 hour
  } else if (req.method === 'GET') {
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  } else {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); // Never cache POST/PUT/DELETE
  }
  // Mobile app performance headers
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cors({
  origin: (origin, cb) => {
    const allowed = [process.env.FRONTEND_URL||'http://localhost:3000','http://localhost:3000','http://localhost:5173'];
    cb(null, !origin || allowed.includes(origin) || process.env.NODE_ENV !== 'production');
  },
  credentials: true,
  allowedHeaders: ['Content-Type','Authorization'],
  methods: ['GET','POST','PUT','DELETE','PATCH'],
}));
app.use('/api/background-check/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));
app.use('/api', apiLimiter);
app.use(sanitizeInput);
app.use(detectSuspiciousActivity);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' }));

// ── Admin-only: backup status & manual trigger ───────────────────────────────
app.get('/api/admin/backups', (req, res) => {
  // Simple check — in production use requireAuth + requireRole('admin')
  const key = req.headers['x-admin-key'];
  if (process.env.NODE_ENV === 'production' && key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ backups: listBackups() });
});

app.post('/api/admin/backups/run', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (process.env.NODE_ENV === 'production' && key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const result = backupDatabase();
  res.json({ success: !!result, path: result });
});

// ── Google Maps API key proxy ─────────────────────────────────────────────────
// Serves the Maps key ONLY to authenticated users. Key never appears in HTML.
// Frontend calls: GET /api/maps/config  (must be signed in)
app.get('/api/maps/config', require('./middleware/auth').requireAuth, (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.json({ key: null }); // Key not configured yet
  res.json({ key });
});

app.use('/api/auth',                    authLimiter, authRoutes);
// Password reset, refresh tokens, 2FA, file uploads
app.use('/api',                         authExtendedRoutes);
app.use('/api/jobs',                    jobRoutes);
app.use('/api/background-check/initiate', bgCheckLimiter);
app.use('/api/background-check',        bgCheckRoutes);
app.use('/api/earnings/cashout',         cashoutLimiter);
app.use('/api/messages',                messageLimiter);
app.use('/api/admin',                   adminLimiter, adminRoutes);
// SECURITY FIX #7: /api/pro previously shared adminRoutes without any rate limiter,
// allowing unlimited probing of admin endpoints via the /api/pro path.
// adminLimiter now applied consistently on both paths.
app.use('/api/pro',                     adminLimiter, adminRoutes);
app.use('/api/profile',                 profileRoutes);
app.use('/api/bids',                    bidRoutes);
app.use('/api/mileage',                 mileageRoutes);
app.use('/api/verify-email',            emailVerifyRoutes);
app.use('/api/support',                 supportRoutes);
app.use('/api',                         profileRoutes);

app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));

// Sentry error handler must be before the generic error handler
if (Sentry) app.use(Sentry.Handlers.errorHandler());

app.use((err, req, res, next) => {
  logger.error('[ERROR]', { method: req.method, path: req.path, error: err.message, stack: err.stack });
  if (err.message && err.message.startsWith('CORS:')) return res.status(403).json({ error: 'CORS blocked' });
  // Never expose stack traces in production
  res.status(err.status || 500).json({
    error: err.status ? err.message : 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { debug: err.message }),
  });
});

app.listen(PORT, () => {
  console.log(`
  ✅  Sparkle backend running on port ${PORT}
  📋  Fees: Client 8% / Business 10% / BG Check $40 / Instant cashout $10
  `);
  startScheduledBackups(); // Start daily automated database backups
});

module.exports = app;
