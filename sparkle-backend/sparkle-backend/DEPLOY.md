# Sparkle Backend — Deployment Guide
## From zero to live in about 30 minutes

---

## What you have
A fully working Node.js backend with:
- ✅ Real user authentication (JWT)
- ✅ Role-based access (cleaners only see cleaner routes, clients only see client routes)
- ✅ Background check flow (Checkr + Stripe Identity)
- ✅ Job posting, accepting, declining, lockout fees
- ✅ In-app messaging
- ✅ Mutual review system
- ✅ Earnings & payouts
- ✅ Pro membership (Stripe subscriptions)
- ✅ Admin dashboard
- ✅ SQLite database (swap to PostgreSQL when you scale past ~10k users)

---

## STEP 1: Get your API keys (do these first)

### Stripe (payments, background check fees, Pro subscriptions)
1. Go to **stripe.com** → Create account (free)
2. Dashboard → Developers → API keys
3. Copy your **Secret key** (starts with `sk_test_...` for testing, `sk_live_...` for real money)
4. Go to **Products** → Create two products:
   - "Sparkle Pro Monthly" → $18/month → copy the **Price ID** (starts with `price_...`)
   - "Sparkle Pro Annual" → $180/year → copy the **Price ID**
5. Go to **Developers → Webhooks** → Add endpoint:
   - URL: `https://YOUR-DOMAIN/api/background-check/webhook/stripe-identity`
   - Events: `identity.verification_session.verified`, `identity.verification_session.requires_input`
   - Copy the **Webhook signing secret** (starts with `whsec_...`)

### Checkr (background checks)
1. Go to **checkr.com** → Sign up as a platform (not individual)
2. Tell them: "I'm building a marketplace for cleaning professionals"
3. They'll approve you in 1-3 business days
4. Dashboard → API Keys → copy your key
5. Dashboard → Webhooks → Add:
   - URL: `https://YOUR-DOMAIN/api/background-check/webhook/checkr`
   - Event: `report.completed`

---

## STEP 2: Deploy to Railway (easiest option — ~$5/month)

### 2a. Push code to GitHub
```bash
# In the sparkle-backend folder:
git init
git add .
git commit -m "Initial Sparkle backend"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/sparkle-backend.git
git push -u origin main
```

### 2b. Deploy on Railway
1. Go to **railway.app** → Sign in with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `sparkle-backend` repo
4. Railway auto-detects Node.js and deploys it
5. Go to your project → **Variables** → Add these:

```
NODE_ENV=production
JWT_SECRET=<generate a random 64-char string — use: openssl rand -hex 32>
STRIPE_SECRET_KEY=sk_live_XXXX        ← your real Stripe key
STRIPE_WEBHOOK_SECRET=whsec_XXXX      ← from Stripe webhook setup
STRIPE_PRO_MONTHLY_PRICE_ID=price_XXXX
STRIPE_PRO_ANNUAL_PRICE_ID=price_XXXX
CHECKR_API_KEY=your_checkr_key
FRONTEND_URL=https://your-frontend-domain.com
```

6. Railway gives you a URL like `sparkle-backend-production.up.railway.app`
7. Test it: `https://YOUR-RAILWAY-URL/health` → should return `{"status":"ok"}`

---

## STEP 3: Swap SQLite → PostgreSQL (when you're ready to scale)

Railway has a built-in PostgreSQL addon:
1. Project → **New** → **Database** → **PostgreSQL**
2. Railway auto-adds `DATABASE_URL` to your environment
3. Install: `npm install pg`
4. In `db.js`, replace the SQLite initialization with:

```javascript
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
module.exports = pool;
```

SQLite is fine for your first 5,000–10,000 users. Switch when you need to.

---

## STEP 4: Connect your frontend

In your frontend (the HTML prototype or any framework):
```javascript
const API = 'https://YOUR-RAILWAY-URL';

// Register a cleaner
const res = await fetch(`${API}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    first_name: 'Jordan',
    last_name: 'Martinez',
    email: 'jordan@example.com',
    password: 'password123',
    role: 'cleaner',       // 'cleaner' or 'client'
    city: 'Seattle',
    zip: '98101'
  })
});
const { token, user } = await res.json();
// Store token in localStorage, send with every request:
// headers: { 'Authorization': `Bearer ${token}` }
```

---

## All API endpoints

### Auth (no token required)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register cleaner or client |
| POST | `/api/auth/login` | Login, returns JWT token |

### Auth (token required)
| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/auth/me` | Any | Get current user + profile |
| POST | `/api/auth/change-password` | Any | Change password |

