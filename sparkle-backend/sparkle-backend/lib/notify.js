'use strict';
// lib/notify.js — in-app notifications written straight to the database.
// Synchronous on purpose: callers use these inside their own transactions, so a
// notification is recorded exactly when the change it describes is.

const { v4: uuid } = require('uuid');
const db = require('../db');

function notify(userId, title, body, type = 'platform') {
  db.prepare('INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)')
    .run(uuid(), userId, title, body, type);
}

function notifyAdmins(title, body, type = 'admin_alert') {
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1").all();
  for (const a of admins) notify(a.id, title, body, type);
}

module.exports = { notify, notifyAdmins };
