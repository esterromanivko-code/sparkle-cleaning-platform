'use strict';
// lib/retention.js — deletes job photos and precise location history once they
// are no longer needed as evidence.
//
// Kept for JOB_EVIDENCE_RETENTION_DAYS (default 180) after a job ends: long
// enough for Sparkle's 72-hour problem window and for card chargebacks, which can
// arrive months later. A job with an unresolved dispute is never swept. Distances
// and times ("arrived 40 m from the address, on site 2h 14m") are kept; the photos
// and the coordinates themselves are not. The privacy policy promises this.

const db = require('../db');
const { removePhotoFiles } = require('./jobPhotoUploads');
const { transaction } = require('./payouts');

const retentionDays = () => Math.max(30, parseInt(process.env.JOB_EVIDENCE_RETENTION_DAYS || '180', 10) || 180);

function runRetentionSweep() {
  const jobs = db.prepare(`
    SELECT j.id FROM jobs j
    WHERE j.status IN ('completed', 'cancelled')
      AND COALESCE(j.completed_at, j.updated_at) < datetime('now', ?)
      AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.job_id = j.id AND d.status != 'resolved')
      AND (EXISTS (SELECT 1 FROM job_photos p WHERE p.job_id = j.id)
           OR EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = j.id)
           OR j.last_lat IS NOT NULL OR j.arrival_lat IS NOT NULL)
    LIMIT 500
  `).all(`-${retentionDays()} days`);

  let photos = 0;
  for (const { id } of jobs) {
    const files = transaction(() => {
      const rows = db.prepare('SELECT filename, thumb_filename FROM job_photos WHERE job_id = ?').all(id);
      db.prepare('DELETE FROM job_photos WHERE job_id = ?').run(id);
      db.prepare('DELETE FROM job_locations WHERE job_id = ?').run(id);
      db.prepare(`
        UPDATE jobs SET last_lat = NULL, last_lng = NULL, last_accuracy_m = NULL,
               arrival_lat = NULL, arrival_lng = NULL, completion_lat = NULL, completion_lng = NULL
        WHERE id = ?
      `).run(id);
      db.prepare('UPDATE lockout_fees SET lat = NULL, lng = NULL WHERE job_id = ?').run(id);
      return rows;
    });
    files.forEach(removePhotoFiles);
    photos += files.length;
  }
  if (jobs.length) console.log(`[RETENTION] Cleared photos and location history for ${jobs.length} job(s) (${photos} photo(s))`);
  return { jobs: jobs.length, photos };
}

function startRetentionSweep() {
  const run = () => { try { runRetentionSweep(); } catch (err) { console.error('[RETENTION]', err.message); } };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}

module.exports = { runRetentionSweep, startRetentionSweep };
