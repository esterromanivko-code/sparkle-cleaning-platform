'use strict';
// db.js — Sparkle database setup using Node 22 built-in SQLite
// In production swap this for PostgreSQL via pg or @neondatabase/serverless

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sparkle.db');

// Create the containing directory first. When DB_PATH points at a mounted volume
// (DB_PATH=/data/sparkle.db) the mount root exists, but a nested path like
// /data/db/sparkle.db would otherwise fail with a bare "unable to open database
// file" that gives no hint about the real cause.
try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch (err) {
  console.error(`[DB] Could not create the directory for DB_PATH (${DB_PATH}): ${err.message}`);
}

let db;
try {
  db = new DatabaseSync(DB_PATH);
} catch (err) {
  console.error(`\n❌  FATAL: could not open the database at ${DB_PATH}\n    ${err.message}`);
  console.error('    Check that DB_PATH points somewhere writable — on Railway that means a mounted Volume.\n');
  process.exit(1);
}

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
    badge_tier          TEXT NOT NULL DEFAULT 'none',  -- none|licensed|insured|licensed_and_insured

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

  -- CLEANER CREDENTIALS (business license + certificate of insurance)
  -- One row per document SUBMISSION, so history is preserved: a renewal inserts a
  -- new row and the prior row is marked 'superseded' once the replacement is approved.
  -- NOTE: SQLite cannot alter a CHECK constraint and CREATE TABLE IF NOT EXISTS is a
  -- no-op on an existing DB, so both enums below must be complete from day one.
  CREATE TABLE IF NOT EXISTS cleaner_credentials (
    id            TEXT PRIMARY KEY,
    cleaner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_type      TEXT NOT NULL CHECK(doc_type IN ('license','coi')),
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','approved','rejected','expired','superseded')),
    filename      TEXT NOT NULL,        -- uuid.ext on disk; NEVER the original name
    original_name TEXT,
    mimetype      TEXT,
    size_bytes    INTEGER,
    issuer        TEXT,                 -- issuing state / insurance carrier
    policy_number TEXT,                 -- SENSITIVE — never returned on a public route
    expires_at    TEXT,                 -- ISO date (YYYY-MM-DD); admin may correct on approve
    review_notes  TEXT,                 -- rejection reason, shown to the cleaner
    reviewed_by   TEXT REFERENCES users(id),
    reviewed_at   TEXT,
    warned_30d_at TEXT,                 -- dedupe marker for the 30-day expiry warning
    is_current    INTEGER NOT NULL DEFAULT 1,   -- 0 once superseded by a newer approval
    submitted_at  TEXT NOT NULL DEFAULT (datetime('now'))
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

  -- JOB PHOTOS — proof of work, and evidence when something goes wrong.
  --   before / after : taken by the assigned cleaner. At least one of each is
  --                    required before the job can be completed, and so paid.
  --   lockout        : the cleaner's photo at the door when they could not get in.
  --   evidence       : attached to a dispute, by either party or an admin.
  -- These are pictures of the inside of people's homes. The files live in
  -- UPLOAD_DIR/job-photos, which is NOT publicly served; routes/jobPhotos.js streams
  -- them only to that job's cleaner, that job's client, and admins.
  -- CHECK constraints can never be changed later, so every enum is complete now.
  CREATE TABLE IF NOT EXISTS job_photos (
    id               TEXT PRIMARY KEY,
    job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    uploaded_by      TEXT NOT NULL REFERENCES users(id),
    role             TEXT NOT NULL CHECK(role IN ('cleaner','client','admin')),
    stage            TEXT NOT NULL CHECK(stage IN ('before','after','lockout','evidence')),
    dispute_id       TEXT,
    client_upload_id TEXT,              -- set by the app so a retried upload is stored once
    filename         TEXT NOT NULL,     -- uuid.jpg, re-encoded so EXIF/GPS is gone; never the original name
    thumb_filename   TEXT NOT NULL,
    size_bytes       INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at       TEXT,              -- admins soft-delete: proof is never silently destroyed
    deleted_by       TEXT REFERENCES users(id),
    delete_reason    TEXT,
    -- evidence photos, and only evidence photos, belong to a dispute
    CHECK ((stage = 'evidence') = (dispute_id IS NOT NULL)),
    -- only the cleaner takes before/after/lockout photos
    CHECK (stage = 'evidence' OR role = 'cleaner'),
    -- and that dispute must be about this same job
    FOREIGN KEY (dispute_id, job_id) REFERENCES disputes(id, job_id) ON DELETE CASCADE
  );

  -- CASHOUTS — one row per transfer to a cleaner's bank. payouts.cashout_id marks
  -- which earnings a transfer covers, so a transfer whose outcome is unknown (the
  -- connection dropped mid-request) is reconciled rather than paid a second time.
  CREATE TABLE IF NOT EXISTS cashouts (
    id                 TEXT PRIMARY KEY,
    cleaner_id         TEXT NOT NULL REFERENCES users(id),
    method             TEXT NOT NULL CHECK(method IN ('standard','instant')),
    destination        TEXT NOT NULL,   -- Stripe Connect account at the time; retries must reuse it
    gross_amount       REAL NOT NULL,   -- earnings claimed, after subtracting any refunds owed
    fee_amount         REAL NOT NULL DEFAULT 0,
    net_amount         REAL NOT NULL,
    status             TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','paid','failed')),
    stripe_transfer_id TEXT,
    instant_status     TEXT,            -- NULL for standard; pending / paid / failed for instant
    error              TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at       TEXT
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
  CREATE INDEX IF NOT EXISTS idx_cred_cleaner ON cleaner_credentials(cleaner_id, doc_type, is_current);
  CREATE INDEX IF NOT EXISTS idx_cred_pending ON cleaner_credentials(status, submitted_at);
  CREATE INDEX IF NOT EXISTS idx_cred_expiry  ON cleaner_credentials(status, expires_at);
  -- job_photos' composite foreign key needs a unique index on its target columns.
  -- id is already the primary key, so this can never fail on existing data.
  CREATE UNIQUE INDEX IF NOT EXISTS ux_disputes_id_job ON disputes(id, job_id);
  CREATE INDEX IF NOT EXISTS idx_job_photos_job     ON job_photos(job_id, stage);
  CREATE INDEX IF NOT EXISTS idx_job_photos_dispute ON job_photos(dispute_id);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_job_photos_client_upload
    ON job_photos(job_id, uploaded_by, client_upload_id) WHERE client_upload_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_disputes_job      ON disputes(job_id, status);
  CREATE INDEX IF NOT EXISTS idx_disputes_filed_by ON disputes(filed_by, created_at);
  CREATE INDEX IF NOT EXISTS idx_disputes_against  ON disputes(against, created_at);
  CREATE INDEX IF NOT EXISTS idx_payouts_job       ON payouts(job_id, type, status);
  CREATE INDEX IF NOT EXISTS idx_cashouts_cleaner  ON cashouts(cleaner_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_cashouts_status   ON cashouts(status, created_at);
`);

// ── Column migrations ─────────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS never alters a table that already exists, so columns
// added after launch are added here. Only "duplicate column name" means the work
// is already done. Anything else must stop the boot: SQLite refuses, for example,
// ADD COLUMN ... DEFAULT (datetime('now')), and swallowing that error would leave
// the column missing and every query that uses it broken.
// Returns true when the column was added on this boot.
function addColumn(table, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    return true;
  } catch (err) {
    if (/duplicate column name/i.test(err.message)) return false;
    throw err;
  }
}

addColumn('users', 'email_verified INTEGER NOT NULL DEFAULT 0');

// No CHECK constraint by design — recomputeBadgeTier() in lib/badges.js is the
// only writer, so the enum is enforced in exactly one place.
addColumn('cleaner_profiles', "badge_tier TEXT NOT NULL DEFAULT 'none'");

// Before/after photos gate payment. Jobs that were already finished before this
// rule existed can never get photos, so they are exempted once, when the column
// first appears — never again, or a later job could slip through.
if (addColumn('jobs', 'photos_required INTEGER NOT NULL DEFAULT 1')) {
  db.exec("UPDATE jobs SET photos_required = 0 WHERE status IN ('completed','cancelled')");
}
addColumn('jobs', 'photos_verified_at TEXT');   // set by /complete once the photos were checked
addColumn('jobs', 'completed_at TEXT');         // the 72-hour problem-report window starts here
addColumn('jobs', 'capture_status TEXT');       // captured | failed | not_required

// Older completed jobs never recorded a completion time; their last update is the
// closest record there is. Only ever touches rows still missing one.
db.exec("UPDATE jobs SET completed_at = updated_at WHERE status = 'completed' AND completed_at IS NULL");

addColumn('disputes', "ruling TEXT CHECK(ruling IN ('cleaner','client'))");
addColumn('disputes', 'refund_status TEXT');    // not_applicable | pending | succeeded | failed
addColumn('disputes', 'refund_id TEXT');
addColumn('disputes', 'refund_amount REAL');
addColumn('disputes', 'respondent_statement TEXT');      // the cleaner's side of the story
addColumn('disputes', 'respondent_statement_at TEXT');

addColumn('payouts', 'cashout_id TEXT REFERENCES cashouts(id)');  // set while a transfer covers this row
addColumn('payouts', 'dispute_id TEXT REFERENCES disputes(id)');  // on refund (clawback) rows
// payouts.status can't gain a 'void' value (CHECK constraints are permanent), so a
// voided row is status 'failed' with the reason recorded here.
addColumn('payouts', 'void_reason TEXT');

// ── Legacy payout clean-up ────────────────────────────────────────────────────
// Choosing a bid used to create the cleaner's payout at booking time, and /complete
// then created a second one, so a finished bid job could pay twice. The booking-
// time row (the earlier one) carries the correct amount — the quote minus the
// success fee. Paid rows are never touched: that money has already moved.
db.exec(`
  UPDATE payouts SET status = 'failed', void_reason = 'duplicate job payout'
  WHERE type = 'job' AND status = 'pending' AND job_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM payouts p2
      WHERE p2.job_id = payouts.job_id AND p2.cleaner_id = payouts.cleaner_id
        AND p2.type = 'job'
        AND (p2.status = 'paid' OR (p2.status = 'pending' AND p2.rowid < payouts.rowid))
    )
`);
// The same booking-time rows survived when the job was later cancelled.
db.exec(`
  UPDATE payouts SET status = 'failed', void_reason = 'job was cancelled'
  WHERE type = 'job' AND status = 'pending' AND cashout_id IS NULL
    AND job_id IN (SELECT id FROM jobs WHERE status = 'cancelled')
`);
// One live job payout per job, from now on. If two PAID duplicates exist the index
// can't be built; the app still works, and the conflict needs a human to look.
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_payouts_one_per_job
           ON payouts(job_id, cleaner_id) WHERE type = 'job' AND status != 'failed'`);
} catch (err) {
  console.warn('[DB] Could not enforce one payout per job — duplicate paid payouts exist:', err.message);
}
// A client can raise one dispute per job. Same reasoning if old duplicates exist.
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_disputes_one_per_job ON disputes(job_id)');
} catch (err) {
  console.warn('[DB] Could not enforce one dispute per job — duplicates exist:', err.message);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_payouts_cashout ON payouts(cashout_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_completed ON jobs(status, completed_at)');

module.exports = db;
