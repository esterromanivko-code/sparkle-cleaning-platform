'use strict';
// routes/credentials.js — cleaner license & insurance (COI) verification.
//
// Flow: cleaner uploads a document -> status 'pending' -> admins are notified ->
// an admin approves or rejects -> cleaner_profiles.badge_tier is recomputed and
// the cleaner is notified.
//
// SECURITY: the uploaded documents contain licence numbers, home addresses and
// policy details. They are never publicly served — GET /:id/file is the only way
// to read one, and it is gated owner-or-admin.

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { credentialUploadLimiter }  = require('../middleware/security');
const { handleDocUpload, discardUpload, DOC_DIR, SERVEABLE_MIMETYPES } = require('../lib/docUploads');
const { recomputeBadgeTier } = require('../lib/badges');
const { sendCredentialApproved, sendCredentialRejected } = require('../lib/email');

const router = express.Router();

const DOC_TYPES  = ['license', 'coi'];
const DOC_LABELS = { license: 'License', coi: 'Insurance' };

// Columns safe to return to the owning cleaner. policy_number is deliberately
// excluded everywhere — it is write-only from the app's perspective.
const CLEANER_FIELDS = `id, doc_type, status, original_name, mimetype, size_bytes,
                        issuer, expires_at, review_notes, reviewed_at, submitted_at, is_current`;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ══════════════════════════════════════════════════════
//  CLEANER — own credentials
// ══════════════════════════════════════════════════════

// GET /api/credentials/mine — the cleaner's own documents (newest first per type)
router.get('/mine', requireAuth, requireRole('cleaner'), (req, res) => {
  const docs = db.prepare(`
    SELECT ${CLEANER_FIELDS} FROM cleaner_credentials
    WHERE cleaner_id = ? AND status != 'superseded'
    ORDER BY submitted_at DESC
  `).all(req.user.id);

  const profile = db.prepare('SELECT badge_tier FROM cleaner_profiles WHERE user_id = ?').get(req.user.id);
  res.json({ documents: docs, badge_tier: profile?.badge_tier || 'none' });
});

