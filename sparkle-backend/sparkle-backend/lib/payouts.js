'use strict';
// lib/payouts.js — the one place that decides what a cleaner can cash out, and
// the only code that moves money to a cleaner.
//
// The rules:
//   • A job's earnings can be cashed out as soon as the job is completed with its
//     before and after photos. There is no waiting period.
//   • While a problem report on that job is unresolved, its earnings are frozen.
//   • If a refund is owed on earnings that were already cashed out, a negative
//     'refund' row takes it back out of the cleaner's next cashout.
//
// Money safety:
//   • Earnings are claimed for a cashout (payouts.cashout_id) before Stripe is
//     called, in one synchronous transaction, so two cashout requests can never
//     both pay the same earnings.
//   • Every Stripe call carries an idempotency key. If Stripe's answer is lost, the
//     claim is kept and reconcileCashouts() settles it — a claim is released only
//     when Stripe definitely did not move the money.

const { v4: uuid } = require('uuid');
const db = require('../db');
const { getStripe } = require('./stripe');
const { notify, notifyAdmins } = require('./notify');

const MIN_CASHOUT_CENTS = 100;
const instantFeeCents = () => Math.round(parseFloat(process.env.INSTANT_CASHOUT_FEE || 10) * 100);

const cents   = n => Math.round((Number(n) || 0) * 100);
const dollars = c => Math.round(c) / 100;

// Stripe errors that prove the request was NOT carried out. Anything else — a
// network failure, a Stripe 500, an idempotency conflict with a request still in
// flight — leaves the outcome unknown, and unknown must never release a claim.
const DEFINITIVE_STRIPE_ERRORS = new Set([
  'StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError',
  'StripeCardError', 'StripeRateLimitError',
]);
function isDefinitiveStripeError(err) {
  return !!err && DEFINITIVE_STRIPE_ERRORS.has(err.type);
}

// ── What is cashable ─────────────────────────────────────────────────────────
// Why a waiting payout row can't be cashed out yet; NULL when it can.
// Refund rows are never held — a debt must not wait for a ruling to count.
const HOLD_REASON_SQL = `
  CASE
    WHEN p.type = 'refund' THEN NULL
    WHEN p.job_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM disputes d WHERE d.job_id = p.job_id AND d.status != 'resolved'
    ) THEN 'dispute'
    WHEN p.type = 'job' AND (j.id IS NULL OR j.status != 'completed') THEN 'not_completed'
    WHEN p.type = 'job' AND j.photos_required = 1 AND j.photos_verified_at IS NULL THEN 'photos'
    WHEN p.type = 'job' AND j.capture_status = 'failed' THEN 'payment'
    ELSE NULL
  END`;

const WAITING_ROWS_SQL = `
  SELECT p.id, p.type, p.amount, p.job_id, j.service_type, j.scheduled_at,
         ${HOLD_REASON_SQL} AS hold_reason
  FROM payouts p
  LEFT JOIN jobs j ON j.id = p.job_id
  WHERE p.cleaner_id = ? AND p.status = 'pending' AND p.cashout_id IS NULL`;

const HOLD_LABELS = {
  dispute:       'The client reported a problem — frozen until Sparkle reviews it',
  not_completed: 'Available once the job is completed with before and after photos',
  photos:        'Waiting on before and after photos',
  payment:       "The client's payment didn't go through — Sparkle is looking into it",
};

function balanceFor(cleanerId) {
  const rows = db.prepare(WAITING_ROWS_SQL).all(cleanerId);
  let earned = 0, owed = 0, held = 0;
  const holds = [];
  for (const r of rows) {
    const c = cents(r.amount);
    if (r.hold_reason) {
      held += c;
      holds.push({
        payout_id: r.id, job_id: r.job_id, type: r.type, amount: dollars(c),
        service_type: r.service_type, scheduled_at: r.scheduled_at,
        reason: r.hold_reason, reason_label: HOLD_LABELS[r.hold_reason],
      });
    } else if (c < 0) {
      owed -= c;
    } else {
      earned += c;
    }
  }
  const processing = db.prepare(
    "SELECT COALESCE(SUM(net_amount), 0) AS total FROM cashouts WHERE cleaner_id = ? AND status = 'processing'"
  ).get(cleanerId).total;

  return {
    available:      dollars(Math.max(0, earned - owed)),
    earned_available: dollars(earned),
    refunds_owed:   dollars(owed),     // subtracted from `available`
    held:           dollars(held),
    holds,
    processing:     dollars(cents(processing)),
    instant_fee:    dollars(instantFeeCents()),
  };
}

