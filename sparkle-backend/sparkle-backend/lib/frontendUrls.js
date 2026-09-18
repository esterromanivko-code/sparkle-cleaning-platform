'use strict';
// lib/frontendUrls.js — which web hosts are Sparkle's own frontend.

// Match on HOSTNAME, not the full origin string. FRONTEND_URL is hand-entered in a
// dashboard, so it routinely differs from the real browser origin by a trailing
// slash, a path, or http:// vs https://.
function hostOf(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function frontendHosts() {
  return new Set([
    ...String(process.env.FRONTEND_URL || '').split(','),
    ...String(process.env.CORS_EXTRA_ORIGINS || '').split(','),
  ].map(hostOf).filter(Boolean));
}

const isLocal = host => host === 'localhost' || host === '127.0.0.1';

// Where to send someone back to after a Stripe-hosted page. The page the browser
// asks for is used only when it's on one of Sparkle's own hosts, so this can never
// become a redirect to someone else's site.
function appReturnUrl(requested) {
  const dev = process.env.NODE_ENV !== 'production';
  try {
    const u = new URL(String(requested || ''));
    const local = isLocal(u.hostname);
    const secure = u.protocol === 'https:' || (u.protocol === 'http:' && local && dev);
    if (secure && (frontendHosts().has(u.hostname) || (local && dev))) return u.origin + u.pathname;
  } catch { /* fall through to the configured frontend */ }

  const first = String(process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).find(Boolean);
  try {
    const u = new URL(/^https?:\/\//i.test(first) ? first : `https://${first}`);
    return `${isLocal(u.hostname) ? u.origin : `https://${u.host}`}/app`;
  } catch {
    return 'http://localhost:4200/sparkle_full.html';
  }
}

module.exports = { hostOf, frontendHosts, appReturnUrl };
