'use strict';
// tests/leak-crawl.js — private data stays private, on EVERY endpoint, automatically.
//
// It plants recognisable "canary" values in everything private (a cleaner's Stripe
// account and bank label, a client's email, phone, street address and door code, a
// card id, messages, notifications, support tickets…), then calls every GET endpoint in
// the API as people who have NO connection to that data — a stranger client, a stranger
// cleaner — and fails if any canary comes back. Endpoints are discovered from the
// source, so a new route is covered the day it is written, without anyone remembering
// to write a test for it. It also checks that, signed out, nothing but the allow-listed
// public routes answers at all.
//
// It would have caught: the public cleaner profile that carried the Stripe account and
// bank label; the open job list that carried street addresses and door codes; and the
// admin backup endpoints that answered anyone.
//
//   npm run test:leaks

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkle-leaks-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  DB_PATH: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  BACKUP_DIR: path.join(TMP, 'backups'),
  PORT: '3016',
  JWT_SECRET: 'leak-crawl-secret',
  STRIPE_SECRET_KEY: '',
  TURNSTILE_SECRET_KEY: '',
  ADMIN_KEY: '',
  GEOCODE_PROVIDER: 'none',
});

const db = require('../db');
const { signToken } = require('../middleware/auth');
const { inventory } = require('../scripts/route-inventory');
require('../server');

