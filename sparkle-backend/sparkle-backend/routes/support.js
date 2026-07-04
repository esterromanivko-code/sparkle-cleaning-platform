'use strict';
// routes/support.js — Customer support ticketing system
// Handles: anonymous + logged-in ticket creation (landing page contact form,
// in-app "Contact support"), ticket threads, and admin ticket management.

const express = require('express');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { requireAuth, requireRole, verifyToken } = require('../middleware/auth');
const { supportLimiter } = require('../middleware/security');
const { sendSupportTicketReceived, sendSupportReply } = require('../lib/email');

const router = express.Router();

// Attaches req.user if a valid Bearer token is present, but never rejects —
// the landing page contact form has no session at all.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = verifyToken(token); } catch { /* ignore — treat as anonymous */ }
  }
  next();
}

// POST /api/support/tickets — create a new ticket (anonymous or logged in)
router.post('/tickets', supportLimiter, optionalAuth, [
  body('name').trim().notEmpty().withMessage('Name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('subject').trim().notEmpty().withMessage('Subject required'),
  body('message').trim().notEmpty().isLength({ max: 5000 }).withMessage('Message required'),
  body('phone').optional({ nullable: true }).trim().isLength({ max: 30 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { name, email, phone, subject, message } = req.body;
  const userId = req.user ? req.user.id : null;

  const id = uuid();
  db.prepare(`INSERT INTO support_tickets (id, user_id, name, email, phone, subject) VALUES (?,?,?,?,?,?)`)
    .run(id, userId, name, email, phone || null, subject);

  db.prepare(`INSERT INTO support_messages (id, ticket_id, sender, sender_id, body) VALUES (?,?,?,?,?)`)
    .run(uuid(), id, 'user', userId, message);

  sendSupportTicketReceived(email, name, id, subject).catch(() => {});

  res.status(201).json({ id, status: 'open' });
});

// GET /api/support/my-tickets — logged-in user's own tickets
router.get('/my-tickets', requireAuth, (req, res) => {
  const tickets = db.prepare(`SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC`).all(req.user.id);
  res.json({ tickets });
});

// GET /api/support/tickets/:id — ticket + message thread (owner or admin)
router.get('/tickets/:id', requireAuth, (req, res) => {
  const ticket = db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (req.user.role !== 'admin' && ticket.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const messages = db.prepare(`SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY sent_at ASC`).all(req.params.id);
  res.json({ ticket, messages });
});

// POST /api/support/tickets/:id/reply — reply on a ticket (owner or admin)
router.post('/tickets/:id/reply', requireAuth, [
  body('message').trim().notEmpty().isLength({ max: 5000 }).withMessage('Message required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const ticket = db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (req.user.role !== 'admin' && ticket.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const sender = req.user.role === 'admin' ? 'admin' : 'user';
  const msgId = uuid();
  db.prepare(`INSERT INTO support_messages (id, ticket_id, sender, sender_id, body) VALUES (?,?,?,?,?)`)
    .run(msgId, req.params.id, sender, req.user.id, req.body.message);

  let newStatus = ticket.status;
  if (sender === 'user' && (ticket.status === 'resolved' || ticket.status === 'closed')) {
    newStatus = 'open';
  } else if (sender === 'admin' && ticket.status === 'open') {
    newStatus = 'in_progress';
  }
  db.prepare(`UPDATE support_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(newStatus, req.params.id);

  if (sender === 'admin') {
    sendSupportReply(ticket.email, ticket.name, req.body.message, ticket.id).catch(() => {});
    if (ticket.user_id) {
      db.prepare(`INSERT INTO notifications (id, user_id, title, body, type) VALUES (?,?,?,?,?)`)
        .run(uuid(), ticket.user_id, '💬 Support replied to your ticket', req.body.message.slice(0, 140), 'support_reply');
    }
  }

  res.status(201).json({ id: msgId, status: newStatus });
});

// ══════════════════════════════════════════════════════
//  ADMIN — manage all tickets
// ══════════════════════════════════════════════════════

// GET /api/support/admin/tickets — list/filter/paginate
router.get('/admin/tickets', requireAuth, requireRole('admin'), (req, res) => {
  const { status, search, page = 1, limit = 20 } = req.query;
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (search) {
    const term = `%${search}%`;
    conditions.push('(name LIKE ? OR email LIKE ? OR subject LIKE ?)');
    params.push(term, term, term);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const lim = Math.min(parseInt(limit) || 20, 100);
  const offset = ((parseInt(page) || 1) - 1) * lim;

  const tickets = db.prepare(`SELECT * FROM support_tickets ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, lim, offset);
  const total = db.prepare(`SELECT COUNT(*) as count FROM support_tickets ${where}`).get(...params).count;

  res.json({ tickets, total, page: parseInt(page) || 1, limit: lim });
});

// PATCH /api/support/admin/tickets/:id — update status
router.patch('/admin/tickets/:id', requireAuth, requireRole('admin'), [
  body('status').isIn(['open', 'in_progress', 'resolved', 'closed']).withMessage('Invalid status'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const ticket = db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  db.prepare(`UPDATE support_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(req.body.status, req.params.id);
  res.json({ id: req.params.id, status: req.body.status });
});

module.exports = router;
