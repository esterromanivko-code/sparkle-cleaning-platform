'use strict';
// lib/stripe.js — the one place a Stripe client is made.
//
//   A real key (sk_test_… or sk_live_…)       → the real Stripe API.
//   No usable key, local development or tests → an in-memory stand-in (below), so
//                                               the app runs and payment flows can
//                                               be tested without a Stripe account.
//   No usable key in production               → a client whose every call fails.
//                                               Nothing is booked, refunded or paid
//                                               out unless real money moves.

const KEY_PATTERN = /^(sk|rk)_(test|live)_[A-Za-z0-9]{20,}$/;

// 'live' | 'test' when a real secret key is set, otherwise null. Placeholders such
// as sk_test_XXXXXXXX or sk_test_placeholder don't count.
function keyMode() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!KEY_PATTERN.test(key) || /^sk_test_X+$/i.test(key)) return null;
  return key.includes('_live_') ? 'live' : 'test';
}

// live | test | mock | off
function paymentsMode() {
  const mode = keyMode();
  if (mode) return mode;
  return process.env.NODE_ENV === 'production' ? 'off' : 'mock';
}

// The browser needs the publishable key that belongs with the secret key: a
// pk_test_ key for sk_test_, pk_live_ for sk_live_. Anything else is ignored.
function publishableKey() {
  const mode = keyMode();
  const pk = String(process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
  if (!mode || !new RegExp(`^pk_${mode}_[A-Za-z0-9]{20,}$`).test(pk)) return null;
  return pk;
}

let _client = null;
let _clientKey = null;

function getStripe() {
  const mode = paymentsMode();
  if (mode === 'live' || mode === 'test') {
    const key = String(process.env.STRIPE_SECRET_KEY).trim();
    if (!_client || _clientKey !== key) {
      _client = require('stripe')(key, { maxNetworkRetries: 2 });
      _clientKey = key;
    }
    return _client;
  }
  return mode === 'mock' ? mockStripe() : disabledStripe();
}

// ── Production without a key ─────────────────────────────────────────────────
// Every API call rejects with an authentication error, which lib/payouts.js treats
// as "Stripe definitely did nothing", so claims are released rather than stuck.
function disabledStripe() {
  const notConfigured = () => {
    const err = new Error('Stripe is not configured on this server (STRIPE_SECRET_KEY is missing or a placeholder).');
    err.type = 'StripeAuthenticationError';
    return err;
  };
  const call = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : call),
    apply: () => Promise.reject(notConfigured()),
  });
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      // Webhook verification is synchronous and callers expect it to throw.
      if (prop === 'webhooks') return { constructEvent: () => { throw notConfigured(); } };
      return call;
    },
  });
}

// ── Local development and tests ──────────────────────────────────────────────
// Keeps PaymentIntents, cards and Connect accounts in memory and follows Stripe's
// state machine closely enough to exercise holds, captures, declines and 3-D
// Secure. Stripe's own test card ids pick the outcome:
//   pm_card_visa (or any other id)   → approved
//   pm_card_chargeDeclined           → declined
//   pm_card_authenticationRequired   → the bank asks the cardholder to approve
let _mock = null;

