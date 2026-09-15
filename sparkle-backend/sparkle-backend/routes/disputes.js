'use strict';
// routes/disputes.js — clients reporting a problem with a job.
//
//   POST /api/disputes                  client: report a problem (within 72 hours)
//   POST /api/disputes/:id/statement    the cleaner: tell their side
//   GET  /api/disputes/mine             disputes I filed or that are about me
//   GET  /api/disputes/:id              either party, or an admin — with the photos
//
// Photos for a dispute are uploaded separately, one at a time, to
// POST /api/job-photos/:jobId?stage=evidence&dispute_id=...  (optional for clients).
// While a dispute is open, the cleaner's earnings for that job can't be cashed out
// (lib/payouts.js). Admins rule on it in routes/admin.js.

const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { transaction } = require('../lib/payouts');
const { notify, notifyAdmins } = require('../lib/notify');
const { serializePhoto } = require('../lib/jobPhotos');
const { trackingSummary } = require('../lib/tracking');
const { MAX_PHOTOS_PER_STAGE } = require('../lib/jobPhotoUploads');

const router = express.Router();

const REPORT_WINDOW_HOURS = 72;
const MAX_REPORTS_PER_30_DAYS = 2;
const JOB_TYPES = ['quality', 'payment', 'other'];

const DISPUTE_SQL = `
  SELECT d.*, j.service_type, j.scheduled_at, j.completed_at, j.client_id, j.cleaner_id,
         cu.first_name AS client_first, substr(cu.last_name, 1, 1) AS client_initial,
         cl.first_name AS cleaner_first, substr(cl.last_name, 1, 1) AS cleaner_initial
  FROM disputes d
  JOIN jobs j ON j.id = d.job_id
  JOIN users cu ON cu.id = j.client_id
  LEFT JOIN users cl ON cl.id = j.cleaner_id`;

function canView(d, user) {
  return user.role === 'admin' || d.filed_by === user.id || d.against === user.id;
}

function serializeDispute(d, user) {
  return {
    id:            d.id,
    job_id:        d.job_id,
    type:          d.type,
    description:   d.description,
    status:        d.status,
    ruling:        d.ruling,
    resolution:    d.resolution,
    created_at:    d.created_at,
    resolved_at:   d.resolved_at,
    respondent_statement:    d.respondent_statement,
    respondent_statement_at: d.respondent_statement_at,
    refund_status: d.refund_status,
    refund_amount: d.refund_amount,
    service_type:  d.service_type,
    scheduled_at:  d.scheduled_at,
    client_name:   d.client_first ? `${d.client_first} ${d.client_initial}.` : null,
    cleaner_name:  d.cleaner_first ? `${d.cleaner_first} ${d.cleaner_initial}.` : null,
    filed_by_me:   d.filed_by === user.id,
    against_me:    d.against === user.id,
    can_add_evidence: d.status !== 'resolved' && canView(d, user),
    evidence_upload_url: `/api/job-photos/${encodeURIComponent(d.job_id)}?stage=evidence&dispute_id=${encodeURIComponent(d.id)}`,
    max_evidence_photos: MAX_PHOTOS_PER_STAGE,
  };
}

