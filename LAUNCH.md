# Sparkle launch checklist

**Plan: the website opens first, to sign up cleaners. Clients and the phone apps follow once cleaners are in.**
Checked against the code on 2026-10-20 by a nine-area review (each finding re-checked by a second reviewer). **[you]** needs your accounts, money or a decision; **[me]** is work Claude does.

## What to do this week, in order

1. Fix the Railway subscription, but first open Railway and confirm the Volume, DB_PATH, UPLOAD_DIR, BACKUP_DIR and NODE_ENV=production, then redeploy.
2. Choose your contact email, company name and mailing address (or the temporary versions).
3. Have me remove the invented earnings figures, the 'zero cut' wording and the fake phone number from the landing page and sign-up.
4. Create your admin account with the one-time token, then delete the token and use a strong password.
5. Connect email in Railway (SMTP, EMAIL_FROM, FRONTEND_URL, DNS records) and test Forgot password.
6. ~~Add the live site to the Turnstile hostname list~~ (done). Still to do: one real cleaner sign-up on the live site to prove the bot check passes.
7. Make the website repo private and set an uptime monitor on /health.
8. Decide what clients see for now (waitlist recommended) and send Terms and Privacy to a lawyer.

## Decisions only you can make

- **What should clients see while there are no cleaners yet?**
  - Options: A) Leave client sign-up open (only if the wording fixes are done). B) Replace 'Book a Cleaning' buttons with a client waitlist. C) Hide client sign-up and make the server refuse client registration.
  - Recommended: B for the cleaner-first launch: a waitlist avoids clients posting jobs that expire after 48 hours and avoids clients hitting 'card payments aren't set up'. Switch to A once Stripe test booking passes and a few cleaners are active.
- **How will you vet cleaners before real clients book them?**
  - Options: A) No approval; rely on optional licence/insurance badges and say so honestly. B) You approve each cleaner after a quick look before they can bid. C) Switch on Checkr background checks (needs consent screens and a lawyer review). D) Manual ID review (needs new work).
  - Recommended: A is fine while only cleaners are on the site. Before clients book, use B at minimum, and decide on C with your lawyer.
- **What is the real company name and contact address?**
  - Options: Use the real legal entity name, a monitored email on a domain you own, and a mailing address (a registered-agent address is fine), or hold off and use plain 'Sparkle' plus a Gmail until the company is formed.
  - Recommended: Decide before announcing: use one name everywhere. If the company is not formed yet, remove 'Technologies, Inc.' and use a temporary monitored address, then update after the lawyer review.
- **How should Sparkle Pro be handled in the phone apps?**
  - Options: A) Hide Pro in app builds and sell it on the website only. B) Build Apple/Google in-app purchase. C) Drop Pro for now.
  - Recommended: A, and leave Pro off entirely at website launch.
- **Where should backups go and how will payouts be funded?**
  - Options: Use Railway Volume backups or add nightly cloud copies; keep some own money in Stripe balance or reword the 1-3 day payout promise.
  - Recommended: Get a second backup location before cleaners upload IDs; test payout timing in the Stripe test booking and then decide.
- **Should cleaners get a late-cancellation payment or a short hold on first payouts?**
  - Options: A) Neither at launch. B) Hold a new cleaner's first few cash-outs for 72 hours. C) Add a late-cancel fee.
  - Recommended: A for the cleaner launch; revisit B and C after the first real bookings.

---

## 1. Before the website opens to cleaners

