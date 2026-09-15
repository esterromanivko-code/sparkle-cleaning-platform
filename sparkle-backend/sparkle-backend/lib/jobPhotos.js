'use strict';
// lib/jobPhotos.js — who may see a job's photos, and how many a job has.
// Shared by routes/jobPhotos.js and the job routes that gate completion on photos.

const db = require('../db');

// How the signed-in user relates to a job: 'cleaner', 'client', 'admin', or null.
// Photos show the inside of someone's home, so null means "doesn't exist" to them.
function jobAccess(job, user) {
  if (!job || !user) return null;
  if (user.role === 'admin') return 'admin';
  if (user.role === 'cleaner' && job.cleaner_id === user.id) return 'cleaner';
  if (user.role === 'client' && job.client_id === user.id) return 'client';
  return null;
}

// Live before/after/lockout photos taken by the job's current cleaner.
function stageCounts(jobId, cleanerId) {
  const counts = { before: 0, after: 0, lockout: 0 };
  if (!cleanerId) return counts;
  const rows = db.prepare(`
    SELECT stage, COUNT(*) AS n FROM job_photos
    WHERE job_id = ? AND uploaded_by = ? AND deleted_at IS NULL AND stage IN ('before','after','lockout')
    GROUP BY stage
  `).all(jobId, cleanerId);
  for (const r of rows) counts[r.stage] = r.n;
  return counts;
}

// The shape every API response uses. Files are only reachable through the
// authenticated /file route, so the app fetches them with its token.
function serializePhoto(p, viewer) {
  const out = {
    id:         p.id,
    job_id:     p.job_id,
    stage:      p.stage,
    role:       p.role,
    dispute_id: p.dispute_id,
    created_at: p.created_at,
    size_bytes: p.size_bytes,
    mine:       !!viewer && p.uploaded_by === viewer.id,
    url:        `/api/job-photos/file/${encodeURIComponent(p.id)}`,
    thumb_url:  `/api/job-photos/file/${encodeURIComponent(p.id)}?variant=thumb`,
  };
  if (viewer?.role === 'admin' && p.deleted_at) {
    Object.assign(out, { deleted_at: p.deleted_at, delete_reason: p.delete_reason });
  }
  return out;
}

module.exports = { jobAccess, stageCounts, serializePhoto };
