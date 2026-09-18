'use strict';
// lib/payments.js — charging clients. (Paying cleaners is lib/payouts.js; their
// payout accounts are lib/connect.js.)
//
// How a booking is paid:
//   1. Book — the client chooses a quote and one of their saved cards. A new card
//      is saved first through Stripe's card form (a SetupIntent), so card numbers
//      never reach Sparkle's servers. Nothing is charged.
//   2. Hold — the total is authorized on the card within HOLD_WINDOW_DAYS of the
//      clean: straight away when booking inside that window, otherwise by the sweep
//      below. A hold only lasts about 7 days, so one placed at booking for a clean
//      weeks away would lapse first.
//   3. Charge — completing the job with its photos captures the hold. If there is
//      no live hold (it lapsed, or was never placed) the saved card is charged.
//   4. Problems — a declined card, or a bank that wants the cardholder to approve
//      the payment (3-D Secure), is flagged on the booking and the client is asked
//      to fix it in My bookings. Until a completed job is paid, the cleaner's
//      earnings for it are held (the 'payment' hold in lib/payouts.js).
//
// Money safety: every call that can move money has an idempotency key, and every
// PaymentIntent names its job in metadata, so a payment whose result was lost is
// found again (findJobPayment) rather than taken twice.

const db = require('../db');
const { getStripe, paymentsMode } = require('./stripe');
const { notify, notifyAdmins } = require('./notify');
const { cents, dollars, transaction, isDefinitiveStripeError } = require('./payouts');

const HOLD_WINDOW_DAYS = 5;
const HOLD_RETRY_HOURS = 12;
const MAX_HOLD_ATTEMPTS = 3;     // card networks penalise retrying a declined card over and over
const MIN_CHARGE_CENTS = 50;     // Stripe's minimum for a USD charge

class PaymentError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const PAYMENTS_OFF = { error: "Card payments aren't set up yet. Please try again later.", code: 'PAYMENTS_UNAVAILABLE' };
const paymentsReady = () => paymentsMode() !== 'off';
const idOf = v => (v && typeof v === 'object' ? v.id : v) || null;

function withinHoldWindow(scheduledAt) {
  const t = Date.parse(scheduledAt);
  return !Number.isFinite(t) || t - Date.now() <= HOLD_WINDOW_DAYS * 86400000;
}

// A client pays the quote plus Sparkle's booking fee: 8%, or 10% for business accounts.
function bookingTotals(quote, clientId) {
  const business = !!db.prepare('SELECT is_business FROM client_profiles WHERE user_id = ?').get(clientId)?.is_business;
  const percent = parseFloat(business ? process.env.BUSINESS_FEE_PERCENT || 10 : process.env.PLATFORM_FEE_PERCENT || 8);
  const quoteCents = cents(quote);
  const feeCents = Math.round(quoteCents * percent / 100);
  return { quote: dollars(quoteCents), fee_percent: percent, booking_fee: dollars(feeCents), total: dollars(quoteCents + feeCents) };
}

function jobForPayment(jobId) {
  return db.prepare(`
    SELECT j.*, u.stripe_customer_id FROM jobs j JOIN users u ON u.id = j.client_id WHERE j.id = ?
  `).get(jobId);
}

const describe = job => `Sparkle ${job.service_type || 'cleaning'}`.slice(0, 120);
const jobMetadata = job => ({ sparkle_job_id: job.id, sparkle_client_id: job.client_id, kind: 'job_payment' });
const pacificDate = iso => {
  const d = new Date(iso);
  return isNaN(d) ? 'your booked day' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
};

// ── Customers and saved cards ───────────────────────────────────────────────

async function ensureCustomer(userId) {
  const user = db.prepare('SELECT id, email, first_name, last_name, stripe_customer_id FROM users WHERE id = ?').get(userId);
  if (!user) throw new PaymentError(404, 'Account not found', 'NOT_FOUND');
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await getStripe().customers.create({
    email: user.email,
    name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || undefined,
    metadata: { sparkle_user_id: user.id },
  }, { idempotencyKey: `customer-${user.id}` });
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL').run(customer.id, user.id);
  return db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(user.id).stripe_customer_id;
}

