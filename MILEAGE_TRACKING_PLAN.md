# Mileage Tracking Feature — Implementation Plan

## Overview
Pro members can track driving miles to/from jobs, get mileage logs, and see tax-deductible summaries.

---

## 1. Database Schema

### New Table: `mileage_logs`
```sql
CREATE TABLE mileage_logs (
  id TEXT PRIMARY KEY,
  cleaner_id TEXT NOT NULL,
  job_id TEXT,
  start_lat REAL,
  start_lng REAL,
  end_lat REAL,
  end_lng REAL,
  distance_miles REAL,
  start_time TEXT,
  end_time TEXT,
  duration_minutes INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (cleaner_id) REFERENCES users(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
```

### Update: `cleaner_profiles` table
Add column if not exists:
```sql
ALTER TABLE cleaner_profiles ADD COLUMN is_pro INTEGER DEFAULT 0;
```

---

## 2. Backend API Endpoints

### POST /api/mileage/start
**Request body:**
```json
{
  "job_id": "uuid",
  "latitude": 47.6062,
  "longitude": -122.3321
}
```

**Response:**
```json
{
  "trip_id": "uuid",
  "started_at": "2026-05-29T10:30:00Z",
  "message": "Mileage tracking started"
}
```

**Logic:**
- Check if cleaner has Pro membership (401 if not)
- Store start coordinates and timestamp
- Return trip_id for later reference

### POST /api/mileage/end
**Request body:**
```json
{
  "trip_id": "uuid",
  "latitude": 47.5960,
  "longitude": -122.2900,
  "ended_at": "2026-05-29T10:45:00Z"
}
```

**Response:**
```json
{
  "trip_id": "uuid",
  "distance_miles": 4.2,
  "duration_minutes": 15,
  "started_at": "2026-05-29T10:30:00Z",
  "ended_at": "2026-05-29T10:45:00Z",
  "message": "Trip logged: 4.2 miles"
}
```

**Logic:**
- Calculate distance using Haversine formula
- Store end coordinates and timestamp
- Calculate duration
- Return summary

### GET /api/mileage/history
**Query params:** `?limit=50&offset=0&from=2026-05-01&to=2026-05-31`

**Response:**
```json
{
  "trips": [
    {
      "trip_id": "uuid",
      "job_id": "uuid",
      "distance_miles": 4.2,
      "duration_minutes": 15,
      "started_at": "2026-05-29T10:30:00Z",
      "job_address": "123 Main St, Seattle, WA"
    }
  ],
  "total_trips": 47,
  "total_miles_month": 187.3
}
```

### GET /api/mileage/stats
**Query params:** `?period=month` (month|week|all)

**Response:**
```json
{
  "period": "month",
  "total_miles": 187.3,
  "total_trips": 47,
  "avg_distance_per_trip": 3.98,
  "avg_duration_minutes": 12,
  "estimated_tax_deduction": 10.51
}
```

**Tax calculation:** `total_miles * 0.67` (2026 IRS rate)

---

## 3. Frontend Changes

### New Modal: Mileage Tracker
- Shows when cleaner marks "I'm on my way" / "Arrived"
- Requests geolocation permission
- Shows real-time distance as they drive (if GPS enabled)
- "End trip" button when they arrive

### New Page: Cleaner > Mileage Log
- List of all trips (sortable by date, distance)
- Filters: date range, job type
- Export as CSV for tax purposes
- Monthly/yearly stats

### Update: Cleaner Dashboard
- Add "Mileage" card showing this month's miles
- Add "Go Pro" CTA if not Pro member yet
- Link to full mileage log

### Update: Pro Membership Check
- Before showing mileage features, check `cleaner_profiles.is_pro`
- Show locked/pro-only badge if user isn't Pro

---

## 4. Frontend Geolocation Flow

**When cleaner clicks "I'm on my way":**
1. Request geolocation permission (one-time)
2. Capture starting coordinates
3. Call `POST /api/mileage/start`
4. Get `trip_id` back
5. Store `trip_id` in session

**When cleaner clicks "I've arrived":**
1. Capture ending coordinates
2. Call `POST /api/mileage/end` with `trip_id`
3. Show success toast: "Trip logged: 4.2 miles · 15 min"
4. Update mileage dashboard in real-time

---

## 5. Implementation Checklist

### Backend (sparkle-backend)
- [ ] Add `mileage_logs` table to db.js
- [ ] Add `is_pro` column to `cleaner_profiles` in db.js
- [ ] Create `routes/mileage.js` with 4 endpoints
- [ ] Add Haversine distance calculation helper in `lib/mileage.js`
- [ ] Add Pro membership middleware check
- [ ] Test endpoints with Postman/curl

### Frontend (sparkle_full.html)
- [ ] Add mileage tracking modal HTML
- [ ] Add mileage log page HTML (page-c-mileage)
- [ ] Add geolocation JS functions
- [ ] Wire "I'm on my way" button to start tracking
- [ ] Wire "I've arrived" button to end tracking
- [ ] Add mileage dashboard card to cleaner dashboard
- [ ] Add "Go Pro" messaging for non-Pro users
- [ ] Test locally with mock coordinates first

---

## 6. Privacy & Legal Notes

- **Geolocation:** Only collected when user explicitly clicks "on my way"
- **Storage:** Coordinates stored in database (encrypted in production)
- **User control:** Cleaner can delete trip history (future feature)
- **Privacy notice:** Add line in settings: "We collect location only when you mark 'on my way' to calculate mileage for tax purposes."

---

## 7. Testing Plan

1. **Local testing:** Mock GPS coordinates (Seattle area)
2. **Distance verification:** Known routes (e.g., Seattle to Bellevue ≈ 15 miles)
3. **Pro tier:** Test that non-Pro users see "upgrade to Pro" message
4. **Edge cases:**
   - Very short trips (< 0.1 miles)
   - Very long trips (multiple hours)
   - Stationary cleaner (0 miles)
   - Network error mid-trip (graceful recovery)

---

## 8. Future Enhancements

- Map visualization of routes
- Real-time map while driving (GPS breadcrumb trail)
- Export to TurboTax or tax software
- Mileage reimbursement request feature
- Integration with Stripe for Pro billing

