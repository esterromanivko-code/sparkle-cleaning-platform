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
  // Single-flight. Refresh tokens rotate, so when several requests get a 401 at
  // once (a batch of photo uploads, say) only ONE refresh may run — a second one
  // would present the already-rotated token, be rejected, and sign the user out
  // in the middle of their work.
  // Resolves to 'ok', 'rejected' (must sign in again) or 'offline'.
  let refreshInFlight = null;
  function tryRefresh() {
    if (!refreshInFlight) {
      refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }
  async function doRefresh() {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return 'rejected';
    let res;
    try {
      res = await fetch(`${BASE}/api/auth/refresh`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch {
      return 'offline';   // a dropped connection is no reason to sign someone out
    }
    if (!res.ok) { clearTokens(); return 'rejected'; }
    const data = await res.json();
    setTokens(data.access_token, data.refresh_token, getUser()); // keep existing user object
    return 'ok';
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
      const outcome = await tryRefresh();
      if (outcome === 'ok') return apiFetch(path, options, true);
      if (outcome === 'offline') throw new Error('Cannot reach Sparkle right now. Check your connection and try again.');
      clearTokens();
      throw new Error('SESSION_EXPIRED');
    }

    // 403 from a suspended account: the backend now rejects banned users on every
    // request, not just at login. End the session through the same SESSION_EXPIRED
    // path every screen already handles, so a suspended user is signed out rather
    // than left in a half-working app. Signing back in shows the real reason.
    // clone() so ordinary 403s (e.g. wrong role) keep their body for the caller.
    if (res.status === 403) {
      const body = await res.clone().json().catch(() => null);
      if (body?.code === 'ACCOUNT_SUSPENDED') {
        clearTokens();
        throw new Error('SESSION_EXPIRED');
      }
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
  let _captchaRequired = false;
  // The same goes for per-call state the callbacks need: the current call's timer
  // and whether it already retried. _captchaError is Cloudflare's last error code.
  let _captchaCall = null;
  let _captchaError = null;

  // Turnstile can legitimately fail for a real person — an ad blocker or privacy
  // extension blocking challenges.cloudflare.com, a locked-down network, or a
  // browser it does not support. Without this the server replies "CAPTCHA token
  // required", which reads like a bug rather than something the user can act on.
  const CAPTCHA_HELP =
    "Couldn't complete the security check. Refresh the page and try again — " +
    'if it keeps happening, disable any ad blocker or VPN for this site or try another browser.';
  // Cloudflare's error code identifies the cause (see its Turnstile error-code list).
  const captchaHelp = () => CAPTCHA_HELP + (_captchaError ? ` (code: ${_captchaError})` : '');

  // Codes that retrying can't fix: a wrong or disabled site key, a hostname not
  // added to the widget in Cloudflare, or the visitor's clock being wrong.
  const CAPTCHA_FINAL_ERRORS = /^(110100|110110|110200|200100|400020|400070)/;
  const CAPTCHA_AUTO_MS = 15000;          // a check that needs nothing from the visitor
  const CAPTCHA_INTERACTIVE_MS = 120000;  // time to tick the box when Cloudflare asks

  // The widget stays invisible unless Cloudflare wants the visitor to tick a box;
  // then it appears at the bottom of the screen. It used to sit off-screen at zero
  // size, so anyone Cloudflare asked to tick the box (common with VPNs, privacy
  // browsers and some extensions) could never do it, and sign-in simply failed.
  function captchaHost() {
    let host = document.getElementById('sparkle-turnstile-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'sparkle-turnstile-host';
      host.style.cssText = 'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);' +
        'z-index:10000;display:flex;flex-direction:column;align-items:center;gap:6px;max-width:calc(100vw - 32px)';
      const note = document.createElement('div');
      note.id = 'sparkle-turnstile-note';
      note.hidden = true;
      note.setAttribute('role', 'status');
      note.textContent = 'Quick security check: tick the box to continue.';
      note.style.cssText = 'background:#fff;color:#1a1a1a;border-radius:8px;padding:6px 12px;font:13px system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.18)';
      const slot = document.createElement('div');
      slot.id = 'sparkle-turnstile-slot';
      host.append(note, slot);
      document.body.appendChild(host);
    }
    return host;
  }

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

    // Past this point CAPTCHA IS configured, so the server will reject a request
    // that arrives without a token. Remember that, so callers can turn a null
    // token into an explanation instead of the server's bare "token required".
    _captchaRequired = true;

    _captchaError = null;
    try {
      const turnstile = await loadTurnstileScript();
      if (!turnstile) { _captchaError = 'script'; return null; }
      const host = captchaHost();
      const note = host.querySelector('#sparkle-turnstile-note');

      return await new Promise(resolve => {
        // Don't hang the sign-in button if Cloudflare is slow or blocked — but give
        // someone who's been asked to tick the box time to do it.
        const call = { retried: false, timer: null };
        call.arm = ms => {
          clearTimeout(call.timer);
          call.timer = setTimeout(() => { _captchaError = _captchaError || 'timeout'; _settleCaptcha(null); }, ms);
        };
        _captchaCall = call;
        _pendingResolve = token => {
          clearTimeout(call.timer);
          note.hidden = true;
          resolve(token || null);
        };
        call.arm(CAPTCHA_AUTO_MS);

        try {
          if (_widgetId === null) {
            // Callbacks are bound once, so they act on whichever call is current.
            _widgetId = turnstile.render(host.querySelector('#sparkle-turnstile-slot'), {
              sitekey: siteKey,
              appearance: 'interaction-only',
              execution: 'execute',
              callback: t => _settleCaptcha(t),
              'error-callback': code => {
                _captchaError = String(code || 'error');
                const current = _captchaCall;
                // Cloudflare's own advice for most failures is to try again, and a
                // second attempt often passes. Once per sign-in, and never for
                // configuration errors.
                if (current && !current.retried && _pendingResolve && !CAPTCHA_FINAL_ERRORS.test(_captchaError)) {
                  current.retried = true;
                  try { turnstile.reset(_widgetId); turnstile.execute(_widgetId); return true; } catch { /* give up below */ }
                }
                _settleCaptcha(null);
                return true;   // handled: don't also log it to the console
              },
              'timeout-callback': () => { _captchaError = 'interaction timeout'; _settleCaptcha(null); },
              'expired-callback': () => _settleCaptcha(null),
              'before-interactive-callback': () => { note.hidden = false; _captchaCall?.arm(CAPTCHA_INTERACTIVE_MS); },
              'after-interactive-callback': () => { note.hidden = true; },
            });
          } else {
            // Tokens are single-use, so always mint a fresh one.
            turnstile.reset(_widgetId);
          }
          turnstile.execute(_widgetId);
        } catch (err) {
          _captchaError = err?.message || 'render';
          _settleCaptcha(null);
        }
      });
    } catch {
      _captchaError = _captchaError || 'script';
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
    if (!cf_turnstile_response && _captchaRequired) throw new Error(captchaHelp());
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
    if (!cf_turnstile_response && _captchaRequired) throw new Error(captchaHelp());
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
   * Client: book a cleaner's quote, paid with one of their saved cards.
   * Resolves to { job_id, total_charged, payment: { status, client_secret?, payment_intent_id? } }
   * where status is authorized | scheduled | action_required (the bank wants approval).
   * Errors carry err.code: CARD_REQUIRED | CARD_NOT_FOUND | CARD_DECLINED | PAYMENTS_UNAVAILABLE.
   */
  function chooseBid(bid_id, payment_method_id) {
    return jsonCall(`/api/bids/${encodeURIComponent(bid_id)}/choose`,
      { method: 'POST', body: JSON.stringify({ payment_method_id }) }, 'Failed to confirm booking');
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

  // ─── Job lifecycle, proof photos, disputes ──────────────────────────────────

  /** Shared helper: send a request and unwrap JSON, keeping status/code on errors. */
  async function jsonCall(path, options, fallback) {
    const res  = await apiFetch(path, options);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.errors?.[0]?.msg || json.error || fallback);
      err.status = res.status;
      err.code   = json.code;
      err.data   = json;
      throw err;
    }
    return json;
  }
  const post = (path, body, fallback) =>
    jsonCall(path, { method: 'POST', body: JSON.stringify(body || {}) }, fallback);

  // `location` is { lat, lng, accuracy } from the device, or null when the cleaner
  // hasn't allowed location — every one of these still works without it.
  const jobPath = (jobId, action) => `/api/jobs/${encodeURIComponent(jobId)}/${action}`;
  const startEnRoute     = (jobId, location = null) => post(jobPath(jobId, 'en-route'), { location }, "Couldn't let the client know you're on the way");
  const sendJobLocation  = (jobId, location) => post(jobPath(jobId, 'location'), location, 'Location update failed');
  const getJobTracking   = (jobId) => jsonCall(jobPath(jobId, 'tracking'), {}, 'Failed to load location');
  const arriveAtJob      = (jobId, location = null) => post(jobPath(jobId, 'arrive'), { location }, 'Could not record your arrival');
  /** Fails with code PHOTOS_REQUIRED (and err.data.counts) until ≥1 before and ≥1 after photo exist. */
  const completeJob      = (jobId, location = null) => post(jobPath(jobId, 'complete'), { location }, 'Could not complete the job');
  const cancelJob        = (jobId) => post(jobPath(jobId, 'cancel'), {}, 'Could not cancel the job');
  /** Needs all 5 checklist items and at least one 'lockout' photo at the door. */
  const chargeLockoutFee = (jobId, checklist, location = null) =>
    post(jobPath(jobId, 'lockout-fee'), { checklist, location }, 'Could not charge the lockout fee');

  /**
   * Permanently delete the signed-in account. On a 409, err.data.blockers lists
   * what has to be finished first (upcoming jobs, earnings to cash out, …).
   */
  async function deleteAccount(password) {
    const json = await jsonCall('/api/auth/me',
      { method: 'DELETE', body: JSON.stringify({ password, confirm: 'DELETE' }) },
      'Could not delete your account');
    clearTokens();
    return json;
  }
  const getMyJobHistory  = () => jsonCall('/api/jobs/my-history', {}, 'Failed to load your recent jobs');

  const getJobPhotos = (jobId) => jsonCall(`/api/job-photos/${encodeURIComponent(jobId)}`, {}, 'Failed to load photos');

  /**
   * Upload ONE photo. stage: before | after | lockout | evidence (evidence needs disputeId).
   * clientUploadId makes a retry after a dropped connection store the photo only once.
   */
  function uploadJobPhoto(jobId, stage, blob, { disputeId, clientUploadId } = {}) {
    const qs = new URLSearchParams({ stage });
    if (disputeId)      qs.set('dispute_id', disputeId);
    if (clientUploadId) qs.set('client_upload_id', clientUploadId);
    const fd = new FormData();
    fd.append('photo', blob, 'photo.jpg');
    return jsonCall(`/api/job-photos/${encodeURIComponent(jobId)}?${qs}`,
      { method: 'POST', body: fd, timeoutMs: 120000 }, 'Photo upload failed');
  }

  const deleteJobPhoto = (photoId, reason) => jsonCall(`/api/job-photos/photo/${encodeURIComponent(photoId)}`,
    { method: 'DELETE', body: JSON.stringify(reason ? { reason } : {}) }, 'Could not remove the photo');

  /**
   * Photos are private, so an <img src> can't load them (it can't send the token).
   * Takes the url / thumb_url the API returned and resolves to a Blob.
   */
  async function getJobPhotoBlob(url) {
    if (!/^\/api\/job-photos\/file\//.test(url)) throw new Error('Not a job photo URL');
    const res = await apiFetch(url, { timeoutMs: 60000 });
    if (!res.ok) throw new Error('Could not load the photo');
    return res.blob();
  }

  /** Client: report a problem (type quality | payment | other | lockout_fee), within 72 hours. */
  const fileDispute = (jobId, type, description) =>
    post('/api/disputes', { job_id: jobId, type, description }, 'Could not submit your report');
  const getMyDisputes        = ()   => jsonCall('/api/disputes/mine', {}, 'Failed to load disputes');
  const getDispute           = (id) => jsonCall(`/api/disputes/${encodeURIComponent(id)}`, {}, 'Failed to load the dispute');
  const addDisputeStatement  = (id, statement) =>
    post(`/api/disputes/${encodeURIComponent(id)}/statement`, { statement }, 'Could not save your response');

  const getNotifications     = ()   => jsonCall('/api/notifications', {}, 'Failed to load notifications');
  const markNotificationRead = (id) => post(`/api/notifications/${encodeURIComponent(id)}/read`, {}, 'Could not update notification');

  const retryDisputeRefund = (id) => adminPost(`/api/admin/disputes/${encodeURIComponent(id)}/retry-refund`, {}, 'retry refund');
  const releaseJobEarnings = (jobId, reason) =>
    adminPost(`/api/admin/jobs/${encodeURIComponent(jobId)}/release-earnings`, { reason }, 'release earnings');
  const getAdminLockoutFees = () => adminGet('/api/admin/lockout-fees', 'lockout fees');

  // ─── Cards, booking payments and payout accounts ────────────────────────────
  // Card numbers never pass through here: they go from Stripe's card form straight
  // to Stripe. These calls only handle the ids of cards a client has saved.

  const getPaymentMethods = () => jsonCall('/api/payments/methods', {}, 'Failed to load your cards');
  const createSetupIntent = () => post('/api/payments/setup-intent', {}, "Couldn't start adding a card");
  const setDefaultCard    = (id) => post(`/api/payments/methods/${encodeURIComponent(id)}/default`, {}, "Couldn't update your default card");
  const removeCard        = (id) => jsonCall(`/api/payments/methods/${encodeURIComponent(id)}`, { method: 'DELETE' }, "Couldn't remove the card");
  /** Resolves to { outcome }: authorized | scheduled | captured | processing | failed (with error) | action_required (with client_secret, payment_intent_id). */
  const payForJob         = (jobId, paymentMethodId) =>
    post(`/api/payments/jobs/${encodeURIComponent(jobId)}/pay`, { payment_method_id: paymentMethodId }, 'Payment failed');
  /** After the client approved a payment with their bank in the browser. */
  const confirmJobPayment = (jobId, paymentIntentId) =>
    post(`/api/payments/jobs/${encodeURIComponent(jobId)}/pay/confirm`, { payment_intent_id: paymentIntentId }, "Couldn't confirm the payment");

  /** Cleaner: { state: not_started | incomplete | verifying | ready | rejected, payouts_enabled, label, needs_info, mode } */
  const getPayoutAccount    = (refresh = false) =>
    jsonCall(`/api/payments/connect/status${refresh ? '?refresh=1' : ''}`, {}, 'Failed to load your payout account');
  /** Resolves to { url } — Stripe's setup pages, which send the cleaner back to returnTo. */
  const startPayoutSetup    = (returnTo) => post('/api/payments/connect/onboard', { return_to: returnTo }, "Couldn't open payout setup");
  const openPayoutDashboard = () => post('/api/payments/connect/dashboard', {}, "Couldn't open your payout account");

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
    startEnRoute,
    sendJobLocation,
    getJobTracking,
    deleteAccount,
    arriveAtJob,
    completeJob,
    cancelJob,
    chargeLockoutFee,
    getMyJobHistory,
    getJobPhotos,
    uploadJobPhoto,
    deleteJobPhoto,
    getJobPhotoBlob,
    fileDispute,
    getMyDisputes,
    getDispute,
    addDisputeStatement,
    getNotifications,
    markNotificationRead,
    retryDisputeRefund,
    releaseJobEarnings,
    getAdminLockoutFees,
    getPublicConfig,
    getPaymentMethods,
    createSetupIntent,
    setDefaultCard,
    removeCard,
    payForJob,
    confirmJobPayment,
    getPayoutAccount,
    startPayoutSetup,
    openPayoutDashboard,
  };
})();