async function listCards(customerId) {
  if (!customerId) return { cards: [], default_payment_method: null };
  const stripe = getStripe();
  const [customer, methods] = await Promise.all([
    stripe.customers.retrieve(customerId),
    stripe.customers.listPaymentMethods(customerId, { type: 'card', limit: 20 }),
  ]);
  const cards = (methods?.data || []).map(m => ({
    id: m.id,
    brand: m.card?.brand || 'card',
    last4: m.card?.last4 || '',
    exp_month: m.card?.exp_month || null,
    exp_year: m.card?.exp_year || null,
  }));
  let defaultId = idOf(customer?.invoice_settings?.default_payment_method);
  if (!cards.some(c => c.id === defaultId)) defaultId = cards[0]?.id || null;
  return { cards, default_payment_method: defaultId };
}

// Throws unless the card is saved on this customer — a client can't pay with, or
// even detect, anyone else's card.
async function assertCardBelongs(customerId, paymentMethodId) {
  if (typeof paymentMethodId !== 'string' || !/^pm_[A-Za-z0-9_]{3,}$/.test(paymentMethodId)) {
    throw new PaymentError(422, 'Choose a card to pay with.', 'CARD_REQUIRED');
  }
  const stripe = getStripe();
  let method;
  try {
    method = await stripe.paymentMethods.retrieve(paymentMethodId);
  } catch (err) {
    if (err?.type === 'StripeInvalidRequestError') throw new PaymentError(422, "That card couldn't be found. Please add it again.", 'CARD_NOT_FOUND');
    throw err;
  }
  const owner = idOf(method.customer);
  // Locally there is no Stripe card form; a test card id stands in for one just saved.
  if (!owner && paymentsMode() === 'mock') {
    await stripe.paymentMethods.attach(method.id, { customer: customerId });
    return method;
  }
  if (owner !== customerId) throw new PaymentError(422, "That card couldn't be found. Please add it again.", 'CARD_NOT_FOUND');
  return method;
}

async function setDefaultCard(customerId, paymentMethodId) {
  await getStripe().customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
}

// ── Confirming a payment on a saved card ────────────────────────────────────

// What a PaymentIntent's status means for a booking.
function intentOutcome(intent) {
  switch (intent?.status) {
    case 'requires_capture':      return 'authorized';
    case 'succeeded':             return 'captured';
    case 'processing':            return 'processing';
    case 'requires_action':
    case 'requires_confirmation': return 'action_required';
    default:                      return 'failed';
  }
}

// Creates and confirms a PaymentIntent on a saved card: a hold (manual capture) or
// a charge. Resolves to { outcome, intent, error } for any answer Stripe gives;
// throws only when the answer was lost, so the caller retries with the same key.
async function confirmOnCard({ job, customerId, paymentMethodId, amountCents, manual, onSession, idempotencyKey, metadata }) {
  const params = {
    amount: amountCents,
    currency: 'usd',
    customer: customerId,
    payment_method: paymentMethodId,
    payment_method_types: ['card'],
    capture_method: manual ? 'manual' : 'automatic',
    confirm: true,
    description: describe(job),
    metadata: metadata || jobMetadata(job),
  };
  // With the client present, their bank can ask them to approve it (3-D Secure) in
  // the browser. Without them, a bank that insists makes the payment fail instead.
  if (onSession) params.use_stripe_sdk = true;
  else params.off_session = true;

  try {
    const intent = await getStripe().paymentIntents.create(params, { idempotencyKey });
    return { outcome: intentOutcome(intent), intent };
  } catch (err) {
    if (err?.type === 'StripeCardError') {
      const needsApproval = err.code === 'authentication_required';
      return {
        outcome: needsApproval ? 'action_required' : 'failed',
        intent: err.payment_intent || null,
        error: needsApproval ? 'Your bank needs you to approve this payment.' : (err.message || 'Your card was declined.'),
      };
    }
    if (isDefinitiveStripeError(err) && err.type !== 'StripeRateLimitError') {
      console.error('[PAYMENTS] Stripe refused a payment for job', job.id, err.message);
      return { outcome: 'failed', intent: null, error: "The card couldn't be charged.", internal: err.message };
    }
    throw err;
  }
}

