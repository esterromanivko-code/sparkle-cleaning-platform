'use strict';
// lib/connect.js — cleaners' payout accounts, through Stripe Connect (Express).
//
// Stripe hosts the whole setup: the cleaner enters their bank account or debit
// card, identity details and tax information on Stripe's own pages, and Stripe
// verifies them and handles the 1099s. Sparkle keeps only the account id and what
// Stripe last reported: whether payouts are enabled, how many details Stripe still
// needs, and a label like "CHASE •••• 6789" to show where the money goes.

const db = require('../db');
const { getStripe } = require('./stripe');
const { notify } = require('./notify');
const { PaymentError } = require('./payments');

function withParam(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

async function ensureConnectAccount(userId) {
  const row = db.prepare(`
    SELECT u.email, cp.stripe_connect_id FROM users u JOIN cleaner_profiles cp ON cp.user_id = u.id WHERE u.id = ?
  `).get(userId);
  if (!row) throw new PaymentError(404, 'Cleaner profile not found', 'NOT_FOUND');
  if (row.stripe_connect_id) return row.stripe_connect_id;

  const account = await getStripe().accounts.create({
    // An Express account: Stripe collects and verifies the details, the cleaner
    // gets Stripe's Express dashboard, and Sparkle is responsible for refunds and
    // chargebacks on clients' payments.
    controller: {
      stripe_dashboard: { type: 'express' },
      fees: { payer: 'application' },
      losses: { payments: 'application' },
    },
    country: 'US',
    email: row.email,
    capabilities: { transfers: { requested: true } },
    business_profile: {
      mcc: '7349',   // cleaning, maintenance and janitorial services
      product_description: 'Residential and commercial cleaning services booked through Sparkle',
    },
    metadata: { sparkle_user_id: userId },
  }, { idempotencyKey: `connect-account-${userId}` });

  db.prepare('UPDATE cleaner_profiles SET stripe_connect_id = ? WHERE user_id = ? AND stripe_connect_id IS NULL').run(account.id, userId);
  applyAccount(account);
  return db.prepare('SELECT stripe_connect_id FROM cleaner_profiles WHERE user_id = ?').get(userId).stripe_connect_id;
}

// Records what Stripe reports about an account, from a fresh lookup or a webhook.
function applyAccount(account) {
  if (!account?.id) return null;
  const before = db.prepare('SELECT user_id, connect_payouts_enabled FROM cleaner_profiles WHERE stripe_connect_id = ?').get(account.id);
  if (!before) return null;

  const externals = account.external_accounts?.data || [];
  const dest = externals.find(e => e.default_for_currency) || externals[0];
  const label = dest
    ? (dest.object === 'card' ? `${dest.brand || 'Debit card'} •••• ${dest.last4}` : `${dest.bank_name || 'Bank account'} •••• ${dest.last4}`)
    : null;
  const requirements = account.requirements || {};
  const dueCount = new Set([...(requirements.currently_due || []), ...(requirements.past_due || [])]).size;
  const enabled = account.payouts_enabled ? 1 : 0;

  db.prepare(`
    UPDATE cleaner_profiles SET
      connect_details_submitted = ?, connect_payouts_enabled = ?, connect_due_count = ?,
      connect_disabled_reason = ?, payout_method_label = COALESCE(?, payout_method_label),
      connect_synced_at = datetime('now')
    WHERE stripe_connect_id = ?
  `).run(account.details_submitted ? 1 : 0, enabled, dueCount, requirements.disabled_reason || null, label, account.id);

  if (enabled && !before.connect_payouts_enabled) {
    notify(before.user_id, '🏦 Payouts are set up', `You can cash out your earnings${label ? ` to ${label}` : ''} now.`, 'payout_account_ready');
  } else if (!enabled && before.connect_payouts_enabled) {
    notify(before.user_id, '⚠️ Your payout account needs attention',
      'Stripe has paused payouts to your account. Open Earnings to see what it needs.', 'payout_account_attention');
  }
  return payoutAccountStatus(before.user_id);
}

// state: not_started | incomplete | verifying | ready | rejected
function payoutAccountStatus(userId) {
  const p = db.prepare(`
    SELECT stripe_connect_id, connect_details_submitted, connect_payouts_enabled, connect_due_count,
           connect_disabled_reason, payout_method_label
    FROM cleaner_profiles WHERE user_id = ?
  `).get(userId);
  if (!p?.stripe_connect_id) return { state: 'not_started', payouts_enabled: false, label: null, needs_info: false };

  const state = /^rejected/.test(p.connect_disabled_reason || '') ? 'rejected'
    : p.connect_payouts_enabled ? 'ready'
    : !p.connect_details_submitted || p.connect_due_count > 0 ? 'incomplete'
    : 'verifying';
  return {
    state,
    payouts_enabled: !!p.connect_payouts_enabled,
    label: p.payout_method_label || null,
    needs_info: p.connect_due_count > 0,
  };
}

async function syncConnectAccount(userId) {
  const p = db.prepare('SELECT stripe_connect_id FROM cleaner_profiles WHERE user_id = ?').get(userId);
  if (p?.stripe_connect_id) applyAccount(await getStripe().accounts.retrieve(p.stripe_connect_id));
  return payoutAccountStatus(userId);
}

// A one-time link to Stripe's setup pages. Stripe sends the cleaner back to
// appUrl?payouts=return when they finish, or ?payouts=refresh if the link expired.
async function onboardingLink(userId, appUrl) {
  const account = await ensureConnectAccount(userId);
  const link = await getStripe().accountLinks.create({
    account,
    type: 'account_onboarding',
    collection_options: { fields: 'eventually_due' },   // ask for everything once, not in rounds
    return_url: withParam(appUrl, 'payouts', 'return'),
    refresh_url: withParam(appUrl, 'payouts', 'refresh'),
  });
  return link.url;
}

// Stripe's Express dashboard, where a cleaner changes their bank account or debit card.
async function dashboardLink(userId) {
  const p = db.prepare('SELECT stripe_connect_id, connect_details_submitted FROM cleaner_profiles WHERE user_id = ?').get(userId);
  if (!p?.stripe_connect_id || !p.connect_details_submitted) {
    throw new PaymentError(409, 'Finish setting up payouts first.', 'PAYOUTS_NOT_SET_UP');
  }
  return (await getStripe().accounts.createLoginLink(p.stripe_connect_id)).url;
}

module.exports = { ensureConnectAccount, applyAccount, payoutAccountStatus, syncConnectAccount, onboardingLink, dashboardLink };
