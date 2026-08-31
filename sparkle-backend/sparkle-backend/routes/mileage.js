'use strict';
// routes/mileage.js — Mileage tracking for Pro cleaners
// Allows tracking of driving distance to/from jobs for tax purposes

const express = require('express');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── Haversine formula: calculate distance between two lat/lng points ────────
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 3959; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return (R * c).toFixed(2);
}

// ─────────────────────────────────────────────────
// POST /api/mileage/start — Start tracking a trip
// ─────────────────────────────────────────────────
router.post('/start', requireAuth, requireRole('cleaner'), [
  body('job_id').notEmpty(),
  body('latitude').isFloat({ min: -90, max: 90 }),
  body('longitude').isFloat({ min: -180, max: 180 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  try {
    // Check if cleaner has Pro membership
    const profile = db.prepare('SELECT is_pro FROM cleaner_profiles WHERE user_id = ?').get(req.user.id);
    if (!profile || !profile.is_pro) {
      return res.status(403).json({ error: 'Mileage tracking requires Pro membership' });
    }

    const { job_id, latitude, longitude } = req.body;

    // Verify job exists and belongs to a client (not this cleaner)
    const job = db.prepare('SELECT client_id FROM jobs WHERE id = ?').get(job_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const tripId = uuid();
    const startTime = new Date().toISOString();

    db.prepare(`
      INSERT INTO mileage_logs (id, cleaner_id, job_id, start_lat, start_lng, start_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tripId, req.user.id, job_id, latitude, longitude, startTime);

    res.status(201).json({
      trip_id: tripId,
      started_at: startTime,
      message: 'Mileage tracking started',
    });
  } catch (err) {
    console.error('Mileage start error:', err);
    res.status(500).json({ error: 'Failed to start mileage tracking' });
  }
});

// ─────────────────────────────────────────────────
// POST /api/mileage/end — End trip and calculate distance
// ─────────────────────────────────────────────────
router.post('/end', requireAuth, requireRole('cleaner'), [
  body('trip_id').notEmpty(),
  body('latitude').isFloat({ min: -90, max: 90 }),
  body('longitude').isFloat({ min: -180, max: 180 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  try {
    const { trip_id, latitude, longitude } = req.body;
    const endTime = new Date().toISOString();

    // Get the trip
    const trip = db.prepare('SELECT * FROM mileage_logs WHERE id = ? AND cleaner_id = ?').get(trip_id, req.user.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.end_lat !== null) return res.status(409).json({ error: 'Trip already ended' });

    // Calculate distance using Haversine
    const distanceMiles = parseFloat(haversineDistance(trip.start_lat, trip.start_lng, latitude, longitude));

    // Calculate duration in minutes
    const startMs = new Date(trip.start_time).getTime();
    const endMs = new Date(endTime).getTime();
    const durationMinutes = Math.round((endMs - startMs) / 60000);

    // Update trip with end data
    db.prepare(`
      UPDATE mileage_logs SET end_lat = ?, end_lng = ?, end_time = ?, distance_miles = ?, duration_minutes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(latitude, longitude, endTime, distanceMiles, durationMinutes, trip_id);

    res.json({
      trip_id,
      distance_miles: distanceMiles,
      duration_minutes: durationMinutes,
      started_at: trip.start_time,
      ended_at: endTime,
      message: `Trip logged: ${distanceMiles} miles`,
    });
  } catch (err) {
    console.error('Mileage end error:', err);
    res.status(500).json({ error: 'Failed to end mileage trip' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/mileage/history — Get trip history
// ─────────────────────────────────────────────────
router.get('/history', requireAuth, requireRole('cleaner'), (req, res) => {
  try {
    // Check Pro membership
    const profile = db.prepare('SELECT is_pro FROM cleaner_profiles WHERE user_id = ?').get(req.user.id);
    if (!profile || !profile.is_pro) {
      return res.status(403).json({ error: 'Mileage tracking requires Pro membership' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;

    // Get completed trips (distance_miles is not NULL)
    const trips = db.prepare(`
      SELECT ml.id, ml.job_id, ml.distance_miles, ml.duration_minutes, ml.start_time, ml.created_at,
             j.address as job_address
      FROM mileage_logs ml
      LEFT JOIN jobs j ON j.id = ml.job_id
      WHERE ml.cleaner_id = ? AND ml.distance_miles IS NOT NULL
      ORDER BY ml.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.user.id, limit, offset);

    // Get stats for the month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthStats = db.prepare(`
      SELECT
        COUNT(*) as total_trips,
        COALESCE(SUM(distance_miles), 0) as total_miles,
        ROUND(AVG(distance_miles), 2) as avg_distance,
        ROUND(AVG(duration_minutes), 1) as avg_duration
      FROM mileage_logs
      WHERE cleaner_id = ? AND distance_miles IS NOT NULL AND created_at >= ?
    `).get(req.user.id, monthStart);

    const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM mileage_logs WHERE cleaner_id = ? AND distance_miles IS NOT NULL').get(req.user.id);

    res.json({
      trips,
      month_stats: monthStats,
      total_trips_all_time: totalCount.cnt,
      limit,
      offset,
    });
  } catch (err) {
    console.error('Mileage history error:', err);
    res.status(500).json({ error: 'Failed to load mileage history' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/mileage/stats — Get mileage statistics
// ─────────────────────────────────────────────────
router.get('/stats', requireAuth, requireRole('cleaner'), (req, res) => {
  try {
    // Check Pro membership
    const profile = db.prepare('SELECT is_pro FROM cleaner_profiles WHERE user_id = ?').get(req.user.id);
    if (!profile || !profile.is_pro) {
      return res.status(403).json({ error: 'Mileage tracking requires Pro membership' });
    }

    const period = req.query.period || 'month'; // month | week | all
    let dateFilter = '';

    if (period === 'week') {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      dateFilter = `AND ml.created_at >= '${weekStart.toISOString()}'`;
    } else if (period === 'month') {
      const monthStart = new Date();
      monthStart.setDate(1);
      dateFilter = `AND ml.created_at >= '${monthStart.toISOString()}'`;
    }

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_trips,
        COALESCE(SUM(distance_miles), 0) as total_miles,
        ROUND(AVG(distance_miles), 2) as avg_distance_per_trip,
        ROUND(AVG(duration_minutes), 1) as avg_duration_minutes,
        MAX(distance_miles) as max_distance,
        MIN(distance_miles) as min_distance
      FROM mileage_logs
      WHERE cleaner_id = ? AND distance_miles IS NOT NULL ${dateFilter}
    `).get(req.user.id);

    // 2026 IRS standard mileage rate: $0.67/mile
    const irsRate = 0.67;
    const estimatedDeduction = parseFloat((stats.total_miles * irsRate).toFixed(2));

    res.json({
      period,
      total_miles: parseFloat(stats.total_miles),
      total_trips: stats.total_trips,
      avg_distance_per_trip: stats.avg_distance_per_trip || 0,
      avg_duration_minutes: stats.avg_duration_minutes || 0,
      max_distance: stats.max_distance || 0,
      min_distance: stats.min_distance || 0,
      estimated_tax_deduction: estimatedDeduction,
      irs_rate_per_mile: irsRate,
    });
  } catch (err) {
    console.error('Mileage stats error:', err);
    res.status(500).json({ error: 'Failed to load mileage statistics' });
  }
});

module.exports = router;
