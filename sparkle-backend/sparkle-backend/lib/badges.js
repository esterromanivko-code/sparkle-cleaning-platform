'use strict';
// lib/badges.js — derives cleaner_profiles.badge_tier from cleaner_credentials.
//
// This is the ONLY writer of badge_tier. Never UPDATE that column directly —
// call recomputeBadgeTier() so the enum stays enforced in one place.

const db = require('../db');

// Search-ranking weights. Mirrors the CASE expression in routes/profiles.js —
// keep the two in sync if these ever change.
const TIER_POINTS = {
  none:                 0,
  licensed:             1,
  insured:              1,
  licensed_and_insured: 3,
};

/**
 * Recompute and persist a cleaner's badge tier from their current credentials.
 *
 * A document only counts when it is the current submission, approved, and not
 * past its expiry date. The expiry check here means the badge is self-correcting
 * even if the daily expiry sweep hasn't run yet.
 *
 * @param {string} cleanerId
 * @returns {'none'|'licensed'|'insured'|'licensed_and_insured'}
 */
function recomputeBadgeTier(cleanerId) {
  const rows = db.prepare(`
    SELECT doc_type FROM cleaner_credentials
    WHERE cleaner_id = ?
      AND is_current = 1
      AND status = 'approved'
      AND (expires_at IS NULL OR date(expires_at) >= date('now'))
  `).all(cleanerId);

  const hasLicense = rows.some(r => r.doc_type === 'license');
  const hasCoi     = rows.some(r => r.doc_type === 'coi');

  const tier = hasLicense && hasCoi ? 'licensed_and_insured'
             : hasLicense           ? 'licensed'
             : hasCoi               ? 'insured'
             :                        'none';

  db.prepare(
    `UPDATE cleaner_profiles SET badge_tier = ?, updated_at = datetime('now') WHERE user_id = ?`
  ).run(tier, cleanerId);

  return tier;
}

module.exports = { recomputeBadgeTier, TIER_POINTS };
