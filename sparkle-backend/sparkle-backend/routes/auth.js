'use strict';
// routes/auth.js — Register, Login, /me, change-password

const express  = require('express');
const bcrypt   = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const db       = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { createRefreshToken, revokeAllUserTokens } = require('../lib/tokens');
const { sendVerificationEmail } = require('./emailVerification');
const { sendWelcomeEmail } = require('../lib/email');
const { requireCaptcha, requireCaptchaStrict } = require('../middleware/captcha');

const router = express.Router();
// SECURITY: Short-lived access tokens (15 min). If a token is stolen, the
// attacker's window is tiny. Frontend refreshes silently via /auth/refresh.
const ACCESS_EXPIRY = '15m';

const registerRules = [
  body('first_name').trim().notEmpty().withMessage('First name required'),
  body('last_name').trim().notEmpty().withMessage('Last name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be 8+ characters'),
  body('role').isIn(['cleaner', 'client']).withMessage('Role must be cleaner or client'),
  body('phone').optional().isMobilePhone(),
];

// POST /api/auth/register
router.post('/register', requireCaptchaStrict, registerRules, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  const { first_name, last_name, email, password, role, phone, city, zip } = req.body;
  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const id = uuid();
    const password_hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (id,role,first_name,last_name,email,phone,city,zip,password_hash) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,role,first_name,last_name,email,phone||null,city||null,zip||null,password_hash);
    if (role==='cleaner') db.prepare('INSERT INTO cleaner_profiles (user_id) VALUES (?)').run(id);
    else db.prepare('INSERT INTO client_profiles (user_id) VALUES (?)').run(id);
    const accessToken  = signToken({ id, role, email, name: first_name+' '+last_name }, ACCESS_EXPIRY);
    const refreshToken = createRefreshToken(db, id, req.headers['user-agent']);
    sendWelcomeEmail(email, first_name, role).catch(e => console.error('[EMAIL]',e.message));
    // Send email verification (non-blocking)
    sendVerificationEmail(id, email, first_name).catch(e => console.error('[EMAIL VERIFY]',e.message));
    res.status(201).json({
      message:'Account created successfully',
      access_token:accessToken, refresh_token:refreshToken, token:accessToken,
      expires_in:15*60,
      user:{id,role,first_name,last_name,email,phone:phone||null,city:city||null,zip:zip||null}
    });
  } catch(err) { console.error('Register error:',err); res.status(500).json({error:'Registration failed'}); }
});

