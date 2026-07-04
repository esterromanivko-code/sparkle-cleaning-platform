# Google Maps + Mileage Tracking Setup Guide

## Overview

Your Sparkle platform now has **Google Maps-powered mileage tracking** that is **Pro-only**. This is critical for your revenue model:

- ✅ Only Sparkle Pro members can access mileage tracking
- ✅ Real-time map visualization of trip routes
- ✅ Automatic distance calculation (Haversine formula)
- ✅ IRS tax deduction estimates ($0.67/mile for 2026)
- ✅ Full GPS route history

---

## Step 1: Get Google Maps API Key

### 1.1 Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Sign in with your Google account
3. Create a new project:
   - Click "Select a Project" → "New Project"
   - Name: `Sparkle Mileage Tracking`
   - Click "Create"

### 1.2 "What framework are you using?"

If the setup wizard asks this, choose **JavaScript** (sometimes shown as a `</>` / "Web" icon).
Do NOT pick React, Angular, Vue, Flutter, Android, or iOS — Sparkle's mileage map uses
the plain Maps JavaScript SDK (`google.maps.Map`, `google.maps.Marker`, `google.maps.Polyline`)
loaded via a `<script>` tag, with no framework.

### 1.3 Enable Google Maps APIs

1. In the left menu, click **APIs & Services** → **Library**
2. Search for and enable these APIs:
   - **Maps JavaScript API** (for displaying maps)
   - **Places API** (for address autocomplete — `libraries=places`)
   - Geometry is bundled into Maps JavaScript API automatically (`libraries=geometry`) — no separate toggle needed.

### 1.4 Create API Key