// Releases a hold or an unfinished payment. Never throws: a hold that can't be
// released lapses by itself within 7 days.
async function releaseIntent(intentId) {
  if (!intentId) return;
  try {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (['requires_capture', 'requires_action', 'requires_confirmation', 'requires_payment_method'].includes(intent.status)) {
      await stripe.paymentIntents.cancel(intentId, {}, { idempotencyKey: `release-${intentId}` });
    }
  } catch (err) {
    console.warn('[PAYMENTS] Could not release', intentId, err.message);
  }
}

// A payment for this job that went through (or is holding money) but may not be
// recorded — the answer to an earlier request was lost.
async function findJobPayment(job) {
  if (!job.stripe_customer_id) return null;
  const created = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(job.created_at || '') ? `${job.created_at.replace(' ', 'T')}Z` : job.created_at);
  const list = await getStripe().paymentIntents.list({
    customer: job.stripe_customer_id,
    limit: 100,
    ...(Number.isFinite(created) && { created: { gte: Math.floor(created / 1000) - 86400 } }),
  });
  return (list?.data || []).find(pi => pi.metadata?.sparkle_job_id === job.id && pi.metadata?.kind === 'job_payment'
    && ['succeeded', 'requires_capture', 'processing'].includes(pi.status)) || null;
}

// ── Holds ───────────────────────────────────────────────────────────────────

async function recordHold(job, { outcome, intent, error, internal }) {
  const status = outcome === 'authorized' ? 'authorized' : outcome === 'action_required' ? 'action_required' : 'failed';
  const kept = transaction(() => db.prepare(`
    UPDATE jobs SET auth_status = ?, stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id), auth_error = ?,
           auth_attempted_at = datetime('now'), auth_attempts = auth_attempts + 1
    WHERE id = ? AND status IN ('accepted','in_progress')
  `).run(status, intent?.id || null, status === 'authorized' ? null : (error || null), job.id).changes === 1);

  if (!kept) {                     // cancelled meanwhile
    if (intent) await releaseIntent(intent.id);
    return 'canceled';
  }
  if (status === 'authorized' && job.stripe_payment_intent_id && job.stripe_payment_intent_id !== intent?.id) {
    await releaseIntent(job.stripe_payment_intent_id);
  }
  if (internal) notifyAdmins('Card payment problem', `Stripe refused the payment hold for job ${job.id}: ${internal}`);
  return status;
}

// Places the hold for a booked job on its saved card.
// Resolves to { outcome, error?, client_secret?, payment_intent_id? }.
async function holdJob(jobId, { onSession = false } = {}) {
  const job = jobForPayment(jobId);
  if (!job || !['accepted', 'in_progress'].includes(job.status)) return { outcome: 'not_applicable' };
  if (job.auth_status === 'authorized') return { outcome: 'authorized' };
  if (!job.payment_method_id || !job.stripe_customer_id) {
    const error = 'No card is saved for this booking.';
    return { outcome: await recordHold(job, { outcome: 'failed', error }), error };
  }

  let result;
  try {
    result = await confirmOnCard({
      job, customerId: job.stripe_customer_id, paymentMethodId: job.payment_method_id,
      amountCents: cents(job.total_charged), manual: true, onSession,
      idempotencyKey: `job-hold-${job.id}-${job.auth_attempts}`,
    });
  } catch (err) {
    db.prepare("UPDATE jobs SET auth_attempted_at = datetime('now') WHERE id = ?").run(job.id);
    console.error('[PAYMENTS] Hold result unknown — will retry:', job.id, err.message);
    return { outcome: 'unknown' };
  }

  const outcome = await recordHold(job, result);
  return {
    outcome,
    error: outcome === 'authorized' ? undefined : result.error,
    client_secret: outcome === 'action_required' && onSession ? result.intent?.client_secret : undefined,
    payment_intent_id: result.intent?.id,
  };
}

