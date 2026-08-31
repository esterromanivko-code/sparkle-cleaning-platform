'use strict';
// routes/backgroundCheck.js
// Full integration: Stripe charges the $25 fee, Checkr runs the check,
// Stripe Identity verifies the ID. Webhooks update status automatically.

const express = require('express');
const axios   = require('axios');
const { v4: uuid } = require('uuid');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getStripe } = require('../lib/stripe');
const stripe = getStripe();

const router = express.Router();

const CHECKR_BASE = 'https://api.checkr.com/v1';
const CHECKR_AUTH = {
  auth: { username: process.env.CHECKR_API_KEY, password: '' }
};

// ─────────────────────────────────────────────────
// GET /api/background-check/status
// Returns the cleaner's current background check status
// ─────────────────────────────────────────────────
router.get('/status', requireAuth, requireRole('cleaner'), (req, res) => {
  const check = db.prepare(
    'SELECT * FROM background_checks WHERE cleaner_id = ? ORDER BY submitted_at DESC LIMIT 1'
  ).get(req.user.id);

  if (!check) {
    return res.json({ status: 'none', message: 'No background check submitted yet' });
  }

  res.json({
    id:               check.id,
    overall_status:   check.overall_status,
    id_status:        check.id_status,
    criminal_status:  check.criminal_status,
    submitted_at:     check.submitted_at,
    completed_at:     check.completed_at,
    expires_at:       check.expires_at,
  });
});

