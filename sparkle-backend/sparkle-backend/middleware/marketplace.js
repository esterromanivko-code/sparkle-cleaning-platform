'use strict';
// middleware/marketplace.js — Fraud and abuse protection for marketplace operations
// Covers: fake reviews, refund abuse, cancellation fees, no-show penalties, payout holds

const db    = require('../db');
const { v4: uuid } = require('uuid');
const { audit } = require('../lib/logger');
const { queueNotification } = require('../lib/queue');

// ─────────────────────────────────────────────────
//  FAKE REVIEW PROTECTION
//  Rules:
//  1. Reviewer must have been part of the job
//  2. Job must be status=completed
//  3. Minimum 1 hour since job completion (prevents instant fake reviews)
//  4. One review per person per job (enforced by DB UNIQUE constraint)
//  5. Flag reviews with suspicious patterns (all 5s from new accounts)
// ─────────────────────────────────────────────────
function validateReview(req, res, next) {
  const { job_id, reviewee_id, rating } = req.body;
  const reviewerId = req.user.id;

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Must be completed
  if (job.status !== 'completed') {
    return res.status(422).json({ error: 'You can only review after a job is completed' });
  }

  // Must be part of the job
  const isClient  = req.user.role === 'client'  && job.client_id  === reviewerId;
  const isCleaner = req.user.role === 'cleaner' && job.cleaner_id === reviewerId;
  if (!isClient && !isCleaner) {
    audit('FAKE_REVIEW_ATTEMPT', { reviewerId, jobId: job_id, reason: 'not_participant' });
    return res.status(403).json({ error: 'You were not part of this job' });
  }

  // Must wait at least 30 minutes after completion (prevents immediate retaliation reviews too)
  if (job.updated_at) {
    const minutesSince = (Date.now() - new Date(job.updated_at).getTime()) / 60000;
    if (minutesSince < 30) {
      return res.status(422).json({
        error: `Please wait ${Math.ceil(30 - minutesSince)} more minutes before leaving a review`
      });
    }
  }

  // Flag suspicious review patterns (new account, first review, giving 1 or 5 stars)
  const reviewer = db.prepare('SELECT created_at FROM users WHERE id = ?').get(reviewerId);
  const accountAgeDays = (Date.now() - new Date(reviewer.created_at).getTime()) / 86400000;
  const reviewCount = db.prepare('SELECT COUNT(*) as cnt FROM reviews WHERE reviewer_id = ?').get(reviewerId).cnt;

  if (accountAgeDays < 3 && reviewCount < 2 && (rating === 1 || rating === 5)) {
    // Don't block it — but flag it for admin review
    db.prepare('UPDATE users SET is_flagged = 1 WHERE id = ?').run(reviewerId);
    audit('SUSPICIOUS_REVIEW', { reviewerId, jobId: job_id, rating, accountAgeDays, reviewCount });
  }

  next();
}

