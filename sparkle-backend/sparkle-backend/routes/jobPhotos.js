'use strict';
// routes/jobPhotos.js — before/after proof photos and dispute evidence.
//
//   POST   /api/job-photos/:jobId?stage=before|after|lockout      cleaner on the job
//   POST   /api/job-photos/:jobId?stage=evidence&dispute_id=...   either party, or an admin
//   GET    /api/job-photos/:jobId                                 cleaner, client, admin
//   GET    /api/job-photos/file/:photoId[?variant=thumb]          cleaner, client, admin
//   DELETE /api/job-photos/photo/:photoId                         uploader (limited) or admin
//
// Uploads are one photo per request, so a dropped connection costs one photo, and
// an optional client_upload_id makes a retried request store it only once.

const express = require('express');
const fs      = require('fs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { jobPhotoUploadLimiter } = require('../middleware/security');
const { handlePhotoUpload, storePhoto, photoPath, removePhotoFiles, MAX_PHOTOS_PER_STAGE } = require('../lib/jobPhotoUploads');
const { jobAccess, stageCounts, serializePhoto } = require('../lib/jobPhotos');
const { transaction } = require('../lib/payouts');

const router = express.Router();

const STAGES = ['before', 'after', 'lockout', 'evidence'];
const CLIENT_UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

const STAGE_STATUSES = {
  before:  ['accepted', 'in_progress'],
  after:   ['in_progress'],
  lockout: ['accepted'],
};
const STAGE_STATUS_ERRORS = {
  before:  'Before photos can be added after you accept the job and until it is completed.',
  after:   'Tap "I\'ve arrived" first — after photos can be added while the job is in progress.',
  lockout: 'Lockout photos can only be added before the job has started.',
};

const fail = (status, error) => ({ problem: { status, error } });

// Every rule for adding a photo, in one synchronous function. It runs once before
// the upload is read (so strangers are refused without touching their bytes) and
// again inside the insert transaction, because the job may have been completed or
// the dispute resolved while the photo was being processed.
function checkUpload({ jobId, stage, disputeId, clientUploadId }, user) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  const access = jobAccess(job, user);
  if (!access) return fail(404, 'Job not found');
  if (!STAGES.includes(stage)) return fail(422, 'stage must be before, after, lockout or evidence');
  if (clientUploadId && !CLIENT_UPLOAD_ID.test(clientUploadId)) return fail(422, 'Invalid client_upload_id');

  let dispute = null;
  if (stage === 'evidence') {
    if (!disputeId) return fail(422, 'dispute_id is required for evidence photos');
    dispute = db.prepare('SELECT * FROM disputes WHERE id = ? AND job_id = ?').get(disputeId, job.id);
    if (!dispute) return fail(404, 'Dispute not found');
    if (access !== 'admin' && dispute.filed_by !== user.id && dispute.against !== user.id) {
      return fail(403, 'Only the people involved in this dispute can add evidence.');
    }
  } else if (access !== 'cleaner') {
    return fail(403, 'Only the cleaner on this job can add before, after and lockout photos.');
  }

  // A retry of an upload that already succeeded gets the stored photo back, even
  // if the job has moved on since.
  if (clientUploadId) {
    const duplicate = db.prepare(`
      SELECT * FROM job_photos WHERE job_id = ? AND uploaded_by = ? AND client_upload_id = ?
    `).get(job.id, user.id, clientUploadId);
    if (duplicate) return { job, duplicate };
  }

  if (stage === 'evidence') {
    if (dispute.status === 'resolved') return fail(409, 'This dispute has already been resolved.');
    const { n } = db.prepare(`
      SELECT COUNT(*) AS n FROM job_photos WHERE dispute_id = ? AND uploaded_by = ? AND deleted_at IS NULL
    `).get(dispute.id, user.id);
    if (n >= MAX_PHOTOS_PER_STAGE) return fail(409, `You can attach up to ${MAX_PHOTOS_PER_STAGE} photos to a dispute.`);
    return { job, role: access, disputeId: dispute.id };
  }

  if (!STAGE_STATUSES[stage].includes(job.status)) {
    const done = job.status === 'completed' || job.status === 'cancelled';
    return fail(409, done ? `This job is already ${job.status}.` : STAGE_STATUS_ERRORS[stage]);
  }
  if (stageCounts(job.id, user.id)[stage] >= MAX_PHOTOS_PER_STAGE) {
    return fail(409, `You can add up to ${MAX_PHOTOS_PER_STAGE} ${stage} photos.`);
  }
  return { job, role: 'cleaner', disputeId: null };
}

function uploadParams(req) {
  return {
    jobId:          req.params.jobId,
    stage:          String(req.query.stage || ''),
    disputeId:      req.query.dispute_id ? String(req.query.dispute_id) : null,
    clientUploadId: req.query.client_upload_id ? String(req.query.client_upload_id) : null,
  };
}

function photoResponse(res, status, row, job, user) {
  res.status(status).json({ photo: serializePhoto(row, user), counts: stageCounts(job.id, job.cleaner_id) });
}

function authorizeUpload(req, res, next) {
  const check = checkUpload(uploadParams(req), req.user);
  if (check.problem) return res.status(check.problem.status).json({ error: check.problem.error });
  if (check.duplicate) return photoResponse(res, 200, check.duplicate, check.job, req.user);
  next();
}