### You
- [ ] **Fix the Railway subscription and redeploy (must).** The live server is running code from before mid-October, so the newest fixes (admin Setup check, honest password-reset message, storage safety check) are not live. Do item 2 below first, then redeploy and check that https://noble-flow-sparkle.up.railway.app/api/config now includes `email_enabled`.
- [ ] **Confirm the permanent disk (Railway Volume) is attached (must).** Accounts, uploaded licences and backups live in files on the server, and ordinary Railway storage is wiped on every deploy. Check in Railway that a Volume exists, that `DB_PATH`, `UPLOAD_DIR` and `BACKUP_DIR` point at it (see .env.example) and that `NODE_ENV=production` is set. The new code refuses to start without this, so skipping it could take the site down right after you redeploy. After redeploying, make a throwaway cleaner and redeploy once more to prove the account survives.
- [ ] **Create your real admin account (must).** Without it you cannot see support messages, documents, disputes or help locked-out people. Set a secret `ADMIN_BOOTSTRAP_TOKEN` in Railway, have me send the one request that makes the account, then delete the token from Railway. Use a long, unique password in a password manager, and consider a second admin so one lost password does not lock you out. This only works after the redeploy.
- [ ] **Choose a real contact email on a domain you own (must).** The landing page and every email use hello@sparkle.com, which you probably do not own, so cleaners' messages could reach a stranger or never arrive. Pick an address you read, then I set it on the site and as `EMAIL_FROM`.
- [ ] **Connect email in Railway.** Add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` and `FRONTEND_URL` from a proper email-sending service (not a personal Gmail). Add the DNS records the service gives you (SPF/DKIM) so mail does not land in spam. Until then nobody can reset a password by email. Test "Forgot password" on your own account.
- [x] **Allow the live website in Cloudflare Turnstile (done: Ester added the site to the hostname list).** Sign-up needs the bot check, so the live site's address must be on the Turnstile hostname list (the list currently has "localhost" on your list). Afterwards do one real cleaner sign-up on the live site before announcing.
- [ ] **Make the website GitHub repo private.** It is public today, exposing your source code and security notes.
- [ ] **Pick a second place for backups and prove one opens.** Backups sit on the same disk as the database, so losing the disk loses both, and uploaded documents are not backed up at all. Use Railway's Volume backups if your plan has them (or ask me for a cloud copy), then download one backup and check it opens.
- [ ] **Set up a free uptime monitor on `/health`.** The server stops retrying after 3 crashes and nothing tells you it is down. Have it email or text you.
- [ ] **Check the Google Maps key is locked down.** In Google Cloud, restrict it to your website address and to Maps/Places only, with a spending alert.
- [ ] **Keep real cleaners away from payout setup for now.** Stripe is in live mode with no card-form key, and test and live Stripe IDs do not mix. Test with your own throwaway accounts, and switch payout setup on only after the Stripe test steps in section 2.
- [ ] **Decision: real company name and mailing address.** Terms, Privacy and the landing footer need one real legal name (the footer says "Sparkle Technologies, Inc." which may not exist) plus a monitored email and postal address. This also blocks the store accounts later.
- [ ] **Decision: what clients see while there are no cleaners.** See the decisions list below. I can then make the matching change.
- [ ] **Lawyer review of Terms and Privacy, liability insurance, Washington business licence.** The documents match the code on fees, but they are self-written. Change the effective date on both pages after edits.
- [ ] **Plan to check Admin > Support and Documents daily.** For now nothing emails you, so you only see new tickets and uploaded licences by signing in (until I add alerts).

### Me (code and settings I'll do)
- [ ] **Remove the invented numbers from the landing page (must).** "$2,800 average monthly earnings", "48 hrs to first booking" and "fastest-growing marketplace" are made up, and fake earnings claims aimed at recruits are a legal risk. Replace them with true points (no monthly fee, you set your rate, 10% only when you win), and soften "Seattle's premier".
- [ ] **Fix the "zero cut" wording at sign-up and on the landing page (must).** The code takes a 10% success fee on each chosen quote, so cleaners would feel misled at their first payout. State the 10% plainly.
- [ ] **Replace the fake phone number and contact details (must).** Remove (206) 555-0190, the phone hours and the placeholder text, use your real email once chosen, and keep one reply-time promise you can actually meet.
- [ ] **Add a required Terms tick-box with an 18+ statement and save the date.** Today sign-up has only small print and no record that anyone agreed.
- [ ] **Stop sign-up throwing away the rate and services.** Every new cleaner is saved at $25/hr with no services until they redo it in My profile.
- [ ] **Give a friendly message for a mistyped phone number.** It currently shows a vague "Invalid value" on the last step.
- [ ] **Remove or reword the background-check banner and "Verified first" wording.** Cleaners are told to complete a check that cannot be started, and nobody can earn the Verified badge yet.
- [ ] **Reword the "New job alerts" toggle.** The server never sends job alerts, so tell cleaners to check the job board.
- [ ] **Hide unfinished "Earn more" pages.** Supply store and Pro say "coming soon"; also drop the insurance page's unverified referral-fee claim and prices.
- [ ] **Hide the payout-setup button (or say "payouts open soon").** It cannot work until Stripe test mode and Connect are done.
- [ ] **Tell new cleaners what to do when there are no jobs.** Empty screens give no next step, and the greeting says "Good morning" at any hour.
- [ ] **Replace developer messages with plain ones.** When the server is unreachable, cleaners can see text about running a server on port 3001.
- [ ] **Fix "Instant or weekly cashout".** Cleaners cash out on request; say so, and mention the $10 instant fee.
- [ ] **Email you about new sign-ups, uploaded documents and support tickets.** Today these are in-app only. Also add the missing counts for waiting documents and open tickets to the admin dashboard.
- [ ] **Add a Reply-To address to emails and make "View ticket" less dead-end.** Replies currently go to the sender mailbox, not the ticket.
- [ ] **Tidy the settings example file.** `.env.example` has Pro price names the code does not read and omits several it does; I'll also add the Volume and admin-token steps to LAUNCH.md and the Setup check.
- [ ] **Make crashes less likely to take the site down.** Add crash handlers, raise the restart limit, and make `/health` check the database.
- [ ] **Write and test a database restore guide.**
- [ ] **Add a branded 404 page.**
- [ ] **Email suspended users the reason.** They only see "Account suspended."
- [ ] **Apply your client decision.** Waitlist or hiding client buttons, or the client-wording fixes below if clients stay open.

## 2. Before clients book and pay on the website

### You
- [ ] **Put Stripe test keys in Railway and do one full test booking (must).** The live server is in live mode with no card-form key, so nobody can add a card, and the payment code has never run against Stripe's test mode. Test a clean booked more than 5 days out, a declined card, a 3-D Secure card, then complete with photos and cash out.
- [ ] **Turn on Stripe Connect and fill in its platform questions.** Cleaners cannot finish payout setup without it. Webhooks are optional.
- [ ] **Switch to live keys only when ready, with a clean reset.** Test-mode IDs saved on accounts do not exist in live mode, so avoid real cleaners touching payouts while on test keys.
- [ ] **Decision: how cleaners are vetted before clients book.** Today anyone who signs up can bid and be hired. See decisions.
- [ ] **Decision: background checks.** Required before clients let strangers into their homes.
- [ ] **Check Washington sales tax with an accountant.** The code collects none, and I could not confirm whether cleaning is taxable or whether a marketplace must collect.
- [ ] **Confirm in Stripe that cleaners' 1099s are handled.** The payout screen promises "Stripe handles your tax forms", and I could not verify that.
- [ ] **Check Stripe's real costs.** Sparkle pays Connect fees, refunds and chargebacks, and the 8%/10% margin notes count only the card fee.
- [ ] **Keep some of your own money in the Stripe balance (or accept delays).** Cleaners may cash out before the client's card payment has settled, which gives a "try again in a day or two" error. Confirm in the test booking.

### Me
- [ ] **Stop saying cleaners are being notified (must).** After posting, the site says nearby cleaners are notified within minutes and bids arrive in 2-4 hours, but nothing is sent. Reword now, or build the alert (which also gives cleaners a reason to come back).
- [ ] **Remove the "save 10%" recurring discount wording (must).** No discount exists in the pricing, so a client choosing weekly pays full price. Remove it or build it.
- [ ] **Email clients about quotes and expired jobs.** Web clients only see in-app notices while the page is open, so they can miss a quote within the 48-hour window. Needs the email setup from section 1.
- [ ] **Say plainly that a job closes after 48 hours with no quotes.** Add it to the post-job and bookings screens, plus an expiry email.
- [ ] **Limit jobs to Seattle or show "Seattle only for now."** Nothing stops a job outside Seattle that no cleaner can serve.
- [ ] **Reword "Held in Escrow" and "fully satisfied".** Escrow is a legal term, and the Terms do not promise a refund on satisfaction.
- [ ] **Add the cleaner approval step you choose.** For example an "approved by Sparkle" flag required before bidding.
- [ ] **Email both people about disputes.** Reports and decisions are in-app only; someone not in the site may start a chargeback.
- [ ] **Add a "My quotes" page for cleaners.** Lost or expired quotes still read "Quote sent" and cannot be re-sent.
- [ ] **Offer partial refunds and consider a short hold on a new cleaner's first cash-outs.** Refunds are all-or-nothing, and money cashed out before a dispute is only recovered from the cleaner's next cash-out.
- [ ] **Add a per-account lock after repeated wrong passwords,** especially for the admin, and add a Content-Security-Policy to the website.
- [ ] **Fix stale wording.** "Find cleaners" says to post a job to get notified when one "accepts" (it should say "sends you a quote"); remove "optional add-ons" from the Terms and leftover $12/$7 add-on code.
- [ ] **Make the job board match its title.** It says "near you" but shows every open job; add a bio box to cleaner profiles.
- [ ] **Keep fee wording in step with the settings.** Percentages are typed by hand in screens and Terms but calculated from Railway settings.

## 3. Before the phone apps launch

### You
- [ ] **Apple Developer and Google Play accounts, with D-U-N-S number (must).** Organisation accounts take weeks and need your real company name and website.
- [ ] **Give store reviewers real accounts (must).** Register one client and one cleaner through normal sign-up (no demo accounts), approve the cleaner, and decide how a reviewer sees a booked job without a real charge (e.g. Stripe test mode).
- [ ] **Fill in Apple's privacy labels and Google's Data safety form (must).** They must agree with the corrected Privacy Policy.
- [ ] **Set up Codemagic, Firebase push and the Android upload key.** `GOOGLE_SERVICES_JSON` and the keystore secrets in GitHub, `FIREBASE_SERVICE_ACCOUNT_JSON` in Railway, the Apple push key in Firebase, and Codemagic's App Store link. Back up the Android key somewhere off the computer.
- [ ] **Prepare store listings.** Screenshots, descriptions, a support link, an adult age rating, and a public way to request account deletion for Google.
- [ ] **Decision: how Sparkle Pro is handled in the apps.** See decisions.

### Me
- [ ] **Correct the Privacy Policy location wording (must).** It says location is shared "while the app is open", but the apps keep sharing with the phone locked. Fix it in the same pass as the lawyer review.
- [ ] **Make iPhone push alerts work.** The iPhone project has no push permission file and no Firebase code, so alerts probably never arrive; this needs a TestFlight test.
- [ ] **Fix the Codemagic Android release or retire it.** It would produce an unsigned file with version number 1; use the GitHub release workflow only.
- [ ] **Make the iPhone build number go up each upload.** It is fixed at 1, so the second upload is refused.
- [ ] **Hide Pro and "coming soon" pages in the app builds,** and prepare the "not just a website" case with the native features.
- [ ] **Add a public account-deletion request link and explain Android location use.** Google may ask for a short declaration for the foreground location service.
- [ ] **Re-copy the website into the apps after Terms/Privacy edits.** The app holds its own copy.
- [ ] **Add small safety items.** Consider turning off Android automatic cloud backup.

## 4. Later
- [ ] **Switch off the Pro subscribe route on the server until Pro is built.** It can already create subscriptions without checking the first payment.
- [ ] **Fix the background-check code before switching it on.** It charges before contacting the provider, has no refund, and prices differ ($25/$30/$40).
- [ ] **Fix 2FA properly.** The half-finished 2FA pass is accepted as a full login, and the website has no 2FA screens; fix both together and do not enable 2FA before then.
- [ ] **Shorten stay-signed-in tokens** (a full year, comment says 30 days); check uploaded photos are real images; keep dependencies updated.
- [ ] **Move to a real domain.** Update the links, Turnstile, FRONTEND_URL and allowed origins together; replace the emoji tab icon.
- [ ] **Email polish.** Reply addresses, buttons that open the right page, retry for failed emails, merge the two sign-up emails, company name and address in the footer.
- [ ] **Late-cancellation fee,** a Redis add-on if you run more than one server, a written Railway setup note, deep links from emails into the app, and a cookie notice if analytics or ads are added.
- [ ] **Live tracking map.** Needs the Google Maps key on the server; phone push alerts come with the apps.

---

# Detailed steps (reference)

Exact steps for Stripe, email, Firebase and the accounts. The checklist above says *when*; this says *how*.

# Sparkle launch checklist

Where things stand, and what is still needed for the website and both phone apps to go live.
**[you]** needs your accounts, money or a decision. **[me]** is code I do.
Last updated 2026-10-15.

---

## The one thing to do first

- [ ] **[you] Put Stripe in test mode.** Railway → the Sparkle backend service → Variables:
      `STRIPE_SECRET_KEY` = your **test** secret key (`sk_test_…`) and
      `STRIPE_PUBLISHABLE_KEY` = your **test** publishable key (`pk_test_…`). Both from Stripe →
      Developers → API keys, with the "Test mode" switch on. Never paste them into chat.
      *Right now the server reports `payments_mode: "live"` with no publishable key: nobody can add a
      card, and anything that did go through would charge a real one.*
      Check: `https://noble-flow-sparkle.up.railway.app/api/config` should show `"payments_mode":"test"`
      and a `pk_test_…` key. Better still, sign in as admin → **Platform overview → Setup check**: it
      says in plain words whether Stripe accepted the key, whether test or live, and whether the
      publishable key matches (it never shows the keys themselves).
      *Railway only picks up changed variables when it redeploys.*

