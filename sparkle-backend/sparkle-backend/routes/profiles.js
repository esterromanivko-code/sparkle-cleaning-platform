'use strict';
// routes/profiles.js  — Cleaner/client profiles, services, settings
// routes/messages.js  — In-app messaging
// routes/reviews.js   — Mutual review system
// routes/payouts.js   — Cleaner earnings & cashouts

const express = require('express');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const db     = require('../db');
 const { requireAuth, requireRole } = require('../middleware/auth');
const { getStripe } = require('../lib/stripe');
const stripe = getStripe();

const router = express.Router();

// ══════════════════════════════════════════════════════
//  CLEANER PROFILE
// ══════════════════════════════════════════════════════

// GET /api/profile/cleaner/:id  — public cleaner profile (any user can view)
router.get('/cleaner/:id', (req, res) => {
  const user = db.prepare(
    'SELECT id, first_name, last_name, city, zip, created_at FROM users WHERE id = ? AND role = ?'
  ).get(req.params.id, 'cleaner');
  if (!user) return res.status(404).json({ error: 'Cleaner not found' });

  const profile = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id = ?').get(user.id);
  const services = db.prepare('SELECT service FROM cleaner_services WHERE cleaner_id = ?').all(user.id);
  const reviews  = db.prepare(`
    SELECT r.*, u.first_name, u.last_name FROM reviews r
    JOIN users u ON u.id = r.reviewer_id
    WHERE r.reviewee_id = ? ORDER BY r.created_at DESC LIMIT 10
  `).all(user.id);

  res.json({
    user:     { id: user.id, first_name: user.first_name, city: user.city, created_at: user.created_at },
    profile:  { ...profile, password_hash: undefined },
    services: services.map(s => s.service),
    reviews,
  });
});

