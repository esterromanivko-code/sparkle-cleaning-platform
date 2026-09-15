'use strict';
// lib/tracking.js — where the cleaner was, and when, for a job.
//
// What is shared with whom:
//   • The client sees the cleaner's live location only from "On my way" until the
//     cleaner arrives. After that they see times ("arrived 10:02, on site 1h 5m").
//   • Arrival, completion and lockout check-ins record the cleaner's position and
//     its distance from the address, as evidence if something is disputed.
//   • Admins see the full trail of location points.
// Precise points are deleted 180 days after the job ends (lib/retention.js).

const db = require('../db');
const { distanceMeters } = require('./geo');

const ARRIVAL_RADIUS_M      = 150;   // "almost there" notice to the client
const FAR_FROM_ADDRESS_M    = 500;   // a check-in farther than this is flagged for review
const LIVE_STALE_SECONDS    = 180;
const MIN_PING_GAP_SECONDS  = 8;

// SQLite stores 'YYYY-MM-DD HH:MM:SS' in UTC without a zone marker.
const iso = s => (s ? (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s) : null);
const ms  = s => (s ? Date.parse(iso(s)) : null);

// Stores one location point for a job and updates the job's latest position.
// Synchronous so callers can use it inside their transactions. Returns the
// distance from the job's address in meters, or null when unknown.
function recordLocation(job, cleanerId, phase, coords) {
  if (!coords) return null;
  const distance = job.lat != null && job.lng != null
    ? distanceMeters(coords.lat, coords.lng, job.lat, job.lng)
    : null;
  db.prepare(`
    INSERT INTO job_locations (job_id, cleaner_id, phase, lat, lng, accuracy_m, distance_m)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(job.id, cleanerId, phase, coords.lat, coords.lng, coords.accuracy, distance);
  db.prepare(`
    UPDATE jobs SET last_lat = ?, last_lng = ?, last_accuracy_m = ?, last_distance_m = ?, last_location_at = datetime('now')
    WHERE id = ?
  `).run(coords.lat, coords.lng, coords.accuracy, distance, job.id);
  return distance;
}

// A check-in counts as far only when even the most generous reading of GPS
// accuracy leaves it more than FAR_FROM_ADDRESS_M away.
function isFar(distance, accuracy) {
  return distance != null && distance - (accuracy || 0) > FAR_FROM_ADDRESS_M;
}

function checkIn(lat, lng, accuracy, distance, access) {
  return {
    location_shared: lat != null,
    distance_m: distance ?? null,
    accuracy_m: accuracy ?? null,
    far_from_address: isFar(distance, accuracy),
    ...(access === 'admin' && lat != null ? { lat, lng } : {}),
  };
}

// Driving time from straight-line distance: roads run ~35% longer than the crow
// flies, at a city average of ~35 km/h. Shown to clients as an estimate.
function etaMinutes(distance) {
  return distance == null ? null : Math.max(1, Math.round(((distance / 1000) * 1.35) / 35 * 60));
}

// What `access` ('cleaner' | 'client' | 'admin' | 'party') may see about a job's location.
function trackingSummary(jobOrId, access) {
  const job = typeof jobOrId === 'string' ? db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobOrId) : jobOrId;
  if (!job) return null;

  const enRoute = job.status === 'accepted' && !!job.en_route_at && !job.arrived_at;
  const secondsAgo = job.last_location_at ? Math.max(0, Math.round((Date.now() - ms(job.last_location_at)) / 1000)) : null;
  const end = job.completed_at ? ms(job.completed_at) : job.status === 'in_progress' ? Date.now() : null;
  const minutesOnSite = job.arrived_at && end ? Math.max(0, Math.round((end - ms(job.arrived_at)) / 60000)) : null;
  const checks = db.prepare(`
    SELECT COUNT(*) AS n, MAX(distance_m) AS max_distance FROM job_locations WHERE job_id = ? AND phase = 'on_site'
  `).get(job.id);

  const summary = {
    job_id:          job.id,
    status:          job.status,
    en_route_at:     iso(job.en_route_at),
    arrived_at:      iso(job.arrived_at),
    completed_at:    iso(job.completed_at),
    minutes_on_site: minutesOnSite,
    address_located: job.lat != null && job.lng != null,
    destination:     job.lat != null && job.lng != null ? { lat: job.lat, lng: job.lng } : null,
    live: enRoute && job.last_lat != null ? {
      lat: job.last_lat,
      lng: job.last_lng,
      accuracy_m: job.last_accuracy_m,
      distance_m: job.last_distance_m,
      eta_minutes: etaMinutes(job.last_distance_m),
      updated_at: iso(job.last_location_at),
      seconds_ago: secondsAgo,
      stale: secondsAgo != null && secondsAgo > LIVE_STALE_SECONDS,
    } : null,
    sharing_location: enRoute && job.last_lat != null,
    arrival:    job.arrived_at ? checkIn(job.arrival_lat, job.arrival_lng, job.arrival_accuracy_m, job.arrival_distance_m, access) : null,
    completion: job.completed_at && job.arrived_at
      ? checkIn(job.completion_lat, job.completion_lng, job.completion_accuracy_m, job.completion_distance_m, access)
      : null,
    on_site_checks: { count: checks.n, max_distance_m: checks.max_distance },
  };

  if (access === 'admin') {
    summary.trail = db.prepare(`
      SELECT phase, lat, lng, accuracy_m, distance_m, recorded_at FROM job_locations
      WHERE job_id = ? ORDER BY id ASC LIMIT 1000
    `).all(job.id).map(r => ({ ...r, recorded_at: iso(r.recorded_at) }));
  }
  return summary;
}

module.exports = {
  recordLocation, trackingSummary, isFar, etaMinutes,
  ARRIVAL_RADIUS_M, FAR_FROM_ADDRESS_M, MIN_PING_GAP_SECONDS,
};
