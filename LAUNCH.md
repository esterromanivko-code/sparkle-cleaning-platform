# Sparkle launch checklist

Everything still standing between today and a public launch of the website *and* the
two phone apps. **[you]** needs your accounts, money or signature; **[me]** is code I
can do. Updated as things land.

---

## 1. Before real customers use the website

### Payments — the one that blocks everything

- [ ] **[you] Put Stripe in test mode while we finish testing.** Railway → Sparkle backend →
      Variables: `STRIPE_SECRET_KEY` = `sk_test_…` and `STRIPE_PUBLISHABLE_KEY` = `pk_test_…`.
      *Right now the server is in **live** mode with no publishable key, so nobody can add a
      card at all, and anything that did go through would charge a real card.*
- [ ] **[you] Enable Stripe Connect** (Stripe → Connect → Get started → platform/marketplace,
      Express accounts). Without it cleaners can't set up payouts.
- [ ] **[you] Add the webhook** (optional but recommended): Stripe → Developers → Webhooks →
      `https://noble-flow-sparkle.up.railway.app/api/payments/webhook`, then put its signing
      secret in `STRIPE_WEBHOOK_SECRET`. A second endpoint for "connected accounts" events
      (`account.updated`) goes in `STRIPE_CONNECT_WEBHOOK_SECRET`.
- [ ] **[both] One full test run with Stripe's test card** `4242 4242 4242 4242`: post a job,
      quote it from a cleaner account, book it, watch the hold appear, complete with photos,
      see the charge, cash out to a test payout account.
- [ ] **[you] Switch both keys to live** only after that test passes.

### Email

- [ ] **[you] Confirm email sending works** on Railway (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
      `SMTP_PASS`, `EMAIL_FROM`). Password resets and email verification depend on it —
      test by using "Forgot password" on your own account.

### Safety of the data

- [ ] **[you] Make the GitHub repository private** (Settings → General → Danger Zone →
      Change visibility), then check Railway and Netlify still deploy.
- [ ] **[you] Turn on Dependabot alerts and secret scanning** (repo Settings → Security).
- [ ] **[me] Off-site database backups.** Backups currently sit on the same Railway disk as
      the database, so one failure loses both.

### Content and links

- [ ] **[me] Fix the dead links** on the landing page: About Us, Careers, Press, and the
      social icons all go nowhere.
- [ ] **[you] Decide what happens to "coming soon" features** — background checks, Sparkle
      Pro and the supply store are visible but switched off. Fine to launch that way; just
      know clients and cleaners will see them.

---

## 2. Before submitting the phone apps

### Accounts (start these first — they have waiting time)

- [ ] **[you] D-U-N-S number** for your business (free, can take 1–2 weeks). Both stores need
      it to publish under a company name.
- [ ] **[you] Apple Developer Program**, $99/year, enrolled as the business.
- [ ] **[you] Google Play Console**, $25 once, registered as an organisation — personal
      accounts have to run a 14-day closed test with 12 people before they can publish.

### Technical setup

- [ ] **[you] Firebase project** + `google-services.json` and `GoogleService-Info.plist`, plus
      an APNs key uploaded to Firebase. Then put the service-account JSON into Railway as
      `FIREBASE_SERVICE_ACCOUNT_JSON`. (See the app project's README.)
- [ ] **[you] Add `localhost` to the Turnstile widget's hostname list** in Cloudflare, or
      signing in from the apps fails its security check.
- [ ] **[you] Codemagic account** connected to the app repository; upload the signing
      certificates and keystore.
- [ ] **[me] Android permissions and iPhone permission wording** applied to the native
      projects (drafted in the app README).
- [ ] **[both] Test on a real phone**: sign in, book, "On my way" with the screen locked,
      photos, complete, cash out, push notifications.

### Store listings

- [ ] **[you] Screenshots** (phone and tablet), description, support URL, and the privacy
      policy URL `https://sparklecleaningplatform.netlify.app/privacy`.
- [ ] **[you] Apple App Privacy** and **Google Data safety** forms: declare location, photos,
      name/email/phone and payment information, matching the privacy policy.
- [ ] **[you] Reviewer accounts**: one real client and one approved cleaner, with their
      sign-ins in the review notes, plus a line explaining that location sharing only starts
      when a cleaner taps "On my way" on a booked job.
- [ ] **[you] Sparkle Pro decision.** Cleaning itself is a physical service, so Stripe is
      fine for bookings — but a Pro subscription sold *inside* the app normally has to use
      Apple's and Google's own billing (15–30%). Simplest: sell Pro on the website only.
- [ ] **[both] TestFlight and Google closed testing** before going public.

---

## 3. Business and legal

- [ ] **[you] Your real company name** replaces "Sparkle Technologies, Inc." in the Terms,
      Privacy Policy and landing footer.
- [ ] **[you] A lawyer reviews the Terms and Privacy Policy.** They're solid drafts, not
      legal advice — especially the independent-contractor wording, the lockout fee, and the
      dispute and refund rules.
- [ ] **[you] Liability insurance** for the platform.
- [ ] **[you] Washington business licence** and your tax setup (Stripe handles cleaners' 1099s).
- [ ] **[you] Checkr account** for background checks, if you want them at launch — there are
      legal obligations (FCRA disclosures and consent) that come with running them.

---

## 4. Recommended before launch, not blocking

- [ ] **[me] A security review pass** over payments, sign-in and uploads once card payments
      have run end to end.
- [ ] **[you] Free scans**: paste your two URLs into securityheaders.com and
      ssllabs.com/ssltest; run Lighthouse in Chrome for accessibility.
- [ ] **[you] Stripe's PCI questionnaire** (it appears in the dashboard). With Stripe's card
      form, card numbers never touch your server, so it's the short version.
- [ ] **[you] Keep a little money in your Stripe balance** if you want instant cashouts to
      work on the same day a job finishes — card payments take about two business days to
      settle, and an instant payout can outrun them.

---

## Already done

- Clients can see quotes and book; cards are collected through Stripe's own form.
- Holds before the clean, charge on completion, declined-card recovery, refunds.
- Cleaner payouts through Stripe Connect Express, with cashouts blocked until it's ready.
- Before/after photos required to get paid; 72-hour problem reports; lockout fees.
- Location tracking (on the way, arrived, time on site) with privacy limits and 180-day deletion.
- Self-service account deletion; Privacy, Terms and Accessibility pages.
- Sign-in fixes: the Cloudflare check now appears when it needs a tap, and a rejected
  sign-in says why instead of "session expired".
- All backend package vulnerabilities fixed (`npm audit`: none).
- Phone-app groundwork: push notifications, device registration, background location bridge.
