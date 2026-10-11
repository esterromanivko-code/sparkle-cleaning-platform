'use strict';
// tests/mobile.js — what the phone apps depend on: registering a device for push
// notifications, and the app's own origin being recognised by CORS.
//   npm run test:mobile

const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkle-mobile-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  DB_PATH: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  BACKUP_DIR: path.join(TMP, 'backups'),
  PORT: '3014',
  JWT_SECRET: 'mobile-test-secret',
  STRIPE_SECRET_KEY: '',
  TURNSTILE_SECRET_KEY: '',
  FIREBASE_SERVICE_ACCOUNT_JSON: '',      // push switched off
  GEOCODE_PROVIDER: 'none',
});

const db = require('../db');
const { signToken } = require('../middleware/auth');
const { hostOf, appReturnUrl } = require('../lib/frontendUrls');
const { pushEnabled, pushToUser } = require('../lib/push');
const { notify } = require('../lib/notify');
const { deleteAccountData } = require('../lib/accountDeletion');
require('../server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let ip = 0;
async function api(p, { method = 'GET', token, body } = {}) {
  const headers = { 'X-Forwarded-For': `10.55.${Math.floor(++ip / 250)}.${ip % 250}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 300) };
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error('server did not start');
}

const T = {};
function user(id, role) {
  db.prepare('INSERT INTO users (id, role, first_name, last_name, email, password_hash) VALUES (?,?,?,?,?,?)')
    .run(id, role, id, 'Test', `${id}@mob.local`, 'x');
  if (role === 'cleaner') db.prepare('INSERT INTO cleaner_profiles (user_id) VALUES (?)').run(id);
  if (role === 'client') db.prepare('INSERT INTO client_profiles (user_id) VALUES (?)').run(id);
  T[id] = signToken({ id, role });
}
const devicesOf = userId => db.prepare('SELECT token, platform FROM device_tokens WHERE user_id = ?').all(userId);
const PHONE = 'fcm-token-' + 'a'.repeat(40);

async function main() {
  await waitForServer();
  user('cn', 'cleaner');
  user('cl', 'client');

  // ── The app's own origins ──────────────────────────────────────────────────
  assert.equal(hostOf('capacitor://localhost'), 'localhost', 'the iOS app talks from capacitor://localhost');
  assert.equal(hostOf('https://localhost'), 'localhost', 'the Android app talks from https://localhost');
  assert.equal(hostOf('https://sparklecleaningplatform.netlify.app/'), 'sparklecleaningplatform.netlify.app');
  assert.equal(hostOf('capacitor://evil.example'), 'evil.example', 'a scheme cannot smuggle another host through');
  assert.ok(appReturnUrl('capacitor://localhost/app').startsWith('http'), 'Stripe is always sent back to a web page');

  // ── Registering a phone ────────────────────────────────────────────────────
  assert.equal((await api('/api/devices', { method: 'POST', body: { token: PHONE, platform: 'ios' } })).status, 401, 'signed out, no device');
  assert.equal((await api('/api/devices', { method: 'POST', token: T.cn, body: { token: 'short', platform: 'ios' } })).status, 422);

  const registered = await api('/api/devices', { method: 'POST', token: T.cn, body: { token: PHONE, platform: 'ios' } });
  assert.equal(registered.status, 200, registered.text);
  assert.equal(registered.json.push_enabled, false, 'push is off until Firebase credentials are set');
  assert.deepEqual(devicesOf('cn').map(d => d.platform), ['ios']);

  await api('/api/devices', { method: 'POST', token: T.cn, body: { token: PHONE, platform: 'ios' } });
  assert.equal(devicesOf('cn').length, 1, 'registering the same phone again keeps one row');

  // A shared phone: whoever signs in last gets that phone's notifications.
  await api('/api/devices', { method: 'POST', token: T.cl, body: { token: PHONE, platform: 'ios' } });
  assert.equal(devicesOf('cn').length, 0);
  assert.equal(devicesOf('cl').length, 1);
  await api('/api/devices', { method: 'POST', token: T.cn, body: { token: PHONE, platform: 'ios' } });

  // ── Sending, with push switched off ────────────────────────────────────────
  assert.equal(pushEnabled(), false);
  assert.deepEqual(await pushToUser('cn', { title: 'Hi', body: 'There' }), { sent: 0, skipped: true });
  notify('cn', '🎉 You were chosen!', 'A client picked your quote.', 'bid_chosen');
  await new Promise(r => setImmediate(r));           // the push attempt runs after the insert
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = 'cn'").get().n, 1,
    'the notification is stored whether or not a push goes out');

  // ── Signing out, and deleting the account ──────────────────────────────────
  assert.equal((await api('/api/devices', { method: 'DELETE', token: T.cl, body: { token: PHONE } })).status, 200);
  assert.equal(devicesOf('cn').length, 1, "signing out elsewhere doesn't unregister someone else's phone");
  assert.equal((await api('/api/devices', { method: 'DELETE', token: T.cn, body: { token: PHONE } })).status, 200);
  assert.equal(devicesOf('cn').length, 0);

  await api('/api/devices', { method: 'POST', token: T.cl, body: { token: PHONE, platform: 'android' } });
  deleteAccountData(db.prepare("SELECT * FROM users WHERE id = 'cl'").get());
  assert.equal(devicesOf('cl').length, 0, 'a deleted account stops receiving push notifications');

  console.log('Mobile tests passed: app origins, device registration, shared phones, sign-out, account deletion.');
}

main()
  .then(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
