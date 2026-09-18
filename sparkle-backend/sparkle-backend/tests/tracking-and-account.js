'use strict';
// tests/tracking-and-account.js — location tracking, account deletion and the
// evidence retention sweep, end to end, against a throwaway database:
//   npm run test:tracking

const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkle-tracking-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  DB_PATH: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  BACKUP_DIR: path.join(TMP, 'backups'),
  PORT: '3012',
  JWT_SECRET: 'tracking-test-secret',
  STRIPE_SECRET_KEY: '',
  TURNSTILE_SECRET_KEY: '',
  GEOCODE_PROVIDER: 'none',      // no network: jobs are seeded with coordinates
});

const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken } = require('../middleware/auth');
const { runRetentionSweep } = require('../lib/retention');
require('../server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let ip = 0;
async function api(p, { method = 'GET', token, body } = {}) {
  const headers = { 'X-Forwarded-For': `10.88.${Math.floor(++ip / 250)}.${ip % 250}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 400) };
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error('server did not start');
}

// Seattle city hall, and points roughly 2 km, 3 km and 60 m away.
const HOME = { lat: 47.6038, lng: -122.3301 };
const FAR_2KM = { lat: 47.6218, lng: -122.3301, accuracy: 15 };
const FAR_3KM = { lat: 47.6308, lng: -122.3301, accuracy: 20 };
const NEAR = { lat: 47.60435, lng: -122.3301, accuracy: 10 };

const PASSWORD = 'TrackTest!2345';
const HASH = bcrypt.hashSync(PASSWORD, 10);
const tokens = {};
function user(id, role, first) {
  db.prepare('INSERT INTO users (id, role, first_name, last_name, email, password_hash, stripe_customer_id) VALUES (?,?,?,?,?,?,?)')
    .run(id, role, first, 'Test', `${id}@tt.local`, HASH, role === 'client' ? `cus_${id}` : null);
  if (role === 'cleaner') db.prepare('INSERT INTO cleaner_profiles (user_id, stripe_connect_id, connect_payouts_enabled, lockout_fee_enabled, lockout_fee_amount) VALUES (?,?,1,1,30)').run(id, 'acct_' + id);
  if (role === 'client') db.prepare('INSERT INTO client_profiles (user_id, default_address) VALUES (?, ?)').run(id, '600 4th Ave');
  tokens[id] = signToken({ id, role });
}
// A booked job paid with a saved card that already has a hold on it.
function job(id, clientId, cleanerId, status = 'accepted') {
  db.prepare(`
    INSERT INTO jobs (id, client_id, cleaner_id, service_type, address, scheduled_at, status, base_amount, total_charged, lat, lng,
                      payment_method_id, auth_status, stripe_payment_intent_id)
    VALUES (?, ?, ?, 'Deep clean', '600 4th Ave, Seattle', '2026-09-20T10:00:00.000Z', ?, 100, 108, ?, ?,
            'pm_card_visa', 'authorized', ?)
  `).run(id, clientId, cleanerId, status, HOME.lat, HOME.lng, `pi_seeded_${id}`);
}
const addPhoto = (jobId, uploader, stage) => db.prepare(`
  INSERT INTO job_photos (id, job_id, uploaded_by, role, stage, filename, thumb_filename)
  VALUES (?, ?, ?, 'cleaner', ?, ?, ?)
`).run(`${jobId}-${stage}-${Math.random().toString(36).slice(2, 8)}`, jobId, uploader, stage, 'x.jpg', 'x_t.jpg');
const ageLastPing = jobId => db.prepare(`UPDATE jobs SET last_location_at = datetime('now', '-1 minute') WHERE id = ?`).run(jobId);
const notifCount = (userId, type) => db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND type = ?').get(userId, type).n;

async function main() {
  await waitForServer();
  user('cl', 'client', 'Cara'); user('cn', 'cleaner', 'Cleo'); user('other', 'cleaner', 'Otto'); user('adm', 'admin', 'Ada');
  job('jA', 'cl', 'cn');
  const T = tokens;

  // ── Location tracking ──────────────────────────────────────────────────────
  assert.equal((await api('/api/jobs/jA/en-route', { method: 'POST', token: T.other, body: { location: FAR_2KM } })).status, 404);
  assert.equal((await api('/api/jobs/jA/en-route', { method: 'POST', token: T.cl, body: {} })).status, 403);
  assert.equal((await api('/api/jobs/jA/location', { method: 'POST', token: T.cn, body: FAR_2KM })).status, 409, 'no pings before "On my way"');

  let t = (await api('/api/jobs/jA/tracking', { token: T.cl })).json.tracking;
  assert.equal(t.live, null);
  assert.equal(t.en_route_at, null);

  assert.equal((await api('/api/jobs/jA/en-route', { method: 'POST', token: T.cn, body: { location: { lat: 200, lng: 0 } } })).status, 422);
  const enRoute = await api('/api/jobs/jA/en-route', { method: 'POST', token: T.cn, body: { location: FAR_2KM } });
  assert.equal(enRoute.status, 200, enRoute.text);
  assert.equal(enRoute.json.location_shared, true);
  assert.equal(notifCount('cl', 'cleaner_en_route'), 1);
  await api('/api/jobs/jA/en-route', { method: 'POST', token: T.cn, body: {} });
  assert.equal(notifCount('cl', 'cleaner_en_route'), 1, 'the client is told once');

  t = (await api('/api/jobs/jA/tracking', { token: T.cl })).json.tracking;
  assert.ok(t.live, 'client sees the cleaner while they are on the way');
  assert.ok(t.live.distance_m > 1800 && t.live.distance_m < 2200, `distance ${t.live.distance_m}`);
  assert.ok(t.live.eta_minutes >= 1);
  assert.equal(t.trail, undefined, 'only admins get the trail');
  assert.equal((await api('/api/jobs/jA/tracking', { token: T.other })).status, 404);

  assert.equal((await api('/api/jobs/jA/location', { method: 'POST', token: T.cn, body: FAR_2KM })).json.skipped, true, 'too soon after the last point');
  ageLastPing('jA');
  const near = await api('/api/jobs/jA/location', { method: 'POST', token: T.cn, body: NEAR });
  assert.equal(near.json.phase, 'en_route');
  assert.ok(near.json.distance_m < 150);
  assert.equal(notifCount('cl', 'cleaner_nearby'), 1);
  ageLastPing('jA');
  await api('/api/jobs/jA/location', { method: 'POST', token: T.cn, body: NEAR });
  assert.equal(notifCount('cl', 'cleaner_nearby'), 1, '"almost there" is sent once');
  assert.equal((await api('/api/jobs/jA/location', { method: 'POST', token: T.cn, body: {} })).status, 422);

  const arrive = await api('/api/jobs/jA/arrive', { method: 'POST', token: T.cn, body: { location: FAR_3KM } });
  assert.equal(arrive.status, 200, arrive.text);
  assert.equal(arrive.json.far_from_address, true, 'checking in 3 km away is flagged');

  t = (await api('/api/jobs/jA/tracking', { token: T.cl })).json.tracking;
  assert.equal(t.live, null, 'live location stops at arrival');
  assert.equal(t.arrival.far_from_address, true);
  assert.equal(t.arrival.lat, undefined, "the client doesn't get check-in coordinates");
  const adminT = (await api('/api/jobs/jA/tracking', { token: T.adm })).json.tracking;
  assert.ok(adminT.arrival.lat, 'admins do');
  assert.deepEqual(adminT.trail.map(p => p.phase), ['en_route', 'en_route', 'en_route', 'arrived']);

  ageLastPing('jA');
  assert.equal((await api('/api/jobs/jA/location', { method: 'POST', token: T.cn, body: NEAR })).json.phase, 'on_site');

  addPhoto('jA', 'cn', 'before'); addPhoto('jA', 'cn', 'after');
  db.prepare(`UPDATE jobs SET arrived_at = datetime('now', '-90 minutes') WHERE id = 'jA'`).run();
  const done = await api('/api/jobs/jA/complete', { method: 'POST', token: T.cn, body: { location: NEAR } });
  assert.equal(done.status, 200, done.text);
  t = (await api('/api/jobs/jA/tracking', { token: T.cl })).json.tracking;
  assert.ok(t.minutes_on_site >= 89 && t.minutes_on_site <= 91, `on site ${t.minutes_on_site}`);
  assert.equal(t.completion.far_from_address, false);
  assert.equal(t.on_site_checks.count, 1);
  assert.equal((await api('/api/jobs/jA/location', { method: 'POST', token: T.cn, body: NEAR })).status, 409, 'sharing ends with the job');

  const booking = (await api('/api/jobs/my-bookings', { token: T.cl })).json.jobs.find(j => j.id === 'jA');
  for (const f of ['last_lat', 'last_lng', 'arrival_lat', 'completion_lat', 'arrival_distance_m']) {
    assert.equal(booking[f], undefined, `my-bookings must not include ${f}`);
  }
  assert.ok(booking.arrived_at && booking.en_route_at);

  // Dispute detail carries the tracking summary.
  const d = await api('/api/disputes', { method: 'POST', token: T.cl, body: { job_id: 'jA', type: 'quality', description: 'My cleaner was not really here the whole time.' } });
  assert.equal(d.status, 201, d.text);
  const partyView = (await api(`/api/disputes/${d.json.dispute.id}`, { token: T.cn })).json;
  assert.equal(partyView.tracking.minutes_on_site >= 89, true);
  assert.equal(partyView.tracking.trail, undefined);
  assert.ok((await api(`/api/disputes/${d.json.dispute.id}`, { token: T.adm })).json.tracking.trail.length >= 5);

  // Lockout fee records where the cleaner stood.
  job('jB', 'cl', 'cn');
  addPhoto('jB', 'cn', 'lockout');
  const lock = await api('/api/jobs/jB/lockout-fee', { method: 'POST', token: T.cn, body: { checklist: [true, true, true, true, true], location: NEAR } });
  assert.equal(lock.status, 200, lock.text);
  const fee = (await api('/api/admin/lockout-fees', { token: T.adm })).json.lockout_fees.find(f => f.job_id === 'jB');
  assert.equal(fee.location_shared, 1);
  assert.ok(fee.distance_m < 150);

  // ── Account deletion ───────────────────────────────────────────────────────
  assert.equal((await api('/api/auth/me', { method: 'DELETE', token: T.cn, body: { password: PASSWORD } })).status, 422, 'must type DELETE');
  assert.equal((await api('/api/auth/me', { method: 'DELETE', token: T.cn, body: { password: 'wrong', confirm: 'DELETE' } })).status, 403);
  assert.equal((await api('/api/auth/me', { method: 'DELETE', token: T.adm, body: { password: PASSWORD, confirm: 'DELETE' } })).status, 403, 'admins cannot self-delete');

  const blocked = await api('/api/auth/me', { method: 'DELETE', token: T.cn, body: { password: PASSWORD, confirm: 'DELETE' } });
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(blocked.json.code, 'DELETION_BLOCKED');
  const reasons = blocked.json.blockers.join(' | ');
  assert.match(reasons, /finished recently/);
  assert.match(reasons, /open problem report/);
  assert.equal(db.prepare("SELECT first_name FROM users WHERE id = 'cn'").get().first_name, 'Cleo', 'nothing changed');

  const clientBlocked = await api('/api/auth/me', { method: 'DELETE', token: T.cl, body: { password: PASSWORD, confirm: 'DELETE' } });
  assert.equal(clientBlocked.status, 409);
  assert.match(clientBlocked.json.blockers.join(' '), /open problem report/);

  // A client with nothing unfinished: an open job and a profile photo.
  user('cl2', 'client', 'Nora');
  db.prepare(`INSERT INTO jobs (id, client_id, service_type, address, scheduled_at, status) VALUES ('jOpen', 'cl2', 'Standard clean', '1 Pine St', '2026-10-01T10:00:00Z', 'open')`).run();
  const photoDir = path.join(process.env.UPLOAD_DIR, 'profiles');
  fs.mkdirSync(photoDir, { recursive: true });
  fs.writeFileSync(path.join(photoDir, 'nora.jpg'), 'x');
  db.prepare(`INSERT INTO file_uploads (id, user_id, type, filename, url) VALUES ('up1', 'cl2', 'profile_photo', 'nora.jpg', '/uploads/profiles/nora.jpg')`).run();
  db.prepare(`INSERT INTO notifications (id, user_id, title, body) VALUES ('n1', 'cl2', 'hi', 'there')`).run();

  const gone = await api('/api/auth/me', { method: 'DELETE', token: T.cl2, body: { password: PASSWORD, confirm: 'delete' } });
  assert.equal(gone.status, 200, gone.text);
  const row = db.prepare("SELECT * FROM users WHERE id = 'cl2'").get();
  assert.equal(row.first_name, 'Deleted');
  assert.equal(row.email, 'deleted-cl2@deleted.invalid');
  assert.ok(row.deleted_at);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id = 'jOpen'").get().status, 'cancelled');
  assert.equal(fs.existsSync(path.join(photoDir, 'nora.jpg')), false, 'profile photo file removed');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = 'cl2'").get().n, 0);
  const after = await api('/api/auth/me', { token: T.cl2 });
  assert.equal(after.status, 401);
  assert.equal(after.json.code, 'ACCOUNT_DELETED');
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email: 'cl2@tt.local', password: PASSWORD } })).status, 401);
  const again = await api('/api/auth/register', { method: 'POST', body: { first_name: 'Nora', last_name: 'Again', email: 'cl2@tt.local', password: 'Another!2345', role: 'client' } });
  assert.equal(again.status, 201, 'the email can be used again: ' + again.text);

  // A cleaner with nothing unfinished: documents are deleted, and they leave search.
  user('cn2', 'cleaner', 'Una');
  const docDir = path.join(process.env.UPLOAD_DIR, 'documents');
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, 'lic.pdf'), '%PDF-');
  db.prepare(`INSERT INTO cleaner_credentials (id, cleaner_id, doc_type, filename) VALUES ('cred1', 'cn2', 'license', 'lic.pdf')`).run();
  assert.ok((await api('/api/cleaners', { token: T.cl })).json.cleaners.some(c => c.id === 'cn2'));
  assert.equal((await api('/api/auth/me', { method: 'DELETE', token: T.cn2, body: { password: PASSWORD, confirm: 'DELETE' } })).status, 200);
  assert.equal(fs.existsSync(path.join(docDir, 'lic.pdf')), false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cleaner_credentials WHERE cleaner_id = 'cn2'").get().n, 0);
  assert.equal((await api('/api/cleaners', { token: T.cl })).json.cleaners.some(c => c.id === 'cn2'), false);

  // ── Retention ──────────────────────────────────────────────────────────────
  db.prepare(`UPDATE jobs SET completed_at = datetime('now', '-200 days') WHERE id = 'jA'`).run();
  assert.equal(runRetentionSweep().jobs, 0, 'an open dispute keeps the evidence');
  db.prepare(`UPDATE disputes SET status = 'resolved', ruling = 'cleaner' WHERE job_id = 'jA'`).run();
  assert.equal(runRetentionSweep().jobs, 1);
  const swept = db.prepare("SELECT arrival_lat, arrival_distance_m, arrived_at FROM jobs WHERE id = 'jA'").get();
  assert.equal(swept.arrival_lat, null);
  assert.ok(swept.arrival_distance_m > 2000, 'distances and times are kept');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM job_locations WHERE job_id = 'jA'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM job_photos WHERE job_id = 'jA'").get().n, 0);

  console.log('Tracking & account tests passed: on my way, live location, arrival checks, time on site, lockout location, account deletion, retention.');
}

main()
  .then(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