// PUT /api/profile/cleaner  — update own cleaner profile (cleaner only)
router.put('/cleaner', requireAuth, requireRole('cleaner'), [
  body('hourly_rate').optional().isFloat({ min: 15, max: 200 }),
  body('lockout_fee_amount').optional().isFloat({ min: 0 }),
  body('lockout_grace_mins').optional().isInt({ min: 5, max: 60 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const {
    hourly_rate, bio,
    lockout_fee_enabled, lockout_fee_amount, lockout_grace_mins,
    services
  } = req.body;

  db.prepare(`
    UPDATE cleaner_profiles SET
      hourly_rate         = COALESCE(?, hourly_rate),
      bio                 = COALESCE(?, bio),
      lockout_fee_enabled = COALESCE(?, lockout_fee_enabled),
      lockout_fee_amount  = COALESCE(?, lockout_fee_amount),
      lockout_grace_mins  = COALESCE(?, lockout_grace_mins),
      updated_at          = datetime('now')
    WHERE user_id = ?
  `).run(hourly_rate||null, bio||null,
         lockout_fee_enabled!=null?lockout_fee_enabled:null,
         lockout_fee_amount||null, lockout_grace_mins||null,
         req.user.id);

  // Update services list if provided
  if (Array.isArray(services)) {
    db.prepare('DELETE FROM cleaner_services WHERE cleaner_id = ?').run(req.user.id);
    const insert = db.prepare('INSERT INTO cleaner_services (id, cleaner_id, service) VALUES (?,?,?)');
    services.forEach(s => insert.run(uuid(), req.user.id, s));
  }

  res.json({ message: 'Profile updated' });
});

// GET /api/profile/cleaners  — browse all verified cleaners (client-facing)
router.get('/cleaners', requireAuth, (req, res) => {
  const { service, min_rate, max_rate, verified_only } = req.query;

  let sql = `
    SELECT u.id, u.first_name, u.city,
           cp.hourly_rate, cp.avg_rating, cp.total_jobs,
           cp.is_verified, cp.is_pro,
           cp.lockout_fee_enabled, cp.lockout_fee_amount
    FROM users u
    JOIN cleaner_profiles cp ON cp.user_id = u.id
    WHERE u.role = 'cleaner' AND u.is_active = 1
  `;
  const params = [];
  if (verified_only === 'true') { sql += ' AND cp.is_verified = 1'; }
  if (min_rate) { sql += ' AND cp.hourly_rate >= ?'; params.push(parseFloat(min_rate)); }
  if (max_rate) { sql += ' AND cp.hourly_rate <= ?'; params.push(parseFloat(max_rate)); }
  sql += ' ORDER BY cp.is_pro DESC, cp.is_verified DESC, cp.avg_rating DESC LIMIT 50';

  let cleaners = db.prepare(sql).all(...params);

  // Filter by service if requested
  if (service) {
    const withService = db.prepare(
      'SELECT cleaner_id FROM cleaner_services WHERE service = ?'
    ).all(service).map(r => r.cleaner_id);
    cleaners = cleaners.filter(c => withService.includes(c.id));
  }

  // Attach services to each
  cleaners = cleaners.map(c => ({
    ...c,
    services: db.prepare('SELECT service FROM cleaner_services WHERE cleaner_id = ?').all(c.id).map(s=>s.service)
  }));

  res.json({ cleaners });
});

// ══════════════════════════════════════════════════════
//  CLIENT PROFILE
// ══════════════════════════════════════════════════════

router.put('/client', requireAuth, requireRole('client'), (req, res) => {
  const { default_address, home_size } = req.body;
  db.prepare(`
    UPDATE client_profiles SET
      default_address = COALESCE(?, default_address),
      home_size       = COALESCE(?, home_size),
      updated_at      = datetime('now')
    WHERE user_id = ?
  `).run(default_address||null, home_size||null, req.user.id);
  res.json({ message: 'Profile updated' });
});

// GET /api/profile/billing  — client billing methods and recent charges
router.get('/billing', requireAuth, requireRole('client'), async (req, res) => {
  const user = db.prepare(`
    SELECT id, stripe_customer_id
    FROM users
    WHERE id = ?
  `).get(req.user.id);

  const clientProfile = db.prepare(`
    SELECT default_address, home_size, is_business, business_name
    FROM client_profiles
    WHERE user_id = ?
  `).get(req.user.id);

  const paymentMethods = [];
  let defaultPaymentMethod = null;

  if (user?.stripe_customer_id) {
    try {
      const customer = await stripe.customers.retrieve(user.stripe_customer_id);
      defaultPaymentMethod = customer?.invoice_settings?.default_payment_method || null;

      const methods = await stripe.customers.listPaymentMethods(user.stripe_customer_id, { type: 'card' });
      for (const method of methods?.data || []) {
        paymentMethods.push({
          id: method.id,
          brand: method.card?.brand || 'card',
          last4: method.card?.last4 || '',
          exp_month: method.card?.exp_month || null,
          exp_year: method.card?.exp_year || null,
          fingerprint: method.card?.fingerprint || null,
        });
      }
    } catch (err) {
      console.warn('Billing lookup failed:', err.message);
    }
  }

  const history = db.prepare(`
    SELECT
      j.id,
      j.service_type,
      j.status,
      j.scheduled_at,
      j.total_charged,
      j.platform_fee,
      j.guarantee_fee,
      j.priority_fee,
      j.tip_amount,
      j.updated_at,
      u.first_name || ' ' || u.last_name AS cleaner_name
    FROM jobs j
    LEFT JOIN users u ON u.id = j.cleaner_id
    WHERE j.client_id = ?
      AND j.total_charged IS NOT NULL
    ORDER BY j.scheduled_at DESC
    LIMIT 50
  `).all(req.user.id);

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total_jobs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs,
      SUM(total_charged) AS total_spent
    FROM jobs
    WHERE client_id = ?
  `).get(req.user.id);

  res.json({
    customer_id: user?.stripe_customer_id || null,
    default_payment_method: defaultPaymentMethod,
    payment_methods: paymentMethods,
    history,
    summary: {
      total_jobs: summary?.total_jobs || 0,
      completed_jobs: summary?.completed_jobs || 0,
      total_spent: summary?.total_spent || 0,
    },
    client_profile: clientProfile || null,
  });
});

// ══════════════════════════════════════════════════════
//  MESSAGES
// ══════════════════════════════════════════════════════

// GET /api/messages/conversations  — list all conversations for current user
router.get('/messages/conversations', requireAuth, (req, res) => {
  const convos = db.prepare(`
    SELECT DISTINCT
      CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END AS other_id,
      MAX(m.sent_at) AS last_sent,
      SUM(CASE WHEN m.receiver_id = ? AND m.is_read = 0 THEN 1 ELSE 0 END) AS unread_count
    FROM messages m
    WHERE m.sender_id = ? OR m.receiver_id = ?
    GROUP BY other_id
    ORDER BY last_sent DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id);

  const enriched = convos.map(c => {
    const other = db.prepare('SELECT id, first_name, last_name, role FROM users WHERE id = ?').get(c.other_id);
    const lastMsg = db.prepare(`
      SELECT body, sent_at FROM messages
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
      ORDER BY sent_at DESC LIMIT 1
    `).get(req.user.id, c.other_id, c.other_id, req.user.id);
    return { ...c, other_user: other, last_message: lastMsg };
  });

  res.json({ conversations: enriched });
});

// GET /api/messages/:user_id  — get messages with a specific user
router.get('/messages/:userId', requireAuth, (req, res) => {
  const msgs = db.prepare(`
    SELECT m.*, u.first_name, u.last_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE (m.sender_id = ? AND m.receiver_id = ?)
       OR (m.sender_id = ? AND m.receiver_id = ?)
    ORDER BY m.sent_at ASC
    LIMIT 100
  `).all(req.user.id, req.params.userId, req.params.userId, req.user.id);

  // Mark as read
  db.prepare(`
    UPDATE messages SET is_read = 1 WHERE receiver_id = ? AND sender_id = ?
  `).run(req.user.id, req.params.userId);

  res.json({ messages: msgs });
});

// POST /api/messages  — send a message
router.post('/messages', requireAuth, [
  body('receiver_id').notEmpty(),
  body('body').trim().notEmpty().isLength({ max: 2000 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { receiver_id, body: msgBody, job_id } = req.body;

  // Make sure receiver exists and is the right role
  const receiver = db.prepare('SELECT id, role FROM users WHERE id = ?').get(receiver_id);
  if (!receiver) return res.status(404).json({ error: 'Recipient not found' });

  const id = uuid();
  db.prepare(`
    INSERT INTO messages (id, job_id, sender_id, receiver_id, body)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, job_id||null, req.user.id, receiver_id, msgBody);

  // In-app notification
  db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
    .run(uuid(), receiver_id, '💬 New message', msgBody.substring(0,80), 'message');

  res.status(201).json({ message_id: id });
});

// ══════════════════════════════════════════════════════
//  REVIEWS
// ══════════════════════════════════════════════════════

// POST /api/reviews  — submit a review (client reviews cleaner OR cleaner reviews client)
router.post('/reviews', requireAuth, [
  body('job_id').notEmpty(),
  body('reviewee_id').notEmpty(),
  body('rating').isInt({ min: 1, max: 5 }),
  body('body').optional().isLength({ max: 1000 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { job_id, reviewee_id, rating, body: reviewBody, tags } = req.body;

  // Verify the job involved both parties
  const job = db.prepare(
    'SELECT * FROM jobs WHERE id = ? AND status = ?'
  ).get(job_id, 'completed');
  if (!job) return res.status(404).json({ error: 'Job not found or not yet completed' });

  const isClient  = req.user.role === 'client'  && job.client_id  === req.user.id;
  const isCleaner = req.user.role === 'cleaner' && job.cleaner_id === req.user.id;
  if (!isClient && !isCleaner) {
    return res.status(403).json({ error: 'You were not part of this job' });
  }

  try {
    const id = uuid();
    db.prepare(`
      INSERT INTO reviews (id, job_id, reviewer_id, reviewee_id, rating, body, tags_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, job_id, req.user.id, reviewee_id, rating, reviewBody||null, tags?JSON.stringify(tags):null);

    // Recalculate average rating for reviewee
    const avgResult = db.prepare(
      'SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE reviewee_id = ?'
    ).get(reviewee_id);

    // Update the correct profile table
    const reviewee = db.prepare('SELECT role FROM users WHERE id = ?').get(reviewee_id);
    if (reviewee.role === 'cleaner') {
      db.prepare(
        'UPDATE cleaner_profiles SET avg_rating = ?, total_jobs = ? WHERE user_id = ?'
      ).run(avgResult.avg, avgResult.cnt, reviewee_id);
    } else {
      db.prepare(
        'UPDATE client_profiles SET avg_rating = ?, total_bookings = ? WHERE user_id = ?'
      ).run(avgResult.avg, avgResult.cnt, reviewee_id);
    }

    // Notify reviewee
    db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
      .run(uuid(), reviewee_id,
        `⭐ New ${rating}-star review!`,
        reviewBody ? reviewBody.substring(0,80) : 'Someone left you a review.',
        'new_review'
      );

    res.status(201).json({ review_id: id, message: 'Review submitted' });

  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'You already reviewed this job' });
    }
    throw err;
  }
});

