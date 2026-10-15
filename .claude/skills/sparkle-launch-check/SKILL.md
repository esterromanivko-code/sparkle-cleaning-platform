---
name: sparkle-launch-check
description: Sparkle's pre-ship checks and release rules. Use before committing, pushing or deploying ANY change to the Sparkle website, backend or phone app, and whenever asked to review, audit, check or "launch" Sparkle — especially changes to API routes or responses, public pages or their wording, payments, dependencies, or what Netlify publishes. Also use when a build or CI run has failed.
---

# Sparkle launch check

Sparkle is a live marketplace that handles money, home addresses and photos taken inside people's homes. Most of the serious bugs found in review were not exotic: an admin endpoint that answered anyone, a profile that returned a whole database row, a site build that published the backend's source, statistics that were made up. Each one is now caught by an automatic check. **Run them. Don't rely on remembering.**

## Before you say "done"

Do these in order. "It works on my machine" is not done; **live and green is done.**

1. **Run the checks** (from the repository root, `C:\Users\ester\Downloads\cleannest_extracted`):
   - `node scripts/launch-check.js` — site, links, claims, metadata, publishing, secrets, routes, leaks. Seconds. Add `--full` for the dependency audit.
   - `cd sparkle-backend/sparkle-backend && npm test` — all eight backend suites, about 20 s.
   - If you changed `scripts/launch-check.js`, also `node scripts/launch-check-selftest.js` (it breaks the site on purpose and must be told).
2. **Try it as a user** for anything visible. `.claude/launch.json` has `sparkle-backend-localtest` (a disposable backend with seeded accounts, from `npm run dev:local`; password for `client@test.local`, `cleaner@test.local`, `admin@test.local` is `LocalTest!2345`) and `sparkle-landing` (port 4200). Walk the flow as **each role**, including the failure paths (wrong password, declined card), not just the happy one.
3. **Push** `git push origin master` and `git push origin master:main` (both; Railway deploys `master`, Netlify deploys `main`). The `.githooks/pre-push` hook re-runs the fast checks; if it blocks you, fix the cause, never `--no-verify`.
4. **Wait for CI.** `gh run list --limit 3` / `gh run watch <id>` on the website repo (workflow *Checks*) and on `esterromanivko-code/sparkle-mobile` (*Android debug APK*). A red run you caused is the first thing to fix, before anything else. Do not report success over a red build.
5. **Verify live**, because passing tests are not the same as a correct deploy:
   - `curl -s -o /dev/null -w '%{http_code}' https://noble-flow-sparkle.up.railway.app/api/admin/backups` → **401**
   - `.../api/profile/cleaner/x` and `.../api/reviews/x` signed out → **401**
   - `https://sparklecleaningplatform.netlify.app/sparkle-backend/sparkle-backend/server.js` and `/LAUNCH.md` → **404**; `/`, `/app`, `/blog`, `/privacy`, `/terms`, `/og-image.png` → **200**
   - `.../api/config` → `payments_mode` is what you expect (see Money below)
6. **Keep the phone app in step.** `C:\Users\ester\Projects\sparkle-mobile` holds a *copy* of the website in `www/`. If `sparkle_full.html`, `sparkle_api.js` or a legal page changed, run `npm run sync:web` there, commit, push, and wait for the *Android debug APK* run. An app that wasn't re-synced shows the old screens against a server that has moved on (this already happened once: the bundle still read street addresses the server had stopped sending).

## Mistakes that actually happened, and what stops them now

