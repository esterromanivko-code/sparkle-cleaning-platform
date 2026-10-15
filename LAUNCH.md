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
      and a `pk_test_…` key.

Then, still on Stripe:

- [ ] **[you] Turn on Connect** (Stripe → Connect → Get started: a marketplace, Express accounts), or
      cleaners can't set up payouts.
- [ ] **[you] Add the webhook** (optional, makes updates arrive sooner): Stripe → Developers → Webhooks →
      `https://noble-flow-sparkle.up.railway.app/api/payments/webhook`, then its signing secret into
      `STRIPE_WEBHOOK_SECRET`. A second one for "connected accounts" (`account.updated`) goes in
      `STRIPE_CONNECT_WEBHOOK_SECRET`.
- [ ] **[both] One full test booking** with Stripe's test card `4242 4242 4242 4242`: post a job, quote it
      from a cleaner account, book it, complete it with photos, see the charge, set up a test payout
      account, cash out. **This is the last unproven part of the money flow.**
- [ ] **[you] Switch both keys to live** only after that works. After that, **[me]** can try the pending
      Stripe library upgrade (a major version, held back until it can be tested against real test mode).

## Other things only you can do

| | What | Why |
| --- | --- | --- |
| [ ] | **Check email works.** Railway variables `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`. Test with "Forgot password" on your own account. | Password resets and verification emails depend on it. |
| [ ] | **Make the website repository private** (GitHub → the repo → Settings → Danger Zone → Change visibility). | It is public today. (The backend source is no longer served by the website, but there's no reason to publish it.) |
| [ ] | **Railway → Settings → "Wait for CI".** | Stops a deploy when the checks fail. |
| [ ] | **Cloudflare → Turnstile → your widget → add the hostname `localhost`.** | The phone apps run from `localhost`; without it signing in from the app fails its security check. |
| [ ] | **Firebase project** → service-account JSON into Railway as `FIREBASE_SERVICE_ACCOUNT_JSON`; `google-services.json` and `GoogleService-Info.plist` for the apps; an APNs key uploaded to Firebase. | Push notifications. Until then they simply don't buzz. |
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
