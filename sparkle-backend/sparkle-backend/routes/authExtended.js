'use strict';
// routes/authExtended.js
// Covers: password reset, refresh tokens, 2FA setup/verify, file uploads

const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const speakeasy = require('speakeasy');
const QRCode   = require('qrcode');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const path     = require('path');

const db       = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { sendPasswordReset, send2FASetupEmail, send2FACode } = require('../lib/email');
const { handleSingleUpload, handleMultipleUpload, getFileUrl, UPLOAD_DIR } = require('../lib/uploads');
const { createRefreshToken, verifyRefreshToken, revokeRefreshToken, revokeAllUserTokens } = require('../lib/tokens');
const { requireCaptcha } = require('../middleware/captcha');
const { authLimiter } = require('../middleware/security');

const router = express.Router();
const ACCESS_EXPIRY = '365d';

// ══════════════════════════════════════════════════════
//  REFRESH TOKENS
//  Access tokens last 1 year. Refresh tokens last 1 year too.
//  Users never get randomly logged out.
//  Revocation still possible (e.g. if account is banned).
// ══════════════════════════════════════════════════════

// SECURITY: 15-minute access tokens, 30-day refresh tokens.
// Short access tokens limit the stolen-token blast radius.
// Refresh tokens are rotated on every use (old one revoked, new one issued).
const ACCESS_TOKEN_EXPIRY  = '15m';
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

// POST /api/auth/refresh
// Body: { refresh_token }
// Returns a new access token without requiring re-login
router.post('/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    return res.status(401).json({ error: 'Refresh token required' });
  }

  const stored = verifyRefreshToken(db, refresh_token);

  if (!stored) {
    return res.status(401).json({ error: 'Invalid or revoked refresh token' });
  }

  // Check expiry
  if (new Date(stored.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Refresh token expired. Please log in again.' });
  }

  // Get user
  const user = db.prepare(
    'SELECT id, role, email, first_name, last_name, is_active FROM users WHERE id = ?'
  ).get(stored.user_id);

  if (!user || !user.is_active) {
    return res.status(403).json({ error: 'Account suspended' });
  }

  // SECURITY: Rotate the refresh token on every use.
  // This means a stolen refresh token can only be used once before it's invalidated.
  // Revoke the old refresh token and issue a new one.
  revokeRefreshToken(db, refresh_token);
  const newRefreshToken = createRefreshToken(db, user.id, req.headers['user-agent']);

  // Issue new short-lived access token
  const newAccessToken = signToken(
    { id: user.id, role: user.role, email: user.email, name: `${user.first_name} ${user.last_name}` },
    ACCESS_TOKEN_EXPIRY
  );

  res.json({
    access_token:  newAccessToken,
    refresh_token: newRefreshToken,   // rotated — client must store this new one
    expires_in:    15 * 60,           // 15 minutes in seconds
  });
});

// POST /api/auth/logout
// Revokes the refresh token so it can't be used to get new access tokens
router.post('/auth/logout', requireAuth, (req, res) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    revokeRefreshToken(db, refresh_token);
  }
  res.json({ message: 'Logged out successfully' });
});

// Helper: create and store a refresh token for a user

// Export so auth.js can use it on login
module.exports.createRefreshToken = createRefreshToken;

// ══════════════════════════════════════════════════════
//  PASSWORD RESET FLOW
//  Step 1: User requests reset → we email them a link
//  Step 2: User clicks link → they set a new password
// ══════════════════════════════════════════════════════

