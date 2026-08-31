'use strict';
// lib/cache.js — Redis caching with automatic in-memory fallback
// When Redis is available: fast distributed cache across all servers
// When Redis is unavailable: falls back to in-process Map (still fast for single server)

const Redis = require('ioredis');

let client = null;
const memCache = new Map(); // fallback
let usingRedis = false;

// ── Connect to Redis if configured ────────────────────────────────────────
function connect() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[CACHE] No REDIS_URL set — using in-memory cache (single server only)');
    return;
  }
  try {
    client = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    client.on('connect',  () => { usingRedis = true;  console.log('[CACHE] Redis connected'); });
    client.on('error',    (e) => { usingRedis = false; console.warn('[CACHE] Redis error, falling back to memory:', e.message); });
    client.on('close',    () => { usingRedis = false; });
    client.connect().catch(() => {});
  } catch {
    console.warn('[CACHE] Redis init failed — using in-memory cache');
  }
}

// ── Core get/set/del ──────────────────────────────────────────────────────
async function get(key) {
  try {
    if (usingRedis && client) {
      const val = await client.get(key);
      return val ? JSON.parse(val) : null;
    }
    const entry = memCache.get(key);
    if (!entry) return null;
    if (entry.expires && entry.expires < Date.now()) { memCache.delete(key); return null; }
    return entry.value;
  } catch { return null; }
}

async function set(key, value, ttlSeconds = 300) {
  try {
    if (usingRedis && client) {
      await client.setex(key, ttlSeconds, JSON.stringify(value));
    } else {
      memCache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
      // Keep memory cache bounded — evict oldest if over 1000 entries
      if (memCache.size > 1000) {
        const firstKey = memCache.keys().next().value;
        memCache.delete(firstKey);
      }
    }
  } catch {}
}

async function del(key) {
  try {
    if (usingRedis && client) await client.del(key);
    else memCache.delete(key);
  } catch {}
}

async function delPattern(pattern) {
  try {
    if (usingRedis && client) {
      const keys = await client.keys(pattern);
      if (keys.length) await client.del(...keys);
    } else {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      for (const key of memCache.keys()) {
        if (regex.test(key)) memCache.delete(key);
      }
    }
  } catch {}
}

// ── Cache middleware factory ───────────────────────────────────────────────
// Usage: router.get('/endpoint', cacheMiddleware(60), handler)
function cacheMiddleware(ttlSeconds = 60, keyFn = null) {
  return async (req, res, next) => {
    // Don't cache authenticated requests by default (each user sees their own data)
    // Pass keyFn to build a user-specific cache key when needed
    const key = keyFn
      ? keyFn(req)
      : `route:${req.method}:${req.path}:${JSON.stringify(req.query)}`;

    const cached = await get(key);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    // Intercept response to cache it
    const originalJson = res.json.bind(res);
    res.json = async (data) => {
      if (res.statusCode === 200) await set(key, data, ttlSeconds);
      res.setHeader('X-Cache', 'MISS');
      return originalJson(data);
    };
    next();
  };
}

// ── TTL presets ───────────────────────────────────────────────────────────
const TTL = {
  SHORT:  30,    // 30s — near-realtime data (job feeds, bid counts)
  MEDIUM: 300,   // 5min — semi-static data (cleaner profiles, reviews)
  LONG:   3600,  // 1hr  — static-ish data (platform stats)
  DAY:    86400, // 24hr — very stable data (service lists)
};

connect();
module.exports = { get, set, del, delPattern, cacheMiddleware, TTL };
