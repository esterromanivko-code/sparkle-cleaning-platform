'use strict';
// routes/jobs.js — Job posting, matching, accepting, completing, lockout fees
//
// A job moves open → accepted → in_progress → completed (or → cancelled).
// Completing requires at least one before and one after photo from the cleaner
// (routes/jobPhotos.js); that is also the moment the cleaner's earnings are created
// and become available to cash out.

const express = require('express');
const { v4: uuid } = require('uuid');
const { body, query, validationResult } = require('express-validator');
const db     = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { stageCounts, jobAccess } = require('../lib/jobPhotos');
const { ensureJobPayout, reverseJobEarnings, transaction } = require('../lib/payouts');
const { notify, notifyAdmins } = require('../lib/notify');
const { readCoords, ensureJobCoordinates } = require('../lib/geo');
const { recordLocation, trackingSummary, isFar, ARRIVAL_RADIUS_M, MIN_PING_GAP_SECONDS } = require('../lib/tracking');
const { locationPingLimiter } = require('../middleware/security');
const payments = require('../lib/payments');

const router = express.Router();

const REPORT_WINDOW_HOURS = 72;

// A cleaner's precise positions reach the client only through /tracking, and only
// while the cleaner is on the way. List endpoints never include them.
const CLEANER_LOCATION_FIELDS = [
  'last_lat', 'last_lng', 'last_accuracy_m', 'last_distance_m', 'last_location_at',
  'arrival_lat', 'arrival_lng', 'arrival_accuracy_m', 'arrival_distance_m',
  'completion_lat', 'completion_lng', 'completion_accuracy_m', 'completion_distance_m',
];
function withoutCleanerLocation(job) {
  const out = { ...job };
  for (const field of CLEANER_LOCATION_FIELDS) delete out[field];
  return out;
}

// Cleaners aren't shown the client's card, Stripe ids or decline messages — only
// whether the client's payment for an upcoming job has a problem.
const PAYMENT_FIELDS = [
  'payment_method_id', 'stripe_payment_intent_id', 'auth_error', 'payment_error',
  'auth_attempts', 'charge_attempts', 'auth_attempted_at',
];
function forCleaner(job) {
  const out = { ...job };
  for (const field of PAYMENT_FIELDS) delete out[field];
  out.payment_issue = ['failed', 'action_required'].includes(job.auth_status);
  return out;
}

// The optional { lat, lng, accuracy } the app sends with check-ins. Returns null
// when none was sent; sends 422 and returns undefined when it's invalid.
function bodyLocation(req, res) {
  try { return readCoords(req.body); }
  catch { res.status(422).json({ error: 'Invalid location' }); return undefined; }
}

// Live before/after photo counts for the job's current cleaner, as SQL columns.
const PHOTO_COUNT_COLUMNS = `
  (SELECT COUNT(*) FROM job_photos ph WHERE ph.job_id = j.id AND ph.uploaded_by = j.cleaner_id
     AND ph.stage = 'before' AND ph.deleted_at IS NULL) AS before_photo_count,
  (SELECT COUNT(*) FROM job_photos ph WHERE ph.job_id = j.id AND ph.uploaded_by = j.cleaner_id
     AND ph.stage = 'after' AND ph.deleted_at IS NULL) AS after_photo_count,
  (SELECT COUNT(*) FROM job_photos ph WHERE ph.job_id = j.id AND ph.uploaded_by = j.cleaner_id
     AND ph.stage = 'lockout' AND ph.deleted_at IS NULL) AS lockout_photo_count`;