router.post('/:jobId', requireAuth, jobPhotoUploadLimiter, authorizeUpload, handlePhotoUpload, async (req, res) => {
  const params = uploadParams(req);

  let stored;
  try {
    stored = await storePhoto(req.file.buffer);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Job photo store error:', err);
    return res.status(500).json({ error: 'Could not save the photo. Please try again.' });
  } finally {
    req.file.buffer = null;
  }

  let result;
  try {
    result = transaction(() => {
      const check = checkUpload(params, req.user);
      if (check.problem || check.duplicate) return check;
      const id = uuid();
      db.prepare(`
        INSERT INTO job_photos
          (id, job_id, uploaded_by, role, stage, dispute_id, client_upload_id, filename, thumb_filename, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, check.job.id, req.user.id, check.role, params.stage, check.disputeId,
             params.clientUploadId, stored.filename, stored.thumbFilename, stored.sizeBytes);
      return { job: check.job, row: db.prepare('SELECT * FROM job_photos WHERE id = ?').get(id) };
    });
  } catch (err) {
    removePhotoFiles(stored);
    console.error('Job photo insert error:', err);
    return res.status(500).json({ error: 'Could not save the photo. Please try again.' });
  }

  if (!result.row) removePhotoFiles(stored);
  if (result.problem) return res.status(result.problem.status).json({ error: result.problem.error });
  if (result.duplicate) return photoResponse(res, 200, result.duplicate, result.job, req.user);
  photoResponse(res, 201, result.row, result.job, req.user);
});

// Declared before /:jobId only for readability — the paths can't collide.
router.get('/file/:photoId', requireAuth, (req, res) => {
  const photo = db.prepare('SELECT * FROM job_photos WHERE id = ?').get(req.params.photoId);
  const job = photo && db.prepare('SELECT id, client_id, cleaner_id FROM jobs WHERE id = ?').get(photo.job_id);
  const access = jobAccess(job, req.user);
  if (!photo || !access || (photo.deleted_at && access !== 'admin')) {
    return res.status(404).json({ error: 'Photo not found' });
  }

  const file = photoPath(req.query.variant === 'thumb' ? photo.thumb_filename : photo.filename);
  let stat;
  try { stat = fs.statSync(file); } catch { return res.status(404).json({ error: 'Photo file is missing' }); }

  res.set({
    'Content-Type':           'image/jpeg',   // always: every stored photo was re-encoded to JPEG
    'Content-Length':         stat.size,
    'Content-Disposition':    'inline',
    'X-Content-Type-Options': 'nosniff',
    // no-store: the response depends on who is asking, and a cached copy on a
    // shared computer must not outlive the session that was allowed to see it.
    'Cache-Control':          'private, no-store',
  });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

router.get('/:jobId', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  const access = jobAccess(job, req.user);
  if (!access) return res.status(404).json({ error: 'Job not found' });

  const rows = db.prepare(`
    SELECT * FROM job_photos
    WHERE job_id = ? ${access === 'admin' ? '' : 'AND deleted_at IS NULL'}
    ORDER BY created_at ASC, rowid ASC
  `).all(job.id);

  res.json({
    job_id:          job.id,
    photos:          rows.map(p => serializePhoto(p, req.user)),
    counts:          stageCounts(job.id, job.cleaner_id),
    photos_required: !!job.photos_required,
    max_per_stage:   MAX_PHOTOS_PER_STAGE,
  });
});

router.delete('/photo/:photoId', requireAuth, (req, res) => {
  const photo = db.prepare('SELECT * FROM job_photos WHERE id = ?').get(req.params.photoId);
  const job = photo && db.prepare('SELECT * FROM jobs WHERE id = ?').get(photo.job_id);
  const access = jobAccess(job, req.user);
  if (!photo || !access || photo.deleted_at) return res.status(404).json({ error: 'Photo not found' });

  // Admins hide rather than destroy: the photo may be the only record of what happened.
  if (access === 'admin') {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return res.status(422).json({ error: 'Give a reason for removing this photo.' });
    db.prepare(`
      UPDATE job_photos SET deleted_at = datetime('now'), deleted_by = ?, delete_reason = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(req.user.id, reason.slice(0, 500), photo.id);
    return res.json({ message: 'Photo removed', counts: stageCounts(job.id, job.cleaner_id) });
  }

  if (photo.uploaded_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only remove photos you added.' });
  }
  if (photo.stage === 'evidence') {
    const dispute = db.prepare('SELECT status FROM disputes WHERE id = ?').get(photo.dispute_id);
    if (!dispute || dispute.status === 'resolved') {
      return res.status(409).json({ error: "Evidence can't be removed once the dispute is resolved." });
    }
  } else if (job.status === 'completed' || job.status === 'cancelled' || job.photos_verified_at) {
    return res.status(409).json({ error: "Photos can't be removed after the job is finished — they're the record of the work." });
  }

  db.prepare('DELETE FROM job_photos WHERE id = ?').run(photo.id);
  removePhotoFiles(photo);
  res.json({ message: 'Photo removed', counts: stageCounts(job.id, job.cleaner_id) });
});

module.exports = router;