// ── Job earnings ─────────────────────────────────────────────────────────────
// The cleaner's earnings for a job: a chosen quote minus Sparkle's success fee,
// otherwise the job's base amount. Idempotent — a retried /complete never creates
// a second row (and ux_payouts_one_per_job backs this up in the database).
// Synchronous; call it inside the caller's transaction.
function ensureJobPayout(job) {
  const existing = db.prepare(`
    SELECT id, amount FROM payouts
    WHERE job_id = ? AND cleaner_id = ? AND type = 'job' AND status != 'failed'
  `).get(job.id, job.cleaner_id);
  if (existing) return { id: existing.id, amount: existing.amount, created: false };

  const bid = db.prepare(`
    SELECT amount, success_fee FROM bids WHERE job_id = ? AND cleaner_id = ? AND status = 'chosen'
  `).get(job.id, job.cleaner_id);
  const amountCents = bid
    ? cents(bid.amount) - cents(bid.success_fee ?? bid.amount * 0.10)
    : cents(job.base_amount);
  if (amountCents <= 0) return null;

  const id = uuid();
  db.prepare(`
    INSERT INTO payouts (id, cleaner_id, job_id, amount, type, status) VALUES (?, ?, ?, ?, 'job', 'pending')
  `).run(id, job.cleaner_id, job.id, dollars(amountCents));
  return { id, amount: dollars(amountCents), created: true };
}

// ── Refunds come out of the cleaner's earnings ───────────────────────────────
// For each live payout of the given types on a job: if it hasn't been cashed out
// it is simply voided; if it has (or a transfer covering it is in flight) a
// negative 'refund' row takes the same amount out of the next cashout.
// Synchronous; call it inside the caller's transaction.
function reverseJobEarnings(jobId, types, disputeId, reason) {
  const rows = db.prepare(`
    SELECT * FROM payouts
    WHERE job_id = ? AND status IN ('pending','paid')
      AND type IN (${types.map(() => '?').join(',')})
  `).all(jobId, ...types);

  let voided = 0, clawedBack = 0;
  for (const r of rows) {
    const voidRes = r.status === 'pending' && r.cashout_id === null
      ? db.prepare(`
          UPDATE payouts SET status = 'failed', void_reason = ?
          WHERE id = ? AND status = 'pending' AND cashout_id IS NULL
        `).run(reason, r.id)
      : { changes: 0 };
    if (voidRes.changes === 1) {
      voided += cents(r.amount);
      continue;
    }
    db.prepare(`
      INSERT INTO payouts (id, cleaner_id, job_id, amount, type, status, dispute_id)
      VALUES (?, ?, ?, ?, 'refund', 'pending', ?)
    `).run(uuid(), r.cleaner_id, jobId, -dollars(cents(r.amount)), disputeId);
    clawedBack += cents(r.amount);
  }
  return { voided: dollars(voided), clawed_back: dollars(clawedBack) };
}

// ── Cashout ──────────────────────────────────────────────────────────────────
class CashoutError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

// Claims every cashable row for a new cashout. No await inside: node:sqlite is
// synchronous, so nothing else can run between reading the rows and claiming them.
function claimCashout(cleanerId, method) {
  const profile = db.prepare('SELECT stripe_connect_id FROM cleaner_profiles WHERE user_id = ?').get(cleanerId);
  if (!profile?.stripe_connect_id) {
    throw new CashoutError(422, 'Bank account not connected. Add a payout account in your profile settings.');
  }
  const feeCents = method === 'instant' ? instantFeeCents() : 0;

  return transaction(() => {
    const rows = db.prepare(WAITING_ROWS_SQL).all(cleanerId).filter(r => !r.hold_reason);
    const grossCents = rows.reduce((sum, r) => sum + cents(r.amount), 0);

    if (grossCents < MIN_CASHOUT_CENTS) {
      const owed = rows.filter(r => r.amount < 0).reduce((s, r) => s - cents(r.amount), 0);
      throw new CashoutError(422, owed > 0 && grossCents < 0
        ? `You have $${dollars(owed).toFixed(2)} in refunds that will come out of your next earnings, so there's nothing to cash out yet.`
        : 'No earnings available to cash out yet.');
    }
    if (grossCents - feeCents < MIN_CASHOUT_CENTS) {
      throw new CashoutError(422,
        `Your available balance ($${dollars(grossCents).toFixed(2)}) is too low to cover the instant cashout fee ($${dollars(feeCents).toFixed(2)}). Use standard payout instead.`,
        { fallback: 'standard' });
    }

    const id = uuid();
    db.prepare(`
      INSERT INTO cashouts (id, cleaner_id, method, destination, gross_amount, fee_amount, net_amount, status, instant_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?)
    `).run(id, cleanerId, method, profile.stripe_connect_id, dollars(grossCents), dollars(feeCents),
           dollars(grossCents - feeCents), method === 'instant' ? 'pending' : null);

    const claim = db.prepare(`
      UPDATE payouts SET cashout_id = ? WHERE id = ? AND status = 'pending' AND cashout_id IS NULL
    `);
    for (const r of rows) {
      if (claim.run(id, r.id).changes !== 1) throw new Error(`payout ${r.id} changed while being claimed`);
    }
    return id;
  });
}

