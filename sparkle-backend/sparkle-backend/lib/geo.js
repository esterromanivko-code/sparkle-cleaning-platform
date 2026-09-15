'use strict';
// lib/geo.js — distances, validating a location sent by the app, and turning a
// job's street address into map coordinates.

const EARTH_RADIUS_M = 6371000;
const GEOCODE_TIMEOUT_MS = 6000;

const round6 = n => Math.round(n * 1e6) / 1e6;

// Great-circle distance in whole meters, or null if any value is missing.
function distanceMeters(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)));
}

class CoordinateError extends Error {}

// Reads { lat, lng, accuracy } from a request body — at the top level or under
// `location`. Returns null when no location was sent (sharing is optional apart
// from live pings) and throws CoordinateError on nonsense, so a bad value is
// refused instead of stored.
function readCoords(body) {
  const src = body && typeof body === 'object' ? (body.location ?? body) : null;
  if (!src || src.lat == null || src.lng == null) return null;
  const lat = Number(src.lat);
  const lng = Number(src.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new CoordinateError('Invalid location');
  }
  let accuracy = src.accuracy == null ? null : Number(src.accuracy);
  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0)) accuracy = null;
  return { lat: round6(lat), lng: round6(lng), accuracy: accuracy === null ? null : Math.min(Math.round(accuracy), 100000) };
}

function geocodeProvider() {
  return String(process.env.GEOCODE_PROVIDER || 'census').toLowerCase();
}

// Street address → { lat, lng }, or null. Never throws.
//   census (default) — US Census Bureau geocoder: free, no key, US addresses only.
//   google           — needs GOOGLE_GEOCODING_API_KEY, a server key. The browser
//                      Maps key is restricted to web pages and won't work here.
//   none             — disabled (tests, or to turn lookups off).
async function geocodeAddress(address) {
  const provider = geocodeProvider();
  const q = String(address || '').trim();
  if (!q || provider === 'none') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    if (provider === 'google') {
      const key = process.env.GOOGLE_GEOCODING_API_KEY;
      if (!key) return null;
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
      const data = await (await fetch(url, { signal: controller.signal })).json();
      const loc = data?.results?.[0]?.geometry?.location;
      return loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) ? { lat: round6(loc.lat), lng: round6(loc.lng) } : null;
    }
    const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
      + `?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const c = (await res.json())?.result?.addressMatches?.[0]?.coordinates;
    return c && Number.isFinite(c.y) && Number.isFinite(c.x) ? { lat: round6(c.y), lng: round6(c.x) } : null;
  } catch (err) {
    console.warn('[GEOCODE] Lookup failed:', err.name === 'AbortError' ? 'timed out' : err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Makes sure a job has coordinates for its address, looking them up once.
// A failed lookup isn't retried, so a bad address can't cause a lookup per ping.
async function ensureJobCoordinates(jobId) {
  const db = require('../db');
  const job = db.prepare('SELECT id, address, city, zip, lat, lng, geocode_status FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  if (job.lat != null && job.lng != null) return { lat: job.lat, lng: job.lng };
  if (job.geocode_status || geocodeProvider() === 'none') return null;

  const coords = await geocodeAddress([job.address, job.city, job.zip].filter(Boolean).join(', '));
  db.prepare('UPDATE jobs SET lat = COALESCE(lat, ?), lng = COALESCE(lng, ?), geocode_status = ? WHERE id = ?')
    .run(coords?.lat ?? null, coords?.lng ?? null, coords ? 'ok' : 'failed', job.id);
  return coords;
}

module.exports = { distanceMeters, readCoords, CoordinateError, geocodeAddress, ensureJobCoordinates };
