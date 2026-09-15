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
    'SELECT id, first_name, last_name, city, zip, avatar_url, created_at FROM users WHERE id = ? AND role = ?'
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
    user:     { id: user.id, first_name: user.first_name, city: user.city, avatar_url: user.avatar_url, created_at: user.created_at },
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
    SELECT u.id, u.first_name, u.city, u.avatar_url,
           cp.hourly_rate, cp.avg_rating, cp.total_jobs,
           cp.is_verified, cp.is_pro, cp.badge_tier,
           cp.lockout_fee_enabled, cp.lockout_fee_amount
    FROM users u
    JOIN cleaner_profiles cp ON cp.user_id = u.id
    WHERE u.role = 'cleaner' AND u.is_active = 1
  `;
  const params = [];
  if (verified_only === 'true') { sql += ' AND cp.is_verified = 1'; }
  if (min_rate) { sql += ' AND cp.hourly_rate >= ?'; params.push(parseFloat(min_rate)); }
  if (max_rate) { sql += ' AND cp.hourly_rate <= ?'; params.push(parseFloat(max_rate)); }
  // Pro members keep their paid placement, then credentials drive the order:
  // Licensed & Insured = 3 pts, a single badge = 1 pt, none = 0, plus avg rating.
  // Badge points stay in sync with TIER_POINTS in lib/badges.js.
  sql += `
    ORDER BY cp.is_pro DESC,
             (CASE cp.badge_tier
                WHEN 'licensed_and_insured' THEN 3
                WHEN 'licensed'             THEN 1
                WHEN 'insured'              THEN 1
                ELSE 0 END) + COALESCE(cp.avg_rating, 0) DESC,
             cp.is_verified DESC
    LIMIT 50`;

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

// What is cashable, what is held and why, and the cashout itself all live in
// lib/payouts.js, so these routes and the job routes can never disagree.
const payoutsLib = require('../lib/payouts');

// GET /api/earnings  — cleaner earnings summary
router.get('/earnings', requireAuth, requireRole('cleaner'), (req, res) => {
  // Voided rows (status 'failed') never count. Refund rows are negative and do.
  const payouts = db.prepare(`
    SELECT p.id, p.job_id, p.amount, p.type, p.status, p.paid_at, p.created_at, p.cashout_id,
           j.service_type, j.scheduled_at
    FROM payouts p
    LEFT JOIN jobs j ON j.id = p.job_id
    WHERE p.cleaner_id = ? AND p.status != 'failed'
    ORDER BY p.created_at DESC LIMIT 50
  `).all(req.user.id);

  // Weeks run Monday–Sunday. (SQLite has no 'start of week' modifier; it silently
  // returned NULL, which made "this week" always $0.)
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN p.created_at >= date('now','weekday 0','-6 days') THEN p.amount END), 0) AS this_week,
      COALESCE(SUM(CASE WHEN p.created_at >= date('now','start of month') THEN p.amount END), 0) AS this_month,
      COALESCE(SUM(p.amount), 0) AS total_earned
    FROM payouts p WHERE p.cleaner_id = ? AND p.status != 'failed'
  `).get(req.user.id);

  const balance = payoutsLib.balanceFor(req.user.id);
  const r2 = n => payoutsLib.dollars(payoutsLib.cents(n));

  const cashouts = db.prepare(`
    SELECT id, method, gross_amount, fee_amount, net_amount, status, instant_status, created_at, completed_at
    FROM cashouts WHERE cleaner_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(req.user.id);

  const lockoutFees = db.prepare(`
    SELECT SUM(fee_amount) as total FROM lockout_fees
    WHERE cleaner_id = ? AND status = 'charged'
  `).get(req.user.id);

  res.json({
    payouts,
    summary: {
      this_week:      r2(totals.this_week),
      this_month:     r2(totals.this_month),
      total_earned:   r2(totals.total_earned),
      pending_payout: balance.available,   // kept for older app versions: what can be cashed out now
    },
    balance,
    cashouts,
    lockout_fees_total: lockoutFees.total || 0,
  });
});

// POST /api/earnings/cashout  — send available earnings to the cleaner's bank
// Body: { type: 'instant' | 'standard' }
//   instant  → within minutes, for the INSTANT_CASHOUT_FEE
//   standard → free, 1–3 business days
router.post('/earnings/cashout', requireAuth, requireRole('cleaner'), async (req, res) => {
  const { type = 'standard' } = req.body;

  if (!['instant', 'standard'].includes(type)) {
    return res.status(422).json({ error: 'type must be instant or standard' });
  }

  try {
    const c = await payoutsLib.cashout(req.user.id, type);

    if (c.status === 'failed') {
      return res.status(502).json({
        error: "The payout couldn't be sent, so nothing left your balance. Please try again later or contact support.",
      });
    }

    const instantFellBack = c.method === 'instant' && c.instant_status === 'failed';
    const details = {
      cashout_id:     c.id,
      status:         c.status,
      gross_amount:   c.gross_amount,
      fee_charged:    instantFellBack ? 0 : c.fee_amount,
      net_amount:     c.net_amount,
      instant_status: c.instant_status,
    };

    if (c.status === 'processing') {
      return res.status(202).json({
        message: "Your payout is being processed. We'll let you know as soon as it's sent.",
        eta: 'Confirming with the bank',
        ...details,
      });
    }

    const instant = c.method === 'instant' && !instantFellBack;
    res.json({
      message:     instantFellBack
        ? "Instant payouts aren't available for your bank, so this was sent as a free standard payout."
        : `${instant ? 'Instant' : 'Standard'} payout initiated`,
      eta:         instant ? 'Within minutes' : '1–3 business days (free)',
      transfer_id: c.stripe_transfer_id,
      ...details,
    });
  } catch (err) {
    if (err instanceof payoutsLib.CashoutError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    console.error('Cashout error:', err);
    res.status(500).json({ error: 'Payout failed. Please try again.' });
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