function markTransferred(cashoutId, transferId) {
  transaction(() => {
    const res = db.prepare(`
      UPDATE cashouts SET status = 'paid', stripe_transfer_id = ?, error = NULL, completed_at = datetime('now')
      WHERE id = ? AND status = 'processing'
    `).run(transferId, cashoutId);
    if (res.changes !== 1) return;
    db.prepare(`
      UPDATE payouts SET status = 'paid', stripe_transfer_id = ?, paid_at = datetime('now')
      WHERE cashout_id = ? AND status = 'pending'
    `).run(transferId, cashoutId);
  });
}

// Only for a transfer Stripe definitely did not make: the earnings go back to
// being available.
function failCashout(cashoutId, message) {
  transaction(() => {
    const res = db.prepare(`
      UPDATE cashouts SET status = 'failed', error = ?, completed_at = datetime('now')
      WHERE id = ? AND status = 'processing'
    `).run(String(message).slice(0, 500), cashoutId);
    if (res.changes !== 1) return;
    db.prepare("UPDATE payouts SET cashout_id = NULL WHERE cashout_id = ? AND status = 'pending'").run(cashoutId);
  });
}

async function sendTransfer(c) {
  const stripe = getStripe();
  try {
    const transfer = await stripe.transfers.create({
      amount:         cents(c.net_amount),
      currency:       'usd',
      destination:    c.destination,
      transfer_group: `cashout_${c.id}`,
      description:    `Sparkle ${c.method} cashout`,
      metadata: {
        sparkle_cashout_id: c.id, sparkle_user_id: c.cleaner_id, kind: 'cashout',
        gross_amount: String(c.gross_amount), fee: String(c.fee_amount),
      },
    }, { idempotencyKey: `cashout-${c.id}` });
    markTransferred(c.id, transfer.id);
    return 'paid';
  } catch (err) {
    if (isDefinitiveStripeError(err)) {
      failCashout(c.id, err.message);
      return 'failed';
    }
    db.prepare('UPDATE cashouts SET error = ? WHERE id = ?').run(String(err.message).slice(0, 500), c.id);
    console.error('[CASHOUT] Transfer outcome unknown — will reconcile:', c.id, err.message);
    return 'processing';
  }
}

// Instant: the transfer lands in the cleaner's Stripe balance, then an instant
// payout sends it to their debit card. If their bank can't take instant payouts,
// the money still goes out on the normal schedule and the fee is given back.
async function sendInstantPayout(c) {
  const stripe = getStripe();
  try {
    await stripe.payouts.create(
      { amount: cents(c.net_amount), currency: 'usd', method: 'instant', metadata: { sparkle_cashout_id: c.id } },
      { stripeAccount: c.destination, idempotencyKey: `cashout-${c.id}-instant` }
    );
    db.prepare("UPDATE cashouts SET instant_status = 'paid' WHERE id = ?").run(c.id);
    return 'paid';
  } catch (err) {
    if (!isDefinitiveStripeError(err)) {
      console.error('[CASHOUT] Instant payout outcome unknown — will reconcile:', c.id, err.message);
      return 'pending';
    }
  }
  return refundInstantFee(c, 'Instant payouts are not available for this bank account');
}