// ─────────────────────────────────────────────────
// GET /api/jobs/available  (cleaner only)
// Returns open jobs near the cleaner that match their services
// ─────────────────────────────────────────────────
router.get('/available', requireAuth, requireRole('cleaner'), (req, res) => {
  const services = db.prepare(
    'SELECT service FROM cleaner_services WHERE cleaner_id = ?'
  ).all(req.user.id).map(s => s.service);

  // Get all open jobs (in production add distance filtering via lat/lng)
  const jobs = db.prepare(`
    SELECT j.*,
           u.first_name || ' ' || u.last_name AS client_name,
           cp.avg_rating AS client_rating,
           cp.total_bookings
    FROM jobs j
    JOIN users u ON u.id = j.client_id
    JOIN client_profiles cp ON cp.user_id = j.client_id
    WHERE j.status = 'open'
    AND j.client_id != ?
    ORDER BY j.is_priority DESC, j.created_at ASC
    LIMIT 50
  `).all(req.user.id);

  res.json({ jobs: jobs.map(forCleaner) });
});

// ─────────────────────────────────────────────────
// GET /api/jobs/my-schedule  (cleaner only)
// Upcoming and in-progress jobs, with how many proof photos each has so far.
// ─────────────────────────────────────────────────
router.get('/my-schedule', requireAuth, requireRole('cleaner'), (req, res) => {
  const jobs = db.prepare(`
    SELECT j.*,
           u.first_name || ' ' || u.last_name AS client_name,
           u.phone AS client_phone,
           cp.avg_rating AS client_rating,
           clp.lockout_fee_enabled, clp.lockout_fee_amount, clp.lockout_grace_mins,
           ${PHOTO_COUNT_COLUMNS}
    FROM jobs j
    JOIN users u ON u.id = j.client_id
    JOIN client_profiles cp ON cp.user_id = j.client_id
    LEFT JOIN cleaner_profiles clp ON clp.user_id = j.cleaner_id
    WHERE j.cleaner_id = ?
    AND j.status IN ('accepted','in_progress')
    ORDER BY j.scheduled_at ASC
  `).all(req.user.id);

  res.json({ jobs: jobs.map(forCleaner) });
});

// ─────────────────────────────────────────────────
// GET /api/jobs/my-history  (cleaner only)
// Recently finished jobs, with their photos, dispute and earnings status.
// ─────────────────────────────────────────────────
router.get('/my-history', requireAuth, requireRole('cleaner'), (req, res) => {
  const jobs = db.prepare(`
    SELECT j.id, j.service_type, j.scheduled_at, j.completed_at, j.status, j.city,
           j.capture_status, j.photos_required,
           u.first_name || ' ' || substr(u.last_name, 1, 1) || '.' AS client_name,
           ${PHOTO_COUNT_COLUMNS},
           d.id AS dispute_id, d.status AS dispute_status, d.type AS dispute_type, d.ruling AS dispute_ruling,
           p.amount AS payout_amount, p.status AS payout_status, p.cashout_id AS payout_cashout_id
    FROM jobs j
    JOIN users u ON u.id = j.client_id
    LEFT JOIN disputes d ON d.id = (SELECT id FROM disputes WHERE job_id = j.id ORDER BY created_at DESC LIMIT 1)
    LEFT JOIN payouts p ON p.id = (
      SELECT id FROM payouts WHERE job_id = j.id AND cleaner_id = j.cleaner_id
        AND type IN ('job','lockout') AND status != 'failed' ORDER BY created_at DESC LIMIT 1)
    WHERE j.cleaner_id = ? AND j.status IN ('completed','cancelled')
    ORDER BY COALESCE(j.completed_at, j.updated_at) DESC
    LIMIT 30
  `).all(req.user.id);

  res.json({ jobs });
});