Then, still on Stripe:

- [ ] **[you] Turn on Connect** (Stripe → Connect → Get started: a marketplace, Express accounts), or
      cleaners can't set up payouts.
- [ ] **[you] Add the webhooks** (optional, makes updates arrive sooner; payments work without them).
      Stripe → Developers → Webhooks → Add endpoint, URL `https://noble-flow-sparkle.up.railway.app/api/payments/webhook`:
      1. *Events on your account* — `payment_intent.succeeded`, `payment_intent.amount_capturable_updated`,
         `payment_intent.processing`, `payment_intent.payment_failed`, `payment_intent.canceled`.
         Open it → **Signing secret → Reveal** (`whsec_…`) → Railway `STRIPE_WEBHOOK_SECRET`.
      2. A second endpoint, same URL, *Events on connected accounts* — `account.updated`.
         Its signing secret → Railway `STRIPE_CONNECT_WEBHOOK_SECRET`.
      The Setup check shows each one as Working once Stripe and Railway agree.
- [ ] **[both] One full test booking** with Stripe's test card `4242 4242 4242 4242`: post a job, quote it
      from a cleaner account, book it, complete it with photos, see the charge, set up a test payout
      account, cash out. **This is the last unproven part of the money flow.**
- [ ] **[you] Switch both keys to live** only after that works. After that, **[me]** can try the pending
      Stripe library upgrade (a major version, held back until it can be tested against real test mode).

