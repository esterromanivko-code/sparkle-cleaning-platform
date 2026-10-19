'use strict';
// lib/setupStatus.js — "is Sparkle's outside world connected properly?", for the admin's
// Setup check card.
//
// Each check is { id, title, status, detail }. status is
//   ok    working          warn  working, but something to know
//   bad   not working      info  optional, or can't be checked from here
// The detail says what to do about it in plain words. Nothing here ever returns a key,
// a secret or a token, only whether it is set, which mode it is in, and what the other
// side said about it. (tests/setup-status.js plants canary secrets to make sure.)

const db = require('../db');
const { paymentsMode, publishableKey } = require('./stripe');
const { emailEnabled } = require('./email');
const { checkCredentials } = require('./push');

const PAYMENT_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.amount_capturable_updated',
  'payment_intent.processing',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
];
const ACCOUNT_EVENT = 'account.updated';

const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9]{16,}$/;
const secretSet = name => WEBHOOK_SECRET.test(String(process.env[name] || '').trim());
const check = (id, title, status, detail) => ({ id, title, status, detail });

// What did Stripe say, in words that aren't Stripe's (their messages can name the key).
function stripeProblem(err) {
  return err && err.type === 'StripeAuthenticationError'
    ? 'Stripe rejected the secret key. Copy it again from Stripe → Developers → API keys.'
    : "Sparkle couldn't reach Stripe just now. Try again in a minute.";
}

async function paymentChecks({ stripe, webhookUrl }) {
  const mode = paymentsMode();
  const out = [];

  if (mode === 'off') {
    out.push(check('payments', 'Card payments', 'bad',
      'No Stripe key is set, so nobody can book. Add STRIPE_SECRET_KEY (a test key, sk_test_…) in Railway → Variables.'));
    return out;
  }
  if (mode === 'mock') {
    out.push(check('payments', 'Card payments', 'info', 'Running on a pretend Stripe (local development). Nothing real is charged.'));
    return out;
  }

  out.push(mode === 'live'
    ? check('payments', 'Card payments', 'warn',
        'LIVE mode: real cards will be charged. Use test keys (sk_test_ and pk_test_) until a full test booking has worked.')
    : check('payments', 'Card payments', 'ok', 'Test mode: no real money moves.'));

  out.push(publishableKey()
    ? check('publishable', 'Card form key', 'ok', `The publishable key matches the ${mode} secret key.`)
    : check('publishable', 'Card form key', 'bad',
        `STRIPE_PUBLISHABLE_KEY is missing, or isn't a pk_${mode}_ key to go with the sk_${mode}_ secret key. Until it is, nobody can add a card.`));

  // Does Stripe accept the secret key? (A read-only call.)
  try {
    await stripe.balance.retrieve();
    out.push(check('stripe-key', 'Stripe secret key', 'ok', 'Stripe accepted it.'));
  } catch (err) {
    out.push(check('stripe-key', 'Stripe secret key', 'bad', stripeProblem(err)));
    return out;   // no point asking about webhooks with a key Stripe refuses
  }

  // Webhooks are optional (payments work without them, just a little slower to update).
  let endpoints = null;
  try {
    endpoints = (await stripe.webhookEndpoints.list({ limit: 100 })).data || [];
  } catch {
    out.push(check('webhooks', 'Stripe webhooks', 'info', "Couldn't read them (a restricted key can't). Optional: they make updates arrive sooner."));
    return out;
  }

  const ours = endpoints.filter(e => e.url === webhookUrl && e.status === 'enabled');
  const listensTo = wanted => ours.some(e => (e.enabled_events || []).includes('*') || wanted.every(w => (e.enabled_events || []).includes(w)));

  const paymentsHook = listensTo(PAYMENT_EVENTS);
  const paymentsSecret = secretSet('STRIPE_WEBHOOK_SECRET');
  out.push(
    paymentsHook && paymentsSecret ? check('webhook-payments', 'Payment webhook', 'ok', 'Stripe tells Sparkle about payments as they happen.')
    : paymentsHook ? check('webhook-payments', 'Payment webhook', 'warn', `The endpoint exists in Stripe, but its signing secret isn't in Railway as STRIPE_WEBHOOK_SECRET, so Sparkle ignores it.`)
    : paymentsSecret ? check('webhook-payments', 'Payment webhook', 'warn', `A signing secret is set, but Stripe has no enabled endpoint at ${webhookUrl} for the payment events.`)
    : check('webhook-payments', 'Payment webhook', 'info', `Optional. Payments still work. To add it: Stripe → Developers → Webhooks → ${webhookUrl}`));

  const accountHook = listensTo([ACCOUNT_EVENT]);
  const accountSecret = secretSet('STRIPE_CONNECT_WEBHOOK_SECRET');
  out.push(
    accountHook && accountSecret ? check('webhook-accounts', 'Payout-account webhook', 'ok', 'Stripe tells Sparkle when a cleaner finishes setting up payouts.')
    : accountHook ? check('webhook-accounts', 'Payout-account webhook', 'warn', `The endpoint exists, but its signing secret isn't in Railway as STRIPE_CONNECT_WEBHOOK_SECRET.`)
    : accountSecret ? check('webhook-accounts', 'Payout-account webhook', 'warn', `A signing secret is set, but Stripe has no enabled endpoint at ${webhookUrl} for account.updated.`)
    : check('webhook-accounts', 'Payout-account webhook', 'info', 'Optional. The app checks with Stripe directly when a cleaner returns from setting up payouts.'));

  out.push(check('connect', 'Stripe Connect (payouts)', 'info',
    "Can't be checked from here. If a cleaner's \"Set up payouts\" shows an error, turn it on: Stripe → Connect → Get started (a marketplace, Express accounts)."));
  return out;
}

