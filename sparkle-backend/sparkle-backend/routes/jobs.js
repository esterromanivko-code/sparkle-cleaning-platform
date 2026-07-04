'use strict';
// routes/jobs.js — Job posting, matching, accepting, lockout fees

const express = require('express');
const { v4: uuid } = require('uuid');
const { body, query, validationResult } = require('express-validator');
const db     = require('../db');
 const { requireAuth, requireRole } = require('../middleware/auth');
const { getStripe } = require('../lib/stripe');
const stripe = getStripe();

const router = express.Router();

// ─────────────────────────────────────────────────
// GET /api/jobs/available  (cleaner only)
// Returns open jobs near the cleaner that match their services
// ─────────────────────────────────────────────────
router.get('/available', requireAuth, requireRole('cleaner'), (req, res) => {
  const services = db.prepare(
    'SELECT service FROM cleaner_services WHERE cleaner_id = ?'
  ).all(req.user.id).map(s => s.service);

  // Get all open jobs (in production add distance filtering via lat/lng)
  const jobs = db.prepare(`
    SELECT j.*,
           u.first_name || ' ' || u.last_name AS client_name,
           cp.avg_rating AS client_rating,
           cp.total_bookings
    FROM jobs j
    JOIN users u ON u.id = j.client_id
    JOIN client_profiles cp ON cp.user_id = j.client_id
    WHERE j.status = 'open'
    AND j.client_id != ?
    ORDER BY j.is_priority DESC, j.created_at ASC
    LIMIT 50
  `).all(req.user.id);

  res.json({ jobs });
});

// ─────────────────────────────────────────────────
// GET /api/jobs/my-schedule  (cleaner only)
// ─────────────────────────────────────────────────
router.get('/my-schedule', requireAuth, requireRole('cleaner'), (req, res) => {
  const jobs = db.prepare(`
    SELECT j.*,
           u.first_name || ' ' || u.last_name AS client_name,
           u.phone AS client_phone,
           cp.avg_rating AS client_rating
    FROM jobs j
    JOIN users u ON u.id = j.client_id
    JOIN client_profiles cp ON cp.user_id = j.client_id
    WHERE j.cleaner_id = ?
    AND j.status IN ('accepted','in_progress')
    ORDER BY j.scheduled_at ASC
  `).all(req.user.id);

  res.json({ jobs });
});

// ─────────────────────────────────────────────────
// GET /api/jobs/my-bookings  (client only)
// ─────────────────────────────────────────────────
router.get('/my-bookings', requireAuth, requireRole('client'), (req, res) => {
  const jobs = db.prepare(`
    SELECT j.*,
           u.first_name || ' ' || u.last_name AS cleaner_name,
           cp.avg_rating AS cleaner_rating,
           cp.is_verified,
           cp.is_pro
    FROM jobs j
    LEFT JOIN users u ON u.id = j.cleaner_id
    LEFT JOIN cleaner_profiles cp ON cp.user_id = j.cleaner_id
    WHERE j.client_id = ?
    ORDER BY j.scheduled_at DESC
    LIMIT 50
  `).all(req.user.id);

  res.json({ jobs });
});

