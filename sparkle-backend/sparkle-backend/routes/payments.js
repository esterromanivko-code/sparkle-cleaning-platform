'use strict';
// routes/payments.js — clients' saved cards and booking payments, cleaners' payout
// accounts, and Stripe's webhook. The rules live in lib/payments.js and lib/connect.js.

const express = require('express');
const Stripe  = require('stripe');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/security');
const { getStripe, paymentsMode, keyMode } = require('../lib/stripe');
const payments = require('../lib/payments');
const connect  = require('../lib/connect');
const { appReturnUrl } = require('../lib/frontendUrls');

const router = express.Router();

function requirePayments(req, res, next) {
  if (!payments.paymentsReady()) return res.status(503).json(payments.PAYMENTS_OFF);
  next();
}

// A PaymentError goes back as its own status and message; anything else is logged
// and replaced with a generic message, so Stripe's internals never reach the browser.
function fail(res, err, fallback) {
  if (err instanceof payments.PaymentError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`[PAYMENTS] ${fallback}:`, err);
  res.status(500).json({ error: fallback });
}

const customerIdOf = userId => db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(userId)?.stripe_customer_id || null;

// ═════════════════════════════════════════════════════
//  SAVED CARDS (clients)
// ═════════════════════════════════════════════════════

router.get('/methods', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const customerId = customerIdOf(req.user.id);
    const cards = payments.paymentsReady() && customerId
      ? await payments.listCards(customerId)
      : { cards: [], default_payment_method: null };
    res.json({ ...cards, mode: paymentsMode() });
  } catch (err) { fail(res, err, 'Could not load your cards'); }
});

// Starts Stripe's card form. The card is saved to the client's Stripe customer when
// the browser confirms it — the card number goes to Stripe, never to Sparkle.
router.post('/setup-intent', requireAuth, requireRole('client'), paymentLimiter, requirePayments, async (req, res) => {
  try {
    const customerId = await payments.ensureCustomer(req.user.id);
    const intent = await getStripe().setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      payment_method_types: ['card'],
      metadata: { sparkle_user_id: req.user.id },
    });
    res.json({ client_secret: intent.client_secret, mode: paymentsMode() });
  } catch (err) { fail(res, err, 'Could not start adding a card'); }
});

router.post('/methods/:id/default', requireAuth, requireRole('client'), paymentLimiter, requirePayments, async (req, res) => {
  try {
    const customerId = await payments.ensureCustomer(req.user.id);
    await payments.assertCardBelongs(customerId, req.params.id);
    await payments.setDefaultCard(customerId, req.params.id);
    res.json({ message: 'Default card updated' });
  } catch (err) { fail(res, err, 'Could not update your default card'); }
});