// ── POST /api/disputes ───────────────────────────────────────────────────────
router.post('/', requireAuth, requireRole('client'), (req, res) => {
  const jobId = String(req.body?.job_id || '');
  const type = String(req.body?.type || '');
  const description = String(req.body?.description || '').trim();

  if (![...JOB_TYPES, 'lockout_fee'].includes(type)) {
    return res.status(422).json({ error: 'type must be quality, payment, other or lockout_fee' });
  }
  if (description.length < 20 || description.length > 2000) {
    return res.status(422).json({ error: 'Please describe the problem in 20 to 2,000 characters.' });
  }

  let outcome;
  try {
    outcome = transaction(() => {
      const job = db.prepare(`
        SELECT *, (julianday('now') - julianday(completed_at)) * 24 AS hours_since_completed
        FROM jobs WHERE id = ? AND client_id = ?
      `).get(jobId, req.user.id);
      if (!job) return { status: 404, error: 'Job not found' };
      if (!job.cleaner_id) return { status: 409, error: 'No cleaner was assigned to this job.' };

      if (type === 'lockout_fee') {
        const fee = db.prepare(`
          SELECT *, (julianday('now') - julianday(created_at)) * 24 AS hours_since
          FROM lockout_fees WHERE job_id = ? AND status = 'charged' ORDER BY created_at DESC LIMIT 1
        `).get(job.id);
        if (!fee) return { status: 409, error: 'There is no lockout fee on this job to dispute.' };
        if (fee.hours_since > REPORT_WINDOW_HOURS) {
          return { status: 409, error: `Lockout fees can be disputed within ${REPORT_WINDOW_HOURS} hours. Contact support for help.` };
        }
      } else {
        if (job.status !== 'completed') {
          return { status: 409, error: 'You can report a problem once the job has been completed.' };
        }
        if (job.hours_since_completed === null || job.hours_since_completed > REPORT_WINDOW_HOURS) {
          return { status: 409, error: `Problems can be reported within ${REPORT_WINDOW_HOURS} hours of the job being completed. Contact support for help.` };
        }
      }

      if (db.prepare('SELECT 1 FROM disputes WHERE job_id = ?').get(job.id)) {
        return { status: 409, error: "You've already reported a problem with this job." };
      }
      const { recent } = db.prepare(`
        SELECT COUNT(*) AS recent FROM disputes WHERE filed_by = ? AND created_at >= datetime('now', '-30 days')
      `).get(req.user.id);
      if (recent >= MAX_REPORTS_PER_30_DAYS) {
        return { status: 429, error: `You can report up to ${MAX_REPORTS_PER_30_DAYS} problems a month here. Please contact support and we'll help.` };
      }

      const id = uuid();
      db.prepare(`
        INSERT INTO disputes (id, job_id, filed_by, against, type, description, status)
        VALUES (?, ?, ?, ?, ?, ?, 'open')
      `).run(id, job.id, req.user.id, job.cleaner_id, type, description);

      // A client who disputes a large share of their bookings gets a human look.
      const { filed } = db.prepare('SELECT COUNT(*) AS filed FROM disputes WHERE filed_by = ?').get(req.user.id);
      const { booked } = db.prepare("SELECT COUNT(*) AS booked FROM jobs WHERE client_id = ? AND status IN ('completed','cancelled')").get(req.user.id);
      if (filed >= 2 && filed / Math.max(booked, 1) > 0.3) {
        db.prepare('UPDATE users SET is_flagged = 1 WHERE id = ?').run(req.user.id);
      }

      const held = db.prepare(`
        SELECT 1 FROM payouts WHERE job_id = ? AND status = 'pending' AND cashout_id IS NULL AND amount > 0
      `).get(job.id);
      const when = new Date(job.scheduled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      notify(job.cleaner_id, '⚠️ A client reported a problem',
        `The client reported a problem with your ${job.service_type} on ${when}.` +
        (held ? ' Your earnings for this job are on hold until Sparkle reviews it.' : ' Sparkle will review it.') +
        ' Add your side and any photos from the job in Earnings → Disputes.',
        'dispute_filed');
      notifyAdmins('New dispute', `A client reported a ${type.replace('_', ' ')} problem on job ${job.id}.`, 'dispute_filed');

      return { status: 201, id };
    });
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) return res.status(409).json({ error: "You've already reported a problem with this job." });
    console.error('File dispute error:', err);
    return res.status(500).json({ error: 'Could not submit your report. Please try again.' });
  }

  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  const d = db.prepare(`${DISPUTE_SQL} WHERE d.id = ?`).get(outcome.id);
  res.status(201).json({ message: 'Problem reported', dispute: serializeDispute(d, req.user) });
});

// ── POST /api/disputes/:id/statement ─────────────────────────────────────────
router.post('/:id/statement', requireAuth, (req, res) => {
  const statement = String(req.body?.statement || '').trim();
  if (statement.length < 10 || statement.length > 2000) {
    return res.status(422).json({ error: 'Please write 10 to 2,000 characters.' });
  }
  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
  if (!d || !canView(d, req.user)) return res.status(404).json({ error: 'Dispute not found' });
  if (d.against !== req.user.id) return res.status(403).json({ error: 'Only the person this was reported about can respond.' });

  const result = db.prepare(`
    UPDATE disputes SET respondent_statement = ?, respondent_statement_at = datetime('now')
    WHERE id = ? AND status != 'resolved'
  `).run(statement, d.id);
  if (result.changes !== 1) return res.status(409).json({ error: 'This dispute has already been resolved.' });

  const fresh = db.prepare(`${DISPUTE_SQL} WHERE d.id = ?`).get(d.id);
  res.json({ message: 'Your side has been added', dispute: serializeDispute(fresh, req.user) });
});

// ── GET /api/disputes/mine ───────────────────────────────────────────────────
router.get('/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`
    ${DISPUTE_SQL}
    WHERE d.filed_by = ? OR d.against = ?
    ORDER BY d.created_at DESC LIMIT 50
  `).all(req.user.id, req.user.id);
  res.json({ disputes: rows.map(d => serializeDispute(d, req.user)) });
});

// ── GET /api/disputes/:id ────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const d = db.prepare(`${DISPUTE_SQL} WHERE d.id = ?`).get(req.params.id);
  if (!d || !canView(d, req.user)) return res.status(404).json({ error: 'Dispute not found' });

  const isAdmin = req.user.role === 'admin';
  const photos = db.prepare(`
    SELECT * FROM job_photos
    WHERE job_id = ? AND (stage IN ('before','after','lockout') OR dispute_id = ?)
      ${isAdmin ? '' : 'AND deleted_at IS NULL'}
    ORDER BY created_at ASC, rowid ASC
  `).all(d.job_id, d.id);

  res.json({
    dispute:  serializeDispute(d, req.user),
    photos:   photos.map(p => serializePhoto(p, req.user)),
    // Arrival, time on site and check-in distances; admins also get the trail.
    tracking: trackingSummary(d.job_id, isAdmin ? 'admin' : 'party'),
  });
});

module.exports = router;
