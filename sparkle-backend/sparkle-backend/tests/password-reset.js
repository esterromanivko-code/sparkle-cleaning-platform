'use strict';
// tests/password-reset.js — forgotten passwords, and the links in Sparkle's emails.
//
// Pins what went wrong: the app had no "Forgot password" button; the emailed link led to
// a page that doesn't exist; with no SMTP the server "sent" reset links to a public test
// inbox; and the reply came back faster for real accounts than for made-up ones.
//   npm run test:reset

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkle-reset-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  DB_PATH: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  BACKUP_DIR: path.join(TMP, 'backups'),
  PORT: '3017',
  JWT_SECRET: 'password-reset-secret',
  STRIPE_SECRET_KEY: '',
  TURNSTILE_SECRET_KEY: '',
  SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
  FRONTEND_URL: 'https://sparkle.test',
  GEOCODE_PROVIDER: 'none',
});

const bcrypt = require('bcryptjs');
const db = require('../db');
const email = require('../lib/email');
require('../server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let ip = 0;
async function api(p, { method = 'GET', body } = {}) {
  const headers = { 'X-Forwarded-For': `10.33.${Math.floor(++ip / 250)}.${ip % 250}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error('server did not start');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The reset email is sent without the request waiting for it, so look for it briefly.
async function nextEmail(count) {
  for (let i = 0; i < 40 && email.outbox.length <= count; i++) await sleep(50);
  return email.outbox.length > count ? email.outbox[email.outbox.length - 1] : null;
}
const tokenIn = message => (message.html.match(/https:\/\/sparkle\.test\/app#reset=([0-9a-f]{64})/) || [])[1];
const forgot = address => api('/api/auth/forgot-password', { method: 'POST', body: { email: address } });
const login = (address, password) => api('/api/auth/login', { method: 'POST', body: { email: address, password } });
const OLD = 'OldPassw0rd!';
const NEW = 'BrandNewPass1!';
// Lets a second request through without waiting out the one-a-minute limit.
const ageTokens = userId => db.prepare("UPDATE password_reset_tokens SET created_at = datetime('now', '-5 minutes') WHERE user_id = ?").run(userId);

async function main() {
  await waitForServer();
  const hash = bcrypt.hashSync(OLD, 10);
  const user = (id, address, extra = '') => {
    db.prepare(`INSERT INTO users (id, role, first_name, last_name, email, password_hash, email_verified) VALUES (?, 'client', ?, 'Tester', ?, ?, 1)`)
      .run(id, id === 'pat' ? '<b>Pat</b>' : id, address, hash);
    db.prepare('INSERT INTO client_profiles (user_id) VALUES (?)').run(id);
    if (extra) db.prepare(`UPDATE users SET ${extra} WHERE id = ?`).run(id);
  };
  user('pat', 'pat@reset.test');
  user('banned', 'banned@reset.test', 'is_active = 0');
  user('gone', 'gone@reset.test', "deleted_at = datetime('now')");

  // ── The app can tell whether email works ───────────────────────────────────
  assert.equal((await api('/api/config')).json.email_enabled, true, 'outside production, mail is captured so the flow can be tried');

  // ── Asking for a link ──────────────────────────────────────────────────────
  assert.equal((await forgot('not-an-email')).status, 422);

  const unknown = await forgot('nobody@reset.test');
  const known = await forgot('pat@reset.test');
  assert.equal(unknown.status, 200);
  assert.equal(known.status, 200);
  assert.deepEqual(unknown.json, known.json, 'the answer never reveals whether an account exists');

  const mail = await nextEmail(0);
  assert.ok(mail, 'a real account is emailed');
  assert.equal(email.outbox.length, 1, 'and an unknown address is not');
  assert.equal(mail.to, 'pat@reset.test');
  assert.equal(mail.subject, 'Reset your Sparkle password');
  const token = tokenIn(mail);
  assert.ok(token, `the email links to the app with the token in the #fragment: ${mail.html.slice(0, 80)}`);
  assert.ok(!/undefined/.test(mail.html), 'no broken address in the email');
  assert.ok(!/\/reset-password/.test(mail.html), 'the old link to a page that does not exist is gone');
  assert.ok(mail.html.includes('&lt;b&gt;Pat&lt;/b&gt;') && !mail.html.includes('<b>Pat</b>'), "a person's name is escaped in the email");
  const row = db.prepare('SELECT token_hash FROM password_reset_tokens WHERE user_id = ?').get('pat');
  assert.ok(row && row.token_hash !== token, 'only a hash of the token is stored');

  assert.equal((await forgot('pat@reset.test')).status, 200);
  await sleep(150);
  assert.equal(email.outbox.length, 1, 'asking again within a minute sends nothing more');

  await forgot('banned@reset.test'); await forgot('gone@reset.test');
  await sleep(150);
  assert.equal(email.outbox.length, 1, 'a suspended or deleted account is not emailed');

  // ── Checking the link ──────────────────────────────────────────────────────
  assert.equal((await api('/api/auth/verify-reset-token', { method: 'POST', body: { token } })).json.valid, true);
  assert.equal((await api('/api/auth/verify-reset-token', { method: 'POST', body: { token: 'f'.repeat(64) } })).json.valid, false);

  // ── Choosing a new password ────────────────────────────────────────────────
  const before = (await login('pat@reset.test', OLD)).json;
  assert.ok(before.refresh_token, 'signed in on another device before the reset');

  assert.equal((await api('/api/auth/reset-password', { method: 'POST', body: { token, new_password: 'short' } })).status, 422, 'too short');
  const wrong = await api('/api/auth/reset-password', { method: 'POST', body: { token: 'f'.repeat(64), new_password: NEW } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /invalid or has expired/);

  const done = await api('/api/auth/reset-password', { method: 'POST', body: { token, new_password: NEW } });
  assert.equal(done.status, 200, done.text);
  assert.equal((await login('pat@reset.test', OLD)).status, 401, 'the old password stops working');
  assert.equal((await login('pat@reset.test', NEW)).status, 200, 'the new one works');
  assert.equal((await api('/api/auth/refresh', { method: 'POST', body: { refresh_token: before.refresh_token } })).status, 401, 'other devices are signed out');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = 'pat' AND type = 'password_changed'").get().n, 1, 'and the account is told');

  assert.equal((await api('/api/auth/reset-password', { method: 'POST', body: { token, new_password: 'AnotherPass22!' } })).status, 400, 'a link works once');
  assert.equal((await api('/api/auth/verify-reset-token', { method: 'POST', body: { token } })).json.valid, false);

  // ── Links expire, and a newer link replaces an older one ───────────────────
  ageTokens('pat');
  await forgot('pat@reset.test');
  const second = tokenIn(await nextEmail(1));
  ageTokens('pat');
  await forgot('pat@reset.test');
  const third = tokenIn(await nextEmail(2));
  assert.ok(second && third && second !== third);
  assert.equal((await api('/api/auth/verify-reset-token', { method: 'POST', body: { token: second } })).json.valid, false, 'asking again cancels the earlier link');
  assert.equal((await api('/api/auth/verify-reset-token', { method: 'POST', body: { token: third } })).json.valid, true);

  db.prepare("UPDATE password_reset_tokens SET expires_at = datetime('now', '-1 minute') WHERE user_id = 'pat'").run();
  assert.equal((await api('/api/auth/reset-password', { method: 'POST', body: { token: third, new_password: NEW + 'x' } })).status, 400, 'an hour-old link no longer works');

  // ── Resetting one account kills every outstanding link for it ──────────────
  ageTokens('pat');
  await forgot('pat@reset.test');
  const fourth = tokenIn(await nextEmail(3));
  db.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .run('extra', 'pat', require('crypto').createHash('sha256').update('e'.repeat(64)).digest('hex'), new Date(Date.now() + 3600e3).toISOString());
  assert.equal((await api('/api/auth/reset-password', { method: 'POST', body: { token: fourth, new_password: NEW } })).status, 200);
  assert.equal((await api('/api/auth/verify-reset-token', { method: 'POST', body: { token: 'e'.repeat(64) } })).json.valid, false, 'another open link died with it');

  // ── With no way to send mail, say so instead of pretending ─────────────────
  const outboxBefore = email.outbox.length;
  const mode = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(email.emailEnabled(), false, 'production without SMTP cannot send');
    assert.equal((await api('/api/config')).json.email_enabled, false, 'and tells the app');
    const refused = await forgot('pat@reset.test');
    assert.equal(refused.status, 503);
    assert.equal(refused.json.code, 'EMAIL_UNAVAILABLE');
    assert.deepEqual(await email.sendEmail({ to: 'a@b.test', subject: 's', html: '<p>x</p>' }), { ok: false, error: 'Email is not configured' });
  } finally { process.env.NODE_ENV = mode; }
  assert.equal(email.outbox.length, outboxBefore, 'nothing was handed to a test inbox or anyone else');

  // ── Email verification links point somewhere real ──────────────────────────
  const { sendVerificationEmail } = require('../routes/emailVerification');
  await sendVerificationEmail('pat', 'pat@reset.test', 'Pat');
  const verify = email.outbox[email.outbox.length - 1];
  const verifyToken = (verify.html.match(/https:\/\/sparkle\.test\/app#verify=([0-9a-f]{64})/) || [])[1];
  assert.ok(verifyToken, 'the verification email opens the app, not a page that does not exist');
  db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run('pat');
  const verified = await api(`/api/verify-email/${verifyToken}`);
  assert.equal(verified.status, 200, verified.text);
  assert.equal(db.prepare("SELECT email_verified FROM users WHERE id = 'pat'").get().email_verified, 1);
  assert.equal((await api(`/api/verify-email/${verifyToken}`)).status, 400, 'a verification link works once');

  console.log('Password reset tests passed: request, email link, new password, expiry, supersession, no-email honesty, verification link.');
}

main()
  .then(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