// ─────────────────────────────────────────────────
// POST /api/background-check/initiate
// Step 1: Charge the cleaner $25 via Stripe, then kick off
//         the Checkr candidate + Stripe Identity session.
// Body: { payment_method_id }
// ─────────────────────────────────────────────────
router.post('/initiate', requireAuth, requireRole('cleaner'), async (req, res) => {
  const { payment_method_id } = req.body;
  if (!payment_method_id) {
    return res.status(422).json({ error: 'payment_method_id is required' });
  }

  // Prevent double-submission
  const existing = db.prepare(
    `SELECT id, overall_status FROM background_checks
     WHERE cleaner_id = ? AND overall_status NOT IN ('consider','suspended')
     ORDER BY submitted_at DESC LIMIT 1`
  ).get(req.user.id);

  if (existing && existing.overall_status === 'pending') {
    return res.status(409).json({ error: 'Background check already in progress', existing });
  }
  if (existing && existing.overall_status === 'clear') {
    return res.status(409).json({ error: 'Background check already passed', existing });
  }

  const cleaner = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  try {
    // ── 1. Stripe: create or retrieve customer ────────────────────────────
    let stripeCustomerId = cleaner.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: cleaner.email,
        name:  `${cleaner.first_name} ${cleaner.last_name}`,
        metadata: { sparkle_user_id: cleaner.id, role: 'cleaner' }
      });
      stripeCustomerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?')
        .run(stripeCustomerId, cleaner.id);
    }

    // ── 2. Stripe: charge $25 ─────────────────────────────────────────────
    const paymentIntent = await stripe.paymentIntents.create({
      amount:               3000,   // $30.00
      currency:             'usd',
      customer:             stripeCustomerId,
      payment_method:       payment_method_id,
      confirm:              true,
      description:          'Sparkle background check fee',
      metadata: {
        sparkle_user_id:    cleaner.id,
        type:               'background_check'
      },
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    if (paymentIntent.status !== 'succeeded') {
      return res.status(402).json({ error: 'Payment failed', status: paymentIntent.status });
    }

    // ── 3. Checkr: create candidate ───────────────────────────────────────
    // In production Checkr sends an email to the candidate to fill in their SSN/DOB
    const candidateRes = await axios.post(`${CHECKR_BASE}/candidates`, {
      first_name: cleaner.first_name,
      last_name:  cleaner.last_name,
      email:      cleaner.email,
      phone:      cleaner.phone,
      // Checkr will collect SSN via their hosted form — you never touch SSN
    }, CHECKR_AUTH);

    const checkrCandidate = candidateRes.data;

    // ── 4. Checkr: create report (orders the actual background check) ──────
    const reportRes = await axios.post(`${CHECKR_BASE}/reports`, {
      package:      process.env.CHECKR_PACKAGE || 'tasker_standard',
      candidate_id: checkrCandidate.id,
    }, CHECKR_AUTH);

    const checkrReport = reportRes.data;

    // ── 5. Stripe Identity: create verification session (ID photo check) ──
    const identitySession = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: { sparkle_user_id: cleaner.id },
      options: {
        document: {
          require_id_number:          false,
          require_live_capture:       true,
          require_matching_selfie:    true,
          allowed_types: ['driving_license', 'passport', 'id_card'],
        }
      },
    });

    // ── 6. Save everything to the database ────────────────────────────────
    const bgCheckId = uuid();
    db.prepare(`
      INSERT INTO background_checks
        (id, cleaner_id, checkr_candidate_id, checkr_report_id,
         stripe_identity_session_id, stripe_charge_id, amount_charged)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      bgCheckId,
      cleaner.id,
      checkrCandidate.id,
      checkrReport.id,
      identitySession.id,
      paymentIntent.id,
      30.00
    );

    res.status(201).json({
      message:              'Background check initiated',
      bg_check_id:          bgCheckId,
      checkr_report_id:     checkrReport.id,
      // Return the Stripe Identity URL so the frontend can redirect for selfie/ID
      identity_session_url: identitySession.url,
      identity_client_secret: identitySession.client_secret,
      payment_intent_id:    paymentIntent.id,
    });

  } catch (err) {
    // SECURITY: Stripe/Checkr errors can contain API key hints or internal details.
    // Log internally but never send err.message to the client.
    console.error('BG check initiation error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to initiate background check. Please try again or contact support.' });
  }
});

// ─────────────────────────────────────────────────
// POST /api/background-check/webhook/checkr
// Checkr calls this automatically when a report completes.
// IMPORTANT: This URL must be registered in your Checkr dashboard.
// ─────────────────────────────────────────────────
router.post('/webhook/checkr', express.raw({ type: 'application/json' }), async (req, res) => {
  // SECURITY FIX: Always verify the Checkr webhook signature.
  // Previously only verified when CHECKR_WEBHOOK_SECRET was set AND a signature was present,
  // meaning unsigned requests were silently accepted in development/staging.
  // An attacker who found a staging URL could send fake "report.completed" events to clear
  // background checks and grant verified badges without passing any actual check.
  const crypto = require('crypto');
  const signature = req.headers['x-checkr-signature'];

  if (!process.env.CHECKR_WEBHOOK_SECRET) {
    console.error('[SECURITY] CHECKR_WEBHOOK_SECRET is not set — all Checkr webhooks rejected.');
    console.error('           Set it in your .env or Railway Variables to receive Checkr events.');
    return res.status(503).json({ error: 'Webhook not configured. Set CHECKR_WEBHOOK_SECRET.' });
  }

  if (!signature) {
    console.warn('[SECURITY] Checkr webhook received without signature — rejecting');
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  const expected = crypto
    .createHmac('sha256', process.env.CHECKR_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    console.warn('[SECURITY] Checkr webhook signature mismatch — possible forgery attempt');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('Checkr webhook received:', event.type);

  if (event.type === 'report.completed') {
    const report = event.data.object;
    const bgCheck = db.prepare(
      'SELECT * FROM background_checks WHERE checkr_report_id = ?'
    ).get(report.id);

    if (!bgCheck) {
      console.warn('No bg_check found for report:', report.id);
      return res.sendStatus(200);
    }

    // Map Checkr result → our status
    const criminalStatus = report.result === 'clear' ? 'clear' : 'consider';
    const overallStatus  = report.result === 'clear' ? 'clear' : 'consider';
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year

    db.prepare(`
      UPDATE background_checks
      SET criminal_status = ?, overall_status = ?, completed_at = ?, expires_at = ?
      WHERE id = ?
    `).run(criminalStatus, overallStatus, now, expiresAt, bgCheck.id);

    // If clear: flip verified badge on cleaner profile
    if (overallStatus === 'clear' && bgCheck.id_status === 'clear') {
      db.prepare(
        'UPDATE cleaner_profiles SET is_verified = 1, updated_at = datetime(' + "'now'" + ') WHERE user_id = ?'
      ).run(bgCheck.cleaner_id);

      // Log in-app notification
      db.prepare(`
        INSERT INTO notifications (id, user_id, title, body, type)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuid(), bgCheck.cleaner_id,
        '🛡️ Background check passed!',
        'Your Verified badge is now live on your profile. You\'ll start appearing higher in search results.',
        'bg_check_passed'
      );

      // TODO: also send email via nodemailer here
    } else if (overallStatus === 'consider') {
      db.prepare(`
        INSERT INTO notifications (id, user_id, title, body, type)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuid(), bgCheck.cleaner_id,
        '⚠️ Background check needs review',
        'Your background check returned a result that requires manual review. Our team will be in touch within 24 hours.',
        'bg_check_review'
      );
    }
  }

  res.sendStatus(200);
});

// ─────────────────────────────────────────────────
// POST /api/background-check/webhook/stripe-identity
// Stripe calls this when the ID verification session completes.
// IMPORTANT: Register this URL in your Stripe dashboard under Webhooks.
// ─────────────────────────────────────────────────
router.post('/webhook/stripe-identity', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe Identity webhook error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'identity.verification_session.verified') {
    const session = event.data.object;
    const bgCheck = db.prepare(
      'SELECT * FROM background_checks WHERE stripe_identity_session_id = ?'
    ).get(session.id);

    if (bgCheck) {
      db.prepare(
        'UPDATE background_checks SET id_status = ? WHERE id = ?'
      ).run('clear', bgCheck.id);

      // Check if both ID and criminal are now clear → activate badge
      const updated = db.prepare('SELECT * FROM background_checks WHERE id = ?').get(bgCheck.id);
      if (updated.criminal_status === 'clear' && updated.id_status === 'clear') {
        db.prepare(
          'UPDATE cleaner_profiles SET is_verified = 1, updated_at = datetime(' + "'now'" + ') WHERE user_id = ?'
        ).run(bgCheck.cleaner_id);
      }
    }
  }

  if (event.type === 'identity.verification_session.requires_input') {
    const session = event.data.object;
    const bgCheck = db.prepare(
      'SELECT * FROM background_checks WHERE stripe_identity_session_id = ?'
    ).get(session.id);
    if (bgCheck) {
      db.prepare(
        'UPDATE background_checks SET id_status = ? WHERE id = ?'
      ).run('flagged', bgCheck.id);
    }
  }

  res.sendStatus(200);
});

// ─────────────────────────────────────────────────
// GET /api/background-check/admin/queue  (admin only)
// Returns all pending/completed checks for admin review
// ─────────────────────────────────────────────────
router.get('/admin/queue', requireAuth, requireRole('admin'), (req, res) => {
  const checks = db.prepare(`
    SELECT
      bc.*,
      u.first_name, u.last_name, u.email,
      u.city, u.zip,
      cp.hourly_rate, cp.total_jobs
    FROM background_checks bc
    JOIN users u ON u.id = bc.cleaner_id
    JOIN cleaner_profiles cp ON cp.user_id = bc.cleaner_id
    ORDER BY bc.submitted_at DESC
    LIMIT 100
  `).all();

  res.json({ checks });
});

// ─────────────────────────────────────────────────
// POST /api/background-check/admin/:id/approve  (admin only)
// Manually approve a background check (e.g. after manual review)
// ─────────────────────────────────────────────────
router.post('/admin/:id/approve', requireAuth, requireRole('admin'), (req, res) => {
  const check = db.prepare('SELECT * FROM background_checks WHERE id = ?').get(req.params.id);
  if (!check) return res.status(404).json({ error: 'Check not found' });

  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE background_checks
    SET overall_status = 'clear', id_status = 'clear', criminal_status = 'clear',
        completed_at = datetime(' + "'now'" + '), expires_at = ?
    WHERE id = ?
  `).run(expiresAt, check.id);

  db.prepare(
    `UPDATE cleaner_profiles SET is_verified = 1, updated_at = datetime('now') WHERE user_id = ?`
  ).run(check.cleaner_id);

  db.prepare(`
    INSERT INTO notifications (id, user_id, title, body, type)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuid(), check.cleaner_id,
    '🛡️ Background check approved!',
    'Your Verified badge is now live. You\'ll appear higher in search results.',
    'bg_check_approved'
  );

  res.json({ message: 'Background check approved and badge activated' });
});

// ─────────────────────────────────────────────────
// POST /api/background-check/admin/:id/reject  (admin only)
// ─────────────────────────────────────────────────
router.post('/admin/:id/reject', requireAuth, requireRole('admin'), (req, res) => {
  const { reason } = req.body;
  const check = db.prepare('SELECT * FROM background_checks WHERE id = ?').get(req.params.id);
  if (!check) return res.status(404).json({ error: 'Check not found' });

  db.prepare(`
    UPDATE background_checks SET overall_status = 'suspended', completed_at = datetime(' + "'now'" + ') WHERE id = ?
  `).run(check.id);

  // Ban the cleaner from taking jobs (but don't delete their account)
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(check.cleaner_id);

  db.prepare(`
    INSERT INTO notifications (id, user_id, title, body, type)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuid(), check.cleaner_id,
    '⚠️ Background check not passed',
    reason || 'Your background check did not meet our requirements. Contact support if you have questions.',
    'bg_check_rejected'
  );

  res.json({ message: 'Background check rejected and cleaner suspended' });
});

module.exports = router;
