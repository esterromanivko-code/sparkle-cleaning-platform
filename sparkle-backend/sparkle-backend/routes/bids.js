'use strict';
// routes/bids.js — Bidding system with full marketplace protections
// Covers: bid spam limits, double booking prevention, 48hr expiry, success fee logic

const express = require('express');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const db     = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/security');
const { queueNotification } = require('../lib/queue');
const { audit } = require('../lib/logger');
const { transaction, cents } = require('../lib/payouts');
const payments = require('../lib/payments');

const router = express.Router();

const SUCCESS_FEE_PCT = 0.10;   // 10% from cleaner when chosen
const MAX_BIDS_PER_CLEANER_PER_DAY = 20;  // bid spam protection
const BID_EXPIRY_HOURS = 48;    // client must choose within 48 hrs

// expires_at is stored as an ISO string; compared as text with SQLite's
// 'YYYY-MM-DD HH:MM:SS' it looked unexpired until the next day. Compare as dates.
const BID_LIVE_SQL = "julianday(b.expires_at) > julianday('now')";

// ─────────────────────────────────────────────────
// POST /api/bids — cleaner submits a bid on an open job
// ─────────────────────────────────────────────────
router.post('/', requireAuth, requireRole('cleaner'), [
  body('job_id').notEmpty(),
  body('amount').isFloat({ min: 10, max: 9999 }).withMessage('Amount must be between $10 and $9999'),
  body('message').trim().isLength({ min: 20, max: 1000 }).withMessage('Message must be 20–1000 characters'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { job_id, amount, message } = req.body;
  const cleanerId = req.user.id;

  // ── 1. Bid spam protection: max 20 bids per cleaner per day ──────────────
  const todayBids = db.prepare(`
    SELECT COUNT(*) as cnt FROM bids
    WHERE cleaner_id = ? AND submitted_at >= date('now')
  `).get(cleanerId);

  if (todayBids.cnt >= MAX_BIDS_PER_CLEANER_PER_DAY) {
    audit('BID_SPAM_BLOCKED', { cleanerId, jobId: job_id, dailyCount: todayBids.cnt });
    return res.status(429).json({
      error: `You have sent ${todayBids.cnt} bids today. Daily limit is ${MAX_BIDS_PER_CLEANER_PER_DAY}. This protects clients from being overwhelmed.`
    });
  }

  // ── 2. Verify job exists and is open ────────────────────────────────────
  const job = db.prepare("SELECT * FROM jobs WHERE id = ? AND status = 'open'").get(job_id);
  if (!job) return res.status(404).json({ error: 'Job not found or no longer accepting bids' });

  // ── 3. Cleaners cannot bid on their own jobs ─────────────────────────────
  if (job.client_id === cleanerId) {
    return res.status(403).json({ error: 'You cannot bid on your own job' });
  }

  // ── 4. Duplicate bid check (UNIQUE constraint also catches this) ──────────
  const existing = db.prepare('SELECT id FROM bids WHERE job_id = ? AND cleaner_id = ?').get(job_id, cleanerId);
  if (existing) return res.status(409).json({ error: 'You have already submitted a bid for this job' });

  // ── 5. Double booking prevention: check cleaner's schedule ───────────────
  const conflict = db.prepare(`
    SELECT j.id, j.scheduled_at FROM jobs j
    WHERE j.cleaner_id = ?
    AND j.status IN ('accepted', 'in_progress')
    AND date(j.scheduled_at) = date(?)
    AND ABS(
      (CAST(strftime('%H', j.scheduled_at) AS INTEGER) * 60 + CAST(strftime('%M', j.scheduled_at) AS INTEGER)) -
      (CAST(strftime('%H', ?) AS INTEGER) * 60 + CAST(strftime('%M', ?) AS INTEGER))
    ) < 180
  `).get(cleanerId, job.scheduled_at, job.scheduled_at, job.scheduled_at);

  if (conflict) {
    return res.status(409).json({
      error: 'This job overlaps with another job already on your schedule. Please check your calendar before bidding.',
      conflict_job_id: conflict.id
    });
  }

  // ── 6. Insert bid ────────────────────────────────────────────────────────
  const bidId     = uuid();
  const successFee = parseFloat((amount * SUCCESS_FEE_PCT).toFixed(2));
  const expiresAt = new Date(Date.now() + BID_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO bids (id, job_id, cleaner_id, amount, message, success_fee, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(bidId, job_id, cleanerId, amount, message, successFee, expiresAt);

  // Notify the client
  await queueNotification(
    job.client_id,
    '💬 New quote received!',
    `A cleaner quoted $${Number(amount).toFixed(2)} for your ${job.service_type}. You have 48 hours to decide.`,
    'new_bid'
  );

  res.status(201).json({
    bid_id:       bidId,
    amount,
    success_fee:  successFee,
    you_receive:  parseFloat((amount - successFee).toFixed(2)),
    expires_at:   expiresAt,
    message:      'Bid submitted. You will be notified if the client chooses you.',
  });
});

// ─────────────────────────────────────────────────
// GET /api/bids/job/:job_id — client views all bids on their job
// Supports sort: price | rating | speed
// ─────────────────────────────────────────────────
router.get('/job/:job_id', requireAuth, requireRole('client', 'admin'), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (req.user.role === 'client' && job.client_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your job' });
  }

  const { sort = 'price' } = req.query;
  const orderMap = {
    price:  'b.amount ASC',
    rating: 'cp.avg_rating DESC, b.amount ASC',
    speed:  'b.submitted_at ASC',
  };
  const orderBy = orderMap[sort] || orderMap.price;

  const bids = db.prepare(`
    SELECT b.id, b.job_id, b.cleaner_id, b.amount, b.message, b.status, b.submitted_at, b.expires_at,
           u.first_name, u.last_name, u.city, u.avatar_url,
           cp.hourly_rate, cp.avg_rating, cp.total_jobs, cp.is_verified, cp.is_pro, cp.badge_tier,
           cp.lockout_fee_enabled, cp.lockout_fee_amount
    FROM bids b
    JOIN users u ON u.id = b.cleaner_id
    JOIN cleaner_profiles cp ON cp.user_id = b.cleaner_id
    WHERE b.job_id = ? AND b.status = 'pending' AND ${BID_LIVE_SQL}
    ORDER BY ${orderBy}
  `).all(req.params.job_id).map(b => {
    // What the client would pay, with their own booking fee (8%, or 10% for businesses).
    const t = payments.bookingTotals(b.amount, job.client_id);
    return { ...b, booking_fee: t.booking_fee, fee_percent: t.fee_percent, client_total: t.total };
  });

  // Check if job is about to expire and flag it
  const hoursLeft = job.created_at
    ? Math.max(0, BID_EXPIRY_HOURS - (Date.now() - new Date(job.created_at).getTime()) / 3600000)
    : 0;

  res.json({ bids, hours_remaining: Math.round(hoursLeft), job });
});

// ─────────────────────────────────────────────────
// POST /api/bids/:bid_id/choose — client books a cleaner
// Body: { payment_method_id } — one of the client's saved cards (see routes/payments.js).
// Nothing is charged now. Inside the hold window (a few days before the clean) the
// total is held on the card straight away; otherwise the hold is placed later. The
// card is charged when the job is completed. See lib/payments.js.
// ─────────────────────────────────────────────────
router.post('/:bid_id/choose', requireAuth, requireRole('client'), paymentLimiter, async (req, res) => {
  if (!payments.paymentsReady()) return res.status(503).json(payments.PAYMENTS_OFF);
  const { payment_method_id } = req.body || {};

  const bid = db.prepare(`
    SELECT b.*, j.client_id, j.service_type, j.scheduled_at, j.address, j.status AS job_status
    FROM bids b JOIN jobs j ON j.id = b.job_id
    WHERE b.id = ? AND b.status = 'pending' AND ${BID_LIVE_SQL}
  `).get(req.params.bid_id);

  if (!bid) return res.status(404).json({ error: 'Bid not found or has expired' });
  if (bid.client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
  if (bid.job_status !== 'open') return res.status(409).json({ error: 'This job has already been booked or closed.' });
  if (!payment_method_id) return res.status(422).json({ error: 'Choose a card to book with.', code: 'CARD_REQUIRED' });

  const totals = payments.bookingTotals(bid.amount, req.user.id);
  let hold = null;

  try {
    const customerId = await payments.ensureCustomer(req.user.id);
    await payments.assertCardBelongs(customerId, payment_method_id);

    // Inside the hold window, place the hold now, while the client is here to
    // approve it with their bank if asked.
    if (payments.withinHoldWindow(bid.scheduled_at)) {
      hold = await payments.confirmOnCard({
        job: { id: bid.job_id, client_id: req.user.id, service_type: bid.service_type },
        customerId, paymentMethodId: payment_method_id, amountCents: cents(totals.total),
        manual: true, onSession: true,
        // Same bid and card → same key, so a retried request can't place a second hold.
        idempotencyKey: `booking-hold-${bid.id}-${payment_method_id}`,
      });
      if (hold.outcome === 'failed') {
        if (hold.intent) payments.releaseIntent(hold.intent.id);
        return res.status(402).json({ error: hold.error || 'Your card was declined. Try another card.', code: 'CARD_DECLINED' });
      }
    }

    // Book it only if the job is still open and this bid still pending. The Stripe
    // calls above awaited, so another request may have booked the job since.
    const holdStatus = hold ? (hold.outcome === 'authorized' ? 'authorized' : 'action_required') : 'scheduled';
    const now = new Date().toISOString();
    const booked = transaction(() => {
      const stillPending = db.prepare("SELECT 1 FROM bids WHERE id = ? AND status = 'pending'").get(bid.id);
      if (!stillPending) return false;
      const jobRes = db.prepare(`
        UPDATE jobs SET
          cleaner_id   = ?,
          status       = 'accepted',
          base_amount  = ?,
          platform_fee = ?,
          total_charged= ?,
          payment_method_id = ?,
          stripe_payment_intent_id = ?,
          auth_status  = ?,
          auth_attempts = ?,
          auth_attempted_at = CASE WHEN ? THEN datetime('now') END,
          auth_error   = ?,
          capture_status = NULL,
          updated_at   = datetime('now')
        WHERE id = ? AND status = 'open'
      `).run(bid.cleaner_id, bid.amount, totals.booking_fee, totals.total, payment_method_id,
             hold?.intent?.id || null, holdStatus, hold ? 1 : 0, hold ? 1 : 0, hold?.error || null, bid.job_id);
      if (jobRes.changes !== 1) return false;
      db.prepare("UPDATE bids SET status = 'chosen', chosen_at = ? WHERE id = ?").run(now, bid.id);
      db.prepare("UPDATE bids SET status = 'declined' WHERE job_id = ? AND id != ? AND status = 'pending'").run(bid.job_id, bid.id);
      return true;
    });

    if (!booked) {
      if (hold?.intent) payments.releaseIntent(hold.intent.id);
      return res.status(409).json({ error: 'This job has already been booked.' });
    }

    payments.setDefaultCard(customerId, payment_method_id).catch(err => console.warn('Could not set default card:', err.message));

    // No payout is created here. The cleaner's earnings are created when the job is
    // completed with its before and after photos (routes/jobs.js) — a booking-time
    // payout could be cashed out for work that never happened.

    await queueNotification(
      bid.cleaner_id,
      '🎉 You were chosen!',
      `A client chose your $${bid.amount} quote for their ${bid.service_type}. Check your schedule.`,
      'bid_chosen'
    );
    const declinedBids = db.prepare("SELECT cleaner_id FROM bids WHERE job_id = ? AND status = 'declined'").all(bid.job_id);
    for (const d of declinedBids) {
      await queueNotification(d.cleaner_id, 'Another cleaner was chosen', 'The client chose a different quote for this job. Keep bidding — your next job is out there!', 'bid_declined');
    }

    audit('BID_CHOSEN', { jobId: bid.job_id, bidId: bid.id, cleanerId: bid.cleaner_id, clientId: req.user.id, amount: bid.amount });

    res.json({
      message:       'Booking confirmed!',
      job_id:        bid.job_id,
      cleaner_id:    bid.cleaner_id,
      quote:         totals.quote,
      booking_fee:   totals.booking_fee,
      total_charged: totals.total,
      payment: {
        status: holdStatus,
        ...(holdStatus === 'action_required' && { client_secret: hold.intent?.client_secret, payment_intent_id: hold.intent?.id }),
      },
      cleaner_earns: bid.amount - (bid.success_fee ?? bid.amount * SUCCESS_FEE_PCT),
    });

  } catch (err) {
    if (err instanceof payments.PaymentError) return res.status(err.status).json({ error: err.message, code: err.code });
    // SECURITY: Never expose internal error details (Stripe messages, stack traces) to clients.
    console.error('Choose bid error:', err);
    res.status(500).json({ error: 'Booking failed. Please try again or contact support.' });
  }
});

// ─────────────────────────────────────────────────
// POST /api/bids/job/:job_id/close — client closes job (no longer needed)
// Required: client must close or choose within 48hrs or job auto-expires
// ─────────────────────────────────────────────────
router.post('/job/:job_id/close', requireAuth, requireRole('client'), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND client_id = ?').get(req.params.job_id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Closing is for a job still collecting quotes. A booked job goes through
  // /api/jobs/:id/cancel, and a finished one can't be closed at all.
  const closed = transaction(() => {
    const res1 = db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'open'").run(job.id);
    if (res1.changes !== 1) return false;
    db.prepare("UPDATE bids SET status = 'declined' WHERE job_id = ? AND status = 'pending'").run(job.id);
    return true;
  });
  if (!closed) {
    return res.status(409).json({ error: 'This job is no longer open. To cancel a booked clean, use Cancel booking instead.' });
  }

  res.json({ message: 'Job closed. All cleaners who bid have been notified.' });
});

// ─────────────────────────────────────────────────
// POST /api/bids/expire — auto-expire jobs after 48hrs (run via cron or queue)
// ─────────────────────────────────────────────────
router.post('/expire', requireAuth, requireRole('admin'), (req, res) => {
  // Expire bids past their 48hr window
  const expiredBids = db.prepare(`
    UPDATE bids SET status = 'expired'
    WHERE status = 'pending' AND julianday(expires_at) < julianday('now')
    RETURNING job_id, cleaner_id
  `).all();

  // Close jobs where all bids have expired and job is still open
  const expiredJobs = db.prepare(`
    UPDATE jobs SET status = 'cancelled'
    WHERE status = 'open'
    AND created_at < datetime('now', '-48 hours')
    AND id NOT IN (SELECT job_id FROM bids WHERE status IN ('pending','chosen'))
    RETURNING id, client_id, service_type
  `).all();

  // Notify clients their job expired
  for (const job of expiredJobs) {
    queueNotification(
      job.client_id,
      '⏰ Your job expired without a booking',
      `Your ${job.service_type} job didn't receive any bids in 48 hours. Try posting again with more flexibility on timing.`,
      'job_expired'
    );
  }

  res.json({
    expired_bids: expiredBids.length,
    expired_jobs: expiredJobs.length,
  });
});

// ─────────────────────────────────────────────────
// GET /api/bids/cleaner — cleaner's own bid history
// ─────────────────────────────────────────────────
router.get('/cleaner', requireAuth, requireRole('cleaner'), (req, res) => {
  const bids = db.prepare(`
    SELECT b.*, j.service_type, j.scheduled_at, j.address,
           u.first_name as client_first_name
    FROM bids b
    JOIN jobs j ON j.id = b.job_id
    JOIN users u ON u.id = j.client_id
    WHERE b.cleaner_id = ?
    ORDER BY b.submitted_at DESC
    LIMIT 50
  `).all(req.user.id);

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_bids,
      SUM(CASE WHEN status='chosen' THEN 1 ELSE 0 END) as won,
      SUM(CASE WHEN status='declined' THEN 1 ELSE 0 END) as lost,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status='chosen' THEN amount - success_fee ELSE 0 END) as total_earned_from_bids
    FROM bids WHERE cleaner_id = ?
  `).get(req.user.id);

  res.json({ bids, stats, win_rate: stats.total_bids > 0 ? Math.round(stats.won / stats.total_bids * 100) : 0 });
});

module.exports = router;
