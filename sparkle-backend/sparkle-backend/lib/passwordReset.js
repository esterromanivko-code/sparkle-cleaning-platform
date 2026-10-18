'use strict';
// lib/passwordReset.js — one-time password reset links.
//
// Both ways of getting a link use this: the person asking for one by email
// (routes/authExtended.js) and an admin making one for someone who can't get the email
// (routes/admin.js). One place decides how a link is made, stored and cancelled.

const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');

const RESET_LINK_MINUTES = 60;

// Cancels every link already issued for this account, then makes one new one.
// Only a hash of the token is stored, so nobody reading the database can use a link; the
// raw token is returned once, for the caller to hand to the person.
function issueResetToken(userId) {
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(userId);

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + RESET_LINK_MINUTES * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(uuid(), userId, tokenHash, expiresAt);

  return { token, expiresAt };
}

module.exports = { issueResetToken, RESET_LINK_MINUTES };
