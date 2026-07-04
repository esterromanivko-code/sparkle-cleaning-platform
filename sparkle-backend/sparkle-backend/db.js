'use strict';
// db.js — Sparkle database setup using Node 22 built-in SQLite
// In production swap this for PostgreSQL via pg or @neondatabase/serverless

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sparkle.db');
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrent reads
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ─────────────────────────────────────────────────
//  SCHEMA
// ─────────────────────────────────────────────────
db.exec(`
  -- USERS (all roles share this table; role field gates access)
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,           -- uuid
    role            TEXT NOT NULL CHECK(role IN ('cleaner','client','admin')),
    first_name      TEXT NOT NULL,
    last_name       TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    phone           TEXT,
    password_hash   TEXT NOT NULL,
    city            TEXT,
    zip             TEXT,
    avatar_url      TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,  -- 0 = banned
    is_flagged      INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- CLEANER PROFILES (1-to-1 with users where role=cleaner)
  CREATE TABLE IF NOT EXISTS cleaner_profiles (
    user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    hourly_rate         REAL NOT NULL DEFAULT 25.00,
    bio                 TEXT,
    lockout_fee_enabled INTEGER NOT NULL DEFAULT 1,
    lockout_fee_amount  REAL NOT NULL DEFAULT 35.00,
    lockout_grace_mins  INTEGER NOT NULL DEFAULT 15,
    is_verified         INTEGER NOT NULL DEFAULT 0,   -- background check passed
    is_pro              INTEGER NOT NULL DEFAULT 0,   -- pro membership active
    pro_expires_at      TEXT,
    avg_rating          REAL NOT NULL DEFAULT 0,
    total_jobs          INTEGER NOT NULL DEFAULT 0,
    total_earnings      REAL NOT NULL DEFAULT 0,
    stripe_connect_id   TEXT,                         -- for payouts
    payout_bank_last4   TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- CLEANER SERVICES (many-to-1 with cleaner_profiles)
  CREATE TABLE IF NOT EXISTS cleaner_services (
    id          TEXT PRIMARY KEY,
    cleaner_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service     TEXT NOT NULL,
    UNIQUE(cleaner_id, service)
  );

  -- CLIENT PROFILES (1-to-1 with users where role=client)
  CREATE TABLE IF NOT EXISTS client_profiles (
    user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_address   TEXT,
    home_size         TEXT,
    is_business       INTEGER NOT NULL DEFAULT 0,
    business_name     TEXT,
    avg_rating        REAL NOT NULL DEFAULT 0,
    total_bookings    INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- JOBS (posted by clients)
  CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES users(id),
    cleaner_id      TEXT REFERENCES users(id),          -- NULL until accepted
    service_type    TEXT NOT NULL,
    bedrooms        INTEGER,
    bathrooms       INTEGER,
    address         TEXT NOT NULL,
    city            TEXT,
    zip             TEXT,
    lat             REAL,
    lng             REAL,
    scheduled_at    TEXT NOT NULL,
    duration_hrs    REAL,
    supplies_by     TEXT NOT NULL DEFAULT 'client' CHECK(supplies_by IN ('client','cleaner')),
    pets            TEXT,
    notes           TEXT,
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK(status IN ('open','accepted','in_progress','completed','cancelled')),
    is_recurring    INTEGER NOT NULL DEFAULT 0,
    recurring_freq  TEXT CHECK(recurring_freq IN ('weekly','biweekly','monthly',NULL)),
    parent_job_id   TEXT REFERENCES jobs(id),           -- for recurring series
    is_priority     INTEGER NOT NULL DEFAULT 0,
    has_guarantee   INTEGER NOT NULL DEFAULT 0,
    base_amount     REAL,                               -- cleaner earns this
    platform_fee    REAL,                               -- Sparkle takes this
    guarantee_fee   REAL,
    priority_fee    REAL,
    tip_amount      REAL NOT NULL DEFAULT 0,
    total_charged   REAL,
    stripe_payment_intent_id TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- LOCKOUT FEE EVENTS
  CREATE TABLE IF NOT EXISTS lockout_fees (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES jobs(id),
    cleaner_id      TEXT NOT NULL REFERENCES users(id),
    client_id       TEXT NOT NULL REFERENCES users(id),
    fee_amount      REAL NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','charged','disputed','refunded')),
    arrived_at      TEXT,
    checklist_json  TEXT,                               -- JSON of 5 confirmed items
    stripe_charge_id TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- MESSAGES
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    job_id      TEXT REFERENCES jobs(id),
    sender_id   TEXT NOT NULL REFERENCES users(id),
    receiver_id TEXT NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL,
    is_read     INTEGER NOT NULL DEFAULT 0,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- REVIEWS (mutual — cleaner reviews client AND client reviews cleaner)
  CREATE TABLE IF NOT EXISTS reviews (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES jobs(id),
    reviewer_id     TEXT NOT NULL REFERENCES users(id),
    reviewee_id     TEXT NOT NULL REFERENCES users(id),
    rating          INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    body            TEXT,
    tags_json       TEXT,                              -- JSON array of quick tags
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(job_id, reviewer_id)                        -- one review per person per job
  );

  -- BACKGROUND CHECKS
  CREATE TABLE IF NOT EXISTS background_checks (
    id                  TEXT PRIMARY KEY,
    cleaner_id          TEXT NOT NULL REFERENCES users(id),
    checkr_candidate_id TEXT,
    checkr_report_id    TEXT,
    stripe_identity_session_id TEXT,
    stripe_charge_id    TEXT,
    amount_charged      REAL NOT NULL DEFAULT 25.00,
    id_status           TEXT DEFAULT 'pending' CHECK(id_status IN ('pending','clear','flagged')),
    criminal_status     TEXT DEFAULT 'pending' CHECK(criminal_status IN ('pending','clear','flagged','consider')),
    overall_status      TEXT DEFAULT 'pending' CHECK(overall_status IN ('pending','clear','consider','suspended','dispute')),
    submitted_at        TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at        TEXT,
    expires_at          TEXT                          -- annual renewal
  );

  -- RECURRING SERIES
  CREATE TABLE IF NOT EXISTS recurring_series (
    id              TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES users(id),
    cleaner_id      TEXT NOT NULL REFERENCES users(id),
    frequency       TEXT NOT NULL CHECK(frequency IN ('weekly','biweekly','monthly')),
    day_of_week     INTEGER,                           -- 0=Sun … 6=Sat
    time_of_day     TEXT,                              -- HH:MM
    service_type    TEXT NOT NULL,
    address         TEXT NOT NULL,
    discount_pct    REAL NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','cancelled')),
    next_job_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- PAYOUTS (cleaner earnings)
  CREATE TABLE IF NOT EXISTS payouts (
    id              TEXT PRIMARY KEY,
    cleaner_id      TEXT NOT NULL REFERENCES users(id),
    job_id          TEXT REFERENCES jobs(id),
    lockout_fee_id  TEXT REFERENCES lockout_fees(id),
    amount          REAL NOT NULL,
    type            TEXT NOT NULL CHECK(type IN ('job','lockout','tip','pro_bonus','refund')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed')),
    stripe_transfer_id TEXT,
    paid_at         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- PRO MEMBERSHIPS
  CREATE TABLE IF NOT EXISTS pro_memberships (
    id                  TEXT PRIMARY KEY,
    cleaner_id          TEXT NOT NULL REFERENCES users(id),
    plan                TEXT NOT NULL CHECK(plan IN ('monthly','annual')),
    stripe_subscription_id TEXT,
    stripe_customer_id  TEXT,
    status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','past_due')),
    started_at          TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at          TEXT NOT NULL,
    cancelled_at        TEXT
  );

  -- DISPUTES
  CREATE TABLE IF NOT EXISTS disputes (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES jobs(id),
    filed_by        TEXT NOT NULL REFERENCES users(id),
    against         TEXT NOT NULL REFERENCES users(id),
    type            TEXT NOT NULL CHECK(type IN ('lockout_fee','quality','no_show','payment','other')),
    description     TEXT NOT NULL,
    evidence_json   TEXT,
    status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_review','resolved')),
    resolution      TEXT,
    resolved_by     TEXT REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at     TEXT
  );

  -- SUPPORT TICKETS (customer service — admin handles these for cleaners & clients)
  CREATE TABLE IF NOT EXISTS support_tickets (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id),    -- NULL for anonymous (landing page contact form)
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    phone       TEXT,
    subject     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- SUPPORT TICKET MESSAGES (thread between the requester and admin)
  CREATE TABLE IF NOT EXISTS support_messages (
    id          TEXT PRIMARY KEY,
    ticket_id   TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    sender      TEXT NOT NULL CHECK(sender IN ('user','admin')),
    sender_id   TEXT REFERENCES users(id),
    body        TEXT NOT NULL,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
  CREATE INDEX IF NOT EXISTS idx_support_tickets_user   ON support_tickets(user_id);
  CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id);

  -- PUSH NOTIFICATION LOG
  CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id),             -- NULL = broadcast
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    type        TEXT,
    action_url  TEXT,
    is_read     INTEGER NOT NULL DEFAULT 0,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- GIFT CARDS
  CREATE TABLE IF NOT EXISTS gift_cards (
    id              TEXT PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    amount          REAL NOT NULL,
    purchased_by    TEXT REFERENCES users(id),
    recipient_email TEXT,
    recipient_name  TEXT,
    message         TEXT,
    redeemed_by     TEXT REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','redeemed','expired')),
    expires_at      TEXT,
    stripe_charge_id TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    redeemed_at     TEXT
  );


  -- PASSWORD RESET TOKENS
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,   -- hashed for security
    expires_at  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- REFRESH TOKENS (long-lived, 1 year, used to get new access tokens)
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    device_hint TEXT,     -- e.g. "iPhone / Safari" for user visibility
    expires_at  TEXT NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    last_used   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- TWO FACTOR AUTH
  CREATE TABLE IF NOT EXISTS two_factor_auth (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret        TEXT NOT NULL,          -- TOTP secret (encrypted at rest in prod)
    is_enabled    INTEGER NOT NULL DEFAULT 0,
    backup_codes  TEXT,                   -- JSON array of hashed backup codes
    enabled_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- FILE UPLOADS
  CREATE TABLE IF NOT EXISTS file_uploads (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    job_id      TEXT REFERENCES jobs(id),
    type        TEXT NOT NULL CHECK(type IN ('profile_photo','job_photo','review_photo')),
    filename    TEXT NOT NULL,
    original_name TEXT,
    mimetype    TEXT,
    size_bytes  INTEGER,
    url         TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );



  -- EMAIL VERIFICATION
  CREATE TABLE IF NOT EXISTS email_verifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    email       TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    verified_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- BIDS / QUOTES (bidding system)
  CREATE TABLE IF NOT EXISTS bids (
    id            TEXT PRIMARY KEY,
    job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    cleaner_id    TEXT NOT NULL REFERENCES users(id),
    amount        REAL NOT NULL CHECK(amount > 0),
    message       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','chosen','declined','expired')),
    success_fee   REAL,
    submitted_at  TEXT NOT NULL DEFAULT (datetime('now')),
    chosen_at     TEXT,
    expires_at    TEXT NOT NULL,
    UNIQUE(job_id, cleaner_id)
  );

  -- CANCELLATION FEES
  CREATE TABLE IF NOT EXISTS cancellation_fees (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES jobs(id),
    charged_to      TEXT NOT NULL REFERENCES users(id),
    amount          REAL NOT NULL,
    reason          TEXT,
    stripe_charge_id TEXT,
    status          TEXT NOT NULL DEFAULT 'charged'
                    CHECK(status IN ('charged','waived','refunded')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- MILEAGE LOGS (Pro membership feature: track cleaner driving miles)
  CREATE TABLE IF NOT EXISTS mileage_logs (
    id              TEXT PRIMARY KEY,              -- uuid
    cleaner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id          TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    start_lat       REAL NOT NULL,
    start_lng       REAL NOT NULL,
    end_lat         REAL,                          -- NULL if trip not yet ended
    end_lng         REAL,                          -- NULL if trip not yet ended
    distance_miles  REAL,                          -- NULL until trip ends
    start_time      TEXT NOT NULL,
    end_time        TEXT,
    duration_minutes INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ALL INDEXES (must come after all table definitions)
  CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_cleaner ON jobs(cleaner_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, is_read);
  CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);
  CREATE INDEX IF NOT EXISTS idx_payouts_cleaner ON payouts(cleaner_id, status);
  CREATE INDEX IF NOT EXISTS idx_bgcheck_cleaner ON background_checks(cleaner_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, revoked);
  CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON password_reset_tokens(user_id, used);
  CREATE INDEX IF NOT EXISTS idx_uploads_user ON file_uploads(user_id, type);
  CREATE INDEX IF NOT EXISTS idx_uploads_job ON file_uploads(job_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at, status);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, is_active);
  CREATE INDEX IF NOT EXISTS idx_bids_job     ON bids(job_id, status);
  CREATE INDEX IF NOT EXISTS idx_bids_cleaner ON bids(cleaner_id, submitted_at);
  CREATE INDEX IF NOT EXISTS idx_bids_expiry  ON bids(expires_at, status);
  CREATE INDEX IF NOT EXISTS idx_email_verify ON email_verifications(token_hash);
  CREATE INDEX IF NOT EXISTS idx_reset_tokens_hash ON password_reset_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_mileage_cleaner ON mileage_logs(cleaner_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_mileage_job ON mileage_logs(job_id);
  CREATE INDEX IF NOT EXISTS idx_mileage_date ON mileage_logs(created_at);
`);

// Safe migration: add email_verified column if it doesn't exist yet
try {
  db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
} catch { /* Column already exists — that's fine */ }

module.exports = db;
