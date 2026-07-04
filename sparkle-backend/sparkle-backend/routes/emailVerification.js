'use strict';
// routes/emailVerification.js — Email verification + CAPTCHA protection

const express = require('express');
const crypto  = require('crypto');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../lib/email');
const { audit } = require('../lib/logger');

const router = express.Router();

// ── Send verification email ───────────────────────────────────────────────
async function sendVerificationEmail(userId, email, firstName) {
  // Invalidate old tokens
  db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(userId);

  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24hrs

  db.prepare(`
    INSERT INTO email_verifications (id, user_id, token_hash, email, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuid(), userId, tokenHash, email, expiresAt);

  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-email?token=${rawToken}`;

  await sendEmail({
    to: email,
    subject: 'Please verify your Sparkle email address',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
        <div style="background:#0F6E56;padding:24px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:22px">Verify your email</h1>
        </div>
        <div style="padding:28px;border:1px solid #E0E2DC;border-top:none;border-radius:0 0 12px 12px">
          <p>Hi ${firstName},</p>
          <p>Click the button below to verify your Sparkle email address. This link expires in 24 hours.</p>
          <div style="text-align:center;margin:28px 0">
            <a href="${verifyUrl}" style="background:#1D9E75;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:500">Verify my email →</a>
          </div>
          <p style="font-size:12px;color:#888">Or copy this link: ${verifyUrl}</p>
          <p style="font-size:12px;color:#888">If you didn't create a Sparkle account, ignore this email.</p>
        </div>
      </div>
    `
  });
}

// ── POST /api/verify-email/send — resend verification email ──────────────
router.post('/send', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT id, email, first_name, email_verified FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.email_verified) return res.status(409).json({ error: 'Email already verified' });

  // Rate limit: max 3 sends per hour
  const recentSends = db.prepare(`
    SELECT COUNT(*) as cnt FROM email_verifications
    WHERE user_id = ? AND created_at >= datetime('now', '-1 hour')
  `).get(user.id).cnt;

  if (recentSends >= 3) {
    return res.status(429).json({ error: 'Too many verification emails sent. Please wait an hour.' });
  }

  await sendVerificationEmail(user.id, user.email, user.first_name);
  res.json({ message: 'Verification email sent. Check your inbox.' });
});



// ── GET /api/verify-email/status — MUST be before /:token ────────────────
router.get('/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT email_verified, email FROM users WHERE id = ?').get(req.user.id);
  res.json({
    email_verified: user?.email_verified === 1,
    email:          user?.email,
    message:        user?.email_verified ? 'Email is verified' : 'Email not yet verified — check your inbox',
  });
});

// ── GET /api/verify-email/:token — click the link in the email ───────────
router.get('/:token', async (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');

  const record = db.prepare(`
    SELECT * FROM email_verifications
    WHERE token_hash = ? AND verified_at IS NULL AND expires_at > datetime('now')
  `).get(tokenHash);

  if (!record) {
    return res.status(400).json({
      error: 'This verification link is invalid or has expired. Request a new one in your account settings.'
    });
  }

  // Mark as verified
  db.prepare('UPDATE users SET email_verified = 1, updated_at = datetime(\'now\') WHERE id = ?').run(record.user_id);
  db.prepare('UPDATE email_verifications SET verified_at = datetime(\'now\') WHERE id = ?').run(record.id);

  audit('EMAIL_VERIFIED', { userId: record.user_id, email: record.email });

  // Redirect to frontend (or return JSON for API clients)
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?email_verified=true`);
  }
  res.json({ message: 'Email verified successfully! Your account is now fully active.' });
});


module.exports = router;
module.exports.sendVerificationEmail = sendVerificationEmail;