async function refundInstantFee(c, why) {
  const stripe = getStripe();
  try {
    if (cents(c.fee_amount) > 0) {
      await stripe.transfers.create({
        amount: cents(c.fee_amount), currency: 'usd', destination: c.destination,
        transfer_group: `cashout_${c.id}`, description: 'Sparkle instant cashout fee refund',
        metadata: { sparkle_cashout_id: c.id, kind: 'instant_fee_refund' },
      }, { idempotencyKey: `cashout-${c.id}-fee-refund` });
    }
    db.prepare("UPDATE cashouts SET instant_status = 'failed', error = ? WHERE id = ?").run(`${why}; fee refunded`, c.id);
    notify(c.cleaner_id, 'Instant cashout unavailable',
      `${why}, so your $${Number(c.net_amount).toFixed(2)} will arrive on the standard schedule instead. The $${Number(c.fee_amount).toFixed(2)} instant fee has been returned to you.`,
      'payout_standard_fallback');
    return 'failed';
  } catch (err) {
    db.prepare("UPDATE cashouts SET instant_status = 'failed', error = ? WHERE id = ?")
      .run(`${why}; fee refund FAILED: ${err.message}`.slice(0, 500), c.id);
    notifyAdmins('Instant fee refund failed',
      `Cashout ${c.id}: instant payout failed and the $${Number(c.fee_amount).toFixed(2)} fee could not be returned automatically. Refund it by hand.`);
    return 'failed';
  }
}

async function cashout(cleanerId, method) {
  const cashoutId = claimCashout(cleanerId, method);
  let c = db.prepare('SELECT * FROM cashouts WHERE id = ?').get(cashoutId);
  const transferStatus = await sendTransfer(c);
  if (transferStatus === 'paid' && method === 'instant') await sendInstantPayout(c);
  c = db.prepare('SELECT * FROM cashouts WHERE id = ?').get(cashoutId);

  if (c.status === 'paid') {
    const instantOk = c.method === 'instant' && c.instant_status === 'paid';
    notify(cleanerId, '💰 Payout on the way!',
      `$${Number(c.net_amount).toFixed(2)} is heading to your bank — arriving ${instantOk ? 'within minutes' : 'in 1–3 business days'}.`,
      'payout_sent');
  }
  return c;
}

// ── Reconciler ───────────────────────────────────────────────────────────────
// Settles cashouts whose Stripe outcome was never learned. Transfers are looked
// up by transfer_group, which works at any age; a retry reuses the original
// idempotency key, which Stripe honours for 24 hours — so after ~23 hours with
// no transfer found, the transfer never happened and the claim is released.
async function reconcileCashouts() {
  const stripe = getStripe();
  const stuck = db.prepare(`
    SELECT *, (julianday('now') - julianday(created_at)) * 24 AS age_hours FROM cashouts
    WHERE (status = 'processing' OR (status = 'paid' AND instant_status = 'pending'))
      AND created_at <= datetime('now', '-3 minutes')
  `).all();

  for (const c of stuck) {
    try {
      if (c.status === 'processing') {
        let found = null;
        if (typeof stripe.transfers.list === 'function') {
          const list = await stripe.transfers.list({ transfer_group: `cashout_${c.id}`, limit: 10 });
          found = (list.data || []).find(t => t.metadata?.kind === 'cashout' && t.metadata?.sparkle_cashout_id === c.id);
        }
        if (found) markTransferred(c.id, found.id);
        else if (c.age_hours < 23) await sendTransfer(c);
        else failCashout(c.id, 'No transfer was made; released after 23 hours');
      }
      const fresh = db.prepare('SELECT * FROM cashouts WHERE id = ?').get(c.id);
      if (fresh.status === 'paid' && fresh.method === 'instant' && fresh.instant_status === 'pending') {
        if (c.age_hours < 23) await sendInstantPayout(fresh);
        else await refundInstantFee(fresh, 'The instant payout could not be confirmed');
      }
    } catch (err) {
      console.error('[CASHOUT] Reconcile failed for', c.id, err.message);
    }
  }
}

function startCashoutReconciler() {
  const run = () => reconcileCashouts().catch(err => console.error('[CASHOUT] Reconciler error:', err.message));
  setTimeout(run, 30 * 1000).unref();
  setInterval(run, 10 * 60 * 1000).unref();
}

module.exports = {
  balanceFor, ensureJobPayout, reverseJobEarnings, cashout, CashoutError,
  reconcileCashouts, startCashoutReconciler, isDefinitiveStripeError, transaction,
  cents, dollars, HOLD_LABELS,
};