// POST /api/credentials/:doc_type — upload a document for review
//
// NOTE: multer writes the file to disk before any validation below runs, so every
// 4xx path must discardUpload(req) or orphaned files pile up on the volume.
// NOTE: sanitizeInput (server.js) runs before the router and only touches req.body,
// which is still empty for multipart — so these fields are validated here explicitly.
router.post('/:doc_type',
  requireAuth, requireRole('cleaner'), credentialUploadLimiter, handleDocUpload,
  (req, res) => {
    const docType = req.params.doc_type;

    if (!DOC_TYPES.includes(docType)) {
      discardUpload(req);
      return res.status(400).json({ error: 'Invalid document type' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No document uploaded' });
    }

    const expiresAt = String(req.body.expires_at || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
      discardUpload(req);
      return res.status(422).json({ error: 'A valid expiry date (YYYY-MM-DD) is required' });
    }
    if (expiresAt <= todayISO()) {
      discardUpload(req);
      return res.status(422).json({ error: 'Expiry date must be in the future' });
    }

    // One pending submission per type at a time — keeps the review queue honest.
    const pending = db.prepare(
      `SELECT id FROM cleaner_credentials WHERE cleaner_id = ? AND doc_type = ? AND status = 'pending'`
    ).get(req.user.id, docType);
    if (pending) {
      discardUpload(req);
      return res.status(409).json({ error: 'You already have a document of this type awaiting review.' });
    }

    const id = uuid();
    try {
      db.prepare(`
        INSERT INTO cleaner_credentials
          (id, cleaner_id, doc_type, status, filename, original_name, mimetype,
           size_bytes, issuer, policy_number, expires_at)
        VALUES (?,?,?,'pending',?,?,?,?,?,?,?)
      `).run(
        id, req.user.id, docType,
        req.file.filename, req.file.originalname, req.file.mimetype, req.file.size,
        String(req.body.issuer || '').trim().slice(0, 120) || null,
        String(req.body.policy_number || '').trim().slice(0, 60) || null,
        expiresAt
      );
    } catch (err) {
      discardUpload(req);
      return res.status(500).json({ error: 'Could not save the document. Please try again.' });
    }

    // Notify every active admin that there's something to review.
    const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin' AND is_active = 1`).all();
    const notify = db.prepare(`INSERT INTO notifications (id,user_id,title,body,type) VALUES (?,?,?,?,?)`);
    const who    = `${req.user.name || 'A cleaner'}`;
    const label  = docType === 'license' ? 'business license' : 'insurance certificate';
    admins.forEach(a => notify.run(
      uuid(), a.id, '📄 New document to review',
      `${who} submitted a ${label} for verification.`, 'credential_submitted'
    ));

    // No-op in the happy path (a renewal keeps the existing approval current until
    // the replacement is approved), but keeps first-upload and edge cases converged.
    recomputeBadgeTier(req.user.id);

    res.status(201).json({ id, doc_type: docType, status: 'pending', expires_at: expiresAt });
  }
);

// DELETE /api/credentials/:id — withdraw a pending submission (owner only)
router.delete('/:id', requireAuth, (req, res) => {
  const cred = db.prepare('SELECT * FROM cleaner_credentials WHERE id = ?').get(req.params.id);
  if (!cred) return res.status(404).json({ error: 'Document not found' });
  if (cred.cleaner_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  if (cred.status !== 'pending') {
    return res.status(409).json({ error: 'Only a document awaiting review can be withdrawn.' });
  }

  db.prepare('DELETE FROM cleaner_credentials WHERE id = ?').run(cred.id);
  try { fs.unlinkSync(path.join(DOC_DIR, path.basename(cred.filename))); } catch {}
  recomputeBadgeTier(cred.cleaner_id);

  res.json({ message: 'Document withdrawn' });
});

// GET /api/credentials/:id/file — stream the document (owner or admin only)
//
// This is deliberately NOT served by express.static. A UUID filename is not an
// access control: one leaked URL (screenshot, referrer header, proxy log) would be
// a permanent, unrevocable disclosure of someone's licence number and address.
router.get('/:id/file', requireAuth, (req, res) => {
  const cred = db.prepare('SELECT * FROM cleaner_credentials WHERE id = ?').get(req.params.id);
  if (!cred) return res.status(404).json({ error: 'Document not found' });
  if (req.user.role !== 'admin' && cred.cleaner_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // basename() defeats path traversal even if a filename were ever tampered with.
  const safeName = path.basename(cred.filename);
  const filePath = path.join(DOC_DIR, safeName);
  if (!filePath.startsWith(DOC_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File is no longer available' });
  }

  // Only serve a mimetype we recognise — never echo back a stored value verbatim.
  const mime = SERVEABLE_MIMETYPES.has(cred.mimetype) ? cred.mimetype : 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', fs.statSync(filePath).size);
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  fs.createReadStream(filePath).pipe(res);
});

// ══════════════════════════════════════════════════════
//  ADMIN — review queue
// ══════════════════════════════════════════════════════

// GET /api/credentials/admin/queue?status=pending — one row per document
router.get('/admin/queue', requireAuth, requireRole('admin'), (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'expired'].includes(req.query.status)
    ? req.query.status : 'pending';

  // policy_number is intentionally not selected — the admin reads it off the document.
  const documents = db.prepare(`
    SELECT c.id, c.cleaner_id, c.doc_type, c.status, c.original_name, c.mimetype,
           c.size_bytes, c.issuer, c.expires_at, c.submitted_at, c.review_notes,
           u.first_name, u.last_name, u.email, u.city,
           cp.badge_tier, cp.avg_rating, cp.total_jobs
    FROM cleaner_credentials c
    JOIN users u             ON u.id      = c.cleaner_id
    JOIN cleaner_profiles cp ON cp.user_id = c.cleaner_id
    WHERE c.status = ?
    ORDER BY c.submitted_at ASC
    LIMIT 200
  `).all(status);

  const pendingCount = db.prepare(
    `SELECT COUNT(*) AS count FROM cleaner_credentials WHERE status = 'pending'`
  ).get().count;

  res.json({ documents, status, pending_count: pendingCount });
});

// POST /api/credentials/admin/:id/approve — body: { expires_at? }
router.post('/admin/:id/approve', requireAuth, requireRole('admin'), (req, res) => {
  const cred = db.prepare('SELECT * FROM cleaner_credentials WHERE id = ?').get(req.params.id);
  if (!cred) return res.status(404).json({ error: 'Document not found' });
  if (cred.status !== 'pending') {
    return res.status(409).json({ error: `Document is already ${cred.status}` });
  }

  // The admin is looking at the actual document, so they may correct the date the
  // cleaner typed. Falls back to the submitted value when omitted.
  const corrected = String(req.body.expires_at || '').trim();
  if (corrected && !/^\d{4}-\d{2}-\d{2}$/.test(corrected)) {
    return res.status(422).json({ error: 'Expiry date must be YYYY-MM-DD' });
  }
  const expiresAt = corrected || cred.expires_at || null;

  // Retire the previously-approved document of this type, if any. Doing this only
  // now is what lets a cleaner renew early without losing their badge mid-review.
  db.prepare(`
    UPDATE cleaner_credentials SET status = 'superseded', is_current = 0
    WHERE cleaner_id = ? AND doc_type = ? AND is_current = 1 AND id != ?
  `).run(cred.cleaner_id, cred.doc_type, cred.id);

  db.prepare(`
    UPDATE cleaner_credentials
    SET status = 'approved', is_current = 1, expires_at = ?, warned_30d_at = NULL,
        review_notes = NULL, reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(expiresAt, req.user.id, cred.id);

  const tier  = recomputeBadgeTier(cred.cleaner_id);
  const label = DOC_LABELS[cred.doc_type];
  const full  = tier === 'licensed_and_insured';

  db.prepare(`INSERT INTO notifications (id,user_id,title,body,type) VALUES (?,?,?,?,?)`)
    .run(uuid(), cred.cleaner_id, `✅ ${label} verified!`,
      full
        ? "You're fully verified — your Licensed & Insured badge is live and you'll rank higher in client search."
        : `Your ${label.toLowerCase()} is approved and your badge is now live on your profile.`,
      'credential_approved');

  const cleaner = db.prepare('SELECT email, first_name FROM users WHERE id = ?').get(cred.cleaner_id);
  if (cleaner) {
    sendCredentialApproved(cleaner.email, cleaner.first_name, label, full).catch(() => {});
  }

  res.json({ message: 'Document approved', badge_tier: tier, expires_at: expiresAt });
});

// POST /api/credentials/admin/:id/reject — body: { reason }
router.post('/admin/:id/reject', requireAuth, requireRole('admin'), [
  body('reason').trim().notEmpty().isLength({ max: 500 }).withMessage('A reason is required'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const cred = db.prepare('SELECT * FROM cleaner_credentials WHERE id = ?').get(req.params.id);
  if (!cred) return res.status(404).json({ error: 'Document not found' });
  if (cred.status !== 'pending') {
    return res.status(409).json({ error: `Document is already ${cred.status}` });
  }

  const reason = req.body.reason.trim();

  db.prepare(`
    UPDATE cleaner_credentials
    SET status = 'rejected', is_current = 0, review_notes = ?,
        reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(reason, req.user.id, cred.id);

  // A rejected renewal must not leave a stale badge standing.
  const tier  = recomputeBadgeTier(cred.cleaner_id);
  const label = DOC_LABELS[cred.doc_type];

  db.prepare(`INSERT INTO notifications (id,user_id,title,body,type) VALUES (?,?,?,?,?)`)
    .run(uuid(), cred.cleaner_id, `⚠️ ${label} not approved`, reason, 'credential_rejected');

  const cleaner = db.prepare('SELECT email, first_name FROM users WHERE id = ?').get(cred.cleaner_id);
  if (cleaner) {
    sendCredentialRejected(cleaner.email, cleaner.first_name, label, reason).catch(() => {});
  }

  res.json({ message: 'Document rejected', badge_tier: tier });
});

module.exports = router;
