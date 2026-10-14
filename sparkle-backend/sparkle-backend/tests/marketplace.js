'use strict';
// tests/marketplace.js — what a client enters, what a cleaner may see, and what stays
// private. Each section pins a real mistake that was found in review:
//   A. the admin backup endpoints answered anyone when ADMIN_KEY was unset
//   B. a cleaner's profile (public!) carried their Stripe account and bank label
//   C. every cleaner saw every open job's street address, map position and door-code notes
//   D. the job form's details were never sent, and the server accepted nonsense
//   E. open jobs never expired, even after their date
//   F. the "suspicious request" filter rejected ordinary sentences
//   npm run test:marketplace

const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkle-market-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  DB_PATH: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  BACKUP_DIR: path.join(TMP, 'backups'),
  PORT: '3015',
  JWT_SECRET: 'marketplace-test-secret',
  STRIPE_SECRET_KEY: '',
  TURNSTILE_SECRET_KEY: '',
  ADMIN_KEY: '',                 // the unset case that used to be fatal
  GEOCODE_PROVIDER: 'none',
});

const db = require('../db');
const { signToken } = require('../middleware/auth');
const { runExpirySweep } = require('../lib/expiry');
require('../server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let ip = 0;
async function api(p, { method = 'GET', token, body } = {}) {
  const headers = { 'X-Forwarded-For': `10.66.${Math.floor(++ip / 250)}.${ip % 250}` };
  if (token) headers.Authorization = `Bearer ${token}`;
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

const T = {};
function user(id, role, first, last) {
  db.prepare('INSERT INTO users (id, role, first_name, last_name, email, phone, password_hash) VALUES (?,?,?,?,?,?,?)')
    .run(id, role, first, last, `${id}@market.local`, '(206) 555-0142', 'x');
  if (role === 'cleaner') db.prepare('INSERT INTO cleaner_profiles (user_id, bio, avg_rating, total_jobs) VALUES (?, ?, 4.8, 12)').run(id, 'Detail-obsessed.');
  if (role === 'client') db.prepare('INSERT INTO client_profiles (user_id, default_address) VALUES (?, ?)').run(id, '1 Home St');
  T[id] = signToken({ id, role });
}
const inDays = d => new Date(Date.now() + d * 86400000).toISOString();
const leaks = (text, needles) => needles.filter(n => text.includes(n));

// Values that must never reach someone they don't belong to.
const CANARY = {
  connect: 'acct_CANARY0CONNECT',
  bank: 'CANARYBANK •••• 0000',
  street: '742 Canary Lane',
  door: 'DOORCODE-CANARY-9931',
  email: 'cara@market.local',
};

async function main() {
  await waitForServer();
  user('cl', 'client', 'Cara', 'Tester'); user('cn', 'cleaner', 'Cleo', 'Cleaner'); user('cn2', 'cleaner', 'Otto', 'Other'); user('adm', 'admin', 'Ada', 'Admin');
  db.prepare('UPDATE cleaner_profiles SET stripe_connect_id = ?, payout_method_label = ?, payout_bank_last4 = ?, total_earnings = 9999 WHERE user_id = ?')
    .run(CANARY.connect, CANARY.bank, '0000', 'cn');

  // ── A. Admin-only backup endpoints ─────────────────────────────────────────
  assert.equal((await api('/api/admin/backups')).status, 401, 'signed out');
  assert.equal((await api('/api/admin/backups', { token: T.cl })).status, 403, 'a client');
  assert.equal((await api('/api/admin/backups', { token: T.cn })).status, 403, 'a cleaner');
  assert.equal((await api('/api/admin/backups/run', { method: 'POST' })).status, 401, 'signed out may not start one');
  assert.equal((await api('/api/admin/backups', { token: T.adm })).status, 200, 'an admin');

  // ── B. A cleaner's profile and reviews ─────────────────────────────────────
  db.prepare("INSERT INTO jobs (id, client_id, cleaner_id, service_type, address, scheduled_at, status) VALUES ('jr', 'cl', 'cn', 'Deep clean', 'x', '2026-01-01T10:00:00Z', 'completed')").run();
  db.prepare("INSERT INTO reviews (id, job_id, reviewer_id, reviewee_id, rating, body) VALUES ('rv', 'jr', 'cl', 'cn', 5, 'Spotless')").run();

  assert.equal((await api('/api/profile/cleaner/cn')).status, 401, 'profiles need a sign-in');
  assert.equal((await api('/api/reviews/cn')).status, 401, 'reviews need a sign-in');
  const prof = await api('/api/profile/cleaner/cn', { token: T.cl });
  assert.equal(prof.status, 200);
  assert.deepEqual(leaks(prof.text, [CANARY.connect, CANARY.bank, 'stripe_connect_id', 'payout_', 'total_earnings', 'pro_expires_at', 'password']), [], 'no private columns');
  assert.equal(prof.json.profile.bio, 'Detail-obsessed.');
  assert.equal(prof.json.profile.avg_rating, 4.8);
  assert.equal(prof.json.reviews[0].last_name, 'T.', 'the reviewer is shown as first name and last initial');
  const revs = await api('/api/reviews/cn', { token: T.cn2 });
  assert.equal(revs.json.reviews[0].last_name, 'T.');
  assert.equal(leaks(revs.text, ['reviewer_id', 'reviewee_id', 'job_id']).length, 0, 'no internal ids in reviews');

  // ── D. Posting a job: everything is kept, and nonsense is refused ──────────
  const full = {
    service_type: 'Move-out clean', bedrooms: 0, bathrooms: 2, address: `${CANARY.street}, Testville, WA 98000`,
    scheduled_at: inDays(4), arrival_window: 'Morning 8–12pm', supplies_by: 'cleaner', pets: 'Dog(s)',
    notes: `Gate code ${CANARY.door}. Please delete the old notes from the table and update me when done.`,
    is_recurring: true, recurring_freq: 'weekly',
  };
  const posted = await api('/api/jobs', { method: 'POST', token: T.cl, body: full });
  assert.equal(posted.status, 201, posted.text);                       // (F: an ordinary sentence is not an attack)
  const J1 = posted.json.job_id;
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(J1);
  assert.equal(row.bedrooms, 0, 'a studio is stored as 0, not dropped as "falsy"');
  assert.equal(row.bathrooms, 2);
  assert.equal(row.supplies_by, 'cleaner');
  assert.equal(row.pets, 'Dog(s)');
  assert.equal(row.arrival_window, 'Morning 8–12pm');
  assert.equal(row.is_recurring, 1);
  assert.equal(row.recurring_freq, 'weekly');
  assert.ok(row.notes.includes(CANARY.door));

  const bad = body => api('/api/jobs', { method: 'POST', token: T.cl, body: { ...full, ...body } });
  assert.equal((await bad({ scheduled_at: inDays(-1) })).status, 422, 'a past date');
  assert.equal((await bad({ supplies_by: 'robot' })).status, 422, 'an unknown supplies option');
  assert.equal((await bad({ address: 'x' })).status, 422, 'a too-short address');
  assert.equal((await bad({ notes: 'x'.repeat(1501) })).status, 422, 'over-long instructions');
  assert.equal((await bad({ bedrooms: 99 })).status, 422);
  assert.equal((await bad({ recurring_freq: 'daily' })).status, 422);
  assert.equal((await api('/api/jobs', { method: 'POST', token: T.cn, body: full })).status, 403, 'only clients post jobs');

  // ── C. What a cleaner sees before being booked ─────────────────────────────
  const open = await api('/api/jobs/available', { token: T.cn });
  assert.equal(open.status, 200, open.text);
  const listed = open.json.jobs.find(j => j.id === J1);
  assert.ok(listed, 'the open job is listed');
  assert.deepEqual(leaks(open.text, [CANARY.street, CANARY.door, CANARY.email, '"address"', '"notes"', '"lat"', '"lng"', 'client_id', 'payment', 'stripe']), [],
    'no street address, map position, instructions, ids or payment details before booking');
  assert.equal(listed.area, 'Testville, WA 98000', 'only the general area');
  assert.equal(listed.client_name, 'Cara T.', 'first name and last initial');
  assert.equal(listed.bedrooms, 0);
  assert.equal(listed.supplies_by, 'cleaner');
  assert.equal(listed.pets, 'Dog(s)');
  assert.equal(listed.arrival_window, 'Morning 8–12pm');
  assert.equal(listed.recurring_freq, 'weekly');
  assert.equal(listed.already_bid, false);
  assert.equal((await api('/api/jobs/available', { token: T.cl })).status, 403, 'clients do not browse open jobs');

  // A quote marks it, for that cleaner only.
  const quoted = await api('/api/bids', { method: 'POST', token: T.cn, body: { job_id: J1, amount: 120, message: 'I bring my own supplies and finish in three hours.' } });
  assert.equal(quoted.status, 201, quoted.text);
  assert.equal((await api('/api/jobs/available', { token: T.cn })).json.jobs.find(j => j.id === J1).already_bid, true);
  assert.equal((await api('/api/jobs/available', { token: T.cn2 })).json.jobs.find(j => j.id === J1).already_bid, false);

  // The notes and address reach only the cleaner the client books.
  db.prepare("UPDATE jobs SET status = 'accepted', cleaner_id = 'cn' WHERE id = ?").run(J1);
  const mine = (await api('/api/jobs/my-schedule', { token: T.cn })).json.jobs.find(j => j.id === J1);
  assert.ok(mine.notes.includes(CANARY.door), 'the booked cleaner sees the instructions');
  assert.ok(mine.address.includes(CANARY.street), 'and the address');
  assert.equal(mine.payment_method_id, undefined, 'but never the client card');
  const theirs = await api('/api/jobs/my-schedule', { token: T.cn2 });
  assert.deepEqual(leaks(theirs.text, [CANARY.street, CANARY.door]), [], 'another cleaner sees none of it');
  assert.equal((await api('/api/jobs/available', { token: T.cn2 })).json.jobs.some(j => j.id === J1), false, 'and a booked job leaves the open list');

  // ── E. Jobs expire ─────────────────────────────────────────────────────────
  const makeOpen = (id, scheduled, createdAt) => db.prepare(`
    INSERT INTO jobs (id, client_id, service_type, address, scheduled_at, status, created_at)
    VALUES (?, 'cl', 'Standard clean', '9 Pine St, Testville, WA 98000', ?, 'open', ?)`).run(id, scheduled, createdAt);
  makeOpen('jPast', inDays(-1), "datetime('now')");                    // placeholder, replaced below
  db.prepare("UPDATE jobs SET created_at = datetime('now', '-2 hours') WHERE id = 'jPast'").run();
  makeOpen('jStale', inDays(5), '1970-01-01 00:00:00');
  db.prepare("UPDATE jobs SET created_at = datetime('now', '-49 hours') WHERE id = 'jStale'").run();
  makeOpen('jLive', inDays(5), '1970-01-01 00:00:00');
  db.prepare("UPDATE jobs SET created_at = datetime('now', '-49 hours') WHERE id = 'jLive'").run();
  db.prepare(`INSERT INTO bids (id, job_id, cleaner_id, amount, message, success_fee, expires_at)
              VALUES ('bLive', 'jLive', 'cn2', 90, 'Happy to take this one on for you.', 9, datetime('now', '+1 day'))`).run();
  makeOpen('jFresh', inDays(5), '1970-01-01 00:00:00');
  db.prepare("UPDATE jobs SET created_at = datetime('now', '-1 hours') WHERE id = 'jFresh'").run();

  assert.equal((await api('/api/jobs/available', { token: T.cn2 })).json.jobs.some(j => j.id === 'jPast'), false, 'a job whose date has passed is not listed even before the sweep');
  const swept = runExpirySweep();
  assert.equal(swept.expired_jobs, 2, 'the past job and the stale one');
  const status = id => db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status;
  assert.equal(status('jPast'), 'cancelled');
  assert.equal(status('jStale'), 'cancelled');
  assert.equal(status('jLive'), 'open', 'a job with a live quote stays open');
  assert.equal(status('jFresh'), 'open', 'and so does a new one');
  assert.equal(status(J1), 'accepted', 'a booked job is never touched');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = 'cl' AND type = 'job_expired'").get().n, 2, 'the client is told, once per job');
  assert.equal(runExpirySweep().expired_jobs, 0, 'running it again does nothing');
  assert.equal((await api('/api/bids/expire', { method: 'POST', token: T.cn })).status, 403, 'only admins can run it by hand');

  // ── F. The request filter keeps real attacks out, not real sentences ───────
  const ticket = message => api('/api/support/tickets', { method: 'POST', body: { name: 'Pat', email: 'pat@market.local', subject: 'Question', message } });
  assert.equal((await ticket('Please update the table and delete the dirty dishes from the sink, then select a time where we are both free.')).status, 201);
  assert.equal((await ticket('Come in on time = great, only = fine')).status, 201);
  assert.equal((await ticket('see ../../etc/passwd')).status, 400, 'path traversal is still refused');
  assert.equal((await ticket('javascript:alert(1)')).status, 400, 'script URLs are still refused');
  // The same input twice in a row gets the same answer (a /g regex used to remember the last match).
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push((await ticket('see ../../etc/passwd')).status);
  assert.deepEqual(answers, [400, 400, 400, 400]);

  console.log('Marketplace tests passed: admin-only backups, private profiles, open-job privacy, full job details, expiry, request filter.');
}

main()
  .then(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
