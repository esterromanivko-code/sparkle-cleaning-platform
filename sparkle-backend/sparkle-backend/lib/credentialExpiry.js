'use strict';
// lib/credentialExpiry.js — daily sweep over cleaner licence / insurance documents.
//
//   1. Warn a cleaner 30 days before a document expires (once, not every day).
//   2. When one lapses, flip it to 'expired' and take the badge down.
//
// Follows the scheduling shape of lib/backup.js: align to a wall-clock UTC hour
// with one setTimeout, then repeat on a 24h setInterval. No cron dependency.

const db = require('../db');
const { v4: uuid } = require('uuid');
const { recomputeBadgeTier } = require('./badges');
const { sendCredentialExpiringSoon, sendCredentialExpired } = require('./email');

const WARN_DAYS = 30;
const RUN_HOUR_UTC = 3;   // an hour after the 2 AM backup, so they don't overlap

const DOC_LABELS = { license: 'License', coi: 'Insurance' };

function daysUntil(isoDate) {
  return Math.ceil((new Date(isoDate + 'T00:00:00Z') - new Date()) / 86400000);
}

function runCredentialExpirySweep() {
  const affected = new Set();
  let warned = 0, expired = 0;

  const notify = db.prepare(`INSERT INTO notifications (id,user_id,title,body,type) VALUES (?,?,?,?,?)`);

  // ── 1. Expiring soon ────────────────────────────────────────────────────────
  // `warned_30d_at IS NULL` is the dedupe: without it this would re-send every
  // single day for a month. The column resets to NULL on approval, so a renewal
  // approaching expiry next year warns again.
  try {
    const expiring = db.prepare(`
      SELECT c.id, c.cleaner_id, c.doc_type, c.expires_at, u.email, u.first_name
      FROM cleaner_credentials c
      JOIN users u ON u.id = c.cleaner_id
      WHERE c.status = 'approved'
        AND c.is_current = 1
        AND c.expires_at IS NOT NULL
        AND c.warned_30d_at IS NULL
        AND date(c.expires_at) >  date('now')
        AND date(c.expires_at) <= date('now', '+${WARN_DAYS} days')
    `).all();

    const markWarned = db.prepare(`UPDATE cleaner_credentials SET warned_30d_at = datetime('now') WHERE id = ?`);

    for (const c of expiring) {
      const label = DOC_LABELS[c.doc_type] || 'Document';
      const left  = Math.max(daysUntil(c.expires_at), 1);

      notify.run(uuid(), c.cleaner_id,
        `⏰ Your ${label.toLowerCase()} expires soon`,
        `Your ${label.toLowerCase()} expires on ${c.expires_at}. Upload a renewal now to keep your verification badge.`,
        'credential_expiring');

      sendCredentialExpiringSoon(c.email, c.first_name, label, c.expires_at, left).catch(() => {});

      // Marked only after the notification is queued, so a crash mid-loop retries
      // tomorrow rather than silently skipping the cleaner.
      markWarned.run(c.id);
      warned++;
    }
  } catch (err) {
    console.error('[CREDENTIALS] Expiry warning sweep failed:', err.message);
  }

  // ── 2. Expired ──────────────────────────────────────────────────────────────
  try {
    const lapsed = db.prepare(`
      SELECT c.id, c.cleaner_id, c.doc_type, c.expires_at, u.email, u.first_name
      FROM cleaner_credentials c
      JOIN users u ON u.id = c.cleaner_id
      WHERE c.status = 'approved'
        AND c.is_current = 1
        AND c.expires_at IS NOT NULL
        AND date(c.expires_at) <= date('now')
    `).all();

    const expire = db.prepare(`UPDATE cleaner_credentials SET status = 'expired' WHERE id = ?`);

    for (const c of lapsed) {
      const label = DOC_LABELS[c.doc_type] || 'Document';
      expire.run(c.id);
      affected.add(c.cleaner_id);

      notify.run(uuid(), c.cleaner_id,
        `⚠️ ${label} expired`,
        `Your ${label.toLowerCase()} expired on ${c.expires_at} and your badge has been removed. Upload a current document to restore it.`,
        'credential_expired');

      sendCredentialExpired(c.email, c.first_name, label).catch(() => {});
      expired++;
    }

    for (const cleanerId of affected) recomputeBadgeTier(cleanerId);
  } catch (err) {
    console.error('[CREDENTIALS] Expiry downgrade sweep failed:', err.message);
  }

  console.log(`[CREDENTIALS] Sweep complete — ${warned} warned, ${expired} expired, ${affected.size} badge${affected.size === 1 ? '' : 's'} recomputed`);
  return { warned, expired, recomputed: affected.size };
}

function startCredentialExpirySweep() {
  // Containers restart on every deploy, which throws away any pending timer. A run
  // shortly after boot means a redeploy can't cause a day to be skipped. Every
  // statement above is guarded, so running more than once a day is a no-op.
  setTimeout(() => {
    try { runCredentialExpirySweep(); } catch (e) { console.error('[CREDENTIALS]', e.message); }
  }, 20_000);

  const msUntilRun = (() => {
    const now  = new Date();
    const next = new Date(now);
    next.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  })();

  setTimeout(() => {
    runCredentialExpirySweep();
    setInterval(runCredentialExpirySweep, 24 * 60 * 60 * 1000);
  }, msUntilRun);

  console.log(`[CREDENTIALS] ✅ Expiry sweep scheduled — next run in ${(msUntilRun / 3_600_000).toFixed(1)}h (daily at ${RUN_HOUR_UTC}:00 UTC)`);
}

module.exports = { startCredentialExpirySweep, runCredentialExpirySweep };
