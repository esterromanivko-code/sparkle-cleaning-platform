'use strict';
// lib/accountDeletion.js — self-service account deletion (Settings → Delete account).
//
// Removed: name, email, phone, city/ZIP, profile photo, cleaner bio and services,
// license and insurance documents, mileage logs, notifications, sign-in sessions,
// saved address. The user row itself stays, renamed "Deleted user", because past
// jobs, payments, payouts, reviews and messages point at it and the other person
// (and tax law) still needs those records.
// Job photos and location history follow the normal 180-day retention in
// lib/retention.js — they're evidence for the other party too.

const fs   = require('fs');
const path = require('path');
const db   = require('../db');
const { balanceFor, transaction } = require('./payouts');
const { DOC_DIR } = require('./docUploads');

const REPORT_WINDOW_HOURS = 72;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

const placeholderEmail = id => `deleted-${id}@deleted.invalid`;
const plural = (n, one, many) => (n === 1 ? one : many);

// Reasons the account can't be deleted yet, in words the user can act on.
function deletionBlockers(user) {
  const blockers = [];
  const count = (sql, ...params) => db.prepare(sql).get(...params).n;

  if (user.role === 'client') {
    const n = count(`SELECT COUNT(*) AS n FROM jobs WHERE client_id = ? AND status IN ('accepted','in_progress')`, user.id);
    if (n) blockers.push(`You have ${n} booked ${plural(n, 'clean', 'cleans')} that ${plural(n, "hasn't", "haven't")} finished yet. Cancel ${plural(n, 'it', 'them')} in My bookings or wait until ${plural(n, "it's", "they're")} done.`);
  }

  if (user.role === 'cleaner') {
    const n = count(`SELECT COUNT(*) AS n FROM jobs WHERE cleaner_id = ? AND status IN ('accepted','in_progress')`, user.id);
    if (n) blockers.push(`You have ${n} ${plural(n, 'job', 'jobs')} on your schedule. Finish or cancel ${plural(n, 'it', 'them')} first.`);

    const recent = db.prepare(`
      SELECT MAX(completed_at) AS last FROM jobs
      WHERE cleaner_id = ? AND status = 'completed' AND (julianday('now') - julianday(completed_at)) * 24 < ?
    `).get(user.id, REPORT_WINDOW_HOURS);
    if (recent.last) {
      const until = new Date(Date.parse(recent.last.replace(' ', 'T') + 'Z') + REPORT_WINDOW_HOURS * 3600 * 1000);
      const when = until.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
      blockers.push(`Clients can still report a problem with a job you finished recently. You can delete your account after ${when} Pacific time.`);
    }

    const b = balanceFor(user.id);
    if (b.available >= 1) blockers.push(`You have $${b.available.toFixed(2)} ready to cash out. Cash it out in Earnings first so you don't lose it.`);
    if (b.held > 0)       blockers.push(`$${b.held.toFixed(2)} of your earnings is on hold. Wait until it's released.`);
    if (b.processing > 0) blockers.push('A payout to your bank is still processing. Try again once it has been sent.');
  }

  const open = count(`SELECT COUNT(*) AS n FROM disputes WHERE (filed_by = ? OR against = ?) AND status != 'resolved'`, user.id, user.id);
  if (open) blockers.push('You have an open problem report. You can delete your account once Sparkle has resolved it.');

  return blockers;
}

// Deletes and anonymizes. Call only when deletionBlockers() is empty.
// Returns the Stripe customer id so the caller can delete it at Stripe too.
function deleteAccountData(user) {
  const files = [];
  const stripeCustomerId = user.stripe_customer_id
    || (user.role === 'client' ? db.prepare('SELECT stripe_customer_id FROM client_profiles WHERE user_id = ?').get(user.id)?.stripe_customer_id : null)
    || null;

  transaction(() => {
    const run = (sql, ...params) => db.prepare(sql).run(...params);

    if (user.role === 'client') {
      // Jobs nobody has booked yet just close; booked ones were a blocker above.
      run(`UPDATE bids SET status = 'declined' WHERE status = 'pending' AND job_id IN (SELECT id FROM jobs WHERE client_id = ? AND status = 'open')`, user.id);
      run(`UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE client_id = ? AND status = 'open'`, user.id);
      run('UPDATE client_profiles SET default_address = NULL, home_size = NULL, stripe_customer_id = NULL WHERE user_id = ?', user.id);
    }

    if (user.role === 'cleaner') {
      run(`UPDATE bids SET status = 'expired' WHERE cleaner_id = ? AND status = 'pending'`, user.id);
      run('DELETE FROM cleaner_services WHERE cleaner_id = ?', user.id);
      run(`UPDATE cleaner_profiles SET bio = NULL, badge_tier = 'none', payout_bank_last4 = NULL, updated_at = datetime('now') WHERE user_id = ?`, user.id);
      for (const c of db.prepare('SELECT filename FROM cleaner_credentials WHERE cleaner_id = ?').all(user.id)) {
        files.push(path.join(DOC_DIR, path.basename(c.filename)));
      }
      run('DELETE FROM cleaner_credentials WHERE cleaner_id = ?', user.id);
      run('DELETE FROM mileage_logs WHERE cleaner_id = ?', user.id);
    }

    run(`UPDATE recurring_series SET status = 'cancelled' WHERE (client_id = ? OR cleaner_id = ?) AND status != 'cancelled'`, user.id, user.id);

    for (const u of db.prepare('SELECT type, filename FROM file_uploads WHERE user_id = ?').all(user.id)) {
      const dir = u.type === 'profile_photo' ? 'profiles' : u.type === 'review_photo' ? 'reviews' : 'jobs';
      files.push(path.join(UPLOAD_DIR, dir, path.basename(u.filename)));
    }
    run('DELETE FROM file_uploads WHERE user_id = ?', user.id);

    for (const table of ['refresh_tokens', 'password_reset_tokens', 'email_verifications', 'two_factor_auth', 'notifications']) {
      run(`DELETE FROM ${table} WHERE user_id = ?`, user.id);
    }
    run(`UPDATE support_tickets SET name = 'Deleted user', email = ?, phone = NULL WHERE user_id = ?`, placeholderEmail(user.id), user.id);

    // The email is freed, so the same person can sign up again later.
    run(`
      UPDATE users SET first_name = 'Deleted', last_name = 'user', email = ?, phone = NULL, city = NULL, zip = NULL,
             avatar_url = NULL, password_hash = '!', stripe_customer_id = NULL, is_active = 0, is_flagged = 0,
             deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `, placeholderEmail(user.id), user.id);
  });

  for (const file of files) { try { fs.unlinkSync(file); } catch {} }
  return { stripeCustomerId };
}

module.exports = { deletionBlockers, deleteAccountData };