| What went wrong | The rule | Caught by |
| --- | --- | --- |
| Admin backup endpoints answered anyone: they compared a header to `ADMIN_KEY`, and when that variable was unset `undefined !== undefined` is false | Authorize with `requireAuth` + `requireRole`, never by comparing to an optional environment variable | `tests/route-guard.js`, `tests/leak-crawl.js` (signed-out), `launch-check` *routes* |
| A public cleaner profile spread the whole database row into the response, exposing the Stripe account id and bank label | Never `res.json({ ...row })` or return `SELECT *`. List the fields. Server-only columns live in `lib/privateFields.js` | `tests/leak-crawl.js` (plants canary values), `launch-check` *leaks*, `tests/marketplace.js` |
| Every cleaner could see every open job's street address, map position and door-code notes | Privacy depends on stage: before booking show the **area** only; address, notes and coordinates go to the booked cleaner and nobody else | `tests/leak-crawl.js`, `tests/marketplace.js` |
| Netlify published the whole repo, so the backend source was downloadable | Publish an **allow-list** (`PUBLIC_FILES` in `scripts/build-site.js`), never a folder. A new page must be added to that list or it 404s | `launch-check` *publish* and *links*, `launch-check-selftest.js` |
| The `/*.md` "hide it" redirect never worked | Netlify ignores a redirect when a real file exists, unless `force = true`. Never rely on a redirect to hide anything | the allow-list above |
| Landing page showed invented numbers ("2,400+ jobs", "4.9★", "98%"), fake testimonials, and promises that were not true (background checks, insurance, a satisfaction guarantee) | Public pages say only what is **true today**. Sample content must be labelled and carry the `example-data` marker. Re-read `terms.html` and `privacy.html` when changing claims: they must agree | `launch-check` *claims* |
| Canonical, social-preview and sitemap URLs pointed at `sparkle.app`, which Sparkle doesn't own; the share image didn't exist | One site address, `DEFAULT_SITE` in `scripts/build-site.js` (override with `SITE_URL`) | `launch-check` *metadata* |
| Footer links went nowhere | No `href="#"` without a handler | `launch-check` *links* |
| The job form collected bedrooms, pets, notes and the time window and sent none of it; jobs never expired though the screen promised 48 hours; a "suspicious request" filter rejected ordinary sentences | Every promise on a screen needs code behind it. Test the **whole flow** in a browser as each role. Don't pattern-match on SQL words | `tests/marketplace.js` |
| A Gradle line (`versionCode (expr).toInteger()`) broke the Android build; it was pushed and the red build went unnoticed | After every push, wait for CI | step 4 above |
| Stripe was left in **live** mode with no publishable key while still being tested | Use test keys (`sk_test_`/`pk_test_`) until a full test booking works. Never switch to live on your own | `GET /api/config` shows `payments_mode` |
| Every 401 was shown as "Session expired", including a wrong password; the CAPTCHA was rendered invisibly | Test sign-in failures, not just success | manual flow in step 2 |
| Helper scripts kept in a temp folder were deleted by the system | Keep tooling in the repository (`scripts/`) | this list |

## Rules to apply while writing code

- **Every API route needs `requireAuth`** unless it is deliberately public, in which case it goes in `sparkle-backend/sparkle-backend/tests/public-routes.json` with a written reason. Adding a route to that file to make a test pass is the wrong move: add auth.
- **Responses are allow-lists.** When you add a column that must stay private, add it to `lib/privateFields.js` and to `FORBIDDEN_KEYS` in `tests/leak-crawl.js`. When you add an endpoint that returns another person's data, plant a canary for it in `plant()` in that test.
- **One person's data never reaches an unrelated person**: addresses, phone, email, notes, coordinates, card and Stripe ids, bank labels, messages, tickets. A stranger sees a first name and last initial.
- **Money**: test mode first; every Stripe call that moves money carries an idempotency key; amounts come from the server, never the browser; card numbers never touch our servers.
- **Secrets**: never ask the user to paste a key into chat; they set them in Railway or Netlify. Never commit one. Never use any password that appeared in chat.
- **Isolation**: do not read or touch `C:\Users\ester\Downloads\sln-enterprise-site` or her other projects.
- **Dependencies**: `npm audit` must be clean. Dependabot opens PRs, but **don't merge them on GitHub**: that puts commits on `main` that `master` doesn't have, and then `git push origin master:main` is rejected. Apply the update on `master` locally, run the checks, and push both. A green PR is not proof for the payments library: the tests use a Stripe stand-in, so a `stripe` major version needs a real test-mode booking first. Skip majors that bring nothing (`bullmq`/`ioredis` while there is no Redis). A workflow that claims something ("runs on every pull request") must really do it; check the `on:` block.
- **Commits** end with the `Co-Authored-By` line from the session's attribution instruction.

## When asked to "review everything"

1. Run all of step 1 and read every failure. 2. Run `node scripts/launch-check.js --full --online`. 3. Read the code, not just the output: the guards find known shapes of mistake. Look for new ones, especially in whatever changed most recently. 4. Walk every page as client, cleaner and admin in the browser and read the console. 5. Verify live (step 5). 6. Report honestly: what was found, what was fixed, what is still open and who has to do it.

## What only the user can do (you cannot verify these from here)

Railway variables (`STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON`, the `SMTP_*` set, `TURNSTILE_*`, `FRONTEND_URL`); Stripe Connect being enabled; Cloudflare Turnstile hostnames (must include `localhost` for the apps); Apple and Google developer accounts; real business, legal and insurance matters. Say clearly when something in this list is the blocker.