const allowedPublic = JSON.parse(fs.readFileSync(path.join(__dirname, 'public-routes.json'), 'utf8'));
delete allowedPublic._why;

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let ip = 0;
async function call(method, url, token, body) {
  const headers = { 'X-Forwarded-For': `10.44.${Math.floor(++ip / 250) % 250}.${ip % 250}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: res.status, text: await res.text() };
  } catch (err) { return { status: 0, text: String(err.message) }; }
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error('server did not start');
}

// ── What is planted, and what no stranger may ever see ───────────────────────
const C = {
  email: 'victim.canary@leak.test', phone: '(425) 555-0177', lastName: 'Zzcanaryvictim',
  street: '742 Canary Lane', door: 'DOORCODE-CANARY-7788', lat: '47.123456', lng: '-122.654321',
  connect: 'acct_CANARYSTRIPE', bank: 'CANARYBANK', bank4: '4242', customer: 'cus_CANARYCUSTOMER',
  card: 'pm_CANARYCARD', intent: 'pi_CANARYINTENT',
  message: 'MESSAGE-CANARY-hello', ticket: 'TICKET-CANARY-subject', notif: 'NOTIF-CANARY-title',
  device: 'DEVICE-CANARY-TOKEN-0123456789', bio: 'BIO-CANARY-text',
};
// Values that may appear only in the key NAMES of a response are checked separately.
const FORBIDDEN_KEYS = ['password_hash', 'stripe_connect_id', 'stripe_customer_id', 'stripe_payment_intent_id', 'payment_method_id',
  'payout_method_label', 'payout_bank_last4', 'connect_payouts_enabled', 'connect_details_submitted', 'refresh_token_hash', 'token_hash'];
// The cleaner's public bio is meant to be seen, so it is the one planted value that is allowed.
const NEEDLES = Object.entries(C).filter(([k]) => k !== 'bio').map(([, v]) => v);

function plant() {
  const U = (id, role, first, last, extra = {}) => db.prepare(
    'INSERT INTO users (id, role, first_name, last_name, email, phone, password_hash, stripe_customer_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, role, first, last, extra.email || `${id}@leak.test`, extra.phone || '(206) 555-0000', 'x', extra.customer || null);
  U('v-cl', 'client', 'Vic', C.lastName, { email: C.email, phone: C.phone, customer: C.customer });
  U('v-cn', 'cleaner', 'Vera', C.lastName, { email: `cleaner.${C.email}`, phone: '(425) 555-0178' });
  U('s-cl', 'client', 'Stan', 'Stranger'); U('s-cn', 'cleaner', 'Sal', 'Stranger'); U('adm', 'admin', 'Ada', 'Admin');
  db.prepare('INSERT INTO client_profiles (user_id, default_address) VALUES (?, ?)').run('v-cl', `${C.street}, Testville, WA 98000`);
  db.prepare('INSERT INTO client_profiles (user_id) VALUES (?)').run('s-cl');
  db.prepare('INSERT INTO cleaner_profiles (user_id, bio, stripe_connect_id, payout_method_label, payout_bank_last4, connect_payouts_enabled, total_earnings) VALUES (?,?,?,?,?,1,5000)')
    .run('v-cn', C.bio, C.connect, `${C.bank} •••• ${C.bank4}`, C.bank4);
  db.prepare('INSERT INTO cleaner_profiles (user_id) VALUES (?)').run('s-cn');

  const when = new Date(Date.now() + 3 * 86400000).toISOString();
  const addr = `${C.street}, Testville, WA 98000`;
  const J = (id, status, extra = '') => db.prepare(`
    INSERT INTO jobs (id, client_id, cleaner_id, service_type, address, city, zip, lat, lng, scheduled_at, status, notes, payment_method_id, stripe_payment_intent_id, base_amount, total_charged)
    VALUES (?, 'v-cl', ?, 'Deep clean', ?, 'Testville', '98000', ?, ?, ?, ?, ?, ?, ?, 100, 108)`)
    .run(id, status === 'open' ? null : 'v-cn', addr, Number(C.lat), Number(C.lng), when, status, `Gate ${C.door}`, C.card, C.intent);
  J('j-open', 'open'); J('j-booked', 'accepted'); J('j-done', 'completed');
  db.prepare("UPDATE jobs SET completed_at = datetime('now') WHERE id = 'j-done'").run();

  db.prepare(`INSERT INTO bids (id, job_id, cleaner_id, amount, message, success_fee, expires_at) VALUES ('b1','j-open','v-cn',100,'${C.bio} quote text here ok',10,datetime('now','+1 day'))`).run();
  db.prepare("INSERT INTO reviews (id, job_id, reviewer_id, reviewee_id, rating, body) VALUES ('r1','j-done','v-cl','v-cn',5,'Great')").run();
  db.prepare('INSERT INTO messages (id, job_id, sender_id, receiver_id, body) VALUES (?,?,?,?,?)').run('m1', 'j-booked', 'v-cl', 'v-cn', C.message);
  db.prepare('INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)').run('n1', 'v-cl', C.notif, C.notif, 'platform');
  db.prepare('INSERT INTO support_tickets (id, user_id, name, email, phone, subject) VALUES (?,?,?,?,?,?)').run('t1', 'v-cl', 'Vic', C.email, C.phone, C.ticket);
  db.prepare("INSERT INTO support_messages (id, ticket_id, sender, sender_id, body) VALUES ('tm1','t1','user','v-cl',?)").run(C.ticket);
  db.prepare("INSERT INTO device_tokens (id, user_id, token, platform) VALUES ('d1','v-cn',?, 'ios')").run(C.device);
  db.prepare("INSERT INTO job_photos (id, job_id, uploaded_by, role, stage, filename, thumb_filename) VALUES ('p1','j-done','v-cn','cleaner','before','x.jpg','x_t.jpg')").run();
  db.prepare("INSERT INTO payouts (id, cleaner_id, job_id, amount, type, status) VALUES ('po1','v-cn','j-done',90,'job','pending')").run();
  db.prepare("INSERT INTO cleaner_credentials (id, cleaner_id, doc_type, filename) VALUES ('cr1','v-cn','license','lic.pdf')").run();
  return ['v-cl', 'v-cn', 's-cl', 's-cn', 'adm', 'j-open', 'j-booked', 'j-done', 'b1', 'r1', 'm1', 'n1', 't1', 'd1', 'p1', 'po1', 'cr1'];
}

const keysDeep = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach(v => keysDeep(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out); }
  return out;
};

async function main() {
  await waitForServer();
  const ids = plant();
  const token = { 's-cl': signToken({ id: 's-cl', role: 'client' }), 's-cn': signToken({ id: 's-cn', role: 'cleaner' }) };

  const routes = inventory().filter(r => r.owner === 'router' || r.file === 'server.js');
  const seen = new Set();
  const unique = routes.filter(r => { const k = `${r.method} ${r.url}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const fill = (url, id) => url.replace(/:[A-Za-z_]+/g, encodeURIComponent(id));
  const hasParam = url => /:[A-Za-z_]+/.test(url);

  const problems = [];
  let requests = 0;

  // 1. Signed out: only the deliberately public routes may answer.
  for (const r of unique) {
    if (`${r.method} ${r.url}` in allowedPublic) continue;
    for (const id of hasParam(r.url) ? ['j-open'] : [null]) {
      const res = await call(r.method, id ? fill(r.url, id) : r.url, null, r.method === 'GET' ? undefined : {});
      requests++;
      if (![401, 403, 404].includes(res.status)) problems.push(`SIGNED OUT  ${r.method} ${r.url} answered ${res.status} (want 401)`);
    }
  }

  // 2. Strangers: no GET may return anyone else's private data.
  const gets = unique.filter(r => r.method === 'GET');
  for (const who of ['s-cl', 's-cn']) {
    for (const r of gets) {
      for (const id of hasParam(r.url) ? ids : [null]) {
        const url = id ? fill(r.url, id) : r.url;
        const res = await call('GET', url, token[who]);
        requests++;
        if (res.status !== 200 || !res.text) continue;
        const found = NEEDLES.filter(n => res.text.includes(n));
        let keys = [];
        try { keys = FORBIDDEN_KEYS.filter(k => keysDeep(JSON.parse(res.text)).has(k)); } catch { /* not JSON */ }
        if (found.length || keys.length) {
          problems.push(`${who === 's-cl' ? 'STRANGER CLIENT ' : 'STRANGER CLEANER'} GET ${url}  →  ${[...found.map(f => `value "${f}"`), ...keys.map(k => `field "${k}"`)].join(', ')}`);
        }
      }
    }
  }

  const unseen = [...new Set(problems)];
  assert.deepEqual(unseen, [], `Private data reached someone it doesn't belong to (${unseen.length}):\n  ${unseen.slice(0, 25).join('\n  ')}`);
  console.log(`Leak crawl passed: ${unique.length} endpoints, ${requests} requests as strangers and signed out, no private data returned.`);
}

main()
  .then(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); })
  .catch(err => { console.error(err.message || err); process.exit(1); });