## Other things only you can do

| | What | Why |
| --- | --- | --- |
| [ ] | **Set up email, then test it.** Railway variables `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, and `FRONTEND_URL` (the website address, so links in emails open the app). Then use **Forgot password?** on the sign-in page with your own account and open the link from the email. | The "Forgot password?" button exists, but until email is set up nobody can reset a password by themselves: the app says so and tells them to contact support, and you can help them from **Admin → User management → Reset password** (it makes a one-time link you send them yourself; only do it once you're sure who you're talking to). `https://noble-flow-sparkle.up.railway.app/api/config` shows `"email_enabled": true` once it is working. Welcome, verification, support-reply and document-approval emails use the same setup. |
| [ ] | **Make the website repository private** (GitHub → the repo → Settings → Danger Zone → Change visibility). | It is public today. (The backend source is no longer served by the website, but there's no reason to publish it.) |
| [ ] | **Railway → Settings → "Wait for CI".** | Stops a deploy when the checks fail. |
| [ ] | **Cloudflare → Turnstile → your widget → add the hostname `localhost`.** | The phone apps run from `localhost`; without it signing in from the app fails its security check. |
| [ ] | **Firebase project** (free). Android, today: create the project, add an Android app `com.sparklecleaning.app`, paste its `google-services.json` into a GitHub secret `GOOGLE_SERVICES_JSON` (phone-app repo), and the service-account key into Railway as `FIREBASE_SERVICE_ACCOUNT_JSON`. Step by step in the phone app's README (Firebase section). Then **Admin → Platform overview → Setup check → Send me a test notification**. iPhone later: `GoogleService-Info.plist` plus an APNs key (needs the Apple account). | Push notifications. Until then they simply don't buzz (they still appear inside the app). The Android GitHub builds had no way to include `google-services.json` before; they do now, and the Play Store build refuses to run without it. |
| [ ] | **D-U-N-S number** (free, 1–2 weeks). | Apple and Google both need it to list the app under a company name. Start now. |
| [ ] | **Apple Developer Program** ($99/yr) and **Google Play Console** ($25 once), both as your business. | Google: register as an organisation, or you must run a 14-day test with 12 people first. |
| [ ] | **Codemagic** (free tier, personal account) for the iPhone build. | Apple needs a Mac. |
| [ ] | **Create the Android upload key**, then four GitHub secrets (see `android-release.yml` in the app repo). I'll walk you through it. | Needed once your Play account is approved. |
| [ ] | **A real company name** for the Terms, Privacy Policy and landing footer (they say "Sparkle Technologies, Inc."). | Legal. |
| [ ] | **A lawyer reviews the Terms and Privacy Policy.** Liability insurance. Washington business licence. | Legal. These are solid drafts, not legal advice. |
| [ ] | **Decide on background checks.** If you want them at launch: a Checkr account (there are legal duties around consent and disclosures), then I turn it on and the marketing can say so. | The site currently says, accurately, that they aren't live. |
| [ ] | **Social accounts, a real domain, real testimonials** — when you have them. | Social icons and testimonials were removed because they were placeholders. A custom domain: set `SITE_URL` in Netlify and every link follows. |
| [ ] | **Store listings:** screenshots, description, the privacy policy URL `https://sparklecleaningplatform.netlify.app/privacy`, Apple's App Privacy and Google's Data safety forms, and a real client and an approved cleaner account for the reviewers. | Store requirements. |
| [ ] | **Decide on Sparkle Pro.** Subscriptions sold *inside* an app normally must use Apple's and Google's billing (15–30%). | Simplest: sell Pro on the website only. |

## Done and checked

**Money**: cards are collected through Stripe's own form, held before the clean and charged when the
cleaner completes it with photos; declined cards and bank approval are handled; cleaners are paid through
Stripe Connect Express; lockout fees come out of the hold.

**Safety and privacy**: every API route needs a sign-in unless deliberately public (15, each with a written
reason); no response carries another person's private data (a test plants canary values and calls every
endpoint as strangers); clients' street addresses and door codes are visible only to the cleaner they book,
cleaners quote from the general area; before and after photos are required to get paid; location is shared
only on "On my way" and deleted after 180 days; self-service account deletion.

