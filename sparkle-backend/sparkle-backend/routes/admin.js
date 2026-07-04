'use strict';
// routes/admin.js — Admin-only platform management
// routes/pro.js   — Sparkle Pro membership via Stripe

const express = require('express');
const { v4: uuid } = require('uuid');
const db     = require('../db');
 const { requireAuth, requireRole } = require('../middleware/auth');
const { getStripe } = require('../lib/stripe');
const stripe = getStripe();

const router = express.Router();

// ══════════════════════════════════════════════════════
//  ADMIN ROUTES  — all require role: admin
// ══════════════════════════════════════════════════════

// GET /api/admin/dashboard — platform stats
router.get('/dashboard', requireAuth, requireRole('admin'), (req, res) => {
  const stats = {
    users: db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN role='cleaner' THEN 1 ELSE 0 END) as cleaners,
        SUM(CASE WHEN role='client' THEN 1 ELSE 0 END) as clients,
        SUM(CASE WHEN is_flagged=1 THEN 1 ELSE 0 END) as flagged,
        SUM(CASE WHEN is_active=0 THEN 1 ELSE 0 END) as banned
      FROM users WHERE role != 'admin'
    `).get(),

    jobs: db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN created_at >= date('now','start of month') THEN 1 ELSE 0 END) as this_month
      FROM jobs
    `).get(),

    revenue: db.prepare(`
      SELECT
        SUM(platform_fee) as platform_fees,
        SUM(guarantee_fee) as guarantee_fees,
        SUM(priority_fee) as priority_fees,
        SUM(platform_fee + guarantee_fee + priority_fee) as total
      FROM jobs WHERE status = 'completed'
    `).get(),

    bgchecks: db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN overall_status='pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN overall_status='clear' THEN 1 ELSE 0 END) as cleared,
        SUM(CASE WHEN overall_status='consider' THEN 1 ELSE 0 END) as needs_review
      FROM background_checks
    `).get(),

    disputes: db.prepare(`
      SELECT COUNT(*) as open FROM disputes WHERE status != 'resolved'
    `).get(),

    pro_members: db.prepare(`
      SELECT COUNT(*) as active FROM pro_memberships WHERE status = 'active'
    `).get(),
  };

  res.json({ stats });
});

// GET /api/admin/users — list users with filters
router.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  const { role, status, search, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let sql = `
    SELECT u.id, u.role, u.first_name, u.last_name, u.email, u.phone,
           u.is_active, u.is_flagged, u.created_at,
           COALESCE(cp.avg_rating, clp.avg_rating) as avg_rating,
           COALESCE(cp.total_jobs, clp.total_bookings) as total_activity,
           COALESCE(cp.is_verified, 0) as is_verified
    FROM users u
    LEFT JOIN cleaner_profiles cp ON cp.user_id = u.id AND u.role = 'cleaner'
    LEFT JOIN client_profiles clp ON clp.user_id = u.id AND u.role = 'client'
    WHERE u.role != 'admin'
  `;
  const params = [];

  if (role)   { sql += ' AND u.role = ?'; params.push(role); }
  if (status === 'banned')  { sql += ' AND u.is_active = 0'; }
  if (status === 'flagged') { sql += ' AND u.is_flagged = 1'; }
  if (search) { sql += ' AND (u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)'; params.push(`%${search}%`,`%${search}%`,`%${search}%`); }

  sql += ` ORDER BY u.created_at DESC LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), offset);

  const users = db.prepare(sql).all(...params);
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role != 'admin'`).get();

  res.json({ users, total: total.cnt, page: parseInt(page), limit: parseInt(limit) });
});

// POST /api/admin/users/:id/ban
router.post('/users/:id/ban', requireAuth, requireRole('admin'), (req, res) => {
  const { reason } = req.body;
  // SECURITY: Prevent admins from banning other admin accounts or themselves.
  const target = db.prepare('SELECT role FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') return res.status(403).json({ error: 'Admin accounts cannot be banned through this interface' });
  if (req.params.id === req.user.id) return res.status(403).json({ error: 'You cannot ban your own account' });

  db.prepare('UPDATE users SET is_active = 0, updated_at = datetime(' + "'now'" + ') WHERE id = ?').run(req.params.id);
  db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
    .run(uuid(), req.params.id, '⚠️ Account suspended',
      reason || 'Your account has been suspended. Contact support to appeal.',
      'account_banned');
  res.json({ message: 'User banned' });
});

// POST /api/admin/users/:id/reinstate
router.post('/users/:id/reinstate', requireAuth, requireRole('admin'), (req, res) => {
  db.prepare('UPDATE users SET is_active = 1, is_flagged = 0, updated_at = datetime(' + "'now'" + ') WHERE id = ?').run(req.params.id);
  db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
    .run(uuid(), req.params.id, '✅ Account reinstated', 'Your account has been reinstated. Welcome back!', 'account_reinstated');
  res.json({ message: 'User reinstated' });
});

// POST /api/admin/users/:id/flag
router.post('/users/:id/flag', requireAuth, requireRole('admin'), (req, res) => {
  db.prepare('UPDATE users SET is_flagged = 1 WHERE id = ?').run(req.params.id);
  res.json({ message: 'User flagged for review' });
});

// GET /api/admin/disputes
router.get('/disputes', requireAuth, requireRole('admin'), (req, res) => {
  const disputes = db.prepare(`
    SELECT d.*,
           filer.first_name || ' ' || filer.last_name AS filed_by_name, filer.role AS filed_by_role,
           against.first_name || ' ' || against.last_name AS against_name, against.role AS against_role,
           j.service_type, j.scheduled_at
    FROM disputes d
    JOIN users filer ON filer.id = d.filed_by
    JOIN users against ON against.id = d.against
    LEFT JOIN jobs j ON j.id = d.job_id
    ORDER BY d.created_at DESC LIMIT 100
  `).all();
  res.json({ disputes });
});

// POST /api/admin/disputes/:id/resolve
router.post('/disputes/:id/resolve', requireAuth, requireRole('admin'), (req, res) => {
  const { resolution, ruling } = req.body; // ruling: 'cleaner' | 'client'
  const dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

  db.prepare(`
    UPDATE disputes SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(resolution, req.user.id, dispute.id);

  // Notify both parties
  [dispute.filed_by, dispute.against].forEach(userId => {
    db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
      .run(uuid(), userId, '⚖️ Dispute resolved', resolution, 'dispute_resolved');
  });

  // If lockout fee dispute and ruling is 'client' → refund the fee
  if (dispute.type === 'lockout_fee' && ruling === 'client') {
    const lockout = db.prepare('SELECT * FROM lockout_fees WHERE job_id = ?').get(dispute.job_id);
    if (lockout?.stripe_charge_id) {
      stripe.refunds.create({ charge: lockout.stripe_charge_id }).catch(console.error);
      db.prepare('UPDATE lockout_fees SET status = ? WHERE id = ?').run('refunded', lockout.id);
    }
  }

  res.json({ message: 'Dispute resolved' });
});