// ─────────────────────────────────────────────────
// GET /api/jobs/my-bookings  (client only)
// Includes whether a problem can still be reported, and until when.
// ─────────────────────────────────────────────────
router.get('/my-bookings', requireAuth, requireRole('client'), (req, res) => {
  const jobs = db.prepare(`
    SELECT j.*,
           u.first_name || ' ' || u.last_name AS cleaner_name,
           cp.avg_rating AS cleaner_rating,
           cp.is_verified,
           cp.is_pro,
           cp.badge_tier,
           ${PHOTO_COUNT_COLUMNS},
           d.id AS dispute_id, d.status AS dispute_status, d.type AS dispute_type,
           d.ruling AS dispute_ruling, d.refund_status AS dispute_refund_status,
           lf.id AS lockout_fee_id, lf.fee_amount AS lockout_fee_amount,
           CASE WHEN j.completed_at IS NOT NULL
                THEN strftime('%Y-%m-%dT%H:%M:%SZ', j.completed_at, '+${REPORT_WINDOW_HOURS} hours') END AS report_deadline,
           (j.status = 'completed' AND j.cleaner_id IS NOT NULL AND j.completed_at IS NOT NULL AND d.id IS NULL
             AND (julianday('now') - julianday(j.completed_at)) * 24 <= ${REPORT_WINDOW_HOURS}) AS can_report,
           (j.status = 'cancelled' AND lf.id IS NOT NULL AND d.id IS NULL
             AND (julianday('now') - julianday(lf.created_at)) * 24 <= ${REPORT_WINDOW_HOURS}) AS can_dispute_lockout,
           (SELECT COUNT(*) FROM bids b WHERE b.job_id = j.id AND b.status = 'pending'
              AND julianday(b.expires_at) > julianday('now')) AS quote_count,
           -- 'hold': the card for an upcoming clean was declined or needs the bank's approval.
           -- 'charge': a finished clean couldn't be charged.
           CASE WHEN j.status IN ('accepted','in_progress') AND j.auth_status IN ('failed','action_required') THEN 'hold'
                WHEN j.status = 'completed' AND j.capture_status = 'failed' THEN 'charge' END AS payment_needed
    FROM jobs j
    LEFT JOIN users u ON u.id = j.cleaner_id
    LEFT JOIN cleaner_profiles cp ON cp.user_id = j.cleaner_id
    LEFT JOIN disputes d ON d.id = (SELECT id FROM disputes WHERE job_id = j.id ORDER BY created_at DESC LIMIT 1)
    LEFT JOIN lockout_fees lf ON lf.id = (
      SELECT id FROM lockout_fees WHERE job_id = j.id AND status = 'charged' ORDER BY created_at DESC LIMIT 1)
    WHERE j.client_id = ?
    ORDER BY j.scheduled_at DESC
    LIMIT 50
  `).all(req.user.id);

  res.json({
    jobs: jobs.map(j => ({ ...withoutCleanerLocation(j), can_report: !!j.can_report, can_dispute_lockout: !!j.can_dispute_lockout })),
  });
});