// POST /api/auth/login
router.post('/login', requireCaptcha, [body('email').isEmail().normalizeEmail(), body('password').notEmpty()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  const { email, password } = req.body;
  try {
    const user = db.prepare('SELECT id,role,first_name,last_name,email,phone,city,zip,password_hash,is_active FROM users WHERE email=?').get(email);
    const FAIL = { error: 'Invalid email or password' };
    if (!user) return res.status(401).json(FAIL);
    if (!user.is_active) return res.status(403).json({ error: 'Account suspended. Contact support.' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json(FAIL);
    // 2FA check
    const tfa = db.prepare('SELECT is_enabled FROM two_factor_auth WHERE user_id=?').get(user.id);
    if (tfa && tfa.is_enabled===1) {
      const jwt = require('jsonwebtoken');
      if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET env variable not set');
      const preAuthToken = jwt.sign({id:user.id,type:'pre_auth'}, process.env.JWT_SECRET, {expiresIn:'10m'});
      return res.json({ requires_2fa:true, pre_auth_token:preAuthToken, user_id:user.id, message:'Enter your 6-digit authenticator code' });
    }
    const accessToken  = signToken({id:user.id,role:user.role,email:user.email,name:user.first_name+' '+user.last_name}, ACCESS_EXPIRY);
    const refreshToken = createRefreshToken(db, user.id, req.headers['user-agent']);
    let profile = null;
    if (user.role==='cleaner') {
      profile = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id=?').get(user.id);
      const services = db.prepare('SELECT service FROM cleaner_services WHERE cleaner_id=?').all(user.id);
      if(profile) profile.services = services.map(s=>s.service);
    } else if (user.role==='client') {
      profile = db.prepare('SELECT * FROM client_profiles WHERE user_id=?').get(user.id);
    }
    res.json({
      access_token:accessToken, refresh_token:refreshToken, token:accessToken,
      expires_in:15*60,
      user:{id:user.id,role:user.role,first_name:user.first_name,last_name:user.last_name,email:user.email,phone:user.phone||null,city:user.city||null,zip:user.zip||null},
      profile
    });
  } catch(err) { console.error('Login error:',err); res.status(500).json({error:'Login failed'}); }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id,role,first_name,last_name,email,phone,city,zip,avatar_url,created_at FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({error:'User not found'});
  let profile = null;
  if (user.role==='cleaner') {
    profile = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id=?').get(user.id);
    const services = db.prepare('SELECT service FROM cleaner_services WHERE cleaner_id=?').all(user.id);
    if(profile) profile.services = services.map(s=>s.service);
  } else if (user.role==='client') {
    profile = db.prepare('SELECT * FROM client_profiles WHERE user_id=?').get(user.id);
  }
  res.json({user,profile});
});

// PATCH /api/auth/me
// Update core account fields that are shared across the portal.
router.patch('/me', requireAuth, [
  body('first_name').optional().trim().isLength({ min: 1, max: 80 }),
  body('last_name').optional().trim().isLength({ min: 1, max: 80 }),
  body('email').optional().trim().isEmail().normalizeEmail(),
  body('phone').optional({ nullable: true }).trim().isLength({ max: 30 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const updates = {};
  if (typeof req.body.first_name === 'string') updates.first_name = req.body.first_name.trim();
  if (typeof req.body.last_name === 'string') updates.last_name = req.body.last_name.trim();
  if (typeof req.body.phone === 'string') updates.phone = req.body.phone.trim();
  if (typeof req.body.email === 'string') {
    const email = req.body.email.trim().toLowerCase();
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
    if (conflict) return res.status(409).json({ error: 'Email already in use' });
    updates.email = email;
  }

  if (Object.keys(updates).length === 0) {
    const user = db.prepare('SELECT id,role,first_name,last_name,email,phone,city,zip,avatar_url,created_at FROM users WHERE id=?').get(req.user.id);
    return res.json({ message: 'No changes made', user });
  }

  const setClause = Object.keys(updates).map(key => `${key} = @${key}`).join(', ');
  db.prepare(`
    UPDATE users SET ${setClause}, updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: req.user.id, ...updates });

  const user = db.prepare('SELECT id,role,first_name,last_name,email,phone,city,zip,avatar_url,created_at FROM users WHERE id=?').get(req.user.id);
  let profile = null;
  if (user.role === 'cleaner') {
    profile = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id=?').get(user.id);
    const services = db.prepare('SELECT service FROM cleaner_services WHERE cleaner_id=?').all(user.id);
    if (profile) profile.services = services.map(s => s.service);
  } else if (user.role === 'client') {
    profile = db.prepare('SELECT * FROM client_profiles WHERE user_id=?').get(user.id);
  }

  res.json({ message: 'Profile updated', user, profile });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, [body('current_password').notEmpty(), body('new_password').isLength({min:8})], async (req,res) => {
  const {current_password,new_password} = req.body;
  const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) return res.status(401).json({error:'Current password is incorrect'});
  const hash = await bcrypt.hash(new_password, 12);
  db.prepare("UPDATE users SET password_hash=?,updated_at=datetime('now') WHERE id=?").run(hash,req.user.id);
  revokeAllUserTokens(db, req.user.id);
  res.json({message:'Password changed. Please log in again on all devices.'});
});

module.exports = router;