// POST /api/admin/notify — send platform-wide push notification
router.post('/notify', requireAuth, requireRole('admin'), (req, res) => {
  const { audience, title, body: notifBody, type } = req.body;
  if (!title || !notifBody) return res.status(422).json({ error: 'title and body required' });

  let users = [];
  if (audience === 'all')             users = db.prepare("SELECT id FROM users WHERE is_active=1 AND role!='admin'").all();
  else if (audience === 'cleaners')   users = db.prepare("SELECT id FROM users WHERE role='cleaner' AND is_active=1").all();
  else if (audience === 'clients')    users = db.prepare("SELECT id FROM users WHERE role='client' AND is_active=1").all();
  else if (audience === 'unverified') users = db.prepare(`
    SELECT u.id FROM users u JOIN cleaner_profiles cp ON cp.user_id = u.id
    WHERE u.role='cleaner' AND cp.is_verified=0 AND u.is_active=1`).all();

  const insert = db.prepare('INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)');
  users.forEach(u => insert.run(uuid(), u.id, title, notifBody, type||'platform'));

  res.json({ message: `Notification sent to ${users.length} users` });
});

// GET /api/admin/revenue — full revenue breakdown
router.get('/revenue', requireAuth, requireRole('admin'), (req, res) => {
  const revenue = db.prepare(`
    SELECT
      SUM(platform_fee)                           as platform_fees,
      SUM(guarantee_fee)                          as guarantee_fees,
      SUM(priority_fee)                           as priority_fees,
      SUM(platform_fee+guarantee_fee+priority_fee) as total_revenue,
      COUNT(DISTINCT client_id)                   as unique_clients,
      COUNT(*)                                    as total_jobs
    FROM jobs WHERE status = 'completed'
  `).get();

  const proRevenue = db.prepare(`
    SELECT COUNT(*) as active_members FROM pro_memberships WHERE status='active'
  `).get();

  const bgRevenue = db.prepare(`
    SELECT COUNT(*) as total, SUM(amount_charged) as revenue
    FROM background_checks WHERE stripe_charge_id IS NOT NULL
  `).get();

  const insuranceRevenue = db.prepare(`
    SELECT 0 as revenue
  `).get(); // Track manually or via affiliate API

  res.json({ revenue, pro: proRevenue, background_checks: bgRevenue, insurance: insuranceRevenue });
});