// ─────────────────────────────────────────────────
//  REFUND ABUSE PROTECTION
//  Rules:
//  1. Max 2 disputes per client per month
//  2. Client must have actually had a job complete (can't dispute what was never done)
//  3. Dispute window: 48 hours after job completion
//  4. Flag clients who dispute > 30% of their bookings
// ─────────────────────────────────────────────────
function validateDispute(req, res, next) {
  const { job_id } = req.body;
  const userId = req.user.id;

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'completed') {
    return res.status(422).json({ error: 'You can only dispute a completed job' });
  }

  // Check dispute window: must be within 48 hours of completion
  if (job.updated_at) {
    const hoursSince = (Date.now() - new Date(job.updated_at).getTime()) / 3600000;
    if (hoursSince > 48) {
      return res.status(422).json({
        error: 'The 48-hour dispute window for this job has passed. Contact support for help.'
      });
    }
  }

  // Max 2 disputes per month
  const monthlyDisputes = db.prepare(`
    SELECT COUNT(*) as cnt FROM disputes
    WHERE filed_by = ? AND created_at >= date('now', 'start of month')
  `).get(userId);

  if (monthlyDisputes.cnt >= 2) {
    audit('REFUND_ABUSE_BLOCKED', { userId, monthlyCount: monthlyDisputes.cnt });
    return res.status(429).json({
      error: 'You have reached the maximum of 2 disputes this month. Contact support for additional help.'
    });
  }

  // Flag if dispute rate is high (> 30% of bookings)
  const totalBookings  = db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE client_id = ? AND status = 'completed'").get(userId).cnt;
  const totalDisputes  = db.prepare('SELECT COUNT(*) as cnt FROM disputes WHERE filed_by = ?').get(userId).cnt;
  if (totalBookings > 3 && totalDisputes / totalBookings > 0.3) {
    db.prepare('UPDATE users SET is_flagged = 1 WHERE id = ?').run(userId);
    audit('HIGH_DISPUTE_RATE', { userId, totalBookings, totalDisputes, rate: (totalDisputes/totalBookings).toFixed(2) });
  }

  next();
}

// ─────────────────────────────────────────────────
//  CANCELLATION FEE LOGIC
//  Rules:
//  - Client cancels > 24hrs before: free, full refund
//  - Client cancels < 24hrs before: 15% cancellation fee (compensates cleaner)
//  - Cleaner cancels: no fee to client (cleaner gets a strike)
//  - 3 cleaner cancellations = account review
// ─────────────────────────────────────────────────
async function applyCancellationPolicy(jobId, cancelledByRole, cancelledById) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || !['open','accepted'].includes(job.status)) return { fee: 0, reason: 'no_fee' };

  const hoursUntilJob = job.scheduled_at
    ? (new Date(job.scheduled_at).getTime() - Date.now()) / 3600000
    : 999;

  const stripe = require('./stripe').getStripe ? require('./stripe').getStripe() : null;

  // ── Client cancellation ─────────────────────────────────────────────────
  if (cancelledByRole === 'client') {
    if (hoursUntilJob >= 24) {
      // Free cancellation — full refund if already authorized
      if (job.stripe_payment_intent_id && stripe) {
        try { await stripe.paymentIntents.cancel(job.stripe_payment_intent_id); } catch {}
      }
      return { fee: 0, reason: 'free_cancellation', refunded: true };
    }

    // Late cancel — charge 15% of the quoted amount
    const cancelFee = job.base_amount ? parseFloat((job.base_amount * 0.15).toFixed(2)) : 0;
    if (cancelFee > 0 && stripe) {
      try {
        const clientUser = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(cancelledById);
        if (clientUser.stripe_customer_id) {
          const charge = await stripe.charges.create({
            amount:      Math.round(cancelFee * 100),
            currency:    'usd',
            customer:    clientUser.stripe_customer_id,
            description: `Sparkle late cancellation fee - job ${jobId}`,
            metadata:    { job_id: jobId, type: 'cancellation_fee' }
          });
          db.prepare(`
            INSERT INTO cancellation_fees (id, job_id, charged_to, amount, reason, stripe_charge_id)
            VALUES (?, ?, ?, ?, 'late_cancellation', ?)
          `).run(uuid(), jobId, cancelledById, cancelFee, charge.id);

          // Give cleaner half the cancellation fee as compensation
          const cleanerCompensation = cancelFee * 0.5;
          if (job.cleaner_id) {
            db.prepare(`
              INSERT INTO payouts (id, cleaner_id, job_id, amount, type, status)
              VALUES (?, ?, ?, ?, 'cancellation_compensation', 'pending')
            `).run(uuid(), job.cleaner_id, jobId, cleanerCompensation);

            await queueNotification(job.cleaner_id,
              '💰 Cancellation compensation',
              `The client cancelled within 24 hours. You will receive $${cleanerCompensation.toFixed(2)} compensation.`,
              'cancellation_comp'
            );
          }
        }
      } catch (err) {
        audit('CANCELLATION_FEE_FAILED', { jobId, error: err.message });
      }
    }
    return { fee: cancelFee, reason: 'late_cancellation', hours_before: Math.round(hoursUntilJob) };
  }

  // ── Cleaner cancellation — track strikes ────────────────────────────────
  if (cancelledByRole === 'cleaner') {
    const cleanerId = cancelledById;

    // Record cancellation strike
    const monthCancel = db.prepare(`
      SELECT COUNT(*) as cnt FROM jobs
      WHERE cleaner_id = ? AND status = 'cancelled'
      AND updated_at >= date('now', 'start of month')
    `).get(cleanerId).cnt;

    if (monthCancel >= 2) {
      // 3+ cancellations this month — flag cleaner for review
      db.prepare('UPDATE users SET is_flagged = 1 WHERE id = ?').run(cleanerId);
      audit('CLEANER_CANCELLATION_ABUSE', { cleanerId, monthlyCount: monthCancel + 1 });

      await queueNotification(cleanerId,
        '⚠️ Cancellation warning',
        'You have cancelled multiple jobs this month. Frequent cancellations may lead to account review. Clients depend on reliability.',
        'cancellation_warning'
      );
    }

    // Notify client — no fee, but find them a replacement
    if (job.client_id) {
      await queueNotification(job.client_id,
        '⚠️ Your cleaner cancelled',
        'We\'re sorry — your cleaner had to cancel. Post your job again and we\'ll help you find a replacement quickly.',
        'cleaner_cancelled'
      );
    }

    return { fee: 0, reason: 'cleaner_cancelled', client_notified: true };
  }

  return { fee: 0, reason: 'admin_cancel' };
}