1. Go to **APIs & Services** → **Credentials**
2. Click **+ Create Credentials** → **API Key**
3. Copy the API key (you'll use this next)
4. ⚠️ **Restrict the key:**
   - Click on the key to edit it
   - **Application restrictions:** Select "HTTP referrers (web sites)"
   - **Add referrer:**
     - `http://localhost:8080/*` (local dev)
     - `https://sparkle-yourusername.netlify.app/*` (production)
   - **API restrictions:** Restrict the key to "Maps JavaScript API" + "Places API" only

---

## Step 2: Add API Key to Backend (.env)

**This step has changed — the key is now served through a secure backend proxy
(`GET /api/maps/config`, requires login) instead of being hardcoded into the HTML.**
The frontend already calls this endpoint and injects the `<script>` tag dynamically
(see `sparkle_full.html` around line 552). You only need to do ONE thing:

### 2.1 Add the key to your backend `.env`

Open `sparkle-backend/sparkle-backend/.env` and set:

```
GOOGLE_MAPS_API_KEY=AIzaSyD_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

### 2.2 Restart the backend

```bash
cd sparkle-backend/sparkle-backend
node server.js
```

That's it — when a logged-in user opens the mileage modal, the frontend fetches
the key from `/api/maps/config` and loads the Google Maps script automatically.

⚠️ **IMPORTANT: Keep this key SECRET**
- Do NOT commit `.env` to GitHub (it should already be in `.gitignore`)
- For production, set `GOOGLE_MAPS_API_KEY` in Railway → Variables (not in any frontend file)
- Never paste the raw key directly into `sparkle_full.html` — that would undo the
  security proxy and expose the key to anyone viewing the page source

---

## Step 3: Pro Membership Gating (Already Implemented!)

### Frontend Gate

When a cleaner tries to start mileage tracking:

```javascript
// ⚠️ PRO-ONLY GATE: Check if user has Pro membership
if (!currentUser.isPro && currentUser.role === 'cleaner') {
  showToast('⭐ Mileage tracking is only available to Sparkle Pro members.');
  showPage('c-pro'); // Redirect to Pro upgrade page
  return;
}
```

### Backend Gate

The backend also verifies Pro status:

```javascript
// Check if cleaner has Pro membership
const profile = db.prepare('SELECT is_pro FROM cleaner_profiles WHERE user_id = ?').get(req.user.id);
if (!profile || !profile.is_pro) {
  return res.status(403).json({ error: 'Mileage tracking requires Pro membership' });
}
```

**Double protection** — frontend AND backend verify Pro status!

---

## How Mileage Tracking Works

### Flow

1. **Cleaner accepts job** → Sees "Start mileage tracking" button
2. **Clicks button** → Frontend checks Pro status
3. **If Pro:** Opens mileage modal with Google Map
4. **GPS tracking starts:** Real-time route shown on map
5. **Cleaner drives:** Route updates on map, distance calculated
6. **Cleaner clicks "End trip"** → Backend records mileage, calculates tax deduction
7. **Data saved** → Added to monthly mileage report

### Real-Time Features

- ✅ **Start marker** (green) — Trip starting location
- ✅ **Current position** (blue) — Real-time cleaner location
- ✅ **Route line** (green) — Trip path
- ✅ **Distance display** — Updates live
- ✅ **Tax deduction** — Real-time calculation at $0.67/mile

### Data Collected

```javascript
{
  trip_id: "uuid",
  cleaner_id: "user_id",
  job_id: "job_id",
  start_lat: 47.6062,
  start_lng: -122.3321,
  end_lat: 47.6150,
  end_lng: -122.3300,
  distance_miles: 0.67,
  start_time: "2026-06-01T10:30:00Z",
  end_time: "2026-06-01T10:45:00Z",
  route: "[{lat, lng}, {lat, lng}, ...]"
}
```

---

## Testing Locally

### Without Real GPS

For local testing without a real GPS device:

1. Open **Chrome DevTools** (F12)
2. Go to **Sensors** tab
3. Set fake GPS coordinates:
   - Latitude: `47.6062` (Seattle)
   - Longitude: `-122.3321` (Seattle)
4. Click "Start mileage tracking"
5. Change GPS coords in DevTools to simulate movement
6. Watch map update in real-time!

### With Real Phone

1. Run backend: `cd sparkle-backend && node server.js`
2. Run frontend: `npx http-server -p 8080`
3. Open on phone: `http://<your-ip>:8080/sparkle_full.html`
4. Accept location permission
5. Start tracking — map will show real-time movement!

---

## Pro Membership Requirements

### For Mileage Tracking Access

User must have:
- ✅ Role = `'cleaner'`
- ✅ `is_pro = true` in database
- ✅ Active Pro subscription (or within trial)

### Revenue Model

**Sparkle earns:**
- $18/month per Pro cleaner (monthly plan)
- $180/year per Pro cleaner (annual plan, saves them $36)

**Mileage tracking is exclusive to Pro** — strong incentive to upgrade!

---

## Deployment Notes

### Local Development
```bash
# sparkle-backend/sparkle-backend/.env
GOOGLE_MAPS_API_KEY=AIzaSyD_your_dev_key_here
```
Restart the backend (`node server.js`). The frontend fetches the key at runtime
from `/api/maps/config` — nothing to set on the frontend side.

### Production (Netlify + Railway)

Set the variable on **Railway** (the backend), not Netlify:

1. Railway dashboard → your backend service → **Variables**
2. Add `GOOGLE_MAPS_API_KEY = AIzaSyD_your_prod_key_here`
3. Railway redeploys automatically

The frontend (on Netlify) needs no Maps-related env vars — it just calls your
Railway backend's `/api/maps/config`, which returns the key to authenticated users.

---

## Pro Features You Can Monetize

With this mileage tracking foundation:

| Feature | Free | Pro | Annual |
|---------|------|-----|--------|
| Basic job acceptance | ✅ | ✅ | ✅ |
| Mileage tracking | ❌ | ✅ | ✅ |
| Tax reports | ❌ | ✅ | ✅ |
| Priority jobs | ❌ | ✅ | ✅ |
| Higher earnings bonus | ❌ | 10% | 10% |
| Dedicated support | ❌ | ✅ | ✅ |
| **Monthly cost** | $0 | $18 | $15 |

---

## Security & Privacy

### Location Data Protection

- ✅ Only authenticated cleaners can track
- ✅ Only tracks during active jobs
- ✅ Data stored in secured SQLite/PostgreSQL
- ✅ Encrypted in transit (HTTPS on production)
- ✅ GPS coordinates never shared with clients

### Google Maps API Security

- ✅ API key restricted to your domains only
- ✅ HTTP referrer restrictions enforced
- ✅ Backend verifies Pro status before allowing API calls
- ✅ Rate limiting prevents abuse

---

## Troubleshooting

### Map not showing

**Issue:** Blank mileage modal without map
**Solution:**
1. Check `GOOGLE_MAPS_API_KEY` is set in `sparkle-backend/sparkle-backend/.env` and the backend was restarted
2. Open DevTools → Network tab, look for a call to `/api/maps/config` — it should return `{ "key": "AIza..." }`. If it returns `{ "key": null }`, the env var isn't set.
3. Check the API key has the correct HTTP referrers set (must include the domain you're testing from)
4. Check **Maps JavaScript API** and **Places API** are both enabled in Google Cloud Console
5. Check browser console for errors (F12) — `/api/maps/config` requires you to be logged in (sends a 401 if not)

### GPS not working

**Issue:** "Could not access location"
**Solutions:**
- Check browser location permission (click lock icon in address bar)
- On phone: Settings → App Permissions → Location → Allow
- On desktop: Chrome → Settings → Privacy → Site Settings → Location

### Distance always zero

**Issue:** Tracker shows 0.0 miles
**Solutions:**
- Check GPS accuracy (requires 5+ meters accuracy)
- Enable high accuracy mode (slower but more accurate)
- Wait 10+ seconds for GPS to lock
- On desktop, use DevTools to simulate movement

### Pro check not working

**Issue:** Non-Pro can access tracking
**Solutions:**
1. Check `is_pro` flag in database
2. Check user actually has active Pro subscription
3. Verify backend route is checking Pro status
4. Check error logs: `console.error()` in DevTools

---

## Future Enhancements

Consider adding:

1. **Route history** — View past trips
2. **Weekly/monthly reports** — PDF exports for taxes
3. **Geofencing** — Auto-start when near job location
4. **Pause/resume** — For breaks during long jobs
5. **Photo checkpoints** — Mark photo locations on route
6. **Integration with tax software** — QuickBooks, TurboTax
7. **Leaderboard** — Top mileage earners (gamification)
8. **Carbon tracking** — Show CO2 offset (eco-friendly marketing)

---

## Compliance & Legal

### US Tax Compliance

- ✅ IRS standard mileage rate ($0.67/mile for 2026)
- ✅ Accurate GPS-based tracking
- ✅ Audit trail (all trips recorded)
- ⚠️ Disclaimer: Users should verify with tax accountant

### GDPR / Privacy Laws

- ✅ Location data collected only with explicit consent
- ✅ Users can delete trip data
- ✅ Data retention policy (recommend 7 years for tax purposes)
- ⚠️ Consider privacy policy updates for your jurisdiction

### Terms of Service

Add to your ToS:

> Mileage tracking is for tax purposes only. Users are responsible for verifying accuracy with their tax professionals. Sparkle does not provide tax advice and is not liable for tax reporting errors.

---

## Files Modified

| File | Changes |
|------|---------|
| `sparkle_full.html` | Mileage map UI + Pro gate + real-time tracking; fetches Maps key from `/api/maps/config` and injects `<script>` dynamically |
| `server.js` | Added `GET /api/maps/config` — serves `GOOGLE_MAPS_API_KEY` only to authenticated users |
| `routes/mileage.js` | Pro membership verification (already in place) |
| `db.js` | Mileage_logs table for GPS route storage (already in place) |
| `.env` | Add `GOOGLE_MAPS_API_KEY=` here (local) / Railway Variables (production) |

---

## Quick Setup Checklist

- [ ] Create Google Cloud project (choose "JavaScript" if asked for a framework)
- [ ] Enable Maps JavaScript API + Places API (Geometry is bundled in)
- [ ] Create API key with HTTP referrer + API restrictions
- [ ] Add `GOOGLE_MAPS_API_KEY=...` to `sparkle-backend/sparkle-backend/.env`
- [ ] Restart backend (`node server.js`) and confirm `/api/maps/config` returns the key
- [ ] Test locally with Chrome DevTools GPS simulation
- [ ] Test on real phone with GPS enabled
- [ ] Verify Pro gate works (non-Pro gets redirected)
- [ ] Deploy to production with secure API key storage
- [ ] Update ToS with mileage tracking disclaimer
- [ ] Monitor usage — track Pro conversion rate
- [ ] Consider future enhancements (reports, leaderboard, etc.)

---

## Support

If you encounter issues:

1. Check Google Cloud Console for API quota/errors
2. Check browser console (F12) for JavaScript errors
3. Check backend logs for Pro verification errors
4. Verify GPS coordinates are valid (use online validator)
5. Test on different devices (desktop, iPhone, Android)

---

**Your mileage tracking is now Pro-exclusive and ready to drive revenue!** 🎉🚗📍

Cleaners who upgrade to Pro get powerful tax deduction tools. You get recurring $18/month revenue per Pro member.

Win-win! 💰
