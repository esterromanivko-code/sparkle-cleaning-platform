'use strict';
// routes/admin.js — Admin-only platform management
// routes/pro.js   — Sparkle Pro membership via Stripe

const express = require('express');
const { v4: uuid } = require('uuid');
const db     = require('../db');
 const { requireAuth, requireRole } = require('../middleware/auth');
const { getStripe } = require('../lib/stripe');
const { reverseJobEarnings, transaction } = require('../lib/payouts');
const { notify } = require('../lib/notify');
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
           j.service_type, j.scheduled_at, j.completed_at, j.total_charged, j.capture_status,
           (j.stripe_payment_intent_id IS NOT NULL) AS has_card_payment,
           (SELECT COUNT(*) FROM job_photos ph WHERE ph.job_id = d.job_id AND ph.deleted_at IS NULL
              AND ph.stage IN ('before','after','lockout')) AS proof_photo_count,
           (SELECT COUNT(*) FROM job_photos ph WHERE ph.dispute_id = d.id AND ph.deleted_at IS NULL) AS evidence_photo_count,
           (SELECT COALESCE(SUM(p.amount), 0) FROM payouts p WHERE p.job_id = d.job_id
              AND p.type IN ('job','lockout') AND p.status != 'failed') AS cleaner_earnings
    FROM disputes d
    JOIN users filer ON filer.id = d.filed_by
    JOIN users against ON against.id = d.against
    LEFT JOIN jobs j ON j.id = d.job_id
    ORDER BY (d.status = 'resolved'), d.created_at DESC LIMIT 100
  `).all();
  res.json({ disputes });
});

// Refund the client for a dispute ruled in their favour. Safe to call again: the
// idempotency key means Stripe refunds at most once however often it's retried.
async function issueDisputeRefund(disputeId) {
  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId);
  if (!d || !['pending', 'failed'].includes(d.refund_status)) return d?.refund_status || null;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(d.job_id);
  const setStatus = (status, refundId = null, error = null) => {
    db.prepare('UPDATE disputes SET refund_status = ?, refund_id = COALESCE(?, refund_id) WHERE id = ?').run(status, refundId, d.id);
    if (error) console.error('Dispute refund failed:', d.id, error);
    return status;
  };

  try {
    if (d.type === 'lockout_fee') {
      const fee = db.prepare(`
        SELECT * FROM lockout_fees WHERE job_id = ? AND stripe_charge_id IS NOT NULL ORDER BY created_at DESC LIMIT 1
      `).get(job.id);
      if (!fee) return setStatus('not_applicable');
      const refund = await stripe.refunds.create(
        { charge: fee.stripe_charge_id, metadata: { sparkle_dispute_id: d.id } },
        { idempotencyKey: `dispute-refund-${d.id}` });
      db.prepare("UPDATE lockout_fees SET status = 'refunded' WHERE id = ?").run(fee.id);
      return setStatus('succeeded', refund.id);
    }

    if (!job.stripe_payment_intent_id) return setStatus('not_applicable');
    if (job.capture_status !== 'captured') {
      // Never captured, so nothing was taken — releasing the authorization is the refund.
      await stripe.paymentIntents.cancel(job.stripe_payment_intent_id, {}, { idempotencyKey: `dispute-release-${d.id}` });
      return setStatus('succeeded');
    }
    const refund = await stripe.refunds.create(
      { payment_intent: job.stripe_payment_intent_id, metadata: { sparkle_dispute_id: d.id } },
      { idempotencyKey: `dispute-refund-${d.id}` });
    return setStatus('succeeded', refund.id);
  } catch (err) {
    return setStatus('failed', null, err.message);
  }
}

// POST /api/admin/disputes/:id/resolve
// Body: { ruling: 'cleaner' | 'client', resolution: 'the explanation both people see' }
// Ruling for the client refunds them (when they paid by card) and takes the
// cleaner's earnings for that job back: voided if not yet cashed out, otherwise
// deducted from the cleaner's next cashout. Ruling for the cleaner releases the hold.
router.post('/disputes/:id/resolve', requireAuth, requireRole('admin'), async (req, res) => {
  const ruling = req.body?.ruling;
  const resolution = String(req.body?.resolution || '').trim();
  if (!['cleaner', 'client'].includes(ruling)) {
    return res.status(422).json({ error: 'ruling must be cleaner or client' });
  }
  if (resolution.length < 10) {
    return res.status(422).json({ error: 'Explain the decision in at least 10 characters — both people will see it.' });
  }

  const outcome = transaction(() => {
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
    if (!d) return { status: 404, error: 'Dispute not found' };
    // Conditional update: two admins resolving at once can't both apply a ruling.
    const upd = db.prepare(`
      UPDATE disputes SET status = 'resolved', ruling = ?, resolution = ?, resolved_by = ?, resolved_at = datetime('now')
      WHERE id = ? AND status != 'resolved'
    `).run(ruling, resolution, req.user.id, d.id);
    if (upd.changes !== 1) return { status: 409, error: 'This dispute has already been resolved.' };

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(d.job_id);
    const isLockout = d.type === 'lockout_fee';
    const what = isLockout ? 'lockout fee' : `${job.service_type} on ${new Date(job.scheduled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    let earnings = null;
    let refundAmount = null;

    if (ruling === 'client') {
      earnings = reverseJobEarnings(job.id, isLockout ? ['lockout'] : ['job', 'tip'], d.id,
        isLockout ? 'lockout fee refunded after dispute' : 'refunded after dispute');
      const fee = isLockout && db.prepare(`
        SELECT * FROM lockout_fees WHERE job_id = ? AND status = 'charged' ORDER BY created_at DESC LIMIT 1
      `).get(job.id);
      const hasCardPayment = isLockout ? !!fee?.stripe_charge_id : !!job.stripe_payment_intent_id;
      refundAmount = isLockout ? fee?.fee_amount ?? null : job.total_charged;
      if (isLockout && fee && !fee.stripe_charge_id) {
        db.prepare("UPDATE lockout_fees SET status = 'refunded' WHERE id = ?").run(fee.id);
      }
      db.prepare('UPDATE disputes SET refund_status = ?, refund_amount = ? WHERE id = ?')
        .run(hasCardPayment ? 'pending' : 'not_applicable', hasCardPayment ? refundAmount : null, d.id);

      const money = n => `$${Number(n).toFixed(2)}`;
      notify(d.filed_by, '⚖️ Your report was upheld',
        `Sparkle reviewed your report about your ${what} and sided with you.` +
        (hasCardPayment && refundAmount ? ` A refund of ${money(refundAmount)} is on its way to your card.` : '') +
        ` ${resolution}`, 'dispute_resolved');
      notify(d.against, '⚖️ Dispute resolved in the client\'s favor',
        `Sparkle reviewed the client's report about your ${what} and ruled in the client's favor.` +
        (earnings.voided > 0 ? ` The ${money(earnings.voided)} for it won't be paid out.` : '') +
        (earnings.clawed_back > 0 ? ` ${money(earnings.clawed_back)} will be deducted from your next cashout.` : '') +
        ` ${resolution}`, 'dispute_resolved');
    } else {
      notify(d.filed_by, '⚖️ Your report was reviewed',
        `Sparkle reviewed your report about your ${what} and found in the cleaner's favor. ${resolution}`, 'dispute_resolved');
      notify(d.against, '⚖️ Dispute resolved in your favor',
        `Sparkle reviewed the client's report about your ${what} and ruled in your favor. ` +
        `Any earnings held for it are available to cash out now. ${resolution}`, 'dispute_resolved');
    }
    return { dispute: d, earnings };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });

  const refundStatus = ruling === 'client' ? await issueDisputeRefund(outcome.dispute.id) : null;
  res.json({
    message: refundStatus === 'failed'
      ? 'Dispute resolved, but the refund failed — use Retry refund.'
      : 'Dispute resolved',
    ruling,
    earnings:      outcome.earnings,
    refund_status: refundStatus,
  });
});