// ─────────────────────────────────────────────────
// POST /api/jobs  (client only)
// Post a new job
// ─────────────────────────────────────────────────
router.post('/', requireAuth, requireRole('client'), [
  body('service_type').notEmpty(),
  body('address').notEmpty(),
  body('scheduled_at').isISO8601(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const {
    service_type, bedrooms, bathrooms, address, city, zip,
    scheduled_at, duration_hrs, supplies_by, pets, notes,
    is_recurring, recurring_freq, is_priority, has_guarantee,
    payment_method_id
  } = req.body;

  try {
    // Calculate fees
    const hourlyRate  = 34; // In production: fetch from matched cleaner's profile
    const estimatedHrs = duration_hrs || 2.5;
    const baseAmount  = hourlyRate * estimatedHrs;
    // Fee depends on client account type (business pays 10%, regular pays 8%)
    const clientProfile = db.prepare("SELECT is_business FROM client_profiles WHERE user_id = ?").get(req.user.id);
    const feePercent = clientProfile?.is_business ? 
      parseFloat(process.env.BUSINESS_FEE_PERCENT || 10) : 
      parseFloat(process.env.PLATFORM_FEE_PERCENT || 8);
    const platformFee = baseAmount * (feePercent / 100);
    const guaranteeFee = has_guarantee ? 12.00 : 0;
    const priorityFee  = is_priority   ?  7.00 : 0;
    const totalCharged = baseAmount + platformFee + guaranteeFee + priorityFee;

    // Stripe: create payment intent (captured later when job completes)
    let paymentIntentId = null;
    if (payment_method_id) {
      const client = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.user.id);
      const pi = await stripe.paymentIntents.create({
        amount:         Math.round(totalCharged * 100),
        currency:       'usd',
        customer:       client.stripe_customer_id,
        payment_method: payment_method_id,
        capture_method: 'manual',   // authorize now, capture when job is complete
        description:    `Sparkle - ${service_type}`,
        metadata: { sparkle_user_id: req.user.id, type: 'job_payment' }
      });
      paymentIntentId = pi.id;
    }

    const id = uuid();
    db.prepare(`
      INSERT INTO jobs
        (id, client_id, service_type, bedrooms, bathrooms, address, city, zip,
         scheduled_at, duration_hrs, supplies_by, pets, notes,
         is_recurring, recurring_freq, is_priority, has_guarantee,
         base_amount, platform_fee, guarantee_fee, priority_fee, total_charged,
         stripe_payment_intent_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, req.user.id, service_type, bedrooms||null, bathrooms||null,
      address, city||null, zip||null, scheduled_at, duration_hrs||null,
      supplies_by||'client', pets||null, notes||null,
      is_recurring?1:0, recurring_freq||null, is_priority?1:0, has_guarantee?1:0,
      baseAmount, platformFee, guaranteeFee, priorityFee, totalCharged,
      paymentIntentId
    );

    // TODO: Push notification to nearby cleaners (via FCM/APNs)

    res.status(201).json({
      message:       'Job posted successfully',
      job_id:        id,
      estimated_total: totalCharged,
      payment_intent_id: paymentIntentId,
    });

  } catch (err) {
    console.error('Post job error:', err);
    res.status(500).json({ error: 'Failed to post job' });
  }
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/accept  (cleaner only)
// ─────────────────────────────────────────────────
router.post('/:id/accept', requireAuth, requireRole('cleaner'), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND status = ?').get(req.params.id, 'open');
  if (!job) return res.status(404).json({ error: 'Job not found or already taken' });

  db.prepare(`
    UPDATE jobs SET cleaner_id = ?, status = 'accepted', updated_at = datetime('now') WHERE id = ?
  `).run(req.user.id, job.id);

  // Notify client
  db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
    .run(uuid(), job.client_id,
      '🧹 Cleaner accepted your job!',
      `A cleaner has confirmed your ${job.service_type} for ${job.scheduled_at}.`,
      'job_accepted'
    );

  res.json({ message: 'Job accepted', job_id: job.id });
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/decline  (cleaner only)
// ─────────────────────────────────────────────────
router.post('/:id/decline', requireAuth, requireRole('cleaner'), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND status = ?').get(req.params.id, 'open');
  if (!job) return res.status(404).json({ error: 'Job not found or not open' });
  // Just skip — job stays open for other cleaners. Log the decline.
  res.json({ message: 'Job declined' });
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/arrive  (cleaner only)
// Cleaner marks themselves as arrived on-site
// ─────────────────────────────────────────────────
router.post('/:id/arrive', requireAuth, requireRole('cleaner'), (req, res) => {
  const job = db.prepare(
    'SELECT * FROM jobs WHERE id = ? AND cleaner_id = ? AND status = ?'
  ).get(req.params.id, req.user.id, 'accepted');

  if (!job) return res.status(404).json({ error: 'Job not found' });

  db.prepare(`UPDATE jobs SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`)
    .run(job.id);

  db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
    .run(uuid(), job.client_id,
      '🧹 Your cleaner has arrived!',
      'Your cleaner is now at your home and has started the job.',
      'cleaner_arrived'
    );

  res.json({ message: 'Arrival confirmed, job in progress' });
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/complete  (cleaner only)
// Marks job complete and triggers payment capture
// ─────────────────────────────────────────────────
router.post('/:id/complete', requireAuth, requireRole('cleaner'), async (req, res) => {
  const job = db.prepare(
    'SELECT * FROM jobs WHERE id = ? AND cleaner_id = ? AND status = ?'
  ).get(req.params.id, req.user.id, 'in_progress');

  if (!job) return res.status(404).json({ error: 'Job not found or not in progress' });

  try {
    // Capture the payment from the client
    if (job.stripe_payment_intent_id) {
      await stripe.paymentIntents.capture(job.stripe_payment_intent_id);
    }

    db.prepare(`UPDATE jobs SET status = 'completed', updated_at = datetime('now') WHERE id = ?`)
      .run(job.id);

    // Create payout record for cleaner (they earn the base amount)
    db.prepare(`
      INSERT INTO payouts (id, cleaner_id, job_id, amount, type, status)
      VALUES (?, ?, ?, ?, 'job', 'pending')
    `).run(uuid(), req.user.id, job.id, job.base_amount);

    // Notify client to leave a review
    db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
      .run(uuid(), job.client_id,
        '⭐ How was your clean?',
        'Your cleaning is complete! Leave a review to help your cleaner grow.',
        'review_prompt'
      );

    // Notify cleaner of earnings
    db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
      .run(uuid(), req.user.id,
        '💰 Job complete — payment processing',
        `$${job.base_amount} will be in your account within 24 hours.`,
        'payout_pending'
      );

    res.json({ message: 'Job completed', cleaner_earns: job.base_amount });

  } catch (err) {
    console.error('Complete job error:', err);
    res.status(500).json({ error: 'Failed to complete job' });
  }
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/cancel  (client or cleaner)
// ─────────────────────────────────────────────────
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const job = db.prepare(
    'SELECT * FROM jobs WHERE id = ? AND status IN (?,?)'
  ).get(req.params.id, 'open', 'accepted');

  if (!job) return res.status(404).json({ error: 'Job cannot be cancelled' });

  // Only client or assigned cleaner can cancel
  const isClient  = req.user.role === 'client'  && job.client_id  === req.user.id;
  const isCleaner = req.user.role === 'cleaner' && job.cleaner_id === req.user.id;
  const isAdmin   = req.user.role === 'admin';
  if (!isClient && !isCleaner && !isAdmin) {
    return res.status(403).json({ error: 'Not authorized to cancel this job' });
  }

  db.prepare(`UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`)
    .run(job.id);

  // Refund if payment was captured
  if (job.stripe_payment_intent_id) {
    try {
      await stripe.paymentIntents.cancel(job.stripe_payment_intent_id);
    } catch {
      // PI may already be captured — handle refund separately
    }
  }

  res.json({ message: 'Job cancelled' });
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/lockout-fee  (cleaner only)
// Charge a lockout fee after confirming all 5 checklist items
// Body: { checklist: [true, true, true, true, true] }
// ─────────────────────────────────────────────────
router.post('/:id/lockout-fee', requireAuth, requireRole('cleaner'), async (req, res) => {
  const { checklist } = req.body;

  // All 5 items must be confirmed true
  if (!Array.isArray(checklist) || checklist.length !== 5 || !checklist.every(Boolean)) {
    return res.status(422).json({
      error: 'All 5 lockout checklist items must be confirmed before charging the fee'
    });
  }

  const job = db.prepare(
    'SELECT * FROM jobs WHERE id = ? AND cleaner_id = ? AND status IN (?,?)'
  ).get(req.params.id, req.user.id, 'accepted', 'in_progress');

  if (!job) return res.status(404).json({ error: 'Job not found or not assigned to you' });

  // Verify lockout fee is enabled for this cleaner
  const profile = db.prepare(
    'SELECT lockout_fee_enabled, lockout_fee_amount FROM cleaner_profiles WHERE user_id = ?'
  ).get(req.user.id);

  if (!profile.lockout_fee_enabled) {
    return res.status(422).json({ error: 'You do not have lockout fee enabled on your profile' });
  }

  // Prevent double-charging
  const existing = db.prepare(
    'SELECT id FROM lockout_fees WHERE job_id = ? AND status != ?'
  ).get(job.id, 'refunded');
  if (existing) return res.status(409).json({ error: 'Lockout fee already charged for this job' });

  try {
    const feeAmount = profile.lockout_fee_amount;
    const clientUser = db.prepare(
      'SELECT stripe_customer_id FROM users WHERE id = ?'
    ).get(job.client_id);

    // Charge the lockout fee to the client's saved payment method
    let chargeId = null;
    if (clientUser.stripe_customer_id) {
      const charge = await stripe.charges.create({
        amount:      Math.round(feeAmount * 100),
        currency:    'usd',
        customer:    clientUser.stripe_customer_id,
        description: `Sparkle lockout fee - job ${job.id}`,
        metadata: { job_id: job.id, cleaner_id: req.user.id, type: 'lockout_fee' }
      });
      chargeId = charge.id;
    }

    const lockoutId = uuid();
    db.prepare(`
      INSERT INTO lockout_fees
        (id, job_id, cleaner_id, client_id, fee_amount, status, arrived_at, checklist_json, stripe_charge_id)
      VALUES (?, ?, ?, ?, ?, 'charged', datetime('now'), ?, ?)
    `).run(lockoutId, job.id, req.user.id, job.client_id, feeAmount, JSON.stringify(checklist), chargeId);

    // Create payout for the cleaner
    db.prepare(`
      INSERT INTO payouts (id, cleaner_id, job_id, lockout_fee_id, amount, type, status)
      VALUES (?, ?, ?, ?, ?, 'lockout', 'pending')
    `).run(uuid(), req.user.id, job.id, lockoutId, feeAmount);

    // Mark job as cancelled (client was a no-show)
    db.prepare(`UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`)
      .run(job.id);

    // Notify client
    db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
      .run(uuid(), job.client_id,
        '⚠️ Lockout fee charged',
        `A $${feeAmount} lockout fee was charged because your cleaner arrived but could not access your home and the appointment was not cancelled.`,
        'lockout_fee_charged'
      );

    res.json({
      message:       'Lockout fee charged successfully',
      lockout_id:    lockoutId,
      fee_amount:    feeAmount,
      stripe_charge: chargeId,
    });

  } catch (err) {
    console.error('Lockout fee error:', err);
    res.status(500).json({ error: 'Failed to charge lockout fee' });
  }
});

module.exports = router;