// ── Charging a completed job ────────────────────────────────────────────────

function paidNotice(job) {
  if (!job.cleaner_id) return;
  notify(job.cleaner_id, "💰 Client's payment received",
    `The payment for your ${job.service_type || 'job'} went through — your earnings for it are ready to cash out.`,
    'payout_available');
}

// Collects payment for a completed job: captures its hold, or charges the saved
// card when there's no hold to capture. Never throws. Resolves to capture_status:
// captured | processing | failed (or the unchanged status of a settled job).
async function chargeCompletedJob(jobId) {
  const job = jobForPayment(jobId);
  if (!job || job.status !== 'completed') return null;
  if (['captured', 'waived', 'not_required'].includes(job.capture_status)) return job.capture_status;

  const stripe = getStripe();
  let status;
  let intentId = null;
  let error = null;
  try {
    let intent = job.stripe_payment_intent_id ? await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id) : null;
    if (!['requires_capture', 'succeeded', 'processing'].includes(intent?.status)) {
      intent = (await findJobPayment(job)) || intent;
    }
    if (intent?.status === 'requires_capture') {
      try {
        intent = await stripe.paymentIntents.capture(intent.id, {}, { idempotencyKey: `capture-${intent.id}` });
      } catch (err) {
        if (!isDefinitiveStripeError(err) || err.type === 'StripeRateLimitError') throw err;
        intent = null;             // the hold is gone; charge the card instead
      }
    }

    if (intent?.status === 'succeeded') {
      status = 'captured';
      intentId = intent.id;
    } else if (intent?.status === 'processing') {
      status = 'processing';
      intentId = intent.id;
    } else if (cents(job.total_charged) < MIN_CHARGE_CENTS) {
      status = 'failed';
      error = 'This booking has no amount to charge.';
    } else if (job.payment_method_id && job.stripe_customer_id) {
      const r = await confirmOnCard({
        job, customerId: job.stripe_customer_id, paymentMethodId: job.payment_method_id,
        amountCents: cents(job.total_charged), manual: false, onSession: false,
        idempotencyKey: `job-charge-${job.id}-${job.charge_attempts}`,
      });
      status = r.outcome === 'captured' ? 'captured' : r.outcome === 'processing' ? 'processing' : 'failed';
      intentId = r.intent?.id || null;
      if (status === 'failed') {
        error = r.error || "The card couldn't be charged.";
        db.prepare('UPDATE jobs SET charge_attempts = charge_attempts + 1 WHERE id = ?').run(job.id);
      }
    } else {
      status = 'failed';
      error = 'No card is saved for this booking.';
    }
  } catch (err) {
    console.error('[PAYMENTS] Charge result unknown — will retry:', job.id, err.message);
    status = 'processing';
  }

  db.prepare(`
    UPDATE jobs SET capture_status = ?, stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id), payment_error = ?
    WHERE id = ? AND COALESCE(capture_status, '') NOT IN ('captured','waived')
  `).run(status, intentId, error, job.id);

  if (status === 'failed' && job.capture_status !== 'failed') {
    notify(job.client_id, '💳 Payment needed for your clean',
      `We couldn't charge your card for your ${job.service_type || 'clean'}${error ? ` (${error.replace(/\.$/, '')})` : ''}. Open My bookings to pay.`,
      'payment_failed');
    notifyAdmins('Payment failed on a completed job',
      `Job ${job.id}: ${error || 'the card could not be charged'}. The client has been asked to pay, and the cleaner's earnings for it are on hold.`);
  }
  if (status === 'captured' && ['failed', 'processing'].includes(job.capture_status)) paidNotice(job);
  return status;
}