**The public site**: only an approved list of files is published (the backend's source used to be
downloadable; it isn't); every statement is true today (invented statistics, fake testimonials and
promises about background checks, insurance and guarantees were replaced with what Sparkle really does);
share links, sitemap and search-engine files point at the real address; no dead links.

**Reliability**: jobs now expire on their own; the job form sends everything; sign-in errors say what went
wrong; the security check appears when Cloudflare needs a tap.

**Code**: no known vulnerable packages; automatic update proposals; all backend suites, a launch check and
its own self-test run on every push (GitHub *Checks*), and a hook runs the fast ones before anything is pushed.

**Phone apps**: Android and iPhone projects exist (private repo `sparkle-mobile`); GitHub builds an
installable Android app for free and a signed Play Store bundle once the upload key exists; push
notifications are built and wait for Firebase.

## Left alone on purpose

- Dependabot proposals for `stripe` 23, `bullmq` 6, `ioredis` 6 and Gradle 9 (major versions). Stripe waits
  for a test-mode booking; the others bring nothing today.
- No Content-Security-Policy header on the website: the pages use inline scripts, so a strict one would
  break them. A real one is a refactor, not a quick fix.
- Cleaners who accept a job and never show up: nothing escalates it automatically yet (the payment hold
  lapses on its own after about a week, and you'd hear from the client). Worth adding after launch.
