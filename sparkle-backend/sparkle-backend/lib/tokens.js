'use strict';
// lib/tokens.js — Refresh token helpers (shared between auth routes)
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const REFRESH_TOKEN_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

function createRefreshToken(db, userId, deviceHint) {
  const token     = crypto.randomBytes(64).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS).toISOString();
  db.prepare(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, device_hint, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuid(), userId, tokenHash, deviceHint || null, expiresAt);
  return token;
}

function verifyRefreshToken(db, rawToken) {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return db.prepare(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0'
  ).get(tokenHash);
}

function revokeRefreshToken(db, rawToken) {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(tokenHash);
}

function revokeAllUserTokens(db, userId) {
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(userId);
}

module.exports = { createRefreshToken, verifyRefreshToken, revokeRefreshToken, revokeAllUserTokens };