// ── Stripe reports a payment ────────────────────────────────────────────────

const lockoutUsesJob = jobId => !!db.prepare('SELECT 1 FROM lockout_fees WHERE job_id = ?').get(jobId);

// Brings a booking in line with a PaymentIntent — after the client approves a
// payment in the browser, or when a webhook arrives. Returns what it concluded.
async function syncPaymentIntent(intent) {
  if (!intent || intent.metadata?.kind !== 'job_payment') return null;
  const job = jobForPayment(intent.metadata.sparkle_job_id);
  if (!job) return null;
  if (job.stripe_customer_id && idOf(intent.customer) && idOf(intent.customer) !== job.stripe_customer_id) return null;
  const upcoming = ['accepted', 'in_progress'].includes(job.status);

  switch (intent.status) {
    case 'requires_capture':
      if (upcoming) {
        db.prepare(`
          UPDATE jobs SET auth_status = 'authorized', stripe_payment_intent_id = ?, auth_error = NULL, auth_attempted_at = datetime('now')
          WHERE id = ? AND status IN ('accepted','in_progress')
        `).run(intent.id, job.id);
        if (job.stripe_payment_intent_id && job.stripe_payment_intent_id !== intent.id) await releaseIntent(job.stripe_payment_intent_id);
        return 'authorized';
      }
      if (job.status === 'completed' && !['captured', 'waived'].includes(job.capture_status)) {
        db.prepare('UPDATE jobs SET stripe_payment_intent_id = ? WHERE id = ?').run(intent.id, job.id);
        return chargeCompletedJob(job.id);
      }
      if (job.status === 'cancelled' && !lockoutUsesJob(job.id)) {
        await releaseIntent(intent.id);
        return 'released';
      }
      return 'ignored';

    case 'succeeded':
      if (job.status === 'completed') {
        const changed = db.prepare(`
          UPDATE jobs SET capture_status = 'captured', stripe_payment_intent_id = ?, payment_error = NULL
          WHERE id = ? AND COALESCE(capture_status, '') NOT IN ('captured','waived')
        `).run(intent.id, job.id).changes;
        if (changed && ['failed', 'processing'].includes(job.capture_status)) paidNotice(job);
        return 'captured';
      }
      if (lockoutUsesJob(job.id)) return 'ignored';   // a lockout fee taken from the hold
      notifyAdmins('Card charged for a clean that is not finished',
        `PaymentIntent ${intent.id} for job ${job.id} (${job.status}) was charged. Check whether it needs a refund.`);
      return 'unexpected';

    case 'processing':
      if (job.status === 'completed' && !['captured', 'waived'].includes(job.capture_status)) {
        db.prepare("UPDATE jobs SET capture_status = 'processing', stripe_payment_intent_id = ? WHERE id = ?").run(intent.id, job.id);
      }
      return 'processing';

    case 'requires_payment_method':
    case 'canceled':
      if (upcoming && job.stripe_payment_intent_id === intent.id) {
        if (job.auth_status === 'authorized') {
          // The hold lapsed or was cancelled at Stripe; the sweep places a new one.
          db.prepare("UPDATE jobs SET auth_status = 'scheduled' WHERE id = ? AND auth_status = 'authorized'").run(job.id);
          return 'scheduled';
        }
        if (job.auth_status === 'action_required' && intent.status === 'requires_payment_method') {
          db.prepare("UPDATE jobs SET auth_status = 'failed', auth_error = ? WHERE id = ?")
            .run(intent.last_payment_error?.message || "The payment wasn't approved.", job.id);
          return 'failed';
        }
      }
      return intent.status;

    default:
      return intent.status;
  }
}

// ── The client pays from My bookings ────────────────────────────────────────

