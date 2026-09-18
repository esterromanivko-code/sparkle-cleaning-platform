'use strict';
// tests/job-photos.js — before/after photos, disputes, cashouts and refunds, end to end.
// Runs against a throwaway database and upload folder with Stripe mocked:
//   npm run test:photos

const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkle-photos-'));
// Set before anything loads .env — dotenv never overrides a variable that is already set.
Object.assign(process.env, {
  NODE_ENV: 'development',
  DB_PATH: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  BACKUP_DIR: path.join(TMP, 'backups'),
  PORT: '3011',
  JWT_SECRET: 'job-photos-test-secret',
  STRIPE_SECRET_KEY: '',          // mock Stripe
  TURNSTILE_SECRET_KEY: '',
  INSTANT_CASHOUT_FEE: '10',
});

const sharp = require('sharp');
const db = require('../db');
const { signToken } = require('../middleware/auth');
require('../server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let ipCounter = 0;

// Every request gets its own client IP (the server trusts one proxy hop), so the
// per-IP limiters — notably 5 cashouts an hour — don't trip over this test.
async function api(p, { method = 'GET', token, body, form } = {}) {
  const headers = { 'X-Forwarded-For': `10.77.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: res.status, json, buf, headers: res.headers, text: buf.toString('utf8').slice(0, 300) };
}

function upload(token, jobId, stage, buf, { type = 'image/jpeg', disputeId, clientUploadId } = {}) {
  const qs = new URLSearchParams({ stage });
  if (disputeId) qs.set('dispute_id', disputeId);
  if (clientUploadId) qs.set('client_upload_id', clientUploadId);
  const form = new FormData();
  form.append('photo', new Blob([buf], { type }), 'photo.jpg');
  return api(`/api/job-photos/${encodeURIComponent(jobId)}?${qs}`, { method: 'POST', token, form });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

const ids = { client: 'pt-client', cleaner: 'pt-cleaner', stranger: 'pt-stranger', admin: 'pt-admin' };

function seed() {
  const u = db.prepare('INSERT INTO users (id, role, first_name, last_name, email, password_hash) VALUES (?,?,?,?,?,?)');
  u.run(ids.client, 'client', 'Cara', 'Client', 'client@pt.local', 'x');
  u.run(ids.cleaner, 'cleaner', 'Cleo', 'Cleaner', 'cleaner@pt.local', 'x');
  u.run(ids.stranger, 'cleaner', 'Stan', 'Stranger', 'stranger@pt.local', 'x');
  u.run(ids.admin, 'admin', 'Ada', 'Admin', 'admin@pt.local', 'x');
  db.prepare('INSERT INTO client_profiles (user_id, default_address) VALUES (?, ?)').run(ids.client, '1 Test St');
  const cp = db.prepare('INSERT INTO cleaner_profiles (user_id, hourly_rate, stripe_connect_id, lockout_fee_enabled, lockout_fee_amount) VALUES (?,?,?,?,?)');
  cp.run(ids.cleaner, 35, 'acct_test_cleaner', 1, 35);
  cp.run(ids.stranger, 35, 'acct_test_stranger', 0, 0);
  db.prepare('UPDATE cleaner_profiles SET connect_payouts_enabled = 1').run();
  db.prepare("UPDATE users SET stripe_customer_id = 'cus_pt_client' WHERE id = ?").run(ids.client);
}

// A booked job is paid with a saved card that already has a hold on it.
function seedJob(id, status = 'accepted', cleanerId = ids.cleaner) {
  const booked = !!cleanerId;
  db.prepare(`
    INSERT INTO jobs (id, client_id, cleaner_id, service_type, address, scheduled_at, status, base_amount, platform_fee, total_charged,
                      payment_method_id, auth_status, stripe_payment_intent_id)
    VALUES (?, ?, ?, 'Deep clean', '1 Test St', '2026-09-20T10:00:00.000Z', ?, 100, 8, 108, ?, ?, ?)
  `).run(id, ids.client, cleanerId, status,
         booked ? 'pm_card_visa' : null, booked ? 'authorized' : null, booked ? `pi_seeded_${id}` : null);
  return id;
}

async function main() {
  await waitForServer();
  seed();
  const T = {};
  for (const [k, id] of Object.entries(ids)) {
    T[k] = signToken({ id, role: db.prepare('SELECT role FROM users WHERE id = ?').get(id).role });
  }

  const img = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#88aacc' } })
    .withExif({ IFD0: { Make: 'SparkleTestCam', Model: 'GPS-Probe' } })
    .jpeg().toBuffer();
  assert.ok((await sharp(img).metadata()).exif, 'source image should carry EXIF');

  const earnings = async () => (await api('/api/earnings', { token: T.cleaner })).json;
  const cashout = (type = 'standard') => api('/api/earnings/cashout', { method: 'POST', token: T.cleaner, body: { type } });
  const dispute = (jobId, type = 'quality') => api('/api/disputes', {
    method: 'POST', token: T.client, body: { job_id: jobId, type, description: 'The bathroom was not cleaned at all.' },
  });
  const resolve = (id, ruling) => api(`/api/admin/disputes/${id}/resolve`, {
    method: 'POST', token: T.admin, body: { ruling, resolution: 'Reviewed the photos from both sides.' },
  });
  async function completeJob(jobId) {
    assert.equal((await api(`/api/jobs/${jobId}/arrive`, { method: 'POST', token: T.cleaner })).status, 200);
    assert.equal((await upload(T.cleaner, jobId, 'before', img)).status, 201);
    assert.equal((await upload(T.cleaner, jobId, 'after', img)).status, 201);
    const r = await api(`/api/jobs/${jobId}/complete`, { method: 'POST', token: T.cleaner });
    assert.equal(r.status, 200, r.text);
    return r;
  }

  // ── A. Uploading proof photos ──────────────────────────────────────────────
  const A = seedJob('pt-job-a');
  assert.equal((await upload(T.stranger, A, 'before', img)).status, 404, 'a stranger cannot see the job exists');
  assert.equal((await upload(T.client, A, 'before', img)).status, 403, 'clients do not take before photos');
  assert.equal((await upload(T.cleaner, A, 'after', img)).status, 409, 'no after photos before arriving');
  assert.equal((await upload(T.cleaner, A, 'sideways', img)).status, 422);
  assert.equal((await upload(T.cleaner, A, 'before', Buffer.from('definitely not a jpeg at all'))).status, 415);
  assert.equal((await upload(T.cleaner, A, 'before', img, { type: 'text/plain' })).status, 415);

  const first = await upload(T.cleaner, A, 'before', img, { clientUploadId: 'retry-abc-123' });
  assert.equal(first.status, 201, first.text);
  assert.equal(first.json.counts.before, 1);
  const retry = await upload(T.cleaner, A, 'before', img, { clientUploadId: 'retry-abc-123' });
  assert.equal(retry.status, 200, 'a retried upload returns the stored photo');
  assert.equal(retry.json.photo.id, first.json.photo.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_photos WHERE job_id = ?').get(A).n, 1);

  const row = db.prepare('SELECT * FROM job_photos WHERE id = ?').get(first.json.photo.id);
  const stored = path.join(process.env.UPLOAD_DIR, 'job-photos', row.filename);
  assert.ok(fs.existsSync(stored), 'photo written to the private folder');
  const meta = await sharp(stored).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.exif, undefined, 'EXIF (and any GPS) must be stripped');

  assert.equal((await api(`/uploads/job-photos/${row.filename}`)).status, 404, 'never publicly served');
  const fileUrl = first.json.photo.url;
  assert.equal((await api(fileUrl, { token: T.stranger })).status, 404);
  assert.equal((await api(fileUrl)).status, 401);
  const full = await api(fileUrl, { token: T.client });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/jpeg');
  assert.match(full.headers.get('cache-control'), /no-store/);
  const thumb = await api(first.json.photo.thumb_url, { token: T.admin });
  assert.equal(thumb.status, 200);
  assert.ok(thumb.buf.length < full.buf.length, 'thumbnail is smaller');

  assert.equal((await api(`/api/job-photos/${A}`, { token: T.client })).json.photos.length, 1);
  assert.equal((await api(`/api/job-photos/${A}`, { token: T.stranger })).status, 404);

  assert.equal((await api(`/api/jobs/${A}/complete`, { method: 'POST', token: T.cleaner })).status, 409, 'must arrive first');
  assert.equal((await api(`/api/jobs/${A}/arrive`, { method: 'POST', token: T.cleaner })).status, 200);
  const noAfter = await api(`/api/jobs/${A}/complete`, { method: 'POST', token: T.cleaner });
  assert.equal(noAfter.status, 422);
  assert.equal(noAfter.json.code, 'PHOTOS_REQUIRED');

  assert.equal((await upload(T.cleaner, A, 'after', img)).status, 201);
  const extra = await upload(T.cleaner, A, 'before', img);
  assert.equal((await api(`/api/job-photos/photo/${extra.json.photo.id}`, { method: 'DELETE', token: T.client })).status, 403);
  const del = await api(`/api/job-photos/photo/${extra.json.photo.id}`, { method: 'DELETE', token: T.cleaner });
  assert.equal(del.status, 200);
  assert.equal(del.json.counts.before, 1);

  const done = await api(`/api/jobs/${A}/complete`, { method: 'POST', token: T.cleaner });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.cleaner_earns, 100);
  assert.equal(done.json.cashable, true);
  const jobA = db.prepare('SELECT * FROM jobs WHERE id = ?').get(A);
  assert.ok(jobA.completed_at && jobA.photos_verified_at);
  const again = await api(`/api/jobs/${A}/complete`, { method: 'POST', token: T.cleaner });
  assert.equal(again.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payouts WHERE job_id = ? AND type = 'job'").get(A).n, 1, 'retrying complete never pays twice');
  assert.equal((await api(`/api/job-photos/photo/${first.json.photo.id}`, { method: 'DELETE', token: T.cleaner })).status, 409);
  assert.equal((await upload(T.cleaner, A, 'before', img)).status, 409);

  // ── B. A dispute freezes the earnings until an admin rules ─────────────────
  let e = await earnings();
  assert.equal(e.balance.available, 100);
  assert.equal(e.summary.pending_payout, 100);

  const bookingA = (await api('/api/jobs/my-bookings', { token: T.client })).json.jobs.find(j => j.id === A);
  assert.equal(bookingA.can_report, true);
  assert.match(bookingA.report_deadline, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  assert.equal((await api('/api/disputes', { method: 'POST', token: T.client, body: { job_id: A, type: 'quality', description: 'bad' } })).status, 422);
  assert.equal((await api('/api/disputes', { method: 'POST', token: T.cleaner, body: { job_id: A, type: 'quality', description: 'The bathroom was not cleaned at all.' } })).status, 403);
  const d1 = await dispute(A);
  assert.equal(d1.status, 201, d1.text);
  assert.equal((await dispute(A)).status, 409, 'one report per job');
  const D1 = d1.json.dispute.id;

  e = await earnings();
  assert.equal(e.balance.available, 0);
  assert.equal(e.balance.held, 100);
  assert.equal(e.balance.holds[0].reason, 'dispute');
  assert.equal((await cashout()).status, 422);

  const ev = await upload(T.client, A, 'evidence', img, { disputeId: D1 });
  assert.equal(ev.status, 201, ev.text);
  assert.equal(ev.json.photo.role, 'client');
  assert.equal((await upload(T.stranger, A, 'evidence', img, { disputeId: D1 })).status, 404);
  assert.equal((await upload(T.client, A, 'evidence', img)).status, 422);

  assert.equal((await api(`/api/disputes/${D1}/statement`, { method: 'POST', token: T.cleaner, body: { statement: 'My after photos show it was spotless.' } })).status, 200);
  assert.equal((await api(`/api/disputes/${D1}/statement`, { method: 'POST', token: T.client, body: { statement: 'Trying to answer my own report.' } })).status, 403);

  const view = await api(`/api/disputes/${D1}`, { token: T.cleaner });
  assert.equal(view.status, 200);
  assert.deepEqual([...new Set(view.json.photos.map(p => p.stage))].sort(), ['after', 'before', 'evidence']);
  assert.equal((await api(`/api/disputes/${D1}`, { token: T.stranger })).status, 404);

  assert.equal((await api(`/api/admin/disputes/${D1}/resolve`, { method: 'POST', token: T.admin, body: { ruling: 'cleaner', resolution: 'ok' } })).status, 422);
  assert.equal((await resolve(D1, 'cleaner')).status, 200);
  assert.equal((await resolve(D1, 'client')).status, 409, 'a ruling cannot be applied twice');
  assert.equal((await upload(T.client, A, 'evidence', img, { disputeId: D1 })).status, 409, 'no evidence after resolution');

  const paidA = await cashout();
  assert.equal(paidA.status, 200, paidA.text);
  assert.equal(paidA.json.status, 'paid');
  assert.equal(paidA.json.net_amount, 100);
  assert.equal(db.prepare("SELECT status FROM payouts WHERE job_id = ? AND type = 'job'").get(A).status, 'paid');
  assert.equal((await cashout()).status, 422, 'nothing left to cash out');

  // ── C. Refund after cashout comes out of the next earnings ─────────────────
  const B = seedJob('pt-job-b');
  await completeJob(B);
  assert.equal((await cashout()).status, 200);
  const d2 = await dispute(B);
  assert.equal(d2.status, 201, d2.text);
  const r2 = await resolve(d2.json.dispute.id, 'client');
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.earnings.clawed_back, 100);
  assert.equal(r2.json.refund_status, 'succeeded', 'the client is refunded to their card');
  e = await earnings();
  assert.equal(e.balance.refunds_owed, 100);
  assert.equal(e.balance.available, 0);

  const C = seedJob('pt-job-c');
  await completeJob(C);
  assert.equal((await earnings()).balance.available, 0, '$100 earned minus $100 owed');
  assert.equal((await cashout()).status, 422);

  const Dj = seedJob('pt-job-d');
  await completeJob(Dj);
  const paidD = await cashout();
  assert.equal(paidD.status, 200, paidD.text);
  assert.equal(paidD.json.net_amount, 100);
  assert.equal(db.prepare("SELECT status FROM payouts WHERE job_id = ? AND type = 'refund'").get(B).status, 'paid', 'the refund was settled');
  e = await earnings();
  assert.equal(e.balance.refunds_owed, 0);
  assert.equal(e.balance.available, 0);

  // ── D. Ruling for the client before cashout voids the earnings ─────────────
  // The client's 2-reports-per-30-days limit was used up above; age those out.
  db.prepare("UPDATE disputes SET created_at = datetime('now', '-40 days')").run();
  const E = seedJob('pt-job-e');
  await completeJob(E);
  const d3 = await dispute(E);
  assert.equal(d3.status, 201, d3.text);
  const r3 = await resolve(d3.json.dispute.id, 'client');
  assert.equal(r3.json.earnings.voided, 100);
  assert.equal(r3.json.earnings.clawed_back, 0);
  assert.equal(db.prepare("SELECT status FROM payouts WHERE job_id = ? AND type = 'job'").get(E).status, 'failed');
  e = await earnings();
  assert.equal(e.balance.available, 0);
  assert.equal(e.balance.held, 0);

  // ── E. Instant cashout, and two cashouts racing ────────────────────────────
  const F = seedJob('pt-job-f');
  await completeJob(F);
  const instant = await cashout('instant');
  assert.equal(instant.status, 200, instant.text);
  assert.equal(instant.json.net_amount, 90);
  assert.equal(instant.json.fee_charged, 10);
  assert.equal(instant.json.instant_status, 'paid');

  const G = seedJob('pt-job-g'); await completeJob(G);
  const H = seedJob('pt-job-h'); await completeJob(H);
  const raced = await Promise.all([cashout(), cashout()]);
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 422], 'exactly one of two simultaneous cashouts pays');
  assert.equal(raced.find(r => r.status === 200).json.net_amount, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payouts WHERE job_id IN (?, ?) AND status = 'paid'").get(G, H).n, 2);

  // ── F. The 72-hour reporting window ────────────────────────────────────────
  const I = seedJob('pt-job-i');
  await completeJob(I);
  db.prepare("UPDATE jobs SET completed_at = datetime('now', '-73 hours') WHERE id = ?").run(I);
  const bookingI = (await api('/api/jobs/my-bookings', { token: T.client })).json.jobs.find(j => j.id === I);
  assert.equal(bookingI.can_report, false);
  assert.equal((await dispute(I)).status, 409);

  // ── G. Bookings, lockouts and cancellations ────────────────────────────────
  const J = seedJob('pt-job-j', 'open', null);
  db.prepare(`INSERT INTO bids (id, job_id, cleaner_id, amount, message, success_fee, expires_at)
              VALUES ('pt-bid-j', ?, ?, 120, 'I would love to take this clean for you.', 12, datetime('now', '+1 day'))`).run(J, ids.cleaner);
  assert.equal((await api(`/api/jobs/${J}/accept`, { method: 'POST', token: T.stranger })).status, 410, 'cleaners quote; they cannot take a job outright');
  const chosen = await api('/api/bids/pt-bid-j/choose', { method: 'POST', token: T.client, body: { payment_method_id: 'pm_card_visa' } });
  assert.equal(chosen.status, 200, chosen.text);
  assert.equal(db.prepare("SELECT status FROM bids WHERE id = 'pt-bid-j'").get().status, 'chosen');
  assert.equal((await api(`/api/bids/job/${J}/close`, { method: 'POST', token: T.client })).status, 409, 'a booked job cannot be closed');

  const K = seedJob('pt-job-k');
  const checklist = [true, true, true, true, true];
  const noDoorPhoto = await api(`/api/jobs/${K}/lockout-fee`, { method: 'POST', token: T.cleaner, body: { checklist } });
  assert.equal(noDoorPhoto.status, 422);
  assert.equal(noDoorPhoto.json.code, 'PHOTOS_REQUIRED');
  assert.equal((await upload(T.cleaner, K, 'lockout', img)).status, 201);
  const lock = await api(`/api/jobs/${K}/lockout-fee`, { method: 'POST', token: T.cleaner, body: { checklist } });
  assert.equal(lock.status, 200, lock.text);
  assert.equal((await api(`/api/jobs/${K}/lockout-fee`, { method: 'POST', token: T.cleaner, body: { checklist } })).status, 404, 'no second charge');
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(K).status, 'cancelled');
  // Job I's $100 (section F) was never cashed out, so it is still in the balance.
  assert.equal((await earnings()).balance.available, 135);
  const d4 = await dispute(K, 'lockout_fee');
  assert.equal(d4.status, 201, d4.text);
  e = await earnings();
  assert.equal(e.balance.available, 100, 'only the disputed lockout fee is frozen');
  assert.equal(e.balance.held, 35);

  const L = seedJob('pt-job-l');
  db.prepare("INSERT INTO payouts (id, cleaner_id, job_id, amount, type, status) VALUES ('pt-legacy-l', ?, ?, 90, 'job', 'pending')").run(ids.cleaner, L);
  assert.equal((await api(`/api/jobs/${L}/cancel`, { method: 'POST', token: T.client })).status, 200);
  assert.equal(db.prepare("SELECT status FROM payouts WHERE id = 'pt-legacy-l'").get().status, 'failed', 'a cancelled job pays nothing');

  // Nothing ever landed in the old public folder.
  const legacyDir = path.join(process.env.UPLOAD_DIR, 'jobs');
  assert.equal(fs.existsSync(legacyDir) ? fs.readdirSync(legacyDir).length : 0, 0);

  console.log('Job photo tests passed: uploads, privacy, completion gate, disputes, cashouts, refunds, lockouts.');
}

main()
  .then(() => {
    // Windows won't delete the folder while the server still holds the database
    // open; a leftover temp folder is harmless, a failed exit code is not.
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(0);
  })
  .catch(err => { console.error(err); process.exit(1); });