function mockStripe() {
  if (_mock) return _mock;

  let seq = 0;
  const newId = prefix => `${prefix}_mock_${Date.now().toString(36)}${(++seq).toString(36)}`;
  const clone = obj => JSON.parse(JSON.stringify(obj));
  const warned = new Set();
  const note = name => {
    if (warned.has(name)) return;
    warned.add(name);
    console.warn(`[MOCK STRIPE] ${name} — set STRIPE_SECRET_KEY to use real Stripe`);
  };

  const intents = new Map();
  const methods = new Map();     // payment method id → customer id (null when detached)
  const customers = new Map();   // customer id → { default_payment_method }
  const accounts = new Map();
  const idempotent = new Map();  // idempotency key → { value } | { error }

  function stripeError(type, message, extra = {}) {
    const err = new Error(message);
    err.type = type;
    Object.assign(err, extra);
    return err;
  }

  // Replays the first outcome for a repeated idempotency key, as Stripe does.
  async function once(options, fn) {
    const key = options?.idempotencyKey;
    if (key && idempotent.has(key)) {
      const saved = idempotent.get(key);
      if (saved.error) throw saved.error;
      return clone(saved.value);
    }
    try {
      const value = await fn();
      if (key) idempotent.set(key, { value: clone(value) });
      return value;
    } catch (error) {
      if (key) idempotent.set(key, { error });
      throw error;
    }
  }

  const cardFor = id => ({
    brand: 'visa',
    last4: id === 'pm_card_chargeDeclined' ? '0002' : id === 'pm_card_authenticationRequired' ? '3184' : '4242',
    exp_month: 12,
    exp_year: new Date().getFullYear() + 4,
  });

  function confirmIntent(pi, { offSession, authenticated } = {}) {
    const pm = pi.payment_method;
    if (pm === 'pm_card_chargeDeclined') {
      pi.status = 'requires_payment_method';
      throw stripeError('StripeCardError', 'Your card was declined.', { code: 'card_declined', payment_intent: clone(pi) });
    }
    if (pm === 'pm_card_authenticationRequired' && !authenticated) {
      if (offSession) {
        pi.status = 'requires_payment_method';
        throw stripeError('StripeCardError', 'This payment requires authentication.', { code: 'authentication_required', payment_intent: clone(pi) });
      }
      pi.status = 'requires_action';
      pi.next_action = { type: 'use_stripe_sdk' };
      return;
    }
    pi.next_action = null;
    pi.latest_charge = newId('ch');
    if (pi.capture_method === 'manual') {
      pi.status = 'requires_capture';
      pi.amount_capturable = pi.amount;
    } else {
      pi.status = 'succeeded';
      pi.amount_received = pi.amount;
    }
  }

  // Intents made before this stand-in kept state (seeded in tests or old local
  // databases) behave like a hold waiting to be captured.
  const legacyIntent = id => ({ id, object: 'payment_intent', status: 'requires_capture', amount: 0, amount_capturable: 0, capture_method: 'manual', metadata: {} });

  const account = (id, fields = {}) => ({
    id, object: 'account', details_submitted: false, payouts_enabled: false, charges_enabled: false,
    requirements: { currently_due: ['external_account', 'individual.ssn_last_4'], past_due: [], disabled_reason: 'requirements.past_due' },
    external_accounts: { data: [] }, metadata: {}, ...fields,
  });
  const readyAccount = id => account(id, {
    details_submitted: true, payouts_enabled: true,
    requirements: { currently_due: [], past_due: [], disabled_reason: null },
    external_accounts: { data: [{ object: 'bank_account', bank_name: 'STRIPE TEST BANK', last4: '6789', default_for_currency: true }] },
  });

  const mock = name => async () => {
    note(name);
    return { id: newId('obj'), status: 'succeeded', current_period_end: Math.floor(Date.now() / 1000) + 2592000 };
  };

  _mock = {
    customers: {
      create: async (params, options) => once(options, async () => {
        const id = newId('cus');
        customers.set(id, { default_payment_method: null, email: params?.email || null });
        return { id, object: 'customer', email: params?.email || null };
      }),
      retrieve: async (id) => ({ id, object: 'customer', invoice_settings: { default_payment_method: customers.get(id)?.default_payment_method || null } }),
      update: async (id, params) => {
        const c = customers.get(id) || { default_payment_method: null };
        if (params?.invoice_settings && 'default_payment_method' in params.invoice_settings) {
          c.default_payment_method = params.invoice_settings.default_payment_method;
        }
        customers.set(id, c);
        return { id, object: 'customer', invoice_settings: { default_payment_method: c.default_payment_method } };
      },
      listPaymentMethods: async (customerId) => ({
        data: [...methods].filter(([, owner]) => owner === customerId)
          .map(([id]) => ({ id, object: 'payment_method', type: 'card', customer: customerId, card: cardFor(id) })),
      }),
      del: async (id) => ({ id, deleted: true }),
    },
    paymentMethods: {
      retrieve: async (id) => {
        if (!/^pm_/.test(id)) throw stripeError('StripeInvalidRequestError', `No such PaymentMethod: '${id}'`, { code: 'resource_missing' });
        return { id, object: 'payment_method', type: 'card', customer: methods.get(id) ?? null, card: cardFor(id) };
      },
      attach: async (id, { customer }) => { methods.set(id, customer); return { id, customer, card: cardFor(id) }; },
      detach: async (id) => { methods.set(id, null); return { id, customer: null }; },
    },
    setupIntents: {
      create: async (params) => {
        note('setupIntents.create');
        const id = newId('seti');
        return { id, object: 'setup_intent', status: 'requires_payment_method', customer: params?.customer, client_secret: `${id}_secret_mock` };
      },
    },
    paymentIntents: {
      create: async (params, options) => once(options, async () => {
        note('paymentIntents.create');
        const id = newId('pi');
        const pi = {
          id, object: 'payment_intent', amount: params.amount, currency: params.currency || 'usd',
          customer: params.customer || null, payment_method: params.payment_method || null,
          capture_method: params.capture_method || 'automatic', metadata: params.metadata || {},
          status: params.payment_method ? 'requires_confirmation' : 'requires_payment_method',
          client_secret: `${id}_secret_mock`, amount_capturable: 0, amount_received: 0, latest_charge: null,
          next_action: null, created: Math.floor(Date.now() / 1000),
        };
        intents.set(id, pi);
        if (params.confirm) confirmIntent(pi, { offSession: !!params.off_session });
        return clone(pi);
      }),
      retrieve: async (id) => clone(intents.get(id) || legacyIntent(id)),
      capture: async (id, params = {}, options) => once(options, async () => {
        const pi = intents.get(id);
        if (!pi) return { ...legacyIntent(id), status: 'succeeded' };
        if (pi.status !== 'requires_capture') {
          throw stripeError('StripeInvalidRequestError', `This PaymentIntent could not be captured because it has a status of ${pi.status}.`, { code: 'payment_intent_unexpected_state' });
        }
        pi.status = 'succeeded';
        pi.amount_received = params.amount_to_capture ?? pi.amount;
        pi.amount_capturable = 0;
        return clone(pi);
      }),
      cancel: async (id, _params, options) => once(options, async () => {
        const pi = intents.get(id);
        if (!pi) return { ...legacyIntent(id), status: 'canceled' };
        if (pi.status === 'succeeded') {
          throw stripeError('StripeInvalidRequestError', 'You cannot cancel this PaymentIntent because it has a status of succeeded.', { code: 'payment_intent_unexpected_state' });
        }
        pi.status = 'canceled';
        pi.amount_capturable = 0;
        return clone(pi);
      }),
      list: async ({ customer } = {}) => ({
        data: [...intents.values()].filter(pi => !customer || pi.customer === customer).reverse().map(clone),
      }),
    },
    charges:       { create: mock('charges.create') },
    refunds:       { create: async () => ({ id: newId('re'), status: 'succeeded' }) },
    transfers:     { create: mock('transfers.create'), list: async () => ({ data: [] }) },
    payouts:       { create: mock('payouts.create') },
    subscriptions: { create: mock('subscriptions.create'), cancel: mock('subscriptions.cancel') },
    identity:      { verificationSessions: { create: mock('identity.verificationSessions.create') } },
    accounts: {
      create: async (params, options) => once(options, async () => {
        note('accounts.create');
        const a = account(newId('acct'), { email: params?.email || null, metadata: params?.metadata || {} });
        accounts.set(a.id, a);
        return clone(a);
      }),
      // Accounts this stand-in didn't create (seeded in tests or local data) are ready.
      retrieve: async (id) => clone(accounts.get(id) || readyAccount(id)),
      createLoginLink: async (id) => ({ object: 'login_link', url: `https://connect.stripe.com/express/mock/${id}` }),
    },
    // There is no Stripe page to visit locally, so "finishing" onboarding happens
    // here and the link leads straight back to the app.
    accountLinks: {
      create: async ({ account: id, return_url }) => {
        if (accounts.has(id)) accounts.set(id, { ...readyAccount(id), metadata: accounts.get(id).metadata });
        return { object: 'account_link', url: return_url };
      },
    },
    webhooks: {
      constructEvent: () => {
        // SECURITY: The mock MUST NOT silently accept webhooks — that would let
        // anyone forge background-check clearances, refunds, etc.
        throw new Error('[MOCK STRIPE] webhooks.constructEvent called without a real STRIPE_SECRET_KEY. ' +
          'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in your environment variables.');
      },
    },

    // Not part of Stripe. What Stripe.js does in the browser when a cardholder
    // approves a payment, and a way for tests to put an account in a given state.
    _mock: {
      clientConfirm(id, paymentMethodId) {
        const pi = intents.get(id);
        if (!pi) throw stripeError('StripeInvalidRequestError', `No such PaymentIntent: '${id}'`);
        if (paymentMethodId) pi.payment_method = paymentMethodId;
        if (!['requires_action', 'requires_confirmation', 'requires_payment_method'].includes(pi.status)) return clone(pi);
        try { confirmIntent(pi, { authenticated: true }); } catch { /* declined: status already updated */ }
        return clone(pi);
      },
      setAccount(id, fields) {
        accounts.set(id, { ...(accounts.get(id) || account(id)), ...fields });
      },
      expireHold(id) {
        const pi = intents.get(id);
        if (pi) { pi.status = 'canceled'; pi.amount_capturable = 0; }
      },
    },
  };
  return _mock;
}

module.exports = { getStripe, paymentsMode, publishableKey, keyMode };