router.delete('/methods/:id', requireAuth, requireRole('client'), paymentLimiter, requirePayments, async (req, res) => {
  try {
    const customerId = await payments.ensureCustomer(req.user.id);
    await payments.assertCardBelongs(customerId, req.params.id);
    const inUse = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE client_id = ? AND payment_method_id = ?
        AND (status IN ('accepted','in_progress') OR (status = 'completed' AND capture_status IN ('failed','processing')))
    `).get(req.user.id, req.params.id).n;
    if (inUse) {
      return res.status(409).json({
        error: 'This card is paying for an upcoming or unpaid clean. Add another card and use it for that booking first.',
        code: 'CARD_IN_USE',
      });
    }
    await getStripe().paymentMethods.detach(req.params.id);
    res.json({ message: 'Card removed' });
  } catch (err) { fail(res, err, 'Could not remove the card'); }
});

// ═════════════════════════════════════════════════════
//  PAYING FOR A BOOKING (clients)
// ═════════════════════════════════════════════════════

// Body: { payment_method_id }. Resolves to { outcome } — authorized | scheduled |
// captured | processing | failed (with error) | action_required (with
// client_secret and payment_intent_id: the browser asks the bank, then calls /confirm).
router.post('/jobs/:id/pay', requireAuth, requireRole('client'), paymentLimiter, requirePayments, async (req, res) => {
  try {
    res.json(await payments.payForJob(req.params.id, req.user.id, req.body?.payment_method_id));
  } catch (err) { fail(res, err, 'Payment failed. Please try again.'); }
});

// After the client approves a payment with their bank in the browser.
router.post('/jobs/:id/pay/confirm', requireAuth, requireRole('client'), requirePayments, async (req, res) => {
  const intentId = req.body?.payment_intent_id;
  if (typeof intentId !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(intentId)) {
    return res.status(422).json({ error: 'payment_intent_id is required' });
  }
  try {
    const job = db.prepare('SELECT id, client_id FROM jobs WHERE id = ?').get(req.params.id);
    if (!job || job.client_id !== req.user.id) return res.status(404).json({ error: 'Booking not found' });
    const stripe = getStripe();
    // Locally there's no bank to approve anything; this stands in for Stripe.js.
    if (paymentsMode() === 'mock' && stripe._mock) stripe._mock.clientConfirm(intentId);
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (intent.metadata?.sparkle_job_id !== job.id) return res.status(404).json({ error: 'Payment not found' });
    const outcome = await payments.syncPaymentIntent(intent);
    res.json({
      outcome,
      ...(intent.status === 'requires_payment_method' && { error: intent.last_payment_error?.message || "The payment wasn't approved." }),
    });
  } catch (err) { fail(res, err, 'Could not confirm the payment'); }
});

// ═════════════════════════════════════════════════════
//  PAYOUT ACCOUNTS (cleaners)
// ═════════════════════════════════════════════════════

router.get('/connect/status', requireAuth, requireRole('cleaner'), async (req, res) => {
  try {
    let status = connect.payoutAccountStatus(req.user.id);
    // Until payouts work, ask Stripe each time: the cleaner may just have finished setup.
    if (status.state !== 'not_started' && (!status.payouts_enabled || req.query.refresh === '1') && payments.paymentsReady()) {
      try {
        status = await connect.syncConnectAccount(req.user.id);
      } catch (err) {
        console.warn('[CONNECT] Could not refresh account status:', err.message);
      }
    }
    res.json({ ...status, mode: paymentsMode() });
  } catch (err) { fail(res, err, 'Could not load your payout account'); }
});

// Body: { return_to } — the app page to come back to (only Sparkle's own hosts are used).
router.post('/connect/onboard', requireAuth, requireRole('cleaner'), paymentLimiter, requirePayments, async (req, res) => {
  try {
    res.json({ url: await connect.onboardingLink(req.user.id, appReturnUrl(req.body?.return_to)) });
  } catch (err) { fail(res, err, "Couldn't open payout setup. Please try again."); }
});

router.post('/connect/dashboard', requireAuth, requireRole('cleaner'), paymentLimiter, requirePayments, async (req, res) => {
  try {
    res.json({ url: await connect.dashboardLink(req.user.id) });
  } catch (err) { fail(res, err, "Couldn't open your payout account. Please try again."); }
});

// ═════════════════════════════════════════════════════
//  STRIPE WEBHOOK — POST /api/payments/webhook
// ═════════════════════════════════════════════════════
// Stripe → Developers → Webhooks → Add endpoint, pointed at this URL:
//   • Events on your account: payment_intent.succeeded, payment_intent.amount_capturable_updated,
//     payment_intent.processing, payment_intent.payment_failed, payment_intent.canceled
//     → its signing secret is STRIPE_WEBHOOK_SECRET
//   • Events on connected accounts: account.updated
//     → its signing secret is STRIPE_CONNECT_WEBHOOK_SECRET
// Everything still works without webhooks (the app asks Stripe directly); they
// make updates arrive sooner. The raw body is kept by server.js for the signature.
router.post('/webhook', async (req, res) => {
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET]
    .map(s => String(s || '').trim())
    .filter(s => /^whsec_[A-Za-z0-9]{16,}$/.test(s));
  if (!secrets.length) return res.status(503).json({ error: 'Stripe webhooks are not configured' });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Expected the raw request body' });

  let event = null;
  for (const secret of secrets) {
    try {
      event = Stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
      break;
    } catch { /* not signed with this secret */ }
  }
  if (!event) return res.status(400).json({ error: 'Invalid signature' });
  // A test-mode event must never change live data, or the other way round.
  if (event.livemode !== (keyMode() === 'live')) return res.json({ received: true, ignored: 'mode' });

  const fresh = db.prepare('INSERT OR IGNORE INTO stripe_events (id, type) VALUES (?, ?)').run(event.id, event.type).changes === 1;
  if (!fresh) return res.json({ received: true, duplicate: true });

  try {
    await handleEvent(event);
    res.json({ received: true });
  } catch (err) {
    db.prepare('DELETE FROM stripe_events WHERE id = ?').run(event.id);   // so Stripe's retry is handled
    console.error('[STRIPE WEBHOOK] Failed to handle', event.type, event.id, err.message);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
});

async function handleEvent(event) {
  const stripe = getStripe();
  const obj = event.data?.object;
  // Events can arrive late or out of order, so the object is always read fresh.
  if (event.type.startsWith('payment_intent.') && !event.account) {
    if (obj?.metadata?.kind !== 'job_payment') return;
    await payments.syncPaymentIntent(await stripe.paymentIntents.retrieve(obj.id));
  } else if (event.type === 'account.updated' && obj?.id) {
    connect.applyAccount(await stripe.accounts.retrieve(obj.id));
  }
}

module.exports = router;