### Jobs
| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/jobs/available` | Cleaner | Browse open jobs near them |
| GET | `/api/jobs/my-schedule` | Cleaner | Their confirmed upcoming jobs |
| GET | `/api/jobs/my-bookings` | Client | Client's booking history |
| POST | `/api/jobs` | Client | Post a new job |
| POST | `/api/jobs/:id/accept` | Cleaner | Accept a job |
| POST | `/api/jobs/:id/decline` | Cleaner | Decline a job |
| POST | `/api/jobs/:id/arrive` | Cleaner | Mark arrived (starts job) |
| POST | `/api/jobs/:id/complete` | Cleaner | Mark complete (triggers payout) |
| POST | `/api/jobs/:id/cancel` | Either | Cancel a job |
| POST | `/api/jobs/:id/lockout-fee` | Cleaner | Charge lockout fee (requires all 5 checklist items) |

### Background Checks
| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/background-check/status` | Cleaner | Check their verification status |
| POST | `/api/background-check/initiate` | Cleaner | Pay $25, start Checkr + Stripe Identity |
| POST | `/api/background-check/webhook/checkr` | Checkr | Checkr calls this automatically |
| POST | `/api/background-check/webhook/stripe-identity` | Stripe | Stripe calls this automatically |
| GET | `/api/background-check/admin/queue` | Admin | See all pending checks |
| POST | `/api/background-check/admin/:id/approve` | Admin | Manually approve |
| POST | `/api/background-check/admin/:id/reject` | Admin | Reject + suspend cleaner |

### Profiles & Cleaners
| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/profile/cleaner/:id` | Any | Public cleaner profile |
| PUT | `/api/profile/cleaner` | Cleaner | Update own profile + services |
| GET | `/api/profile/cleaners` | Any | Browse/search cleaners |
| PUT | `/api/profile/client` | Client | Update client profile |

### Messages
| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/messages/conversations` | Any | List all conversations |
| GET | `/api/messages/:userId` | Any | Get messages with a user |
| POST | `/api/messages` | Any | Send a message |

### Reviews
| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/reviews` | Either | Submit a review (after job completes) |
| GET | `/api/reviews/:userId` | Any | Get reviews for a user |

### Earnings & Payouts
| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/earnings` | Cleaner | Earnings summary + history |
| POST | `/api/earnings/cashout` | Cleaner | Request payout to bank |

### Notifications
| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/notifications` | Any | Get user's notifications |
| POST | `/api/notifications/:id/read` | Any | Mark notification read |

### Pro Membership
| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/pro/subscribe` | Cleaner | Subscribe to Pro ($18/mo or $180/yr) |
| DELETE | `/api/pro/cancel` | Cleaner | Cancel Pro subscription |

### Admin (admin role only)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/dashboard` | Platform stats |
| GET | `/api/admin/users` | List all users with filters |
| POST | `/api/admin/users/:id/ban` | Ban a user |
| POST | `/api/admin/users/:id/reinstate` | Reinstate a banned user |
| POST | `/api/admin/users/:id/flag` | Flag for review |
| GET | `/api/admin/disputes` | All disputes |
| POST | `/api/admin/disputes/:id/resolve` | Resolve a dispute |
| POST | `/api/admin/notify` | Send push notifications to users |
| GET | `/api/admin/revenue` | Full revenue breakdown |

---

## How the background check money flows

```
Cleaner pays $25 in app
    ↓
Stripe charges their card
    ↓
Your backend sends $18 to Checkr (via Checkr API)
    ↓
Checkr sends candidate an email to collect SSN/DOB
    ↓
Checkr runs the check (24–72 hrs)
    ↓
Checkr calls your webhook at /api/background-check/webhook/checkr
    ↓
Your backend reads the result:
  - CLEAR → flips is_verified=true, badge appears on profile, notifies cleaner
  - CONSIDER → flags for your manual admin review
    ↓
Stripe Identity (simultaneously):
  - Sends cleaner a link to take selfie + photo of ID
  - Calls your webhook when done
  - Your backend stores id_status = 'clear'

You keep: $25 - $18 (Checkr) - $1.50 (Stripe Identity) = ~$5.50 profit per check
```

---

## What to do next (in order)

1. **Create Stripe + Checkr accounts** and get your API keys
2. **Push to GitHub** and deploy to Railway
3. **Test everything** with Stripe test cards (card `4242 4242 4242 4242`)
4. **Connect your frontend** HTML file to the real API
5. **Onboard beta users** — start with 5–10 cleaners in your city
6. **Swap SQLite → PostgreSQL** once you have real users
7. **Add push notifications** (Firebase Cloud Messaging) for mobile alerts

---

## Cost to run this backend per month
- Railway hobby plan: **~$5/month**
- Checkr per background check: **~$18** (you charge $25, keep $5.50)
- Stripe fees: **2.9% + 30¢** per transaction (already accounted for in your 5% fee)
- Total fixed cost to run: **~$5/month** until you hit serious scale