// ══════════════════════════════════════════════════════
//  PRO MEMBERSHIP ROUTES
// ══════════════════════════════════════════════════════

// POST /api/pro/subscribe  — cleaner subscribes to Pro
router.post('/pro/subscribe', requireAuth, requireRole('cleaner'), async (req, res) => {
  const { plan, payment_method_id } = req.body; // plan: 'monthly' | 'annual'
  if (!['monthly','annual'].includes(plan)) {
    return res.status(422).json({ error: 'plan must be monthly or annual' });
  }

  const cleaner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  try {
    // Create or get Stripe customer
    let customerId = cleaner.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: cleaner.email,
        name: `${cleaner.first_name} ${cleaner.last_name}`,
        payment_method: payment_method_id,
        invoice_settings: { default_payment_method: payment_method_id },
        metadata: { sparkle_user_id: cleaner.id }
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, cleaner.id);
    }

    // Create the Stripe subscription
    const priceId = plan === 'monthly'
      ? process.env.STRIPE_PRO_MONTHLY_PRICE_ID   // set this in Stripe dashboard
      : process.env.STRIPE_PRO_ANNUAL_PRICE_ID;

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      expand: ['latest_invoice.payment_intent'],
      metadata: { sparkle_user_id: cleaner.id, plan }
    });

    const expiresAt = new Date(subscription.current_period_end * 1000).toISOString();

    // Save to DB
    db.prepare(`
      INSERT INTO pro_memberships (id, cleaner_id, plan, stripe_subscription_id, stripe_customer_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuid(), cleaner.id, plan, subscription.id, customerId, expiresAt);

    // Activate Pro on profile
    db.prepare(`
      UPDATE cleaner_profiles SET is_pro = 1, pro_expires_at = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(expiresAt, cleaner.id);

    db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
      .run(uuid(), cleaner.id, '⭐ Welcome to Sparkle Pro!',
        'Your Pro badge is live and you now get priority job notifications.', 'pro_activated');

    res.status(201).json({ message: 'Pro membership activated', expires_at: expiresAt });

  } catch (err) {
    // SECURITY: Never expose Stripe error messages to clients — they can contain
    // API key hints, charge IDs, or internal system details.
    console.error('Pro subscribe error:', err);
    res.status(500).json({ error: 'Subscription failed. Please try again or contact support.' });
  }
});

// DELETE /api/pro/cancel
router.delete('/pro/cancel', requireAuth, requireRole('cleaner'), async (req, res) => {
  const membership = db.prepare(
    "SELECT * FROM pro_memberships WHERE cleaner_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
  ).get(req.user.id);

  if (!membership) return res.status(404).json({ error: 'No active Pro membership' });

  await stripe.subscriptions.cancel(membership.stripe_subscription_id);

  db.prepare(`
    UPDATE pro_memberships SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?
  `).run(membership.id);

  db.prepare(`
    UPDATE cleaner_profiles SET is_pro = 0, updated_at = datetime('now') WHERE user_id = ?
  `).run(req.user.id);

  res.json({ message: 'Pro membership cancelled. It remains active until the end of the billing period.' });
});

module.exports = router;
