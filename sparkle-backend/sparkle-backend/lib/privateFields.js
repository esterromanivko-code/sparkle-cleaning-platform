'use strict';
// lib/privateFields.js — columns that exist for the server's own use and must never be
// sent to a browser or a phone, not even to the person they belong to.
//
// A cleaner's Stripe account id and bank label, a client's Stripe customer id, and the
// like are things the server needs and the app never does. Keeping them out of every
// response means a bug or injected script in a page can't read them, and a new column
// added to a table isn't exposed by accident.
//
// Prefer listing the fields a response SHOULD have. This is the fallback for responses
// that return a whole profile row to its owner.

const PRIVATE_PROFILE_FIELDS = [
  'password_hash',
  'stripe_customer_id', 'stripe_connect_id',
  'payout_bank_last4', 'payout_method_label',
  'connect_details_submitted', 'connect_payouts_enabled', 'connect_due_count',
  'connect_disabled_reason', 'connect_synced_at',
];

function stripPrivate(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const field of PRIVATE_PROFILE_FIELDS) delete out[field];
  return out;
}

module.exports = { stripPrivate, PRIVATE_PROFILE_FIELDS };
