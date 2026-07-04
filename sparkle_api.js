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
    const token = getAccessToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res;
    try {
      // Mobile timeout: 15 seconds (longer than desktop due to slower networks)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

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

  // ─── Auth ────────────────────────────────────────────────────────────────────

  /**
   * Register a new user.
   * @param {{ first_name, last_name, email, password, role, phone?, city?, zip? }} data
   */
  async function register(data) {
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      body:   JSON.stringify(data),
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
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body:   JSON.stringify({ email, password }),
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
  };
})();