// ─────────────────────────────────────────────────
// POST /api/jobs  (client only)
// Post a new job
// ─────────────────────────────────────────────────
router.post('/', requireAuth, requireRole('client'), [
  body('service_type').notEmpty(),
  body('address').notEmpty(),
  body('scheduled_at').isISO8601(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const {
    service_type, bedrooms, bathrooms, address, city, zip,
    scheduled_at, duration_hrs, supplies_by, pets, notes,
    is_recurring, recurring_freq, is_priority, has_guarantee,
  } = req.body;

  try {
    // Calculate fees
    const hourlyRate  = 34; // In production: fetch from matched cleaner's profile
    const estimatedHrs = duration_hrs || 2.5;
    const baseAmount  = hourlyRate * estimatedHrs;
    // Fee depends on client account type (business pays 10%, regular pays 8%)
    const clientProfile = db.prepare("SELECT is_business FROM client_profiles WHERE user_id = ?").get(req.user.id);
    const feePercent = clientProfile?.is_business ?
      parseFloat(process.env.BUSINESS_FEE_PERCENT || 10) :
      parseFloat(process.env.PLATFORM_FEE_PERCENT || 8);
    const platformFee = baseAmount * (feePercent / 100);
    const guaranteeFee = has_guarantee ? 12.00 : 0;
    const priorityFee  = is_priority   ?  7.00 : 0;
    const totalCharged = baseAmount + platformFee + guaranteeFee + priorityFee;

    // Nothing is charged when a job is posted. The client adds a card when they book
    // one of the quotes (routes/bids.js), and the amounts above are replaced then.
    const id = uuid();
    db.prepare(`
      INSERT INTO jobs
        (id, client_id, service_type, bedrooms, bathrooms, address, city, zip,
         scheduled_at, duration_hrs, supplies_by, pets, notes,
         is_recurring, recurring_freq, is_priority, has_guarantee,
         base_amount, platform_fee, guarantee_fee, priority_fee, total_charged)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, req.user.id, service_type, bedrooms||null, bathrooms||null,
      address, city||null, zip||null, scheduled_at, duration_hrs||null,
      supplies_by||'client', pets||null, notes||null,
      is_recurring?1:0, recurring_freq||null, is_priority?1:0, has_guarantee?1:0,
      baseAmount, platformFee, guaranteeFee, priorityFee, totalCharged
    );

    // Look up the address's map coordinates in the background, for arrival checks.
    ensureJobCoordinates(id).catch(() => {});

    // TODO: Push notification to nearby cleaners (via FCM/APNs)

    res.status(201).json({
      message:       'Job posted successfully',
      job_id:        id,
      estimated_total: totalCharged,
    });

  } catch (err) {
    console.error('Post job error:', err);
    res.status(500).json({ error: 'Failed to post job' });
  }
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/accept  (cleaner only) — retired
// A cleaner used to be able to take an open job outright, which booked it with no
// card and no say from the client. Cleaners send a quote instead; the client books
// the one they want and adds a card (POST /api/bids/:bid_id/choose).
// ─────────────────────────────────────────────────
router.post('/:id/accept', requireAuth, requireRole('cleaner'), (req, res) => {
  res.status(410).json({ error: 'Send the client a quote instead — they book the cleaner they choose.', code: 'QUOTE_REQUIRED' });
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/decline  (cleaner only)
// ─────────────────────────────────────────────────
router.post('/:id/decline', requireAuth, requireRole('cleaner'), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND status = ?').get(req.params.id, 'open');
  if (!job) return res.status(404).json({ error: 'Job not found or not open' });
  // Just skip — job stays open for other cleaners. Log the decline.
  res.json({ message: 'Job declined' });
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/en-route  (cleaner only)
// "On my way": tells the client, and starts live location sharing when the
// cleaner's device sends a location. Body: { location: { lat, lng, accuracy } } (optional)
// ─────────────────────────────────────────────────
router.post('/:id/en-route', requireAuth, requireRole('cleaner'), async (req, res) => {
  const coords = bodyLocation(req, res);
  if (coords === undefined) return;
  const owned = db.prepare('SELECT id FROM jobs WHERE id = ? AND cleaner_id = ?').get(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Job not found' });
  await ensureJobCoordinates(owned.id);

  const outcome = transaction(() => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND cleaner_id = ?').get(owned.id, req.user.id);
    if (job.status !== 'accepted') {
      return { status: 409, error: job.status === 'in_progress' ? "You've already arrived at this job." : `This job is ${job.status}.` };
    }
    const first = db.prepare(`
      UPDATE jobs SET en_route_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND en_route_at IS NULL
    `).run(job.id).changes === 1;
    recordLocation(job, req.user.id, 'en_route', coords);
    if (first) {
      notify(job.client_id, '🚗 Your cleaner is on the way',
        coords ? 'Follow their location from My bookings until they arrive.' : "They'll let you know when they arrive.",
        'cleaner_en_route');
    }
    return { jobId: job.id };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });

  res.json({
    message: 'The client knows you are on the way',
    location_shared: !!coords,
    tracking: trackingSummary(outcome.jobId, 'cleaner'),
  });
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/location  (cleaner only)
// A live position: on the way (shown to the client) or on site (kept as
// evidence). Body: { lat, lng, accuracy }
// ─────────────────────────────────────────────────
router.post('/:id/location', requireAuth, requireRole('cleaner'), locationPingLimiter, (req, res) => {
  const coords = bodyLocation(req, res);
  if (coords === undefined) return;
  if (!coords) return res.status(422).json({ error: 'lat and lng are required' });

  const result = transaction(() => {
    const job = db.prepare(`
      SELECT *, (julianday('now') - julianday(last_location_at)) * 86400 AS seconds_since_last
      FROM jobs WHERE id = ? AND cleaner_id = ?
    `).get(req.params.id, req.user.id);
    if (!job) return { status: 404, error: 'Job not found' };
    const phase = job.status === 'accepted' && job.en_route_at ? 'en_route'
      : job.status === 'in_progress' ? 'on_site' : null;
    if (!phase) return { status: 409, code: 'TRACKING_ENDED', error: 'Location sharing has ended for this job.' };
    if (job.seconds_since_last != null && job.seconds_since_last < MIN_PING_GAP_SECONDS) return { skipped: true };

    const distance = recordLocation(job, req.user.id, phase, coords);
    if (phase === 'en_route' && distance != null && distance <= ARRIVAL_RADIUS_M) {
      const firstTime = db.prepare(`
        UPDATE jobs SET nearby_notified_at = datetime('now') WHERE id = ? AND nearby_notified_at IS NULL
      `).run(job.id).changes === 1;
      if (firstTime) notify(job.client_id, '📍 Your cleaner is almost there', 'Your cleaner is just around the corner.', 'cleaner_nearby');
    }
    return { phase, distance };
  });
  if (result.error) return res.status(result.status).json({ error: result.error, code: result.code });
  res.json(result.skipped ? { skipped: true } : { recorded: true, phase: result.phase, distance_m: result.distance });
});

// ─────────────────────────────────────────────────
// GET /api/jobs/:id/tracking — the job's cleaner, its client, or an admin
// What each may see is decided in lib/tracking.js.
// ─────────────────────────────────────────────────
router.get('/:id/tracking', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  const access = jobAccess(job, req.user);
  if (!access) return res.status(404).json({ error: 'Job not found' });
  res.json({ tracking: trackingSummary(job, access) });
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/arrive  (cleaner only)
// Cleaner marks themselves as arrived on-site. The optional location is kept,
// with its distance from the address, as evidence if the visit is disputed.
// Body: { location: { lat, lng, accuracy } }
// ─────────────────────────────────────────────────
router.post('/:id/arrive', requireAuth, requireRole('cleaner'), async (req, res) => {
  const coords = bodyLocation(req, res);
  if (coords === undefined) return;
  const owned = db.prepare('SELECT id FROM jobs WHERE id = ? AND cleaner_id = ? AND status = ?')
    .get(req.params.id, req.user.id, 'accepted');
  if (!owned) return res.status(404).json({ error: 'Job not found' });
  if (coords) await ensureJobCoordinates(owned.id);

  const outcome = transaction(() => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND cleaner_id = ? AND status = ?')
      .get(owned.id, req.user.id, 'accepted');
    if (!job) return null;
    const distance = recordLocation(job, req.user.id, 'arrived', coords);
    db.prepare(`
      UPDATE jobs SET status = 'in_progress', arrived_at = datetime('now'), updated_at = datetime('now'),
             arrival_lat = ?, arrival_lng = ?, arrival_accuracy_m = ?, arrival_distance_m = ?
      WHERE id = ?
    `).run(coords?.lat ?? null, coords?.lng ?? null, coords?.accuracy ?? null, distance, job.id);
    notify(job.client_id,
      '🧹 Your cleaner has arrived!',
      'Your cleaner is now at your home and has started the job.',
      'cleaner_arrived');
    return { distance };
  });
  if (!outcome) return res.status(404).json({ error: 'Job not found' });

  res.json({
    message: 'Arrival confirmed, job in progress',
    location_shared: !!coords,
    arrival_distance_m: outcome.distance,
    far_from_address: isFar(outcome.distance, coords?.accuracy),
  });
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/complete  (cleaner only)
// Requires ≥1 before and ≥1 after photo. Captures the client's payment and makes
// the cleaner's earnings available to cash out straight away.
// Safe to retry: a repeat call on a completed job finishes whatever didn't happen.
// ─────────────────────────────────────────────────
router.post('/:id/complete', requireAuth, requireRole('cleaner'), async (req, res) => {
  const coords = bodyLocation(req, res);
  if (coords === undefined) return;
  // The photo check and the status change happen in one synchronous step, so a
  // photo can't be deleted in between.
  const step = transaction(() => {
    const j = db.prepare('SELECT * FROM jobs WHERE id = ? AND cleaner_id = ?').get(req.params.id, req.user.id);
    if (!j) return { status: 404, error: 'Job not found' };
    if (j.status === 'completed') return { job: j, alreadyCompleted: true };
    if (j.status !== 'in_progress') {
      return { status: 409, error: j.status === 'accepted' ? 'Tap "I\'ve arrived" before completing the job.' : `This job is ${j.status}.` };
    }

    const counts = stageCounts(j.id, req.user.id);
    const hasPhotos = counts.before >= 1 && counts.after >= 1;
    if (j.photos_required && !hasPhotos) {
      return {
        status: 422, code: 'PHOTOS_REQUIRED', counts,
        error: 'Add at least one before photo and one after photo to complete this job and get paid.',
      };
    }
    db.prepare(`
      UPDATE jobs SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now'),
             photos_verified_at = CASE WHEN ? THEN datetime('now') ELSE photos_verified_at END
      WHERE id = ? AND status = 'in_progress'
    `).run(hasPhotos ? 1 : 0, j.id);
    if (coords) {
      const distance = recordLocation(j, req.user.id, 'completed', coords);
      db.prepare('UPDATE jobs SET completion_lat = ?, completion_lng = ?, completion_accuracy_m = ?, completion_distance_m = ? WHERE id = ?')
        .run(coords.lat, coords.lng, coords.accuracy, distance, j.id);
    }
    return { job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(j.id), alreadyCompleted: false };
  });
  if (step.error) {
    return res.status(step.status).json({ error: step.error, ...(step.code && { code: step.code, counts: step.counts }) });
  }

  try {
    let job = step.job;
    // Collect the client's payment (lib/payments.js). A charge that already failed
    // isn't retried from here — tapping Complete again mustn't keep retrying a
    // declined card; the client pays from My bookings.
    if (!job.capture_status || job.capture_status === 'processing') await payments.chargeCompletedJob(job.id);
    job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);

    const payout = ensureJobPayout(job);
    const onHold = ['failed', 'processing'].includes(job.capture_status);
    const earns = payout ? payout.amount : 0;

    if (!step.alreadyCompleted) {
      notify(job.client_id,
        '⭐ How was your clean?',
        'Your cleaning is complete! See the before and after photos in your bookings and leave a review. ' +
        `If something isn't right, you can report a problem within ${REPORT_WINDOW_HOURS} hours.`,
        'review_prompt');
      notify(req.user.id,
        onHold ? '✅ Job complete — payment under review' : '💰 Job complete — ready to cash out',
        onHold
          ? `Your $${earns.toFixed(2)} for this job is on hold until the client's payment goes through. They've been asked to pay.`
          : `$${earns.toFixed(2)} is available to cash out now.`,
        onHold ? 'payout_held' : 'payout_available');
    }

    res.json({
      message:        step.alreadyCompleted ? 'Job already completed' : 'Job completed',
      cleaner_earns:  earns,
      cashable:       !onHold,
      capture_status: job.capture_status,
    });
  } catch (err) {
    // The job IS completed at this point; a retry of this endpoint finishes the rest.
    console.error('Complete job error:', err);
    res.status(500).json({ error: 'The job was marked complete, but something went wrong setting up your earnings. Tap Complete again to retry.' });
  }
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/cancel  (client or cleaner)
// ─────────────────────────────────────────────────
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const job = db.prepare(
    'SELECT * FROM jobs WHERE id = ? AND status IN (?,?)'
  ).get(req.params.id, 'open', 'accepted');

  if (!job) return res.status(404).json({ error: 'Job cannot be cancelled' });

  // Only client or assigned cleaner can cancel
  const isClient  = req.user.role === 'client'  && job.client_id  === req.user.id;
  const isCleaner = req.user.role === 'cleaner' && job.cleaner_id === req.user.id;
  const isAdmin   = req.user.role === 'admin';
  if (!isClient && !isCleaner && !isAdmin) {
    return res.status(403).json({ error: 'Not authorized to cancel this job' });
  }

  const cancelled = transaction(() => {
    const result = db.prepare(`
      UPDATE jobs SET status = 'cancelled', auth_status = CASE WHEN auth_status IS NOT NULL THEN 'canceled' END,
             updated_at = datetime('now')
      WHERE id = ? AND status IN ('open','accepted')
    `).run(job.id);
    if (result.changes !== 1) return false;
    db.prepare("UPDATE bids SET status = 'declined' WHERE job_id = ? AND status = 'pending'").run(job.id);
    // Older bookings created earnings up front; nothing is owed for a job that won't happen.
    reverseJobEarnings(job.id, ['job'], null, 'job was cancelled');
    if (job.cleaner_id && !isCleaner) {
      notify(job.cleaner_id, 'Booking cancelled', `Your ${job.service_type} on ${job.scheduled_at} was cancelled.`, 'job_cancelled');
    }
    if (isCleaner || isAdmin) {
      notify(job.client_id, 'Booking cancelled', `Your ${job.service_type} on ${job.scheduled_at} was cancelled.`, 'job_cancelled');
    }
    return true;
  });
  if (!cancelled) return res.status(409).json({ error: 'Job cannot be cancelled' });

  // Nothing is charged before a clean happens, so cancelling just releases the hold.
  if (job.stripe_payment_intent_id) await payments.releaseIntent(job.stripe_payment_intent_id);

  res.json({ message: 'Job cancelled' });
});

