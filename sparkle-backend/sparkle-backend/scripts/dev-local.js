'use strict';
// scripts/dev-local.js — a throwaway local copy of the backend, seeded with test
// accounts, for trying the app in a browser:
//
//   npm run dev:local        then open the website with its API pointed at localhost:3001
//
// Everything here is disposable and local: a fresh database and upload folder in the
// OS temp directory on every start, Stripe replaced by lib/stripe.js's stand-in, no
// CAPTCHA, no email. It refuses to run if NODE_ENV is "production".
//
// Test accounts (password for all: LocalTest!2345)
//   cleaner@test.local   a verified cleaner with two booked jobs
//   client@test.local    a client with an open job that has a quote, and an unpaid clean
//   admin@test.local     an admin

const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.env.NODE_ENV === 'production') {
  console.error('dev-local.js is for local testing only and will not run with NODE_ENV=production.');
  process.exit(1);
}

const BACKEND = path.join(__dirname, '..');
const DIR = path.join(os.tmpdir(), 'sparkle-dev-local');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

Object.assign(process.env, {
  NODE_ENV: 'development',
  PORT: process.env.PORT || '3001',
  DB_PATH: path.join(DIR, 'local.db'),
  UPLOAD_DIR: path.join(DIR, 'uploads'),
  BACKUP_DIR: path.join(DIR, 'backups'),
  JWT_SECRET: 'local-browser-test-secret',
  STRIPE_SECRET_KEY: '',
  STRIPE_PUBLISHABLE_KEY: '',
  TURNSTILE_SECRET_KEY: '',
  TURNSTILE_SITE_KEY: '',
  FIREBASE_SERVICE_ACCOUNT_JSON: '',
  FRONTEND_URL: 'http://localhost:4200',
  GOOGLE_MAPS_API_KEY: '',
  SENTRY_DSN: '',
  SMTP_HOST: '',
  INSTANT_CASHOUT_FEE: '10',
  GEOCODE_PROVIDER: 'none',   // the jobs below are seeded with coordinates
});

const bcrypt = require('bcryptjs');
const db = require(path.join(BACKEND, 'db'));

const PASSWORD = 'LocalTest!2345';
const hash = bcrypt.hashSync(PASSWORD, 10);
const columns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
function addUser(id, role, first, last, email) {
  const fields = ['id', 'role', 'first_name', 'last_name', 'email', 'phone', 'password_hash'];
  const values = [id, role, first, last, email, '(206) 555-0100', hash];
  if (columns.includes('email_verified')) { fields.push('email_verified'); values.push(1); }
  db.prepare(`INSERT INTO users (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...values);
}
addUser('lt-cleaner', 'cleaner', 'Cleo', 'Tester', 'cleaner@test.local');
addUser('lt-client', 'client', 'Cara', 'Tester', 'client@test.local');
addUser('lt-admin', 'admin', 'Ada', 'Tester', 'admin@test.local');

// No payout account yet, so "Set up payouts" can be tried.
db.prepare(`INSERT INTO cleaner_profiles (user_id, hourly_rate, bio, lockout_fee_enabled, lockout_fee_amount, lockout_grace_mins, is_verified, avg_rating, total_jobs)
            VALUES ('lt-cleaner', 35, 'Detail-obsessed and always on time.', 1, 40, 20, 1, 4.9, 23)`).run();
db.prepare("INSERT INTO client_profiles (user_id, default_address) VALUES ('lt-client', '12 Test Lane, Seattle, WA 98101')").run();

const hoursFromNow = h => new Date(Date.now() + h * 3600 * 1000).toISOString();

// Two booked jobs for the cleaner, paid with a card that already has a hold on it.
const booked = db.prepare(`
  INSERT INTO jobs (id, client_id, cleaner_id, service_type, address, city, scheduled_at, arrival_window, status, base_amount, platform_fee, total_charged,
                    lat, lng, bedrooms, bathrooms, supplies_by, pets, notes, payment_method_id, auth_status, stripe_payment_intent_id)
  VALUES (?, 'lt-client', 'lt-cleaner', ?, '12 Test Lane, Seattle, WA 98101', 'Seattle', ?, 'Afternoon 12–5pm', 'accepted', ?, ?, ?,
          47.6038, -122.3301, 2, 2, 'client', 'Cat(s)', ?, 'pm_card_visa', 'authorized', ?)`);
booked.run('lt-job-photos', 'Deep clean', hoursFromNow(1), 120, 9.6, 129.6, 'Gate code 4471. The cat is shy and hides in the bedroom.', 'pi_seeded_photos');
booked.run('lt-job-lockout', 'Standard clean', hoursFromNow(1), 90, 7.2, 97.2, null, 'pi_seeded_lockout');

// An open job with a quote waiting, to book with a card — and one for the cleaner to quote on.
const open = db.prepare(`
  INSERT INTO jobs (id, client_id, service_type, address, city, scheduled_at, arrival_window, status, base_amount, total_charged, bedrooms, bathrooms, supplies_by, pets, notes)
  VALUES (?, 'lt-client', ?, '12 Test Lane, Seattle, WA 98101', 'Seattle', ?, ?, 'open', 85, 91.8, ?, ?, ?, ?, ?)`);
open.run('lt-job-open', 'Move-out clean', hoursFromNow(48), 'Morning 8–12pm', 0, 1, 'cleaner', null, 'Key is under the mat.');
open.run('lt-job-quote-me', 'Standard clean', hoursFromNow(72), 'Evening 5–8pm', 3, 2, 'client', 'Dog(s)', 'Side gate code 8812.');
db.prepare(`INSERT INTO bids (id, job_id, cleaner_id, amount, message, success_fee, expires_at)
            VALUES ('lt-bid-open', 'lt-job-open', 'lt-cleaner', 150, 'Hi! I specialise in move-out cleans and bring all my own supplies. I can be there at 10am.', 15, ?)`)
  .run(hoursFromNow(24));

// A finished clean whose card charge failed, to pay from My bookings.
db.prepare(`INSERT INTO jobs (id, client_id, cleaner_id, service_type, address, city, scheduled_at, status, completed_at, base_amount, platform_fee, total_charged,
                              payment_method_id, capture_status, payment_error, photos_required)
            VALUES ('lt-job-unpaid', 'lt-client', 'lt-cleaner', 'Standard clean', '12 Test Lane, Seattle, WA 98101', 'Seattle', ?, 'completed', datetime('now', '-2 hours'), 110, 8.8, 118.8,
                    'pm_card_chargeDeclined', 'failed', 'Your card was declined.', 0)`).run(hoursFromNow(-4));
db.prepare("INSERT INTO payouts (id, cleaner_id, job_id, amount, type, status) VALUES ('lt-payout-unpaid', 'lt-cleaner', 'lt-job-unpaid', 99, 'job', 'pending')").run();

console.log(`[LOCAL TEST] Seeded cleaner@test.local, client@test.local, admin@test.local (password ${PASSWORD})`);
require(path.join(BACKEND, 'server'));
