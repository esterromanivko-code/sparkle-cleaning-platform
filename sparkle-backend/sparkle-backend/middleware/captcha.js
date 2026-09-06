'use strict';
// middleware/captcha.js — Cloudflare Turnstile CAPTCHA verification
//
// WHY TURNSTILE over reCAPTCHA / hCaptcha:
//   - Free with no usage limits
//   - Privacy-respecting (no Google tracking)
//   - Invisible by default — most real users never see a challenge
//   - Works on mobile just as well as desktop
//   - Easy to set up: cloudflare.com/products/turnstile
//
// SETUP (5 minutes):
//   1. Go to dash.cloudflare.com → Turnstile → Add Site
//   2. Enter your domain (e.g. sparkle.com)
//   3. Choose "Invisible" widget type
//   4. Copy your Site Key (goes in your frontend HTML)
//   5. Copy your Secret Key (goes in TURNSTILE_SECRET_KEY env var)
//
// HOW IT WORKS:
//   Frontend: Turnstile JS runs silently, generates a cf-turnstile-response token
//   Backend:  This middleware verifies that token with Cloudflare's API
//   Result:   Bots get blocked. Real users never notice anything.

const axios = require('axios');
const { audit } = require('../lib/logger');

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// ── Core verification function ─────────────────────────────────────────────
async function verifyTurnstileToken(token, remoteIp) {
  // If CAPTCHA is not configured, skip in development
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey || secretKey === 'TURNSTILE_SECRET_KEY_HERE') {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[CAPTCHA] TURNSTILE_SECRET_KEY not set in production — CAPTCHA disabled');
    }
    return { success: true, skipped: true };
  }

  if (!token) {
    return { success: false, error: 'CAPTCHA token missing' };
  }

  try {
    const response = await axios.post(
      TURNSTILE_VERIFY_URL,
      new URLSearchParams({
        secret:   secretKey,
        response: token,
        remoteip: remoteIp || '',
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 5000,
        // Cloudflare answers 400 for a malformed or invalid token. Axios throws on
        // any non-2xx by default, which sent those into the "service unavailable"
        // branch and reported an outage for what is really a failed check. Accept
        // every status here and judge on the body, so the catch below means only
        // one thing: Cloudflare could not be reached at all.
        validateStatus: () => true,
      }
    );

    const data = response.data;
    return {
      success:    data.success === true,
      error:      data['error-codes']?.[0] || null,
      challenge:  data['challenge_ts'],
      hostname:   data.hostname,
    };
  } catch (err) {
    console.error('[CAPTCHA] Turnstile verification failed:', err.message);
    // Fail open if Cloudflare is unreachable (don't block real users due to API outage)
    return { success: true, skipped: true, error: 'verification_unavailable' };
  }
}

// ── Express middleware ─────────────────────────────────────────────────────
// Usage: router.post('/login', requireCaptcha, handler)
// Frontend must send { cf_turnstile_response: '<token>' } in the request body
async function requireCaptcha(req, res, next) {
  const token    = req.body?.cf_turnstile_response || req.headers['x-cf-turnstile-response'];
  const remoteIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip;

  const result = await verifyTurnstileToken(token, remoteIp);

  if (!result.success && !result.skipped) {
    audit('CAPTCHA_FAILED', {
      ip:     remoteIp,
      path:   req.path,
      error:  result.error,
    });
    return res.status(400).json({
      error: 'CAPTCHA verification failed. Please refresh the page and try again.',
      captcha_error: result.error,
    });
  }

  // Attach result to request for optional logging
  req.captcha = result;
  next();
}

// ── Strict mode: block on verification failure even if Cloudflare unreachable
// Use on highest-risk endpoints like /register where bot signups are most costly
let _warnedUnconfigured = false;

async function requireCaptchaStrict(req, res, next) {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey || secretKey === 'TURNSTILE_SECRET_KEY_HERE') {
    if (process.env.NODE_ENV !== 'production') return next(); // skip in dev
    // Previously this returned 503, which made registration impossible on any
    // production deploy without Turnstile configured — the sign-up form was
    // simply dead. Fail open instead (matching requireCaptcha above) and warn
    // loudly, so an unconfigured CAPTCHA degrades bot protection rather than
    // taking down the product.
    if (!_warnedUnconfigured) {
      _warnedUnconfigured = true;
      console.warn(
        '\n⚠️  [CAPTCHA] TURNSTILE_SECRET_KEY is not set — bot protection on ' +
        'registration is DISABLED.\n' +
        '   Set it up at dash.cloudflare.com → Turnstile before real launch.\n'
      );
    }
    return next();
  }

  const token    = req.body?.cf_turnstile_response || req.headers['x-cf-turnstile-response'];
  const remoteIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip;

  if (!token) {
    return res.status(400).json({ error: 'CAPTCHA token required' });
  }

  try {
    const response = await axios.post(
      TURNSTILE_VERIFY_URL,
      new URLSearchParams({ secret: secretKey, response: token, remoteip: remoteIp || '' }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 5000,
        // Cloudflare answers 400 for a malformed or invalid token. Axios throws on
        // any non-2xx by default, which sent those into the "service unavailable"
        // branch and reported an outage for what is really a failed check. Accept
        // every status here and judge on the body, so the catch below means only
        // one thing: Cloudflare could not be reached at all.
        validateStatus: () => true,
      }
    );
    if (!response.data.success) {
      const codes = response.data['error-codes'] || [];
      audit('CAPTCHA_STRICT_FAILED', { ip: remoteIp, path: req.path, codes });
      console.warn('[CAPTCHA] Rejected by Cloudflare:', codes.join(', ') || '(no code given)');

      // Surface the reason. These codes describe the CONFIGURATION or the token,
      // never anything secret, and without them a failure is impossible to tell
      // apart from a mistyped key. invalid-input-secret in particular means the
      // secret does not match the site key's widget — the single most common
      // setup mistake, and unguessable from a generic failure message.
      const explain =
        codes.includes('invalid-input-secret')  ? 'The CAPTCHA secret key on the server is wrong or does not match the site key.'
      : codes.includes('timeout-or-duplicate')  ? 'That CAPTCHA had already been used or expired. Please try again.'
      : codes.includes('invalid-input-response')? 'The CAPTCHA response was not valid. Please refresh and try again.'
      : codes.includes('bad-request')           ? 'The CAPTCHA request was malformed.'
      : 'CAPTCHA verification failed. Please try again.';

      return res.status(400).json({ error: explain, captcha_error: codes.join(',') || null });
    }
  } catch (err) {
    // Strict mode: fail closed on network error
    return res.status(503).json({ error: 'CAPTCHA service unavailable. Please try again shortly.' });
  }

  next();
}

module.exports = { requireCaptcha, requireCaptchaStrict, verifyTurnstileToken };
