'use strict';
// lib/push.js — push notifications to the Sparkle phone apps, through Firebase
// Cloud Messaging. Firebase delivers to Android itself and to iPhones via Apple,
// so one set of credentials covers both.
//
// Switched off until FIREBASE_SERVICE_ACCOUNT_JSON is set (the JSON key from
// Firebase → Project settings → Service accounts → Generate new private key).
// Without it every call here does nothing, so the website and tests are untouched.
//
// Notifications are stored in the database either way (lib/notify.js); a push is
// only the tap on the shoulder, never the record.

const crypto = require('crypto');
const db = require('../db');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let _account = null;      // parsed credentials, or false when unusable
let _token = null;        // { value, expiresAt }

function serviceAccount() {
  if (_account !== null) return _account;
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return (_account = false);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) throw new Error('client_email, private_key and project_id are required');
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');   // survives being pasted into a dashboard
    _account = parsed;
  } catch (err) {
    console.error('[PUSH] FIREBASE_SERVICE_ACCOUNT_JSON could not be read:', err.message);
    _account = false;
  }
  return _account;
}

const pushEnabled = () => !!serviceAccount();

// Google wants a short-lived token signed with the service account's key.
function signedAssertion(account) {
  const now = Math.floor(Date.now() / 1000);
  const part = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const body = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), account.private_key).toString('base64url')}`;
}

async function accessToken() {
  if (_token && _token.expiresAt > Date.now() + 60_000) return _token.value;
  const account = serviceAccount();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedAssertion(account),
    }),
  });
  if (!res.ok) throw new Error(`Google refused the push credentials (${res.status})`);
  const data = await res.json();
  _token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return _token.value;
}

// Sends to every phone this person is signed in on. Never throws: a notification
// that can't be pushed is still waiting for them in the app.
async function pushToUser(userId, { title, body, type, jobId } = {}) {
  if (!pushEnabled()) return { sent: 0, skipped: true };
  const devices = db.prepare('SELECT token FROM device_tokens WHERE user_id = ?').all(userId);
  if (!devices.length) return { sent: 0 };

  let auth;
  try {
    auth = await accessToken();
  } catch (err) {
    console.error('[PUSH]', err.message);
    return { sent: 0, error: err.message };
  }

  const project = serviceAccount().project_id;
  let sent = 0;
  for (const device of devices) {
    const message = {
      token: device.token,
      notification: { title, body },
      data: { type: String(type || ''), job_id: String(jobId || '') },
      android: { priority: 'high', notification: { channel_id: 'sparkle', sound: 'default' } },
      apns: { payload: { aps: { sound: 'default' } } },
    };
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (res.ok) {
        sent++;
        db.prepare("UPDATE device_tokens SET last_used_at = datetime('now') WHERE token = ?").run(device.token);
        continue;
      }
      const status = (await res.json().catch(() => ({})))?.error?.status;
      // The app was uninstalled, or the token was replaced: stop sending to it.
      if (res.status === 404 || status === 'UNREGISTERED' || status === 'INVALID_ARGUMENT') {
        db.prepare('DELETE FROM device_tokens WHERE token = ?').run(device.token);
      } else {
        console.error('[PUSH] Firebase refused a message:', res.status, status || '');
      }
    } catch (err) {
      console.error('[PUSH] Could not reach Firebase:', err.message);
    }
  }
  return { sent };
}

module.exports = { pushToUser, pushEnabled };