// POST /api/admin/disputes/:id/retry-refund
router.post('/disputes/:id/retry-refund', requireAuth, requireRole('admin'), async (req, res) => {
  const d = db.prepare('SELECT refund_status FROM disputes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dispute not found' });
  if (d.refund_status !== 'failed') {
    return res.status(409).json({ error: `Nothing to retry — refund status is ${d.refund_status || 'none'}.` });
  }
  const refundStatus = await issueDisputeRefund(req.params.id);
  res.status(refundStatus === 'succeeded' || refundStatus === 'not_applicable' ? 200 : 502)
    .json({ refund_status: refundStatus });
});

// POST /api/admin/jobs/:id/release-earnings
// Body: { reason }. Releases earnings held because the client's payment couldn't
// be captured (Sparkle absorbs it) or because photos are missing. Open disputes
// are released by resolving the dispute instead.
router.post('/jobs/:id/release-earnings', requireAuth, requireRole('admin'), (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) return res.status(422).json({ error: 'Give a reason for releasing these earnings.' });

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job || job.status !== 'completed') return res.status(404).json({ error: 'Completed job not found' });

  const result = db.prepare(`
    UPDATE jobs SET
      capture_status = CASE WHEN capture_status = 'failed' THEN 'waived' ELSE capture_status END,
      photos_required = CASE WHEN photos_verified_at IS NULL THEN 0 ELSE photos_required END,
      updated_at = datetime('now')
    WHERE id = ? AND (capture_status = 'failed' OR (photos_required = 1 AND photos_verified_at IS NULL))
  `).run(job.id);
  if (result.changes !== 1) return res.status(409).json({ error: 'Nothing is held on this job (open disputes are released by resolving them).' });

  console.log(`[AUDIT] Earnings released for job ${job.id} by admin ${req.user.id}: ${reason}`);
  if (job.cleaner_id) {
    notify(job.cleaner_id, '💰 Earnings released', `Your earnings for the ${job.service_type} job are available to cash out now.`, 'payout_available');
  }
  res.json({ message: 'Earnings released' });
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