// POST /api/auth/forgot-password
// Body: { email }
// ALWAYS returns success (never reveals if email exists — prevents enumeration)
router.post('/auth/forgot-password', requireCaptcha, [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: 'Please provide a valid email address' });
  }

  // Always return the same response whether email exists or not
  const SAFE_RESPONSE = { message: 'If that email is registered, you\'ll receive a reset link shortly.' };

  const { email } = req.body;

  try {
    const user = db.prepare('SELECT id, first_name, is_active FROM users WHERE email = ?').get(email);

    if (!user || !user.is_active) {
      // Return success anyway — never reveal if email exists
      return res.json(SAFE_RESPONSE);
    }

    // Invalidate any existing reset tokens for this user
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(user.id);

    // Generate a secure random token
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    db.prepare(`
      INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(uuid(), user.id, tokenHash, expiresAt);

    // Send the email with the RAW token (not the hash)
    await sendPasswordReset(email, user.first_name, rawToken);

    res.json(SAFE_RESPONSE);

  } catch (err) {
    console.error('Forgot password error:', err);
    res.json(SAFE_RESPONSE); // Still return success on error — don't leak info
  }
});

// POST /api/auth/reset-password
// Body: { token, new_password }
// Called when user clicks the link in their email
// SECURITY: authLimiter added — prevents timing/enumeration attacks on token endpoint.
router.post('/auth/reset-password', authLimiter, [
  body('token').notEmpty().withMessage('Reset token required'),
  body('new_password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { token, new_password } = req.body;

  try {
    // Hash the token and look it up
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const resetRecord = db.prepare(`
      SELECT * FROM password_reset_tokens
      WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')
    `).get(tokenHash);

    if (!resetRecord) {
      return res.status(400).json({
        error: 'This reset link is invalid or has expired. Please request a new one.'
      });
    }

    // Hash new password
    const password_hash = await bcrypt.hash(new_password, 12);

    // Update password
    db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
    `).run(password_hash, resetRecord.user_id);

    // Mark token as used
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(resetRecord.id);

    // Revoke ALL existing refresh tokens (security: new password = fresh start)
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(resetRecord.user_id);

    // Notify user
    db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
      .run(uuid(), resetRecord.user_id,
        '🔒 Password changed',
        'Your Sparkle password was just changed. If you didn\'t do this, contact support immediately.',
        'password_changed'
      );

    res.json({ message: 'Password reset successfully. You can now log in with your new password.' });

  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Password reset failed. Please try again.' });
  }
});

