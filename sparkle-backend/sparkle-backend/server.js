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
const credentialRoutes   = require('./routes/credentials');

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

// ═══════════════════════════════════════════════════
//  PERSISTENCE CHECK — refuse to silently lose data
// ═══════════════════════════════════════════════════
// Railway (and most container hosts) give each deploy a fresh filesystem. Anything
// written inside the app directory is destroyed on the next deploy — including the
// SQLite database and every uploaded document. The fix is a mounted Volume with
// DB_PATH / UPLOAD_DIR / BACKUP_DIR pointed at it. This check makes a
// misconfiguration loud instead of silent-and-catastrophic.
{
  const path = require('path');
  const appDir = __dirname;
  const isEphemeral = p => !p || path.resolve(p).startsWith(appDir);
  const unsafe = [
    ['DB_PATH',    process.env.DB_PATH],
    ['UPLOAD_DIR', process.env.UPLOAD_DIR],
    ['BACKUP_DIR', process.env.BACKUP_DIR],
  ].filter(([, v]) => isEphemeral(v)).map(([k]) => k);

  if (unsafe.length && process.env.NODE_ENV === 'production') {
    console.error(`
  ╔══════════════════════════════════════════════════════════════════════╗
  ║  ⚠️   DATA LOSS WARNING — ${unsafe.join(', ').padEnd(42)}║
  ╠══════════════════════════════════════════════════════════════════════╣
  ║  These paths are inside the container and will be WIPED on every     ║
  ║  deploy, taking the database and all uploaded documents with them.   ║
  ║                                                                      ║
  ║  Fix: attach a Volume mounted at /data, then set:                    ║
  ║      DB_PATH=/data/sparkle.db                                        ║
  ║      UPLOAD_DIR=/data/uploads                                        ║
  ║      BACKUP_DIR=/data/backups                                        ║
  ╚══════════════════════════════════════════════════════════════════════╝
`);
    // Opt-out for anyone who genuinely wants throwaway storage.
    if (process.env.ALLOW_EPHEMERAL_STORAGE !== 'true') {
      console.error('  Refusing to start. Set ALLOW_EPHEMERAL_STORAGE=true to override.\n');
      process.exit(1);
    }
  }
}

require('./db');
const { startScheduledBackups, listBackups, backupDatabase } = require('./lib/backup');
const { startCredentialExpirySweep } = require('./lib/credentialExpiry');

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

// ── CORS ─────────────────────────────────────────────────────────────────────
// The previous version compared origins with a bare `includes()`, so a
// FRONTEND_URL that differed by a trailing slash silently rejected every browser
// request — the API answered fine to curl while the real site got CORS errors.
// Origins are normalised here, a comma-separated list is supported, and Netlify
// branch/preview subdomains of the configured host are allowed.
// Match on HOSTNAME, not the full origin string. FRONTEND_URL is hand-entered in a
// dashboard, so it routinely differs from the real browser origin by a trailing
// slash, a path, or http:// vs https:// — Netlify even reports its own primary URL
// as http:// while serving over https. Any of those mismatches silently killed
// every browser request while curl kept working. Comparing hosts removes that
// whole class of misconfiguration without widening the allowlist to other sites.
function hostOf(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const ALLOWED_HOSTS = new Set([
  ...String(process.env.FRONTEND_URL || '').split(',').map(hostOf),
  ...String(process.env.CORS_EXTRA_ORIGINS || '').split(',').map(hostOf),
  'localhost',
  '127.0.0.1',
].filter(Boolean));

// A configured Netlify host also permits its branch and deploy-preview subdomains,
// e.g. deploy-preview-3--sparkle.netlify.app for sparkle.netlify.app.
const NETLIFY_PREVIEW_PATTERNS = [...ALLOWED_HOSTS]
  .map(h => /^([a-z0-9-]+)\.netlify\.app$/i.exec(h)?.[1])
  .filter(Boolean)
  .map(site => new RegExp(`^[a-z0-9-]+--${site}\\.netlify\\.app$`, 'i'));

const _rejectedOrigins = new Set();

app.use(cors({
  origin: (origin, cb) => {
    // No Origin header: curl, server-to-server, native apps, same-origin.
    if (!origin) return cb(null, true);
    if (process.env.NODE_ENV !== 'production') return cb(null, true);

    const host = hostOf(origin);
    if (host && ALLOWED_HOSTS.has(host)) return cb(null, true);
    if (host && NETLIFY_PREVIEW_PATTERNS.some(re => re.test(host))) return cb(null, true);

    // Log each unknown origin once — otherwise this is very hard to diagnose,
    // since the browser only ever reports a generic CORS failure.
    if (!_rejectedOrigins.has(origin)) {
      _rejectedOrigins.add(origin);
      console.warn(`[CORS] Rejected origin: ${origin}  (allowed hosts: ${[...ALLOWED_HOSTS].join(', ') || 'none'})`);
    }
    cb(null, false);
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

app.get('/health', (req, res) => res.json({
  status:  'ok',
  time:    new Date().toISOString(),
  version: '1.0.0',
  // Public frontend hostnames only — no secrets. Included because a CORS
  // misconfiguration is otherwise invisible from outside the container.
  cors_allowed_hosts: [...ALLOWED_HOSTS],
}));

// ═══════════════════════════════════════════════════
//  STATIC UPLOADS — profile photos and job photos only
// ═══════════════════════════════════════════════════
// SECURITY: mounted per-subdirectory ON PURPOSE. Never mount UPLOAD_DIR itself —
// it also contains uploads/documents, the licence and insurance scans, which carry
// licence numbers and home addresses and must only ever be reachable through the
// authenticated owner-or-admin route in routes/credentials.js.
{
  const path = require('path');
  const { UPLOAD_DIR } = require('./lib/uploads');
  const publicDirs = ['profiles', 'jobs', 'reviews'];   // NOT 'documents'
  const opts = {
    index:  false,
    dotfiles: 'deny',
    setHeaders: res => {
      res.set('X-Content-Type-Options', 'nosniff');
      // Set explicitly: the global cache middleware above stamps every non-/api
      // GET with `private, no-store`, which would otherwise defeat caching here.
      res.set('Cache-Control', 'public, max-age=604800');
      // helmet defaults every response to Cross-Origin-Resource-Policy: same-origin.
      // The frontend is served from a different origin (Netlify -> Railway, or
      // :4200 -> :3001 locally), so without this the browser refuses to render
      // these images even though the request itself succeeds with a 200.
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  };
  publicDirs.forEach(dir => {
    app.use(`/uploads/${dir}`, express.static(path.join(UPLOAD_DIR, dir), opts));
  });
  // Anything else under /uploads (notably /uploads/documents) is a hard 404.
  app.use('/uploads', (req, res) => res.status(404).json({ error: 'Not found' }));
}

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
app.use('/api/credentials',             credentialRoutes);
// NOTE: keep new mounts ABOVE this line — it is a catch-all on /api.
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
  startScheduledBackups();        // Daily automated database backups
  startCredentialExpirySweep();   // Daily licence/insurance expiry warnings + downgrades
});

module.exports = app;