async function pushChecks() {
  const creds = await checkCredentials();
  const phones = db.prepare('SELECT COUNT(*) n FROM device_tokens').get().n;
  const phoneNote = phones === 0
    ? 'No phone has the app signed in yet.'
    : `${phones} phone${phones === 1 ? ' is' : 's are'} signed in with the app.`;

  if (!creds.configured) {
    return [check('push', 'Phone notifications', 'bad', creds.unreadable
      ? `FIREBASE_SERVICE_ACCOUNT_JSON is set but can't be read (${creds.unreadable}). Paste the whole downloaded .json file again.`
      : "Firebase isn't connected, so phones won't buzz (notifications still appear inside the app). Add FIREBASE_SERVICE_ACCOUNT_JSON in Railway → Variables.")];
  }
  if (!creds.ok) {
    return [check('push', 'Phone notifications', 'bad',
      `Firebase project "${creds.project_id}" is set, but Google refused the key (${creds.error}). Generate a new private key for it in Firebase → Project settings → Service accounts.`)];
  }
  return [check('push', 'Phone notifications', 'ok',
    `Connected to Firebase project "${creds.project_id}". ${phoneNote} Use "Send me a test notification" to prove a phone buzzes.`)];
}

function otherChecks() {
  const out = [];
  const smtp = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  out.push(smtp ? check('email', 'Email', 'ok', 'Sparkle can send email (password resets, welcome, support replies).')
    : emailEnabled() ? check('email', 'Email', 'info', 'Emails are only being captured (local development), not sent.')
    : check('email', 'Email', 'bad', "Not set up, so nobody can reset a password by email. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and EMAIL_FROM in Railway → Variables."));

  const captcha = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
  out.push(captcha && captcha !== 'TURNSTILE_SECRET_KEY_HERE'
    ? check('captcha', 'Bot protection', 'ok', 'Sign-up and sign-in are protected by Cloudflare Turnstile.')
    : check('captcha', 'Bot protection', 'warn', 'Turnstile is off, so bots can create accounts. Add TURNSTILE_SECRET_KEY in Railway → Variables.'));

  out.push(String(process.env.FRONTEND_URL || '').trim()
    ? check('frontend', 'Website address', 'ok', 'Set, so links in emails and the browser security rules point at the right place.')
    : check('frontend', 'Website address', 'bad', 'FRONTEND_URL is not set. Add your website address in Railway → Variables.'));
  return out;
}

async function setupChecks({ stripe, webhookUrl }) {
  const [payments, push] = await Promise.all([paymentChecks({ stripe, webhookUrl }), pushChecks()]);
  return [...payments, ...push, ...otherChecks()];
}

module.exports = { setupChecks, PAYMENT_EVENTS };