// For a booking whose hold failed or needs the bank's approval, or a finished
// clean whose charge failed. The card is one of the client's saved cards.
// Resolves to { outcome, error?, client_secret?, payment_intent_id? }.
async function payForJob(jobId, clientId, paymentMethodId) {
  const job = jobForPayment(jobId);
  if (!job || job.client_id !== clientId) throw new PaymentError(404, 'Booking not found', 'NOT_FOUND');
  const upcoming = ['accepted', 'in_progress'].includes(job.status);
  const unpaid = job.status === 'completed' && job.capture_status === 'failed';
  if (upcoming && job.auth_status === 'authorized') {
    throw new PaymentError(409, 'Your card is already approved for this clean.', 'NOTHING_TO_PAY');
  }
  if (!upcoming && !unpaid) {
    throw new PaymentError(409, job.status === 'completed' ? 'This clean is already paid for.' : 'There is nothing to pay for this booking.', 'NOTHING_TO_PAY');
  }

  const customerId = await ensureCustomer(clientId);
  await assertCardBelongs(customerId, paymentMethodId);

  // Something may already have gone through without being recorded.
  const existing = await findJobPayment({ ...job, stripe_customer_id: customerId });
  if (existing) {
    const outcome = await syncPaymentIntent(existing);
    if (['authorized', 'captured', 'processing'].includes(outcome)) return { outcome };
  }

  if (upcoming) {
    if (job.payment_method_id !== paymentMethodId) {
      // A new card is a new request to Stripe, so it needs a new idempotency key.
      db.prepare('UPDATE jobs SET payment_method_id = ?, auth_attempts = auth_attempts + 1 WHERE id = ?').run(paymentMethodId, job.id);
    }
    if (job.status === 'accepted' && !withinHoldWindow(job.scheduled_at)) {
      db.prepare("UPDATE jobs SET auth_status = 'scheduled', auth_error = NULL WHERE id = ?").run(job.id);
      return { outcome: 'scheduled' };
    }
    return holdJob(job.id, { onSession: true });
  }

  if (job.payment_method_id !== paymentMethodId) {
    db.prepare('UPDATE jobs SET payment_method_id = ?, charge_attempts = charge_attempts + 1 WHERE id = ?').run(paymentMethodId, job.id);
  }
  const current = jobForPayment(job.id);
  let r;
  try {
    r = await confirmOnCard({
      job: current, customerId, paymentMethodId, amountCents: cents(current.total_charged),
      manual: false, onSession: true, idempotencyKey: `job-pay-${job.id}-${current.charge_attempts}`,
    });
  } catch (err) {
    console.error('[PAYMENTS] Payment result unknown for job', job.id, err.message);
    throw new PaymentError(502, "We couldn't confirm the payment with your bank. Check My bookings in a minute before trying again.", 'PAYMENT_UNKNOWN');
  }
  if (r.intent) db.prepare('UPDATE jobs SET stripe_payment_intent_id = ? WHERE id = ?').run(r.intent.id, job.id);
  if (r.outcome === 'captured' || r.outcome === 'processing') {
    return { outcome: (await syncPaymentIntent(r.intent)) || r.outcome };
  }
  if (r.outcome === 'action_required') {
    return { outcome: 'action_required', client_secret: r.intent?.client_secret, payment_intent_id: r.intent?.id };
  }
  db.prepare('UPDATE jobs SET charge_attempts = charge_attempts + 1, payment_error = ? WHERE id = ?').run(r.error || null, job.id);
  return { outcome: 'failed', error: r.error };
}

// ── Lockout fees ────────────────────────────────────────────────────────────