// ─────────────────────────────────────────────────
//  PROVIDER NO-SHOW HANDLER
//  Called when a cleaner doesn't mark "arrived" within 30 mins of scheduled time
//  and the lockout fee has been triggered
// ─────────────────────────────────────────────────
async function handleProviderNoShow(jobId) {
  const job = db.prepare(`
    SELECT j.*, u.id as cleaner_user_id
    FROM jobs j LEFT JOIN users u ON u.id = j.cleaner_id
    WHERE j.id = ?
  `).get(jobId);
  if (!job || !job.cleaner_id) return;

  // Notify client
  await queueNotification(job.client_id,
    '⚠️ Your cleaner hasn\'t arrived',
    'Your cleaner has not marked their arrival. If they are a no-show, you can charge a lockout fee from the job page.',
    'no_show_alert'
  );

  // Flag the cleaner
  db.prepare('UPDATE users SET is_flagged = 1 WHERE id = ?').run(job.cleaner_id);
  audit('PROVIDER_NO_SHOW', { jobId, cleanerId: job.cleaner_id, clientId: job.client_id });
}

// ─────────────────────────────────────────────────
//  PAYOUT HOLD — release payout 24hrs after job completes
//  Gives clients time to dispute before money moves
// ─────────────────────────────────────────────────
function getPayoutsReadyForRelease() {
  return db.prepare(`
    SELECT p.*, cp.stripe_connect_id, u.email
    FROM payouts p
    JOIN cleaner_profiles cp ON cp.user_id = p.cleaner_id
    JOIN users u ON u.id = p.cleaner_id
    WHERE p.status = 'pending'
    AND p.type = 'job'
    AND p.created_at <= datetime('now', '-24 hours')
    AND p.job_id IN (
      SELECT id FROM jobs WHERE status = 'completed'
      AND id NOT IN (SELECT job_id FROM disputes WHERE status != 'resolved')
    )
  `).all();
}

module.exports = {
  validateReview,
  validateDispute,
  applyCancellationPolicy,
  handleProviderNoShow,
  getPayoutsReadyForRelease,
};
