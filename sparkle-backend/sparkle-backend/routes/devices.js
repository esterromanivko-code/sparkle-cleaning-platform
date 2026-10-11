'use strict';
// routes/devices.js — the phones a person is signed in on, so notifications can
// reach them as push (lib/push.js). The app registers on sign-in and unregisters
// on sign-out; a token belongs to whoever registered it last, which is what
// happens when two people share a phone.

const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pushEnabled } = require('../lib/push');

const router = express.Router();
const PLATFORMS = ['ios', 'android', 'web'];

function readToken(req, res) {
  const token = req.body?.token;
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) {
    res.status(422).json({ error: 'A device token is required' });
    return null;
  }
  return token;
}

// POST /api/devices  { token, platform }
router.post('/', requireAuth, (req, res) => {
  const token = readToken(req, res);
  if (!token) return;
  const platform = PLATFORMS.includes(req.body?.platform) ? req.body.platform : 'web';

  // The same phone re-registering (a new sign-in, or a token Firebase rotated)
  // moves to the current user rather than being stored twice.
  db.prepare(`
    INSERT INTO device_tokens (id, user_id, token, platform, last_used_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, last_used_at = datetime('now')
  `).run(uuid(), req.user.id, token, platform);

  res.json({ registered: true, push_enabled: pushEnabled() });
});

// DELETE /api/devices  { token } — on sign-out, so the next person to use this
// phone doesn't get someone else's notifications.
router.delete('/', requireAuth, (req, res) => {
  const token = readToken(req, res);
  if (!token) return;
  db.prepare('DELETE FROM device_tokens WHERE token = ? AND user_id = ?').run(token, req.user.id);
  res.json({ registered: false });
});

module.exports = router;