// ─────────────────────────────────────────────────
// POST /api/jobs/:id/lockout-fee  (cleaner only)
// Charge a lockout fee after confirming all 5 checklist items and taking at least
// one photo at the door (stage 'lockout') as proof.
// Body: { checklist: [true, true, true, true, true] }
// ─────────────────────────────────────────────────
router.post('/:id/lockout-fee', requireAuth, requireRole('cleaner'), async (req, res) => {
  const { checklist } = req.body;

  // All 5 items must be confirmed true
  if (!Array.isArray(checklist) || checklist.length !== 5 || !checklist.every(Boolean)) {
    return res.status(422).json({
      error: 'All 5 lockout checklist items must be confirmed before charging the fee'
    });
  }

  const coords = bodyLocation(req, res);
  if (coords === undefined) return;
  if (coords && db.prepare('SELECT 1 FROM jobs WHERE id = ? AND cleaner_id = ?').get(req.params.id, req.user.id)) {
    await ensureJobCoordinates(req.params.id);
  }

  // Verify lockout fee is enabled for this cleaner
  const profile = db.prepare(
    'SELECT lockout_fee_enabled, lockout_fee_amount FROM cleaner_profiles WHERE user_id = ?'
  ).get(req.user.id);

  if (!profile?.lockout_fee_enabled) {
    return res.status(422).json({ error: 'You do not have lockout fee enabled on your profile' });
  }
  const feeAmount = profile.lockout_fee_amount;

  // Reserve the fee before charging, in one synchronous step, so a double tap
  // can't charge the client twice. A lockout means the cleaner never got in, so
  // it only applies to a job that hasn't started.
  const lockoutId = uuid();
  const reserved = transaction(() => {
    const j = db.prepare(
      'SELECT * FROM jobs WHERE id = ? AND cleaner_id = ? AND status = ?'
    ).get(req.params.id, req.user.id, 'accepted');
    if (!j) return { status: 404, error: 'Job not found, not assigned to you, or already started' };
    if (db.prepare('SELECT id FROM lockout_fees WHERE job_id = ? AND status != ?').get(j.id, 'refunded')) {
      return { status: 409, error: 'Lockout fee already charged for this job' };
    }
    if (stageCounts(j.id, req.user.id).lockout < 1) {
      return { status: 422, code: 'PHOTOS_REQUIRED', error: 'Take at least one photo at the door before charging a lockout fee.' };
    }
    db.prepare(`
      INSERT INTO lockout_fees
        (id, job_id, cleaner_id, client_id, fee_amount, status, arrived_at, checklist_json)
      VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), ?)
    `).run(lockoutId, j.id, req.user.id, j.client_id, feeAmount, JSON.stringify(checklist));
    if (coords) {
      // Where the cleaner was when they said they couldn't get in.
      const distance = recordLocation(j, req.user.id, 'lockout', coords);
      db.prepare('UPDATE lockout_fees SET lat = ?, lng = ?, accuracy_m = ?, distance_m = ? WHERE id = ?')
        .run(coords.lat, coords.lng, coords.accuracy, distance, lockoutId);
    }
    return { job: j };
  });
  if (reserved.error) {
    return res.status(reserved.status).json({ error: reserved.error, ...(reserved.code && { code: reserved.code }) });
  }
  const job = reserved.job;

  let chargeId = null;
  const feeText = `$${Number(feeAmount).toFixed(2)}`;
  try {
    ({ chargeId } = await payments.chargeLockoutFee(job.id, lockoutId, feeAmount));
  } catch (err) {
    if (err instanceof payments.PaymentError) {
      db.prepare("DELETE FROM lockout_fees WHERE id = ? AND status = 'pending'").run(lockoutId);
      notifyAdmins('Lockout fee could not be charged',
        `A cleaner was locked out of a ${job.service_type} job (${job.id}), but the client's card couldn't be charged the ${feeText} lockout fee. Follow up with the client.`);
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    // No answer from Stripe: keep the reservation, so a retry can't charge twice.
    console.error('Lockout fee error:', err);
    notifyAdmins('Lockout fee needs checking',
      `Charging the ${feeText} lockout fee on job ${job.id} got no answer from Stripe. Check Stripe for the charge before retrying.`);
    return res.status(502).json({ error: "We couldn't confirm the lockout fee charge. Sparkle will check it and let you know." });
  }

  transaction(() => {
    db.prepare("UPDATE lockout_fees SET status = 'charged', stripe_charge_id = ? WHERE id = ?").run(chargeId, lockoutId);

    // Create payout for the cleaner — available to cash out unless the client disputes it
    db.prepare(`
      INSERT INTO payouts (id, cleaner_id, job_id, lockout_fee_id, amount, type, status)
      VALUES (?, ?, ?, ?, ?, 'lockout', 'pending')
    `).run(uuid(), req.user.id, job.id, lockoutId, feeAmount);

    // Mark job as cancelled (client was a no-show)
    db.prepare(`UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`)
      .run(job.id);
    db.prepare("UPDATE bids SET status = 'declined' WHERE job_id = ? AND status = 'pending'").run(job.id);
    reverseJobEarnings(job.id, ['job'], null, 'job was cancelled (lockout)');

    notify(job.client_id,
      '⚠️ Lockout fee charged',
      `A $${feeAmount} lockout fee was charged because your cleaner arrived but could not access your home and the appointment was not cancelled. ` +
      `If this is wrong, you can dispute it from your bookings within ${REPORT_WINDOW_HOURS} hours.`,
      'lockout_fee_charged');
    notifyAdmins('🔒 Lockout fee charged',
      `A $${feeAmount} lockout fee was charged on a ${job.service_type} job. The cleaner's door photo is in Lockout fees.`,
      'lockout_fee_charged');
  });

  res.json({
    message:       'Lockout fee charged successfully',
    lockout_id:    lockoutId,
    fee_amount:    feeAmount,
    stripe_charge: chargeId,
  });
});

module.exports = router;
