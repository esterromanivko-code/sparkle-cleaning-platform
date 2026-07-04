'use strict';

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('node:crypto');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-test-secret-please-change';
process.env.PORT = process.env.PORT || '3007';

const db = require('../db');
const { signToken } = require('../middleware/auth');

require('../server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let cookieJar = '';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/api/auth/me`);
      if (res.status === 401 || res.status === 403 || res.status === 404) return;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`Server did not start on ${BASE}`);
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookieJar) headers.Cookie = cookieJar;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  if (setCookies.length) {
    const cookies = new Map((cookieJar ? cookieJar.split(/;\s*/).filter(Boolean) : []).map(pair => {
      const idx = pair.indexOf('=');
      return [pair.slice(0, idx), pair.slice(idx + 1)];
    }));
    for (const raw of setCookies) {
      const first = raw.split(';')[0];
      const idx = first.indexOf('=');
      if (idx > -1) {
        const name = first.slice(0, idx);
        const value = first.slice(idx + 1);
        cookies.set(name, value);
      }
    }
    cookieJar = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { res, json, text };
}

function cleanupUser(id) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM reviews WHERE reviewer_id = ? OR reviewee_id = ?').run(id, id);
    db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(id, id);
    db.prepare('DELETE FROM payouts WHERE cleaner_id = ?').run(id);
    db.prepare('DELETE FROM jobs WHERE client_id = ? OR cleaner_id = ?').run(id, id);
    db.prepare('DELETE FROM cleaner_services WHERE cleaner_id = ?').run(id);
    db.prepare('DELETE FROM cleaner_profiles WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM client_profiles WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function main() {
  await waitForServer();

  const runId = randomUUID().slice(0, 8);
  const clientId = `smoke-client-${runId}`;
  const cleanerId = `smoke-cleaner-${runId}`;
  const clientEmail = `smoke_client_${runId}@sparkle.local`;
  const cleanerEmail = `smoke_cleaner_${runId}@sparkle.local`;
  const password = 'SmokeTest!234';
  const jobId = `smoke-job-${runId}`;

  cleanupUser(clientId);
  cleanupUser(cleanerId);

  const pwHash = await bcrypt.hash(password, 12);
  db.prepare(`
    INSERT INTO users (id, role, first_name, last_name, email, phone, city, zip, password_hash, stripe_customer_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(clientId, 'client', 'Smoke', 'Client', clientEmail, '(206) 555-0101', 'Seattle', '98101', pwHash, `cus_${runId}`);
  db.prepare(`
    INSERT INTO users (id, role, first_name, last_name, email, phone, city, zip, password_hash, stripe_customer_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cleanerId, 'cleaner', 'Smoke', 'Cleaner', cleanerEmail, '(206) 555-0102', 'Seattle', '98102', pwHash, null);
  db.prepare(`INSERT INTO client_profiles (user_id, default_address, home_size, is_business) VALUES (?, ?, ?, ?)`)
    .run(clientId, '123 Smoke St', '2 bed / 2 bath', 0);
  db.prepare(`INSERT INTO cleaner_profiles (user_id, hourly_rate, is_verified, avg_rating, total_jobs) VALUES (?, ?, ?, ?, ?)`)
    .run(cleanerId, 35, 1, 4.9, 12);
  db.prepare(`INSERT INTO cleaner_services (id, cleaner_id, service) VALUES (?, ?, ?)`)
    .run(`svc-${runId}`, cleanerId, 'deep clean');
  db.prepare(`
    INSERT INTO jobs (
      id, client_id, cleaner_id, service_type, address, city, zip, scheduled_at,
      status, base_amount, platform_fee, guarantee_fee, priority_fee, total_charged
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, clientId, cleanerId, 'deep clean', '123 Smoke St', 'Seattle', '98101', '2026-06-05T10:00:00.000Z', 'completed', 120, 9.6, 0, 0, 129.6);
  db.prepare(`INSERT INTO payouts (id, cleaner_id, job_id, amount, type, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`payout-${runId}`, cleanerId, jobId, 120, 'job', 'pending');
  db.prepare(`INSERT INTO messages (id, job_id, sender_id, receiver_id, body) VALUES (?, ?, ?, ?, ?)`)
    .run(`msg-${runId}`, jobId, cleanerId, clientId, 'Hello, I am on my way and ready for the clean.');

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: clientEmail, password, cf_turnstile_response: 'test-token' },
  });
  assert.equal(login.res.status, 200, login.text);
  assert.ok(login.json.access_token, 'login should return access token');
  assert.equal(login.json.user.phone, '(206) 555-0101');

  const clientToken = login.json.access_token;

  const me = await request('/api/auth/me', { token: clientToken });
  assert.equal(me.res.status, 200, me.text);
  assert.equal(me.json.user.email, clientEmail);
  assert.equal(me.json.profile.default_address, '123 Smoke St');

  const updated = await request('/api/auth/me', {
    method: 'PATCH',
    token: clientToken,
    body: { phone: '(206) 555-0199' },
  });
  assert.equal(updated.res.status, 200, updated.text);
  assert.equal(updated.json.user.phone, '(206) 555-0199');

  const convoList = await request('/api/messages/conversations', { token: clientToken });
  assert.equal(convoList.res.status, 200, convoList.text);
  assert.ok(Array.isArray(convoList.json.conversations), 'conversations should be an array');
  assert.equal(convoList.json.conversations[0].other_user.id, cleanerId);

  const messages = await request(`/api/messages/${encodeURIComponent(cleanerId)}`, { token: clientToken });
  assert.equal(messages.res.status, 200, messages.text);
  assert.ok(messages.json.messages.length >= 1, 'should return at least one message');

  const sent = await request('/api/messages', {
    method: 'POST',
    token: clientToken,
    body: { receiver_id: cleanerId, body: 'Thanks, see you tomorrow!', job_id: jobId },
  });
  assert.equal(sent.res.status, 201, sent.text);

  const review = await request('/api/reviews', {
    method: 'POST',
    token: clientToken,
    body: { job_id: jobId, reviewee_id: cleanerId, rating: 5, body: 'Fantastic job!', tags: ['Punctual', 'Thorough'] },
  });
  assert.equal(review.res.status, 201, review.text);

  const reviews = await request(`/api/reviews/${encodeURIComponent(cleanerId)}`);
  assert.equal(reviews.res.status, 200, reviews.text);
  assert.ok(reviews.json.reviews.length >= 1, 'should return review records');

  const billing = await request('/api/profile/billing', { token: clientToken });
  assert.equal(billing.res.status, 200, billing.text);
  assert.ok(Array.isArray(billing.json.payment_methods), 'billing should include payment_methods array');
  assert.ok(Array.isArray(billing.json.history), 'billing should include history array');
  assert.equal(billing.json.summary.total_jobs, 1);

  const cleanerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: cleanerEmail, password, cf_turnstile_response: 'test-token' },
  });
  assert.equal(cleanerLogin.res.status, 200, cleanerLogin.text);
  const cleanerToken = cleanerLogin.json.access_token;

  const earnings = await request('/api/earnings', { token: cleanerToken });
  assert.equal(earnings.res.status, 200, earnings.text);
  assert.ok(Array.isArray(earnings.json.payouts), 'earnings should include payouts array');

  console.log('Smoke test passed: auth, profile, messages, reviews, billing, earnings.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
