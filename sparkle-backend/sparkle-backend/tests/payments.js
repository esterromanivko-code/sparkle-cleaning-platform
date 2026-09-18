'use strict';
// tests/payments.js — clients' cards, holds and charges, cleaners' payout accounts,
// and the Stripe webhook, end to end against a throwaway database with Stripe
// simulated (lib/stripe.js):
//   npm run test:payments

const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkle-payments-'));
const WEBHOOK_SECRET = 'whsec_' + 'a1b2c3d4'.repeat(4);
Object.assign(process.env, {
  NODE_ENV: 'development',
  DB_PATH: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  BACKUP_DIR: path.join(TMP, 'backups'),
  PORT: '3013',
  JWT_SECRET: 'payments-test-secret',
  STRIPE_SECRET_KEY: '',
  STRIPE_PUBLISHABLE_KEY: '',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  TURNSTILE_SECRET_KEY: '',
  GEOCODE_PROVIDER: 'none',
  FRONTEND_URL: 'https://sparkle.test',
  INSTANT_CASHOUT_FEE: '10',
});

const Stripe = require('stripe');
const db = require('../db');
const { signToken } = require('../middleware/auth');
const { getStripe, paymentsMode, publishableKey } = require('../lib/stripe');
const { runPaymentSweep } = require('../lib/payments');
require('../server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let ip = 0;
async function api(p, { method = 'GET', token, body, headers: extra = {}, raw } = {}) {
  const headers = { 'X-Forwarded-For': `10.99.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 400) };
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error('server did not start');
}

const T = {};
function user(id, role) {
  db.prepare('INSERT INTO users (id, role, first_name, last_name, email, password_hash) VALUES (?,?,?,?,?,?)')
    .run(id, role, id, 'Test', `${id}@pay.local`, 'x');
  if (role === 'cleaner') db.prepare('INSERT INTO cleaner_profiles (user_id, lockout_fee_enabled, lockout_fee_amount) VALUES (?, 1, 35)').run(id);
  if (role === 'client') db.prepare('INSERT INTO client_profiles (user_id, default_address) VALUES (?, ?)').run(id, '1 Pay St');
  T[id] = signToken({ id, role });
}
const daysFromNow = d => new Date(Date.now() + d * 86400000).toISOString();
function openJob(id, clientId, days) {
  db.prepare(`INSERT INTO jobs (id, client_id, service_type, address, scheduled_at, status, base_amount, total_charged)
              VALUES (?, ?, 'Deep clean', '1 Pay St', ?, 'open', 85, 91.8)`).run(id, clientId, daysFromNow(days));
}
function quote(id, jobId, cleanerId, amount = 100) {
  db.prepare(`INSERT INTO bids (id, job_id, cleaner_id, amount, message, success_fee, expires_at)
              VALUES (?, ?, ?, ?, 'I would love to take this clean for you.', ?, datetime('now', '+1 day'))`)
    .run(id, jobId, cleanerId, amount, amount * 0.1);
}
const job = id => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
const intent = id => getStripe().paymentIntents.retrieve(id);
const notifications = (userId, type) => db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND type = ?').get(userId, type).n;
const choose = (bidId, pm, token = T.cl) => api(`/api/bids/${bidId}/choose`, { method: 'POST', token, body: { payment_method_id: pm } });
const pay = (jobId, pm) => api(`/api/payments/jobs/${jobId}/pay`, { method: 'POST', token: T.cl, body: { payment_method_id: pm } });
const booking = async jobId => (await api('/api/jobs/my-bookings', { token: T.cl })).json.jobs.find(j => j.id === jobId);
async function finish(jobId) {
  assert.equal((await api(`/api/jobs/${jobId}/arrive`, { method: 'POST', token: T.cn })).status, 200);
  for (const stage of ['before', 'after']) {
    db.prepare(`INSERT INTO job_photos (id, job_id, uploaded_by, role, stage, filename, thumb_filename) VALUES (?, ?, 'cn', 'cleaner', ?, 'x.jpg', 'x_t.jpg')`)
      .run(`${jobId}-${stage}`, jobId, stage);
  }
  const r = await api(`/api/jobs/${jobId}/complete`, { method: 'POST', token: T.cn });
  assert.equal(r.status, 200, r.text);
  return r.json;
}
function webhook(event) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return api('/api/payments/webhook', { method: 'POST', raw: payload, headers: { 'Stripe-Signature': signature } });
}

async function main() {
  await waitForServer();
  user('cl', 'client'); user('other', 'client'); user('cn', 'cleaner'); user('adm', 'admin');

  // ── Setup ──────────────────────────────────────────────────────────────────
  const config = (await api('/api/config')).json;
  assert.equal(config.payments_mode, 'mock');
  assert.equal(config.stripe_publishable_key, null);
  assert.deepEqual((await api('/api/payments/methods', { token: T.cl })).json.cards, []);
  const setup = await api('/api/payments/setup-intent', { method: 'POST', token: T.cl });
  assert.equal(setup.status, 200, setup.text);
  assert.ok(setup.json.client_secret);
  assert.ok(job, 'helpers load');
  assert.ok(db.prepare("SELECT stripe_customer_id FROM users WHERE id = 'cl'").get().stripe_customer_id, 'a Stripe customer was created');
  assert.equal((await api('/api/payments/setup-intent', { method: 'POST', token: T.cn })).status, 403, 'cleaners have no cards');

  // ── Booking inside the hold window places the hold ─────────────────────────
  openJob('j1', 'cl', 2); quote('b1', 'j1', 'cn');
  const noCard = await choose('b1', undefined);
  assert.equal(noCard.status, 422);
  assert.equal(noCard.json.code, 'CARD_REQUIRED');
  const booked = await choose('b1', 'pm_card_visa');
  assert.equal(booked.status, 200, booked.text);
  assert.equal(booked.json.payment.status, 'authorized');
  assert.equal(booked.json.total_charged, 108, '$100 quote plus the 8% booking fee');
  let j1 = job('j1');
  assert.equal(j1.status, 'accepted');
  assert.equal(j1.auth_status, 'authorized');
  const hold1 = await intent(j1.stripe_payment_intent_id);
  assert.equal(hold1.status, 'requires_capture');
  assert.equal(hold1.amount, 10800);
  assert.equal(hold1.metadata.sparkle_job_id, 'j1');
  const methods = (await api('/api/payments/methods', { token: T.cl })).json;
  assert.deepEqual(methods.cards.map(c => c.last4), ['4242']);
  assert.equal(methods.default_payment_method, 'pm_card_visa');

  openJob('jo', 'other', 2); quote('bo', 'jo', 'cn');
  const stolen = await choose('bo', 'pm_card_visa', T.other);
  assert.equal(stolen.status, 422, "someone else's saved card can't be used");
  assert.equal(stolen.json.code, 'CARD_NOT_FOUND');

  // A declined card doesn't book anything.
  openJob('j2', 'cl', 1); quote('b2', 'j2', 'cn');
  const declined = await choose('b2', 'pm_card_chargeDeclined');
  assert.equal(declined.status, 402, declined.text);
  assert.equal(declined.json.code, 'CARD_DECLINED');
  assert.equal(job('j2').status, 'open');
  assert.equal(db.prepare("SELECT status FROM bids WHERE id = 'b2'").get().status, 'pending');

  // A bank that wants the client's approval: booked, then approved in the browser.
  openJob('j5', 'cl', 2); quote('b5', 'j5', 'cn');
  const needsOk = await choose('b5', 'pm_card_authenticationRequired');
  assert.equal(needsOk.status, 200, needsOk.text);
  assert.equal(needsOk.json.payment.status, 'action_required');
  assert.ok(needsOk.json.payment.client_secret && needsOk.json.payment.payment_intent_id);
  assert.equal((await booking('j5')).payment_needed, 'hold');
  const approved = await api('/api/payments/jobs/j5/pay/confirm', { method: 'POST', token: T.cl, body: { payment_intent_id: needsOk.json.payment.payment_intent_id } });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.outcome, 'authorized');
  assert.equal(job('j5').auth_status, 'authorized');
  assert.equal((await api('/api/payments/jobs/j5/pay/confirm', { method: 'POST', token: T.other, body: { payment_intent_id: needsOk.json.payment.payment_intent_id } })).status, 404);

  // ── Outside the window the hold waits for the sweep ────────────────────────
  openJob('j3', 'cl', 20); quote('b3', 'j3', 'cn');
  assert.equal((await choose('b3', 'pm_card_visa')).json.payment.status, 'scheduled');
  assert.equal(job('j3').stripe_payment_intent_id, null, 'nothing is held weeks ahead');
  await runPaymentSweep();
  assert.equal(job('j3').auth_status, 'scheduled');
  db.prepare('UPDATE jobs SET scheduled_at = ? WHERE id = ?').run(daysFromNow(3), 'j3');
  await runPaymentSweep();
  assert.equal(job('j3').auth_status, 'authorized');

  // A card that declines when the sweep places the hold: the client is told, the
  // cleaner sees a warning (but not the card), and the client fixes it.
  openJob('j4', 'cl', 30); quote('b4', 'j4', 'cn');
  assert.equal((await choose('b4', 'pm_card_chargeDeclined')).json.payment.status, 'scheduled');
  db.prepare('UPDATE jobs SET scheduled_at = ? WHERE id = ?').run(daysFromNow(2), 'j4');
  await runPaymentSweep();
  assert.equal(job('j4').auth_status, 'failed');
  assert.equal(notifications('cl', 'payment_action_required'), 1);
  await runPaymentSweep();
  assert.equal(notifications('cl', 'payment_action_required'), 1, 'not retried or re-sent straight away');
  assert.equal((await booking('j4')).payment_needed, 'hold');
  const sched = (await api('/api/jobs/my-schedule', { token: T.cn })).json.jobs.find(j => j.id === 'j4');
  assert.equal(sched.payment_issue, true);
  assert.equal(sched.payment_method_id, undefined, "cleaners don't see the client's card");
  assert.equal(sched.auth_error, undefined);
  const fixed = await pay('j4', 'pm_card_visa');
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal(fixed.json.outcome, 'authorized');
  assert.equal((await booking('j4')).payment_needed, null);
  assert.equal((await pay('j4', 'pm_card_visa')).status, 409, 'nothing left to fix');

  // ── Completing the job captures the hold ───────────────────────────────────
  const done = await finish('j1');
  assert.equal(done.capture_status, 'captured');
  assert.equal(done.cashable, true);
  assert.equal((await intent(j1.stripe_payment_intent_id)).status, 'succeeded');
  assert.equal((await api('/api/earnings', { token: T.cn })).json.balance.available, 90, 'quote minus the 10% success fee');

  // ── Payout accounts ────────────────────────────────────────────────────────
  const noAccount = await api('/api/earnings/cashout', { method: 'POST', token: T.cn, body: { type: 'standard' } });
  assert.equal(noAccount.status, 422);
  assert.equal(noAccount.json.code, 'PAYOUTS_NOT_SET_UP');
  assert.equal((await api('/api/payments/connect/status', { token: T.cn })).json.state, 'not_started');
  assert.equal((await api('/api/payments/connect/status', { token: T.cl })).status, 403);

  const evil = await api('/api/payments/connect/onboard', { method: 'POST', token: T.cn, body: { return_to: 'https://evil.example/steal' } });
  assert.equal(evil.status, 200, evil.text);
  assert.ok(evil.json.url.startsWith('https://sparkle.test/app?payouts=return'), `never returns to another site: ${evil.json.url}`);
  const onboard = await api('/api/payments/connect/onboard', { method: 'POST', token: T.cn, body: { return_to: 'https://sparkle.test/sparkle_full.html' } });
  assert.ok(onboard.json.url.startsWith('https://sparkle.test/sparkle_full.html?payouts=return'));
  const acct = db.prepare("SELECT stripe_connect_id FROM cleaner_profiles WHERE user_id = 'cn'").get().stripe_connect_id;
  assert.match(acct, /^acct_/);

  // Details sent, Stripe still verifying.
  getStripe()._mock.setAccount(acct, { details_submitted: true, payouts_enabled: false, requirements: { currently_due: [], past_due: [] } });
  let status = (await api('/api/payments/connect/status', { token: T.cn })).json;
  assert.equal(status.state, 'verifying');
  const notReady = await api('/api/earnings/cashout', { method: 'POST', token: T.cn, body: { type: 'standard' } });
  assert.equal(notReady.json.code, 'PAYOUTS_NOT_READY');

  getStripe()._mock.setAccount(acct, {
    payouts_enabled: true, requirements: { currently_due: [], past_due: [] },
    external_accounts: { data: [{ object: 'bank_account', bank_name: 'STRIPE TEST BANK', last4: '6789', default_for_currency: true }] },
  });
  status = (await api('/api/payments/connect/status', { token: T.cn })).json;
  assert.equal(status.state, 'ready');
  assert.equal(status.label, 'STRIPE TEST BANK •••• 6789');
  assert.equal(notifications('cn', 'payout_account_ready'), 1);
  const cashed = await api('/api/earnings/cashout', { method: 'POST', token: T.cn, body: { type: 'standard' } });
  assert.equal(cashed.status, 200, cashed.text);
  assert.equal(cashed.json.net_amount, 90);
  const dash = await api('/api/payments/connect/dashboard', { method: 'POST', token: T.cn });
  assert.equal(dash.status, 200, dash.text);
  assert.ok(dash.json.url);

  // ── A charge that fails at completion holds the earnings until the client pays ──
  openJob('j6', 'cl', 2); quote('b6', 'j6', 'cn');
  assert.equal((await choose('b6', 'pm_card_visa')).json.payment.status, 'authorized');
  getStripe()._mock.expireHold(job('j6').stripe_payment_intent_id);          // the hold lapsed
  db.prepare("UPDATE jobs SET payment_method_id = 'pm_card_chargeDeclined' WHERE id = 'j6'").run();
  const unpaid = await finish('j6');
  assert.equal(unpaid.capture_status, 'failed');
  assert.equal(unpaid.cashable, false);
  let earnings = (await api('/api/earnings', { token: T.cn })).json.balance;
  assert.equal(earnings.available, 0);
  assert.equal(earnings.holds[0].reason, 'payment');
  assert.equal(notifications('cl', 'payment_failed'), 1);
  assert.equal((await booking('j6')).payment_needed, 'charge');
  const attempts = job('j6').charge_attempts;
  await api('/api/jobs/j6/complete', { method: 'POST', token: T.cn });
  assert.equal(job('j6').charge_attempts, attempts, "tapping Complete again doesn't retry the declined card");

  const blockedDelete = await api('/api/auth/me', { method: 'DELETE', token: T.cl, body: { password: 'x', confirm: 'DELETE' } });
  assert.ok([403, 409].includes(blockedDelete.status));

  const paid = await pay('j6', 'pm_card_visa');
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.json.outcome, 'captured');
  assert.equal(job('j6').capture_status, 'captured');
  assert.equal(notifications('cn', 'payout_available') >= 1, true);
  earnings = (await api('/api/earnings', { token: T.cn })).json.balance;
  assert.equal(earnings.available, 90, 'released once the client paid');
  assert.equal((await pay('j6', 'pm_card_visa')).status, 409, 'never charged twice');

  // ── Webhook ────────────────────────────────────────────────────────────────
  assert.equal((await api('/api/payments/webhook', { method: 'POST', raw: '{}' })).status, 400, 'unsigned events are rejected');
  const hold3 = job('j3').stripe_payment_intent_id;
  getStripe()._mock.expireHold(hold3);
  const event = { id: 'evt_test_1', object: 'event', type: 'payment_intent.canceled', livemode: false, data: { object: { id: hold3, metadata: { kind: 'job_payment' } } } };
  const hook = await webhook(event);
  assert.equal(hook.status, 200, hook.text);
  assert.equal(job('j3').auth_status, 'scheduled', 'a lapsed hold is placed again by the sweep');
  assert.equal((await webhook(event)).json.duplicate, true);
  const liveEvent = await webhook({ ...event, id: 'evt_test_2', livemode: true });
  assert.equal(liveEvent.json.ignored, 'mode', 'live events never touch test data');

  // ── Lockout fees come out of the hold ──────────────────────────────────────
  openJob('j7', 'cl', 1); quote('b7', 'j7', 'cn');
  assert.equal((await choose('b7', 'pm_card_visa')).json.payment.status, 'authorized');
  db.prepare(`INSERT INTO job_photos (id, job_id, uploaded_by, role, stage, filename, thumb_filename) VALUES ('j7-door', 'j7', 'cn', 'cleaner', 'lockout', 'x.jpg', 'x_t.jpg')`).run();
  const lock = await api('/api/jobs/j7/lockout-fee', { method: 'POST', token: T.cn, body: { checklist: [true, true, true, true, true] } });
  assert.equal(lock.status, 200, lock.text);
  const lockHold = await intent(job('j7').stripe_payment_intent_id);
  assert.equal(lockHold.status, 'succeeded');
  assert.equal(lockHold.amount_received, 3500, 'only the $35 fee is taken');
  assert.ok(db.prepare("SELECT stripe_charge_id FROM lockout_fees WHERE job_id = 'j7'").get().stripe_charge_id);

  // Cancelling releases the hold; cleaners can't take jobs outright.
  const hold5 = job('j5').stripe_payment_intent_id;
  assert.equal((await api('/api/jobs/j5/cancel', { method: 'POST', token: T.cl })).status, 200);
  assert.equal((await intent(hold5)).status, 'canceled');
  assert.equal(job('j5').auth_status, 'canceled');
  assert.equal((await api('/api/jobs/j2/accept', { method: 'POST', token: T.cn })).status, 410);

  // ── Which Stripe mode the server runs in ───────────────────────────────────
  const saved = { NODE_ENV: process.env.NODE_ENV, STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY };
  try {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = '';
    assert.equal(paymentsMode(), 'off', 'production never simulates payments');
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
    assert.equal(paymentsMode(), 'off', 'a placeholder is not a key');
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'Ab1'.repeat(12);
    assert.equal(paymentsMode(), 'test');
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_live_' + 'Ab1'.repeat(12);
    assert.equal(publishableKey(), null, 'a live publishable key with a test secret key is refused');
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_' + 'Ab1'.repeat(12);
    assert.equal(publishableKey(), process.env.STRIPE_PUBLISHABLE_KEY);
  } finally {
    Object.assign(process.env, saved);
  }

  console.log('Payment tests passed: cards, holds, declines, bank approval, sweep, capture, failed charges, payouts setup, webhook, lockout, cancel.');
}

main()
  .then(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
