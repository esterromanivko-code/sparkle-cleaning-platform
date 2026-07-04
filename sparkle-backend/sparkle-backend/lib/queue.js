'use strict';
// lib/queue.js — Background job queue using BullMQ (Redis) with in-process fallback
// Handles: email sending, payout transfers, recurring job scheduling, notification dispatch
// Falls back to synchronous processing if Redis unavailable

const { logger } = require('./logger');

let Queue, Worker, QueueEvents;
let useQueue = false;

// Try to load BullMQ (requires Redis)
try {
  const bullmq = require('bullmq');
  Queue       = bullmq.Queue;
  Worker      = bullmq.Worker;
  QueueEvents = bullmq.QueueEvents;
  useQueue    = !!process.env.REDIS_URL;
} catch {
  logger.warn('[QUEUE] BullMQ not available — jobs run synchronously');
}

const queues   = {};
const handlers = {};

// ── Register a job handler ────────────────────────────────────────────────
function registerHandler(queueName, handler) {
  handlers[queueName] = handler;

  if (useQueue && Worker) {
    const worker = new Worker(queueName, async (job) => {
      logger.info(`[QUEUE] Processing job: ${queueName} #${job.id}`, { data: job.name });
      return handler(job.data);
    }, {
      connection: { url: process.env.REDIS_URL },
      concurrency: 5,
    });

    worker.on('failed', (job, err) => {
      logger.error(`[QUEUE] Job failed: ${queueName}`, { jobId: job?.id, error: err.message });
    });
    worker.on('completed', (job) => {
      logger.debug(`[QUEUE] Job completed: ${queueName} #${job.id}`);
    });
  }
}

// ── Add a job to a queue ───────────────────────────────────────────────────
async function addJob(queueName, data, opts = {}) {
  if (useQueue && Queue) {
    if (!queues[queueName]) {
      queues[queueName] = new Queue(queueName, {
        connection: { url: process.env.REDIS_URL },
        defaultJobOptions: {
          attempts:    3,
          backoff:     { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail:     50,
        },
      });
    }
    return queues[queueName].add(queueName, data, opts);
  }

  // Fallback: run synchronously (slight delay to not block response)
  const handler = handlers[queueName];
  if (handler) {
    setImmediate(async () => {
      try { await handler(data); }
      catch (e) { logger.error(`[QUEUE] Sync job error: ${queueName}`, { error: e.message }); }
    });
  }
}

// ── Pre-defined job types ─────────────────────────────────────────────────

// Email queue
const EMAIL_QUEUE = 'email';
registerHandler(EMAIL_QUEUE, async ({ to, subject, html }) => {
  const { sendEmail } = require('./email');
  return sendEmail({ to, subject, html });
});

async function queueEmail(to, subject, html) {
  return addJob(EMAIL_QUEUE, { to, subject, html });
}

// Payout queue — process cleaner payouts via Stripe
const PAYOUT_QUEUE = 'payout';
registerHandler(PAYOUT_QUEUE, async ({ cleanerId, amount, stripeConnectId }) => {
  const { getStripe } = require('./stripe');
  const stripe = getStripe();
  const db = require('../db');
  const { v4: uuid } = require('uuid');

  const transfer = await stripe.transfers.create({
    amount:      Math.round(amount * 100),
    currency:    'usd',
    destination: stripeConnectId,
    description: `Sparkle payout for cleaner ${cleanerId}`,
  });

  db.prepare(`
    UPDATE payouts SET status = 'paid', stripe_transfer_id = ?, paid_at = datetime('now')
    WHERE cleaner_id = ? AND status = 'pending'
  `).run(transfer.id, cleanerId);

  logger.info('[QUEUE] Payout completed', { cleanerId, amount, transferId: transfer.id });
});

async function queuePayout(cleanerId, amount, stripeConnectId) {
  return addJob(PAYOUT_QUEUE, { cleanerId, amount, stripeConnectId }, {
    delay: 1000,   // 1s delay before processing
    priority: 1,   // high priority
  });
}

// Notification queue — send push/in-app notifications
const NOTIF_QUEUE = 'notification';
registerHandler(NOTIF_QUEUE, async ({ userId, title, body, type }) => {
  const db = require('../db');
  const { v4: uuid } = require('uuid');
  db.prepare(`
    INSERT INTO notifications (id, user_id, title, body, type) VALUES (?, ?, ?, ?, ?)
  `).run(uuid(), userId, title, body, type);
  // TODO: add FCM/APNs push notification call here
});

async function queueNotification(userId, title, body, type = 'platform') {
  return addJob(NOTIF_QUEUE, { userId, title, body, type });
}

// Recurring job scheduler — generates next job in a series
const RECURRING_QUEUE = 'recurring';
registerHandler(RECURRING_QUEUE, async ({ seriesId }) => {
  const db = require('../db');
  const { v4: uuid } = require('uuid');

  const series = db.prepare('SELECT * FROM recurring_series WHERE id = ? AND status = ?').get(seriesId, 'active');
  if (!series) return;

  // Calculate next job date
  const nextDate = new Date(series.next_job_at);
  const freq     = series.frequency;
  const daysToAdd = freq === 'weekly' ? 7 : freq === 'biweekly' ? 14 : 30;
  nextDate.setDate(nextDate.getDate() + daysToAdd);

  // Create the next job
  const jobId = uuid();
  db.prepare(`
    INSERT INTO jobs (id, client_id, service_type, address, scheduled_at, is_recurring, recurring_freq, parent_job_id)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(jobId, series.client_id, series.service_type, series.address,
         nextDate.toISOString(), series.frequency, seriesId);

  // Update series next_job_at
  db.prepare('UPDATE recurring_series SET next_job_at = ? WHERE id = ?').run(nextDate.toISOString(), seriesId);

  // Notify the preferred cleaner
  db.prepare(`
    INSERT INTO notifications (id, user_id, title, body, type) VALUES (?, ?, ?, ?, ?)
  `).run(uuid(), series.cleaner_id,
    '📅 Recurring job ready',
    `Your next scheduled clean is on ${nextDate.toLocaleDateString()}. Check your schedule.`,
    'recurring_job'
  );

  logger.info('[QUEUE] Recurring job created', { seriesId, jobId, nextDate });
});

async function scheduleRecurringJob(seriesId, delayMs = 0) {
  return addJob(RECURRING_QUEUE, { seriesId }, { delay: delayMs });
}

module.exports = { addJob, queueEmail, queuePayout, queueNotification, scheduleRecurringJob };