// POST /api/auth/verify-reset-token
// Body: { token }
// Frontend can call this to check if a token is valid before showing the form
router.post('/auth/verify-reset-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const record = db.prepare(`
    SELECT id FROM password_reset_tokens
    WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')
  `).get(tokenHash);

  res.json({ valid: !!record });
});

// ══════════════════════════════════════════════════════
//  TWO-FACTOR AUTHENTICATION (TOTP)
//  Uses Google Authenticator / Authy compatible codes
//  Required for: admin (always), cleaners (always)
//  Optional for: clients
// ══════════════════════════════════════════════════════

// POST /api/auth/2fa/setup
// Generates a TOTP secret and QR code for the user to scan
// Must call /api/auth/2fa/enable after scanning to confirm it works
router.post('/auth/2fa/setup', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT first_name, email, role FROM users WHERE id = ?').get(req.user.id);

  // Generate TOTP secret
  const secret = speakeasy.generateSecret({
    name:   `Sparkle (${user.email})`,
    issuer: 'Sparkle',
    length: 32,
  });

  // Store the secret (not yet enabled — they need to confirm a code first)
  const existing = db.prepare('SELECT user_id FROM two_factor_auth WHERE user_id = ?').get(req.user.id);
  if (existing) {
    db.prepare('UPDATE two_factor_auth SET secret = ?, is_enabled = 0 WHERE user_id = ?')
      .run(secret.base32, req.user.id);
  } else {
    db.prepare(`
      INSERT INTO two_factor_auth (user_id, secret, is_enabled) VALUES (?, ?, 0)
    `).run(req.user.id, secret.base32);
  }

  // Generate QR code as data URL (user scans this with Authenticator app)
  const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);

  res.json({
    message:      'Scan the QR code with Google Authenticator or Authy, then call /2fa/enable with a code to activate.',
    qr_code:      qrCodeDataUrl,        // base64 image the frontend displays
    otpauth_url:  secret.otpauth_url,   // for apps that accept URLs
    manual_key:   secret.base32,        // if they can't scan, enter this manually
  });
});

// POST /api/auth/2fa/enable
// Body: { code }  — 6-digit code from their authenticator app
// Activates 2FA after confirming the code works
router.post('/auth/2fa/enable', requireAuth, [
  body('code').isLength({ min: 6, max: 6 }).isNumeric(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ error: 'Provide a valid 6-digit code' });

  const { code } = req.body;
  const tfa = db.prepare('SELECT secret FROM two_factor_auth WHERE user_id = ?').get(req.user.id);

  if (!tfa) {
    return res.status(400).json({ error: 'Call /2fa/setup first to get your QR code' });
  }

  // Verify the code against the secret
  const valid = speakeasy.totp.verify({
    secret:   tfa.secret,
    encoding: 'base32',
    token:    code,
    window:   2,  // Allow 1 step either side for clock drift
  });

  if (!valid) {
    return res.status(400).json({ error: 'Invalid code. Make sure your phone clock is correct and try again.' });
  }

  // Generate backup codes (hashed) — user saves these in case they lose their phone
  const backupCodes = Array.from({ length: 8 }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase()  // e.g. "A3F2C9B1"
  );
  // SECURITY: Use cost factor 12 (same as passwords), not 8.
  // Backup codes are only 32 bits of entropy — cost 8 cracks them in hours on GPU.
  const hashedBackupCodes = await Promise.all(backupCodes.map(c => bcrypt.hash(c, 12)));

  db.prepare(`
    UPDATE two_factor_auth
    SET is_enabled = 1, backup_codes = ?, enabled_at = datetime('now')
    WHERE user_id = ?
  `).run(JSON.stringify(hashedBackupCodes), req.user.id);

  const user = db.prepare('SELECT first_name, email FROM users WHERE id = ?').get(req.user.id);
  await send2FASetupEmail(user.email, user.first_name, tfa.otpauth_url);

  res.json({
    message:      '2FA enabled successfully!',
    backup_codes: backupCodes,  // ONLY shown once — user must save these
    warning:      'Save these backup codes somewhere safe. They can be used if you lose access to your authenticator app. They will NOT be shown again.',
  });
});

// POST /api/auth/2fa/disable
// Body: { code }  — requires a valid code to disable (prevents attackers from turning it off)
router.post('/auth/2fa/disable', requireAuth, [
  body('code').isLength({ min: 6, max: 6 }).isNumeric(),
], (req, res) => {
  const { code } = req.body;
  const tfa = db.prepare('SELECT * FROM two_factor_auth WHERE user_id = ? AND is_enabled = 1').get(req.user.id);

  if (!tfa) return res.status(400).json({ error: '2FA is not enabled on your account' });

  const valid = speakeasy.totp.verify({
    secret: tfa.secret, encoding: 'base32', token: code, window: 2
  });
  if (!valid) return res.status(400).json({ error: 'Invalid code' });

  db.prepare('UPDATE two_factor_auth SET is_enabled = 0 WHERE user_id = ?').run(req.user.id);

  db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
    .run(uuid(), req.user.id,
      '⚠️ 2FA disabled',
      'Two-factor authentication was disabled on your account. If you didn\'t do this, contact support immediately.',
      '2fa_disabled'
    );

  res.json({ message: '2FA disabled. Your account is less secure without it.' });
});

// POST /api/auth/2fa/verify
// Body: { code, user_id }
// Called AFTER a successful password login if the user has 2FA enabled
// Returns a full access token only if code is correct
// SECURITY: authLimiter added — prevents brute-forcing the 6-digit TOTP code.
router.post('/auth/2fa/verify', authLimiter, [
  body('code').isLength({ min: 6, max: 8 }).withMessage('Provide your 6-digit code'),
  body('user_id').notEmpty(),
  body('pre_auth_token').notEmpty(),  // short-lived token issued after password check, before 2FA
], async (req, res) => {
  const { code, user_id, pre_auth_token } = req.body;

  // Verify the pre-auth token (issued during login before 2FA check)
  let preAuth;
  try {
    const jwt = require('jsonwebtoken');
    preAuth = jwt.verify(pre_auth_token, process.env.JWT_SECRET);
    if (preAuth.type !== 'pre_auth' || preAuth.id !== user_id) {
      return res.status(401).json({ error: 'Invalid pre-auth token' });
    }
  } catch {
    return res.status(401).json({ error: 'Pre-auth token invalid or expired' });
  }

  const tfa = db.prepare(
    'SELECT secret, backup_codes FROM two_factor_auth WHERE user_id = ? AND is_enabled = 1'
  ).get(user_id);

  if (!tfa) return res.status(400).json({ error: '2FA not configured for this account' });

  // Try TOTP code first
  let valid = speakeasy.totp.verify({
    secret: tfa.secret, encoding: 'base32', token: code, window: 2
  });

  // If TOTP fails, check backup codes
  if (!valid && code.length === 8) {
    const backupCodes = JSON.parse(tfa.backup_codes || '[]');
    const matchIndex  = backupCodes.findIndex(hash => {
      try { return bcrypt.compareSync(code.toUpperCase(), hash); } catch { return false; }
    });
    if (matchIndex >= 0) {
      valid = true;
      // Remove used backup code
      backupCodes.splice(matchIndex, 1);
      db.prepare('UPDATE two_factor_auth SET backup_codes = ? WHERE user_id = ?')
        .run(JSON.stringify(backupCodes), user_id);
    }
  }

  if (!valid) {
    return res.status(401).json({ error: 'Invalid code. Try again or use a backup code.' });
  }

  // Issue full access + refresh tokens
  const user = db.prepare('SELECT id, role, email, first_name, last_name FROM users WHERE id = ?').get(user_id);
  const accessToken  = signToken({ id: user.id, role: user.role, email: user.email, name: `${user.first_name} ${user.last_name}` }, ACCESS_TOKEN_EXPIRY);
  const refreshToken = createRefreshToken(db, user.id, req.headers['user-agent']);

  res.json({
    message:       '2FA verified',
    access_token:  accessToken,
    refresh_token: refreshToken,
    user: { id: user.id, role: user.role, first_name: user.first_name, email: user.email },
  });
});

// GET /api/auth/2fa/status
// Returns whether 2FA is set up and enabled for current user
router.get('/auth/2fa/status', requireAuth, (req, res) => {
  const tfa = db.prepare('SELECT is_enabled, enabled_at FROM two_factor_auth WHERE user_id = ?').get(req.user.id);
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);

  res.json({
    is_enabled:   tfa?.is_enabled === 1,
    enabled_at:   tfa?.enabled_at || null,
    required:     ['admin','cleaner'].includes(user.role),  // required for admin + cleaners
    message:      tfa?.is_enabled
      ? '2FA is active on your account'
      : ['admin','cleaner'].includes(user.role)
        ? '2FA is required for your account. Please set it up in settings.'
        : '2FA is optional but recommended',
  });
});

// ══════════════════════════════════════════════════════
//  FILE UPLOADS
//  Profile photos and job photos
// ══════════════════════════════════════════════════════

// POST /api/upload/profile-photo
// Multipart form — field name: "photo"
router.post('/upload/profile-photo', requireAuth, handleSingleUpload, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No photo uploaded' });
  }

  const url = getFileUrl(req.file.filename, 'profiles');

  // Save to file_uploads table
  const uploadId = uuid();
  db.prepare(`
    INSERT INTO file_uploads (id, user_id, type, filename, original_name, mimetype, size_bytes, url)
    VALUES (?, ?, 'profile_photo', ?, ?, ?, ?, ?)
  `).run(uploadId, req.user.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, url);

  // Update user avatar_url
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(url, req.user.id);

  res.json({
    message:   'Profile photo uploaded',
    upload_id: uploadId,
    url,
    filename:  req.file.filename,
    size_bytes: req.file.size,
  });
});

// POST /api/upload/job-photos/:job_id
// Multipart form — field name: "photos" (up to 10)
router.post('/upload/job-photos/:job_id', requireAuth, handleMultipleUpload, (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No photos uploaded' });
  }

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Make sure the uploader is part of this job
  const isCleaner = req.user.role === 'cleaner' && job.cleaner_id === req.user.id;
  const isClient  = req.user.role === 'client'  && job.client_id  === req.user.id;
  const isAdmin   = req.user.role === 'admin';
  if (!isCleaner && !isClient && !isAdmin) {
    return res.status(403).json({ error: 'You are not part of this job' });
  }

  const uploaded = [];
  const insert = db.prepare(`
    INSERT INTO file_uploads (id, user_id, job_id, type, filename, original_name, mimetype, size_bytes, url)
    VALUES (?, ?, ?, 'job_photo', ?, ?, ?, ?, ?)
  `);

  for (const file of req.files) {
    const url      = getFileUrl(file.filename, 'jobs');
    const uploadId = uuid();
    insert.run(uploadId, req.user.id, job.id, file.filename, file.originalname, file.mimetype, file.size, url);
    uploaded.push({ upload_id: uploadId, url, filename: file.filename, size_bytes: file.size });
  }

  res.json({
    message:  `${uploaded.length} photo${uploaded.length > 1 ? 's' : ''} uploaded`,
    photos:   uploaded,
    job_id:   job.id,
  });
});

// GET /api/upload/job-photos/:job_id
// Returns all photos for a job
router.get('/upload/job-photos/:job_id', requireAuth, (req, res) => {
  const photos = db.prepare(`
    SELECT id, type, url, original_name, size_bytes, created_at,
           u.first_name, u.role as uploader_role
    FROM file_uploads f
    JOIN users u ON u.id = f.user_id
    WHERE f.job_id = ?
    ORDER BY f.created_at ASC
  `).all(req.params.job_id);

  res.json({ photos });
});

// GET /api/upload/profile-photo/:user_id
// Get a user's current profile photo
// SECURITY: requireAuth added — unauthenticated IDOR fix.
// Profile photos are public on a marketplace, but we still require a valid session
// to prevent unauthenticated bulk harvesting of user photo URLs.
router.get('/upload/profile-photo/:user_id', requireAuth, (req, res) => {
  const photo = db.prepare(`
    SELECT url, created_at FROM file_uploads
    WHERE user_id = ? AND type = 'profile_photo'
    ORDER BY created_at DESC LIMIT 1
  `).get(req.params.user_id);

  if (!photo) return res.status(404).json({ error: 'No profile photo' });
  res.json(photo);
});

// DELETE /api/upload/:upload_id
// Delete a photo (only uploader or admin)
router.delete('/upload/:upload_id', requireAuth, (req, res) => {
  const upload = db.prepare('SELECT * FROM file_uploads WHERE id = ?').get(req.params.upload_id);
  if (!upload) return res.status(404).json({ error: 'Upload not found' });

  if (upload.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized to delete this file' });
  }

  // Delete from disk
  const fs   = require('fs');
  const subdir = upload.type === 'profile_photo' ? 'profiles' : upload.type === 'review_photo' ? 'reviews' : 'jobs';
  const filePath = require('path').join(UPLOAD_DIR, subdir, upload.filename);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch {}
  }

  db.prepare('DELETE FROM file_uploads WHERE id = ?').run(upload.id);
  res.json({ message: 'Photo deleted' });
});

module.exports = router;
