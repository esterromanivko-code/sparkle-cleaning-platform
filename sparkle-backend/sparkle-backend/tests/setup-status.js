'use strict';
// tests/setup-status.js — the admin's Setup check and "send me a test notification".
//
// Pins: only admins can use them; they say plainly what is and isn't connected (Stripe,
// Firebase, email); a failed push says WHY instead of only logging it; and no secret ever
// appears in an answer. Stripe and Google are replaced by fakes, so nothing leaves the machine.
//   npm run test:setup

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkle-setup-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  DB_PATH: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  BACKUP_DIR: path.join(TMP, 'backups'),
  PORT: '3018',
  JWT_SECRET: 'setup-status-secret',
  STRIPE_SECRET_KEY: '', STRIPE_PUBLISHABLE_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_CONNECT_WEBHOOK_SECRET: '',
  FIREBASE_SERVICE_ACCOUNT_JSON: '',
  TURNSTILE_SECRET_KEY: '',
  SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
  FRONTEND_URL: 'https://sparkle.test',
  GEOCODE_PROVIDER: 'none',
});

const db = require('../db');
const { signToken } = require('../middleware/auth');
const { setupChecks, PAYMENT_EVENTS } = require('../lib/setupStatus');
require('../server');

// ── Fake Google: a token endpoint and Firebase Cloud Messaging ─────────────────
const realFetch = global.fetch;
const sentToFirebase = [];
let tokenOk = true;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'https://oauth2.googleapis.com/token') return tokenOk ? reply({ access_token: 'fake', expires_in: 3600 }) : reply({ error: 'invalid_grant' }, 400);
  if (u.startsWith('https://fcm.googleapis.com/')) {
    const { message } = JSON.parse(opts.body);
    sentToFirebase.push(message);
    if (message.token === 'dead-token') return reply({ error: { status: 'UNREGISTERED' } }, 404);
    if (message.token === 'denied-token') return reply({ error: { status: 'PERMISSION_DENIED' } }, 403);
    return reply({ name: 'projects/x/messages/1' });
  }
  return realFetch(url, opts);
};

const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function api(p, { method = 'GET', token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error('server did not start');
}

const byId = checks => Object.fromEntries(checks.map(c => [c.id, c]));
// Built in code, so this file never contains something shaped like a real Stripe webhook
// secret (launch-check's secrets scan would rightly flag it).
const fakeSigningSecret = tail => `${'whsec'}_${tail}`;
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const serviceAccount = project => JSON.stringify({
  type: 'service_account', project_id: project, private_key: PEM,
  client_email: `canary-bot@${project}.iam.gserviceaccount.com`,
});
// Words that must never come back from any answer.
const CANARIES = ['CANARYSECRETKEY', 'CANARYPUBLISHKEY', 'CANARYWEBHOOK', 'CANARYSMTP', 'BEGIN PRIVATE KEY', 'canary-bot@'];
const noCanaries = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const c of CANARIES) assert.ok(!text.includes(c), `${label} leaked "${c}"`);
};