// GET /api/reviews/:userId  — get reviews for a user
router.get('/reviews/:userId', (req, res) => {
  const reviews = db.prepare(`
    SELECT r.*, u.first_name, u.last_name, u.role AS reviewer_role
    FROM reviews r JOIN users u ON u.id = r.reviewer_id
    WHERE r.reviewee_id = ?
    ORDER BY r.created_at DESC LIMIT 50
  `).all(req.params.userId);

  const stats = db.prepare(`
    SELECT
      AVG(rating) as avg_rating,
      COUNT(*) as total,
      SUM(CASE WHEN rating=5 THEN 1 ELSE 0 END) as five,
      SUM(CASE WHEN rating=4 THEN 1 ELSE 0 END) as four,
      SUM(CASE WHEN rating=3 THEN 1 ELSE 0 END) as three,
      SUM(CASE WHEN rating=2 THEN 1 ELSE 0 END) as two,
      SUM(CASE WHEN rating=1 THEN 1 ELSE 0 END) as one
    FROM reviews WHERE reviewee_id = ?
  `).get(req.params.userId);

  res.json({ reviews, stats });
});

// ══════════════════════════════════════════════════════
//  EARNINGS / PAYOUTS (cleaner)
// ══════════════════════════════════════════════════════

// GET /api/earnings  — cleaner earnings summary
router.get('/earnings', requireAuth, requireRole('cleaner'), (req, res) => {
  const payouts = db.prepare(`
    SELECT p.*, j.service_type, j.scheduled_at
    FROM payouts p
    LEFT JOIN jobs j ON j.id = p.job_id
    WHERE p.cleaner_id = ?
    ORDER BY p.created_at DESC LIMIT 50
  `).all(req.user.id);

  const summary = db.prepare(`
    SELECT
      SUM(CASE WHEN p.created_at >= date('now','start of week') THEN p.amount ELSE 0 END) as this_week,
      SUM(CASE WHEN p.created_at >= date('now','start of month') THEN p.amount ELSE 0 END) as this_month,
      SUM(p.amount) as total_earned,
      SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END) as pending_payout
    FROM payouts p WHERE p.cleaner_id = ?
  `).get(req.user.id);

  const lockoutFees = db.prepare(`
    SELECT SUM(fee_amount) as total FROM lockout_fees
    WHERE cleaner_id = ? AND status = 'charged'
  `).get(req.user.id);

  res.json({ payouts, summary, lockout_fees_total: lockoutFees.total || 0 });
});

