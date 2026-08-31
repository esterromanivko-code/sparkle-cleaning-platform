'use strict';
// scripts/create-admin.js — one-time bootstrap for a real admin account
//
// Admin accounts can't be created through the public /api/auth/register
// endpoint (it only allows role 'cleaner' or 'client') — that's intentional,
// so nobody can sign themselves up as an admin. This script inserts an admin
// user directly into the database instead.
//
// Usage:
//   node scripts/create-admin.js <email> <password> <first_name> <last_name>
//
// Example:
//   node scripts/create-admin.js admin@sparkle.app "MyStrongPass123!" Ada Admin
//
// After running, sign in on the normal sign-in form with these credentials —
// you'll land in the real admin portal (not demo mode).

const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../db');

const [, , email, password, firstName, lastName] = process.argv;

if (!email || !password || !firstName || !lastName) {
  console.error('Usage: node scripts/create-admin.js <email> <password> <first_name> <last_name>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

(async () => {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    if (existing.role === 'admin') {
      console.error(`A user with email ${email} already exists and is already an admin.`);
    } else {
      console.error(`A user with email ${email} already exists with role '${existing.role}'. Choose a different email.`);
    }
    process.exit(1);
  }

  const id = uuid();
  const password_hash = await bcrypt.hash(password, 12);
  db.prepare(
    'INSERT INTO users (id,role,first_name,last_name,email,password_hash,email_verified) VALUES (?,?,?,?,?,?,1)'
  ).run(id, 'admin', firstName, lastName, email, password_hash);

  console.log(`Admin account created: ${email} (id: ${id})`);
  console.log('Sign in with this email/password on the normal sign-in form to access the admin portal.');
})();