// Charges a lockout fee on a job that never started: taken from the booking's hold
// when there is one (the rest of the hold is released), otherwise from the saved
// card. Resolves to { chargeId, intentId }. Throws PaymentError when the client
// can't be charged; any other error means the result is unknown.
async function chargeLockoutFee(jobId, lockoutId, feeAmount) {
  const stripe = getStripe();
  const job = jobForPayment(jobId);
  const feeCents = cents(feeAmount);
  const chargeOf = intent => idOf(intent.latest_charge);

  if (job.stripe_payment_intent_id && job.auth_status === 'authorized') {
    const hold = await stripe.paymentIntents.retrieve(job.stripe_payment_intent_id);
    if (hold.status === 'requires_capture' && feeCents <= (hold.amount_capturable || hold.amount)) {
      try {
        const captured = await stripe.paymentIntents.capture(hold.id, { amount_to_capture: feeCents }, { idempotencyKey: `lockout-${lockoutId}` });
        return { chargeId: chargeOf(captured), intentId: captured.id };
      } catch (err) {
        if (!isDefinitiveStripeError(err) || err.type === 'StripeRateLimitError') throw err;
        // The hold couldn't be used; try the card itself below.
      }
    }
  }

  if (!job.payment_method_id || !job.stripe_customer_id) {
    throw new PaymentError(402, "The client has no card saved, so the lockout fee couldn't be charged. Sparkle will follow up with them.", 'NO_CARD');
  }
  const r = await confirmOnCard({
    job, customerId: job.stripe_customer_id, paymentMethodId: job.payment_method_id, amountCents: feeCents,
    manual: false, onSession: false, idempotencyKey: `lockout-${lockoutId}-card`,
    metadata: { sparkle_job_id: job.id, sparkle_lockout_fee_id: lockoutId, kind: 'lockout_fee' },
  });
  if (r.outcome !== 'captured') {
    throw new PaymentError(402, "The client's card was declined, so the lockout fee couldn't be charged. Sparkle will follow up with them.", 'CARD_DECLINED');
  }
  if (job.auth_status === 'authorized') await releaseIntent(job.stripe_payment_intent_id);
  return { chargeId: chargeOf(r.intent), intentId: r.intent.id };
}

// ── Background sweep ────────────────────────────────────────────────────────

async function runPaymentSweep() {
  if (!paymentsReady()) return;

  // Place holds on cleans that are now inside the hold window, and retry declined
  // ones a few times, spaced out.
  const due = db.prepare(`
    SELECT id, client_id, service_type, scheduled_at, auth_status FROM jobs
    WHERE status = 'accepted' AND payment_method_id IS NOT NULL
      AND julianday(scheduled_at) - julianday('now') <= ${HOLD_WINDOW_DAYS}
      AND (COALESCE(auth_status, 'scheduled') = 'scheduled'
           OR (auth_status = 'failed' AND auth_attempts < ${MAX_HOLD_ATTEMPTS}
               AND (auth_attempted_at IS NULL OR auth_attempted_at <= datetime('now', '-${HOLD_RETRY_HOURS} hours'))))
    ORDER BY scheduled_at
    LIMIT 50
  `).all();
  for (const j of due) {
    const r = await holdJob(j.id);
    if (['failed', 'action_required'].includes(r.outcome) && r.outcome !== j.auth_status) {
      notify(j.client_id, '💳 Your card needs attention',
        `We couldn't approve the payment for your ${j.service_type || 'clean'} on ${pacificDate(j.scheduled_at)}. ` +
        'Open My bookings to update your card so your cleaner can still come.',
        'payment_action_required');
    }
  }

  // Completed jobs whose charge result was lost.
  const unsettled = db.prepare(`SELECT id FROM jobs WHERE status = 'completed' AND capture_status = 'processing' LIMIT 25`).all();
  for (const j of unsettled) await chargeCompletedJob(j.id);
}

function startPaymentSweep() {
  const run = () => runPaymentSweep().catch(err => console.error('[PAYMENTS] Sweep error:', err.message));
  setTimeout(run, 45 * 1000).unref();
  setInterval(run, 15 * 60 * 1000).unref();
}

module.exports = {
  PaymentError, PAYMENTS_OFF, HOLD_WINDOW_DAYS, paymentsReady, withinHoldWindow, bookingTotals,
  ensureCustomer, listCards, assertCardBelongs, setDefaultCard,
  confirmOnCard, releaseIntent, holdJob, chargeCompletedJob, syncPaymentIntent, payForJob,
  chargeLockoutFee, runPaymentSweep, startPaymentSweep,
};
