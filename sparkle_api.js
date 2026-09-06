/**
 * sparkle_api.js — API client for Sparkle backend
 * Backend: http://localhost:3001
 *
 * Handles:
 *  - JWT token storage (localStorage)
 *  - Silent token refresh on 401
 *  - Auth: register, login, me, logout
 *  - Jobs: post, available, my-bookings, my-schedule
 *  - Bids: submit, view, choose
 *
 * Exported as window.SparkleAPI
 */
window.SparkleAPI = (function () {
  'use strict';

  // ── UPDATE THIS after you deploy to Railway ──────────────────────────────
  // Copy your Railway URL here, e.g. 'https://sparkle-backend-production.up.railway.app'
  // For local development, it will auto-detect localhost and use http://localhost:3001
  function normalizeBase(url) {
    return String(url || '').replace(/\/+$/, '');
  }

  function resolveBase() {
    if (typeof window === 'undefined') return 'http://localhost:3001';

    const globalBase = window.__SPARKLE_API_BASE__;
    if (typeof globalBase === 'string' && globalBase.trim()) {
      return normalizeBase(globalBase);
    }

    const metaBase = document.querySelector('meta[name="sparkle-api-base"]')?.content?.trim();
    if (metaBase && !metaBase.includes('YOUR-PROJECT')) {
      return normalizeBase(metaBase);
    }

    const storedBase = localStorage.getItem('sparkle_api_base');
    if (storedBase) {
      return normalizeBase(storedBase);
    }

    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:') {
      return 'http://localhost:3001';
    }

    return normalizeBase(window.location.origin);
  }

  const BASE = resolveBase();

  // ─── Token storage ──────────────────────────────────────────────────────────
  function getAccessToken()  { return localStorage.getItem('sparkle_access_token'); }
  function getRefreshToken() { return localStorage.getItem('sparkle_refresh_token'); }
  function getUser() {
    try { return JSON.parse(localStorage.getItem('sparkle_user')); }
    catch { return null; }
  }
  function setTokens(access, refresh, user) {
    localStorage.setItem('sparkle_access_token', access);
    localStorage.setItem('sparkle_refresh_token', refresh);
    if (user) localStorage.setItem('sparkle_user', JSON.stringify(user));
  }
  function clearTokens() {
    localStorage.removeItem('sparkle_access_token');
    localStorage.removeItem('sparkle_refresh_token');
    localStorage.removeItem('sparkle_user');
    localStorage.removeItem('sparkle_role');
  }

  /** True when a real (non-demo) session is active */
  function isRealSession() {
    return !!getAccessToken();
  }

  // ─── Auto-refresh ───────────────────────────────────────────────────────────
  async function tryRefresh() {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${BASE}/api/auth/refresh`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) { clearTokens(); return false; }
      const data = await res.json();
      const user = getUser(); // keep existing user object
      setTokens(data.access_token, data.refresh_token, user);
      return true;
    } catch {
      clearTokens();
      return false;
    }
  }

  // ─── Core fetch with auto-refresh + MOBILE OPTIMIZATIONS ───────────────────
  /**
   * @param {string} path  - API path, e.g. '/api/jobs'
   * @param {RequestInit} options
   * @param {boolean} _retry - internal: true when retrying after refresh
   *
   * Mobile: 15-second timeout, proper error messages
   */
  async function apiFetch(path, options = {}, _retry = false) {
    const token  = getAccessToken();
    const isForm = options.body instanceof FormData;
    const headers = {
      // Never set Content-Type for FormData — the browser has to generate the
      // multipart boundary itself. Setting it manually leaves multer with a body
      // it can't parse, and req.file comes back undefined.
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res;
    try {
      // Mobile timeout: 15 seconds (longer than desktop due to slower networks).
      // File uploads and document downloads need far more — a 10MB scan on a phone
      // connection blows straight through 15s.
      const controller = new AbortController();
      const timeoutMs  = options.timeoutMs || (isForm ? 90000 : 15000);
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      res = await fetch(`${BASE}${path}`, {
        ...options,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Request timeout. Check your internet connection and try again.');
      }
      throw new Error(
        'Cannot reach backend. Make sure the Sparkle server is running on port 3001.\n' +
        '  cd sparkle-backend && node server.js'
      );
    }

    // 401: try silent token refresh once
    if (res.status === 401 && !_retry) {
      const refreshed = await tryRefresh();
      if (refreshed) return apiFetch(path, options, true);
      clearTokens();
      throw new Error('SESSION_EXPIRED');
    }

    return res;
  }

  // ─── CAPTCHA (Cloudflare Turnstile) ──────────────────────────────────────────
  //
  // The backend enforces Turnstile on register, login and forgot-password, but
  // ONLY when TURNSTILE_SECRET_KEY is set. The site key is fetched from
  // /api/config, so CAPTCHA is switched on entirely from the backend environment
  // — no frontend edit, no redeploy.
  //
  // When no site key is configured, getCaptchaToken() resolves to null, no script
  // is loaded, and the server skips verification. That is the default state, so
  // this code is inert until you turn Turnstile on.

  const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  let _configPromise = null;
  let _scriptPromise = null;
  let _widgetId = null;
  // The widget's callbacks are bound once at render() time, but each call needs to
  // settle its OWN promise. Route every callback through this mutable slot instead
  // of closing over the first call's resolver — otherwise the second and every
  // later call would wait on a resolver that already fired, and hang until timeout.
  let _pendingResolve = null;

  function _settleCaptcha(token) {
    const resolve = _pendingResolve;
    _pendingResolve = null;
    if (resolve) resolve(token || null);
  }

  /** Public runtime config from the backend, fetched at most once. */
  function getPublicConfig() {
    if (!_configPromise) {
      _configPromise = fetch(`${BASE}/api/config`)
        .then(r => (r.ok ? r.json() : {}))
        .catch(() => ({}));            // offline or old backend — behave as unconfigured
    }
    return _configPromise;
  }

  function loadTurnstileScript() {
    if (_scriptPromise) return _scriptPromise;
    _scriptPromise = new Promise((resolve, reject) => {
      if (window.turnstile) return resolve(window.turnstile);
      const s = document.createElement('script');
      s.src = TURNSTILE_SRC;
      s.async = true;
      s.defer = true;
      s.onload  = () => resolve(window.turnstile);
      s.onerror = () => reject(new Error('Could not load the CAPTCHA script'));
      document.head.appendChild(s);
    });
    return _scriptPromise;
  }

  /**
   * Produce a fresh Turnstile token, or null when CAPTCHA is not configured.
   *
   * Tokens are single-use and short-lived, so the widget is reset before every
   * run rather than cached. Any failure resolves to null instead of throwing:
   * the server is the authority on whether a token was required, and a client-side
   * hiccup should surface as the server's clear error rather than a dead button.
   */
  async function getCaptchaToken() {
    let siteKey = null;
    try {
      ({ turnstile_site_key: siteKey } = await getPublicConfig());
    } catch { return null; }
    if (!siteKey) return null;                       // CAPTCHA switched off
    if (typeof document === 'undefined') return null;

    try {
      const turnstile = await loadTurnstileScript();
      if (!turnstile) return null;

      let host = document.getElementById('sparkle-turnstile-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'sparkle-turnstile-host';
        host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;left:-9999px';
        document.body.appendChild(host);
      }

      return await new Promise(resolve => {
        // Don't hang the sign-in button if Cloudflare is slow or blocked.
        let timer = null;
        const done = token => { if (timer) clearTimeout(timer); resolve(token || null); };
        _pendingResolve = done;
        timer = setTimeout(() => _settleCaptcha(null), 12000);

        try {
          if (_widgetId === null) {
            _widgetId = turnstile.render(host, {
              sitekey: siteKey,
              size: 'invisible',
              // Route through _settleCaptcha so each call settles its own promise.
              callback:           t => _settleCaptcha(t),
              'error-callback':   () => _settleCaptcha(null),
              'timeout-callback': () => _settleCaptcha(null),
              'expired-callback': () => _settleCaptcha(null),
            });
          } else {
            // Tokens are single-use, so always mint a fresh one.
            turnstile.reset(_widgetId);
          }
          turnstile.execute(_widgetId);
        } catch {
          _settleCaptcha(null);
        }
      });
    } catch {
      return null;
    }
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  /**
   * Register a new user.
   * @param {{ first_name, last_name, email, password, role, phone?, city?, zip? }} data
   */
  async function register(data) {
    const cf_turnstile_response = await getCaptchaToken();
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      body:   JSON.stringify(cf_turnstile_response ? { ...data, cf_turnstile_response } : data),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Registration failed';
      throw new Error(msg);
    }
    setTokens(json.access_token, json.refresh_token, json.user);
    localStorage.setItem('sparkle_role', json.user.role);
    return json;
  }

  /**
   * Sign in with email and password.
   * @returns {{ access_token, refresh_token, user, profile }}
   */
  async function login(email, password) {
    const cf_turnstile_response = await getCaptchaToken();
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body:   JSON.stringify(cf_turnstile_response ? { email, password, cf_turnstile_response } : { email, password }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Login failed');
    setTokens(json.access_token, json.refresh_token, json.user);
    localStorage.setItem('sparkle_role', json.user.role);
    return json;
  }

  /** Fetch current user profile (validates token is still good). */
  async function me() {
    const res = await apiFetch('/api/auth/me');
    if (!res.ok) throw new Error('Not authenticated');
    return res.json();
  }

  /** Update the signed-in user's core account details. */
  async function updateMe(data) {
    const res = await apiFetch('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Failed to update profile';
      throw new Error(msg);
    }
    if (json.user) setTokens(getAccessToken(), getRefreshToken(), json.user);
    return json;
  }

  /** Clear all stored tokens (call before showing login screen). */
  function logout() {
    clearTokens();
  }

  // ─── Jobs ────────────────────────────────────────────────────────────────────

  /**
   * Client: post a new job.
   * @param {{ service_type, address, scheduled_at, bedrooms?, bathrooms?,
   *            duration_hrs?, notes?, supplies_by?, pets?,
   *            is_recurring?, recurring_freq?, is_priority?, has_guarantee? }} data
   */
  async function postJob(data) {
    const res = await apiFetch('/api/jobs', {
      method: 'POST',
      body:   JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Failed to post job';
      throw new Error(msg);
    }
    return json;
  }

  /** Cleaner: get open jobs available to bid on. */
  async function getAvailableJobs() {
    const res = await apiFetch('/api/jobs/available');
    if (!res.ok) throw new Error('Failed to load available jobs');
    return res.json();
  }

  /** Client: get own job history and active bookings. */
  async function getMyBookings() {
    const res = await apiFetch('/api/jobs/my-bookings');
    if (!res.ok) throw new Error('Failed to load bookings');
    return res.json();
  }

  /** Client: get payment methods and recent billing activity. */
  async function getBilling() {
    const res = await apiFetch('/api/profile/billing');
    if (!res.ok) throw new Error('Failed to load billing');
    return res.json();
  }

  /** Cleaner: get upcoming jobs on schedule. */
  async function getMySchedule() {
    const res = await apiFetch('/api/jobs/my-schedule');
    if (!res.ok) throw new Error('Failed to load schedule');
    return res.json();
  }

  // ─── Bids ────────────────────────────────────────────────────────────────────

  /**
   * Cleaner: submit a bid on an open job.
   * @param {string} job_id
   * @param {number} amount   - e.g. 95.00
   * @param {string} message  - 20–1000 characters
   */
  async function submitBid(job_id, amount, message) {
    const res = await apiFetch('/api/bids', {
      method: 'POST',
      body:   JSON.stringify({ job_id, amount, message }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to submit bid');
    return json;
  }

  /**
   * Client: get all bids on a job.
   * @param {string} job_id
   * @param {'price'|'rating'|'speed'} sort
   */
  async function getBidsForJob(job_id, sort = 'price') {
    const res = await apiFetch(`/api/bids/job/${encodeURIComponent(job_id)}?sort=${sort}`);
    if (!res.ok) throw new Error('Failed to load bids');
    return res.json();
  }

  /**
   * Client: choose a bid (locks booking and authorizes payment).
   * @param {string} bid_id
   * @param {string} [payment_method_id]  - Stripe payment method (optional in dev)
   */
  async function chooseBid(bid_id, payment_method_id) {
    const res = await apiFetch(`/api/bids/${encodeURIComponent(bid_id)}/choose`, {
      method: 'POST',
      body:   JSON.stringify({ payment_method_id }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to confirm booking');
    return json;
  }

  // â”€â”€â”€ Messaging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function getMessageConversations() {
    const res = await apiFetch('/api/messages/conversations');
    if (!res.ok) throw new Error('Failed to load conversations');
    return res.json();
  }

  async function getMessages(userId) {
    const res = await apiFetch(`/api/messages/${encodeURIComponent(userId)}`);
    if (!res.ok) throw new Error('Failed to load messages');
    return res.json();
  }

  async function sendMessage(data) {
    const res = await apiFetch('/api/messages', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Failed to send message';
      throw new Error(msg);
    }
    return json;
  }

  // â”€â”€â”€ Reviews â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function getReviews(userId) {
    const res = await apiFetch(`/api/reviews/${encodeURIComponent(userId)}`);
    if (!res.ok) throw new Error('Failed to load reviews');
    return res.json();
  }

  async function submitReview(data) {
    const res = await apiFetch('/api/reviews', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Failed to submit review';
      throw new Error(msg);
    }
    return json;
  }

  // ─── Cleaner profile & marketplace ──────────────────────────────────────────

  /** Get a cleaner's public profile, services, and reviews. */
  async function getCleanerProfile(userId) {
    const res = await apiFetch(`/api/profile/cleaner/${encodeURIComponent(userId)}`);
    if (!res.ok) throw new Error('Failed to load cleaner profile');
    return res.json();
  }

  /**
   * Cleaner: update own profile (rate, bio, lockout policy, services).
   * @param {{ hourly_rate?, bio?, lockout_fee_enabled?, lockout_fee_amount?, lockout_grace_mins?, services? }} data
   */
  async function updateCleanerProfile(data) {
    const res = await apiFetch('/api/profile/cleaner', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Failed to update profile';
      throw new Error(msg);
    }
    return json;
  }

  /**
   * Client: browse cleaners, optionally filtered.
   * @param {{ service?, min_rate?, max_rate?, verified_only? }} [filters]
   */
  async function getCleaners(filters = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.set(k, v);
    });
    const qs = params.toString();
    const res = await apiFetch(`/api/cleaners${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error('Failed to load cleaners');
    return res.json();
  }

  // ─── Earnings & payouts ──────────────────────────────────────────────────────

  /** Cleaner: get payout history and earnings summary. */
  async function getEarnings() {
    const res = await apiFetch('/api/earnings');
    if (!res.ok) throw new Error('Failed to load earnings');
    return res.json();
  }

  /**
   * Cleaner: cash out available earnings.
   * @param {'instant'|'standard'} [type='standard']
   */
  async function cashout(type = 'standard') {
    const res = await apiFetch('/api/earnings/cashout', {
      method: 'POST',
      body: JSON.stringify({ type }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Cashout failed');
    return json;
  }

  // ─── Mileage Tracking (Pro feature) ─────────────────────────────────────────

  /**
   * Start tracking a mileage trip.
   * @param {string} job_id
   * @param {number} latitude
   * @param {number} longitude
   */
  async function startMileageTrip(job_id, latitude, longitude) {
    const res = await apiFetch('/api/mileage/start', {
      method: 'POST',
      body: JSON.stringify({ job_id, latitude, longitude }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to start mileage tracking');
    return json; // { trip_id, started_at, message }
  }

  /**
   * End a mileage trip and calculate distance.
   * @param {string} trip_id
   * @param {number} latitude
   * @param {number} longitude
   */
  async function endMileageTrip(trip_id, latitude, longitude) {
    const res = await apiFetch('/api/mileage/end', {
      method: 'POST',
      body: JSON.stringify({ trip_id, latitude, longitude }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to end mileage trip');
    return json; // { trip_id, distance_miles, duration_minutes, ... }
  }

  /**
   * Get mileage trip history.
   * @param {number} [limit=50]
   * @param {number} [offset=0]
   */
  async function getMileageHistory(limit = 50, offset = 0) {
    const res = await apiFetch(`/api/mileage/history?limit=${limit}&offset=${offset}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to load mileage history');
    return json;
  }

  /**
   * Get mileage statistics for a period.
   * @param {'week'|'month'|'all'} [period='month']
   */
  async function getMileageStats(period = 'month') {
    const res = await apiFetch(`/api/mileage/stats?period=${period}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to load mileage statistics');
    return json;
  }

  // ─── Support / Customer Service ─────────────────────────────────────────────

  /**
   * Create a support ticket. Works for anonymous visitors (landing page contact
   * form) and logged-in users (will be linked to their account automatically).
   * @param {{ name, email, subject, message, phone? }} data
   */
  async function createSupportTicket(data) {
    const res = await apiFetch('/api/support/tickets', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Failed to send support request';
      throw new Error(msg);
    }
    return json;
  }

  /** Logged-in user: get own support tickets. */
  async function getMyTickets() {
    const res = await apiFetch('/api/support/my-tickets');
    if (!res.ok) throw new Error('Failed to load support tickets');
    return res.json();
  }

  /** Get a single ticket and its message thread (owner or admin). */
  async function getTicket(id) {
    const res = await apiFetch(`/api/support/tickets/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error('Failed to load ticket');
    return res.json();
  }

  /** Reply to a support ticket (owner or admin). */
  async function replyToTicket(id, message) {
    const res = await apiFetch(`/api/support/tickets/${encodeURIComponent(id)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Failed to send reply';
      throw new Error(msg);
    }
    return json;
  }

  /**
   * Admin: list all support tickets.
   * @param {{ status?, search?, page?, limit? }} [filters]
   */
  async function getAllTickets(filters = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.set(k, v);
    });
    const qs = params.toString();
    const res = await apiFetch(`/api/support/admin/tickets${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error('Failed to load tickets');
    return res.json();
  }

  /** Admin: update a ticket's status. */
  async function updateTicketStatus(id, status) {
    const res = await apiFetch(`/api/support/admin/tickets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Failed to update ticket';
      throw new Error(msg);
    }
    return json;
  }

  // ─── Profile photo ──────────────────────────────────────────────────────────

  /**
   * Upload the signed-in user's profile photo (any role).
   * @param {File} file  image file — the backend accepts JPG/PNG/GIF/WebP/HEIC up to 10MB
   * @returns {{ url: string }} url is root-relative, e.g. /uploads/profiles/<uuid>.jpg
   */
  async function uploadProfilePhoto(file) {
    const fd = new FormData();
    fd.append('photo', file);
    const res  = await apiFetch('/api/upload/profile-photo', { method: 'POST', body: fd });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Could not upload your photo');
    return json;
  }

  /** Remove the signed-in user's profile photo. */
  async function deleteProfilePhoto() {
    const res  = await apiFetch('/api/upload/profile-photo', { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Could not remove your photo');
    return json;
  }

  // ─── Credentials (license & insurance verification) ─────────────────────────

  /** Cleaner: own documents plus the derived badge_tier. */
  async function getMyCredentials() {
    const res = await apiFetch('/api/credentials/mine');
    if (!res.ok) throw new Error('Failed to load your documents');
    return res.json();
  }

  /**
   * Cleaner: upload a verification document.
   * @param {'license'|'coi'} docType
   * @param {File}   file
   * @param {{ expires_at: string, issuer?: string, policy_number?: string }} meta
   */
  async function uploadCredential(docType, file, meta = {}) {
    const fd = new FormData();
    fd.append('document', file);
    fd.append('expires_at', meta.expires_at || '');
    if (meta.issuer)        fd.append('issuer', meta.issuer);
    if (meta.policy_number) fd.append('policy_number', meta.policy_number);

    // No Content-Type header — apiFetch detects FormData and lets the browser
    // set the multipart boundary.
    const res  = await apiFetch(`/api/credentials/${encodeURIComponent(docType)}`, {
      method: 'POST',
      body: fd,
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Upload failed';
      throw new Error(msg);
    }
    return json;
  }

  /** Cleaner: withdraw a document that is still awaiting review. */
  async function deleteCredential(id) {
    const res  = await apiFetch(`/api/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to withdraw document');
    return json;
  }

  /**
   * Fetch a document's bytes (owner or admin).
   * Returns the raw Response — the caller does `.blob()`. A plain <img>/<iframe>
   * src cannot carry the Authorization header, so the viewer must go through
   * fetch -> blob -> URL.createObjectURL.
   */
  async function getCredentialFile(id) {
    const res = await apiFetch(`/api/credentials/${encodeURIComponent(id)}/file`, { timeoutMs: 60000 });
    if (!res.ok) throw new Error('Could not open the document');
    return res;
  }

  /** Admin: the review queue for a given status (default 'pending'). */
  async function getPendingCredentials(status = 'pending') {
    const res = await apiFetch(`/api/credentials/admin/queue?status=${encodeURIComponent(status)}`);
    if (!res.ok) throw new Error('Failed to load the review queue');
    return res.json();
  }

  /** Admin: approve a document, optionally correcting the expiry date. */
  async function approveCredential(id, expiresAt) {
    const res  = await apiFetch(`/api/credentials/admin/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: JSON.stringify(expiresAt ? { expires_at: expiresAt } : {}),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Failed to approve document';
      throw new Error(msg);
    }
    return json;
  }

  /** Admin: reject a document with a reason the cleaner will see. */
  async function rejectCredential(id, reason) {
    const res  = await apiFetch(`/api/credentials/admin/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.errors?.[0]?.msg || json.error || 'Failed to reject document';
      throw new Error(msg);
    }
    return json;
  }

  // ─── Admin console ──────────────────────────────────────────────────────────

  /** Shared helper: GET an admin endpoint and unwrap JSON. */
  async function adminGet(path, label) {
    const res = await apiFetch(path);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Failed to load ${label}`);
    }
    return res.json();
  }

  /** Shared helper: POST to an admin endpoint and unwrap JSON. */
  async function adminPost(path, body, label) {
    const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.errors?.[0]?.msg || json.error || `Failed to ${label}`);
    return json;
  }

  /** Platform-wide counts for the admin dashboard. */
  function getAdminDashboard() {
    return adminGet('/api/admin/dashboard', 'dashboard stats');
  }

  /** Paginated user list. filters: { role, status, search, page, limit } */
  function getAdminUsers(filters = {}) {
    const p = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
    const qs = p.toString();
    return adminGet(`/api/admin/users${qs ? '?' + qs : ''}`, 'users');
  }

  const banUser       = (id, reason) => adminPost(`/api/admin/users/${encodeURIComponent(id)}/ban`, { reason }, 'ban user');
  const reinstateUser = (id)         => adminPost(`/api/admin/users/${encodeURIComponent(id)}/reinstate`, {}, 'reinstate user');
  const flagUser      = (id)         => adminPost(`/api/admin/users/${encodeURIComponent(id)}/flag`, {}, 'flag user');

  const getDisputes   = ()                        => adminGet('/api/admin/disputes', 'disputes');
  const resolveDisputeApi = (id, resolution, ruling) =>
    adminPost(`/api/admin/disputes/${encodeURIComponent(id)}/resolve`, { resolution, ruling }, 'resolve dispute');

  /** Send an in-app notification to an audience: all | cleaners | clients | unverified */
  const sendPlatformNotification = (audience, title, body, type) =>
    adminPost('/api/admin/notify', { audience, title, body, type }, 'send notification');

  const getBgCheckQueue  = ()            => adminGet('/api/background-check/admin/queue', 'background checks');
  const approveBgCheck   = (id)          => adminPost(`/api/background-check/admin/${encodeURIComponent(id)}/approve`, {}, 'approve background check');
  const rejectBgCheck    = (id, reason)  => adminPost(`/api/background-check/admin/${encodeURIComponent(id)}/reject`, { reason }, 'reject background check');

  // ─── Public API ─────────────────────────────────────────────────────────────
  return {
    isRealSession,
    getApiBase: () => BASE,
    getUser,
    register,
    login,
    me,
    updateMe,
    logout,
    postJob,
    getAvailableJobs,
    getMyBookings,
    getMySchedule,
    getBilling,
    submitBid,
    getBidsForJob,
    chooseBid,
    startMileageTrip,
    endMileageTrip,
    getMileageHistory,
    getMileageStats,
    getMessageConversations,
    getMessages,
    sendMessage,
    getReviews,
    submitReview,
    getCleanerProfile,
    updateCleanerProfile,
    getCleaners,
    getEarnings,
    cashout,
    createSupportTicket,
    getMyTickets,
    getTicket,
    replyToTicket,
    getAllTickets,
    updateTicketStatus,
    getAdminDashboard,
    getAdminUsers,
    banUser,
    reinstateUser,
    flagUser,
    getDisputes,
    resolveDispute: resolveDisputeApi,
    sendPlatformNotification,
    getBgCheckQueue,
    approveBgCheck,
    rejectBgCheck,
    uploadProfilePhoto,
    deleteProfilePhoto,
    getMyCredentials,
    uploadCredential,
    deleteCredential,
    getCredentialFile,
    getPendingCredentials,
    approveCredential,
    rejectCredential,
  };
})();
