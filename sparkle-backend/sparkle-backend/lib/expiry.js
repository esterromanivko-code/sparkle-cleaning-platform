'use strict';
// lib/expiry.js — closes jobs nobody booked, and expires old quotes.
//
// The screens promise a client "48 hours to pick a cleaner before the job expires",
// but the only code that did it sat behind an admin-only button nothing ever
// pressed. Open jobs stayed open — and biddable — for ever, long after their date.
// This now runs on its own.
//
//   • A quote stops counting 48 hours after it was sent.
//   • An open job is closed when its date has passed, or when it has been open for
//     48 hours and has no live quote. (Booked jobs are never touched here.)

const db = require('../db');
const { notify } = require('./notify');
const { transaction } = require('./payouts');

function runExpirySweep() {
  const outcome = transaction(() => {
    const expiredBids = db.prepare(`
      UPDATE bids SET status = 'expired'
      WHERE status = 'pending' AND julianday(expires_at) < julianday('now')
      RETURNING job_id
    `).all();

    const closedJobs = db.prepare(`
      UPDATE jobs SET status = 'cancelled', updated_at = datetime('now')
      WHERE status = 'open'
        AND (
          julianday(scheduled_at) <= julianday('now')
          OR (created_at < datetime('now', '-48 hours')
              AND id NOT IN (SELECT job_id FROM bids WHERE status IN ('pending', 'chosen')))
        )
      RETURNING id, client_id, service_type, scheduled_at
    `).all();

    for (const job of closedJobs) {
      db.prepare("UPDATE bids SET status = 'expired' WHERE job_id = ? AND status = 'pending'").run(job.id);
      const passed = Date.parse(job.scheduled_at) <= Date.now();
      notify(job.client_id, '⏰ Your job expired without a booking',
        passed
          ? `The date for your ${job.service_type} passed before a cleaner was booked. Post it again for a new date.`
          : `Your ${job.service_type} didn't get booked within 48 hours. Post it again, ideally with a more flexible date.`,
        'job_expired');
    }
    return { expired_bids: expiredBids.length, expired_jobs: closedJobs.length };
  });
  if (outcome.expired_bids || outcome.expired_jobs) {
    console.log(`[EXPIRY] Closed ${outcome.expired_jobs} job(s), expired ${outcome.expired_bids} quote(s)`);
  }
  return outcome;
}

function startExpirySweep() {
  const run = () => { try { runExpirySweep(); } catch (err) { console.error('[EXPIRY] Sweep failed:', err.message); } };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 15 * 60 * 1000).unref();
}

module.exports = { runExpirySweep, startExpirySweep };
