'use strict';
// lib/stripe.js — lazy Stripe initialization
// Server starts fine without keys (for local testing).
// In production, set STRIPE_SECRET_KEY in your .env and it works automatically.

let _stripe = null;

function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key || key.startsWith('sk_test_XXXX')) {
      // Return a mock so routes don't crash during local dev
      return createMockStripe();
    }
    _stripe = require('stripe')(key);
  }
  return _stripe;
}

function createMockStripe() {
  const mock = (name) => async (...args) => {
    console.warn(`[MOCK STRIPE] ${name} called — add real STRIPE_SECRET_KEY to go live`);
    return { id: 'mock_' + Date.now(), status: 'succeeded', current_period_end: Math.floor(Date.now()/1000) + 2592000 };
  };
  return {
    customers:     {
      create: mock('customers.create'),
      retrieve: async (customerId) => ({ id: customerId, invoice_settings: { default_payment_method: null } }),
      listPaymentMethods: async () => ({ data: [] }),
    },
    paymentIntents:{ create: mock('paymentIntents.create'), capture: mock('paymentIntents.capture'), cancel: mock('paymentIntents.cancel') },
    charges:       { create: mock('charges.create') },
    refunds:       { create: mock('refunds.create') },
    transfers:     { create: mock('transfers.create') },
    subscriptions: { create: mock('subscriptions.create'), cancel: mock('subscriptions.cancel') },
    identity:      { verificationSessions: { create: mock('identity.verificationSessions.create') } },
    webhooks: {
      constructEvent: () => {
        // SECURITY: The mock MUST NOT silently accept webhooks — that would let
        // anyone forge background-check clearances, refunds, etc.
        // Set a real STRIPE_SECRET_KEY (test or live) to receive webhooks properly.
        throw new Error('[MOCK STRIPE] webhooks.constructEvent called without a real STRIPE_SECRET_KEY. ' +
          'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in your environment variables.');
      },
    },
  };
}

module.exports = { getStripe };