async function main() {
  await waitForServer();
  for (const [id, role] of [['adm', 'admin'], ['cl', 'client']]) {
    db.prepare(`INSERT INTO users (id, role, first_name, last_name, email, password_hash, email_verified) VALUES (?, ?, ?, 'Test', ?, 'x', 1)`)
      .run(id, role, id, `${id}@setup.test`);
  }
  const admin = signToken({ id: 'adm', role: 'admin' });
  const client = signToken({ id: 'cl', role: 'client' });

  // ── Who may use it ─────────────────────────────────────────────────────────
  for (const [method, p] of [['GET', '/api/admin/setup-status'], ['POST', '/api/admin/push-test']]) {
    assert.equal((await api(p, { method })).status, 401, `${p}: signed out`);
    assert.equal((await api(p, { method, token: client })).status, 403, `${p}: a client`);
  }

  // ── Nothing connected yet ──────────────────────────────────────────────────
  process.env.SMTP_PASS = 'CANARYSMTP-password';       // set, but SMTP_HOST/USER aren't: still not "set up"
  process.env.STRIPE_WEBHOOK_SECRET = fakeSigningSecret('CANARYWEBHOOK1234567890');
  let res = await api('/api/admin/setup-status', { token: admin });
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  let c = byId(res.json.checks);
  assert.equal(c.payments.status, 'info', 'local development uses a pretend Stripe');
  assert.equal(c.push.status, 'bad');
  assert.match(c.push.detail, /FIREBASE_SERVICE_ACCOUNT_JSON/);
  assert.equal(c.email.status, 'info', 'captured in development, not sent');
  assert.equal(c.captcha.status, 'warn');
  assert.equal(c.frontend.status, 'ok');
  noCanaries('status', res.text);

  let pushTest = await api('/api/admin/push-test', { method: 'POST', token: admin });
  assert.equal(pushTest.status, 409);
  assert.match(pushTest.json.error, /Firebase isn't connected/);

  // ── Firebase connected, but no phone signed in ─────────────────────────────
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = serviceAccount('canary-project');
  res = await api('/api/admin/setup-status', { token: admin });
  c = byId(res.json.checks);
  assert.equal(c.push.status, 'ok', c.push.detail);
  assert.match(c.push.detail, /canary-project/);
  assert.match(c.push.detail, /No phone has the app signed in/);
  noCanaries('status with Firebase', res.text);

  pushTest = await api('/api/admin/push-test', { method: 'POST', token: admin });
  assert.equal(pushTest.status, 409);
  assert.match(pushTest.json.error, /No phone is signed in as you/);

  // ── A phone is signed in: the test notification arrives ────────────────────
  const addPhone = token => db.prepare(`INSERT INTO device_tokens (id, user_id, token, platform) VALUES (?, 'adm', ?, 'android')`).run(crypto.randomUUID(), token);
  addPhone('good-token');
  pushTest = await api('/api/admin/push-test', { method: 'POST', token: admin });
  assert.equal(pushTest.status, 200, pushTest.text);
  assert.match(pushTest.json.message, /Sent to 1 of 1 phone\./);
  const message = sentToFirebase.at(-1);
  assert.equal(message.token, 'good-token');
  assert.equal(message.notification.title, 'Sparkle test');
  assert.match((byId((await api('/api/admin/setup-status', { token: admin })).json.checks)).push.detail, /1 phone is signed in/);

  // ── Google refuses the key ─────────────────────────────────────────────────
  tokenOk = false;
  res = await api('/api/admin/setup-status', { token: admin });
  c = byId(res.json.checks);
  assert.equal(c.push.status, 'bad');
  assert.match(c.push.detail, /Google refused the key/);
  noCanaries('status with a refused key', res.text);
  // A different key forces a fresh token, so the refusal shows up on the real send too.
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = serviceAccount('other-project');
  pushTest = await api('/api/admin/push-test', { method: 'POST', token: admin });
  assert.equal(pushTest.status, 502);
  assert.match(pushTest.json.error, /credentials were refused/);
  tokenOk = true;

  // ── Firebase says why a message didn't go ──────────────────────────────────
  db.prepare("DELETE FROM device_tokens WHERE user_id = 'adm'").run();
  addPhone('dead-token');
  pushTest = await api('/api/admin/push-test', { method: 'POST', token: admin });
  assert.equal(pushTest.status, 502);
  assert.match(pushTest.json.error, /uninstalled or reinstalled/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_tokens WHERE token = 'dead-token'").get().n, 0, 'a dead phone is forgotten');

  addPhone('denied-token');
  pushTest = await api('/api/admin/push-test', { method: 'POST', token: admin });
  assert.equal(pushTest.status, 502);
  assert.match(pushTest.json.error, /Cloud Messaging API \(V1\)/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_tokens WHERE token = 'denied-token'").get().n, 1, 'a permissions problem is not the phone\'s fault, so it is kept');

  // ── Unreadable Firebase setting ────────────────────────────────────────────
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{ not json CANARYSECRETKEY';
  c = byId((await api('/api/admin/setup-status', { token: admin })).json.checks);
  assert.equal(c.push.status, 'bad');
  assert.match(c.push.detail, /can't be read/);
  noCanaries('status with an unreadable key', c.push.detail);
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '';

  // ── Stripe, against a fake Stripe ──────────────────────────────────────────
  const URL_ = 'https://api.sparkle.test/api/payments/webhook';
  const endpoint = (events, extra = {}) => ({ url: URL_, status: 'enabled', enabled_events: events, ...extra });
  const fakeStripe = ({ endpoints = [], keyError = null, listError = null } = {}) => ({
    balance: { retrieve: async () => { if (keyError) throw keyError; return {}; } },
    webhookEndpoints: { list: async () => { if (listError) throw listError; return { data: endpoints }; } },
  });
  const stripeEnv = (mode, extra = {}) => Object.assign(process.env, {
    STRIPE_SECRET_KEY: `sk_${mode}_CANARYSECRETKEY1234567890`,
    STRIPE_PUBLISHABLE_KEY: `pk_${mode}_CANARYPUBLISHKEY1234567890`,
    STRIPE_WEBHOOK_SECRET: fakeSigningSecret('CANARYWEBHOOK1234567890'),
    STRIPE_CONNECT_WEBHOOK_SECRET: fakeSigningSecret('CANARYWEBHOOKCONNECT123456'),
    ...extra,
  });
  const run = async (stripe) => {
    const checks = await setupChecks({ stripe, webhookUrl: URL_ });
    noCanaries('a Stripe check', checks);
    return byId(checks);
  };

  // everything in place
  stripeEnv('test');
  c = await run(fakeStripe({ endpoints: [endpoint(PAYMENT_EVENTS), endpoint(['account.updated'])] }));
  assert.equal(c.payments.status, 'ok'); assert.match(c.payments.detail, /Test mode/);
  assert.equal(c.publishable.status, 'ok');
  assert.equal(c['stripe-key'].status, 'ok');
  assert.equal(c['webhook-payments'].status, 'ok');
  assert.equal(c['webhook-accounts'].status, 'ok');
  assert.equal(c.connect.status, 'info');

  // wildcard events count
  c = await run(fakeStripe({ endpoints: [endpoint(['*'])] }));
  assert.equal(c['webhook-payments'].status, 'ok'); assert.equal(c['webhook-accounts'].status, 'ok');

  // a live key is flagged
  stripeEnv('live');
  c = await run(fakeStripe());
  assert.equal(c.payments.status, 'warn'); assert.match(c.payments.detail, /LIVE mode/);

  // the publishable key must match the secret key's mode
  stripeEnv('test', { STRIPE_PUBLISHABLE_KEY: 'pk_live_CANARYPUBLISHKEY1234567890' });
  c = await run(fakeStripe());
  assert.equal(c.publishable.status, 'bad');
  assert.match(c.publishable.detail, /pk_test_/);
  stripeEnv('test', { STRIPE_PUBLISHABLE_KEY: '' });
  assert.equal((await run(fakeStripe())).publishable.status, 'bad', 'missing publishable key');

  // Stripe refuses the key: said in our words, never theirs (their message can quote the key)
  stripeEnv('test');
  const refused = Object.assign(new Error('Invalid API Key provided: sk_test_CANARYSECRETKEY****'), { type: 'StripeAuthenticationError' });
  c = await run(fakeStripe({ keyError: refused }));
  assert.equal(c['stripe-key'].status, 'bad');
  assert.match(c['stripe-key'].detail, /rejected the secret key/);
  assert.ok(!c['webhook-payments'], 'no webhook questions with a key Stripe refuses');
  c = await run(fakeStripe({ keyError: Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }) }));
  assert.match(c['stripe-key'].detail, /couldn't reach Stripe/);

  // webhooks: endpoint without its secret, secret without its endpoint, wrong events, disabled
  stripeEnv('test', { STRIPE_WEBHOOK_SECRET: '', STRIPE_CONNECT_WEBHOOK_SECRET: '' });
  c = await run(fakeStripe({ endpoints: [endpoint(PAYMENT_EVENTS), endpoint(['account.updated'])] }));
  assert.equal(c['webhook-payments'].status, 'warn'); assert.match(c['webhook-payments'].detail, /STRIPE_WEBHOOK_SECRET/);
  assert.equal(c['webhook-accounts'].status, 'warn'); assert.match(c['webhook-accounts'].detail, /STRIPE_CONNECT_WEBHOOK_SECRET/);
  c = await run(fakeStripe());
  assert.equal(c['webhook-payments'].status, 'info', 'optional, so not an error');
  assert.equal(c['webhook-accounts'].status, 'info');

  stripeEnv('test');
  c = await run(fakeStripe({ endpoints: [endpoint(['payment_intent.succeeded'])] }));
  assert.equal(c['webhook-payments'].status, 'warn', 'only some of the events');
  c = await run(fakeStripe({ endpoints: [endpoint(PAYMENT_EVENTS, { status: 'disabled' })] }));
  assert.equal(c['webhook-payments'].status, 'warn', 'a disabled endpoint is not an endpoint');
  c = await run(fakeStripe({ endpoints: [{ ...endpoint(PAYMENT_EVENTS), url: 'https://elsewhere.test/hook' }] }));
  assert.equal(c['webhook-payments'].status, 'warn', 'an endpoint somewhere else is not ours');

  // a restricted key can't list webhooks: say so, don't fail
  c = await run(fakeStripe({ listError: new Error('permission') }));
  assert.equal(c.webhooks.status, 'info');
  assert.equal(c['stripe-key'].status, 'ok');

  // production with no key: bookings are off
  process.env.STRIPE_SECRET_KEY = '';
  const mode = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { c = await run(fakeStripe()); } finally { process.env.NODE_ENV = mode; }
  assert.equal(c.payments.status, 'bad'); assert.match(c.payments.detail, /nobody can book/);

  console.log('Setup status tests passed: access, Stripe checks, Firebase checks, test notification, failure reasons, no secrets.');
}

main()
  .then(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