// POST /api/earnings/cashout  — request payout to bank
// Body: { type: 'instant' | 'standard' }
//   instant  → processed within minutes, 0 flat fee deducted from payout
//   standard → free, processed on next weekly batch (every Monday)
router.post('/earnings/cashout', requireAuth, requireRole('cleaner'), async (req, res) => {
  const { type = 'standard' } = req.body;

  if (!['instant', 'standard'].includes(type)) {
    return res.status(422).json({ error: 'type must be instant or standard' });
  }

  const profile = db.prepare(
    'SELECT stripe_connect_id FROM cleaner_profiles WHERE user_id = ?'
  ).get(req.user.id);

  if (!profile.stripe_connect_id) {
    return res.status(422).json({
      error: 'Bank account not connected. Add a payout account in your profile settings.'
    });
  }

  const pending = db.prepare(`
    SELECT SUM(amount) as total FROM payouts WHERE cleaner_id = ? AND status = 'pending'
  `).get(req.user.id);

  if (!pending.total || pending.total < 1) {
    return res.status(422).json({ error: 'No pending earnings to cash out' });
  }

  // Fee logic
  const INSTANT_FEE = parseFloat(process.env.INSTANT_CASHOUT_FEE || 10.00);
  const isInstant   = type === 'instant';
  const cashoutFee  = isInstant ? INSTANT_FEE : 0;
  const grossAmount = pending.total;
  const netAmount   = Math.max(0, grossAmount - cashoutFee);

  if (netAmount < 1) {
    return res.status(422).json({
      error: `Pending balance ($${grossAmount.toFixed(2)}) is too low to cover the instant cashout fee ($${INSTANT_FEE.toFixed(2)}). Use standard payout instead.`
    });
  }

  try {
    const stripeMethod = isInstant ? 'instant' : 'standard';

    // Transfer net amount to cleaner (after fee deduction)
    const transfer = await stripe.transfers.create({
      amount:      Math.round(netAmount * 100),
      currency:    'usd',
      destination: profile.stripe_connect_id,
      // Stripe supports instant payouts on eligible debit cards/bank accounts
      ...(isInstant && { method: 'instant' }),
      description: `Sparkle ${type} payout for cleaner ${req.user.id}`,
      metadata: {
        sparkle_user_id: req.user.id,
        type:            type,
        gross_amount:    grossAmount,
        fee_charged:     cashoutFee,
      }
    });

    // Mark all pending payouts as paid
    db.prepare(`
      UPDATE payouts SET status = 'paid', stripe_transfer_id = ?, paid_at = datetime('now')
      WHERE cleaner_id = ? AND status = 'pending'
    `).run(transfer.id, req.user.id);

    // If instant, log the fee as platform revenue
    if (isInstant && cashoutFee > 0) {
      db.prepare(`
        INSERT INTO payouts (id, cleaner_id, amount, type, status, paid_at)
        VALUES (?, ?, ?, 'instant_fee_deduction', 'paid', datetime('now'))
      `).run(require('uuid').v4(), req.user.id, -cashoutFee);
    }

    // Notify cleaner
    const eta = isInstant ? 'within minutes' : 'by next Monday';
    db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
      .run(require('uuid').v4(), req.user.id,
        '💰 Payout on the way!',
        `$${netAmount.toFixed(2)} is heading to your bank — arriving ${eta}.${isInstant ? ' ($10 instant fee applied)' : ' (Free standard payout)'}`,
        'payout_sent'
      );

    res.json({
      message:       `${isInstant ? 'Instant' : 'Standard'} payout initiated`,
      gross_amount:  grossAmount,
      fee_charged:   cashoutFee,
      net_amount:    netAmount,
      eta:           isInstant ? 'Within minutes' : 'Next Monday (free)',
      transfer_id:   transfer.id,
    });

  } catch (err) {
    console.error('Cashout error:', err);
    // If instant not supported by their bank account, fall back gracefully
    if (err.code === 'instant_payouts_unsupported') {
      return res.status(422).json({
        error: 'Instant payouts are not supported by your linked bank account. Use standard payout instead (free, every Monday).',
        fallback: 'standard'
      });
    }
    res.status(500).json({ error: 'Payout failed', detail: err.message });
  }
});

// GET /api/notifications  — get user's notifications
router.get('/notifications', requireAuth, (req, res) => {
  const notifs = db.prepare(`
    SELECT * FROM notifications WHERE user_id = ?
    ORDER BY sent_at DESC LIMIT 30
  `).all(req.user.id);
  res.json({ notifications: notifs });
});

// POST /api/notifications/:id/read
router.post('/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
