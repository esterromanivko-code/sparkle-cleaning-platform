#!/usr/bin/env node
'use strict';
// scripts/launch-check.js — the checks that stand between a mistake and the public.
//
//   node scripts/launch-check.js            fast, offline: run before every push (a git hook does)
//   node scripts/launch-check.js --full     adds the dependency vulnerability audit (needs the network)
//   node scripts/launch-check.js --online   adds a real request to every external link
//
// Every check here exists because of a real mistake:
//   syntax    a page whose script has a typo is a dead page
//   links     links that go nowhere, and pages that load a file nobody publishes
//   claims    invented statistics, fake testimonials and promises that weren't true
//   metadata  share links and the sitemap pointing at a domain Sparkle doesn't own
//   publish   the website serving the backend's source code
//   secrets   keys committed by accident
//   routes    an API route left open to the world
//   leaks     whole database rows spread into a response
//   audit     dependencies with known vulnerabilities
//
// Exit code 1 if anything fails. To silence a finding you have reviewed, see the note
// beside that check — never by deleting the check.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const FULL = process.argv.includes('--full');
const ONLINE = process.argv.includes('--online');
const BACKEND = path.join(ROOT, 'sparkle-backend', 'sparkle-backend');

const problems = [];
const fail = (area, message) => problems.push({ area, message });
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const exists = file => fs.existsSync(path.join(ROOT, file));
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const PAGES = ['sparkle_landing.html', 'sparkle_full.html', 'sparkle_blog.html', 'privacy.html', 'terms.html', 'accessibility.html'];

// The public file list and the site address come from the build script, so there is one
// place to change each.
const buildSource = read('scripts/build-site.js');
const PUBLIC_FILES = [...(/const PUBLIC_FILES = \[([\s\S]*?)\];/.exec(buildSource)?.[1] || '').matchAll(/'([^']+)'/g)].map(m => m[1]);
const SITE = /const DEFAULT_SITE = '([^']+)'/.exec(buildSource)?.[1];
const SITE_HOST = SITE && new URL(SITE).host;

// ── syntax ──────────────────────────────────────────────────────────────────
function checkSyntax() {
  for (const page of PAGES) {
    const html = read(page);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc=/.test(m[1])) continue;
      const where = `${page}:${lineOf(html, m.index)}`;
      try {
        if (/ld\+json/i.test(m[1])) JSON.parse(m[2]);
        else new vm.Script(m[2], { filename: where });
      } catch (err) { fail('syntax', `${where} ${err.message}`); }
    }
  }
  const scripts = ['sparkle_api.js', ...fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js')).map(f => `scripts/${f}`)];
  for (const file of scripts) {
    try { new vm.Script(read(file).replace(/^#!.*\n/, ''), { filename: file }); }
    catch (err) { fail('syntax', `${file} ${err.message}`); }
  }
}

// ── links ───────────────────────────────────────────────────────────────────
function checkLinks() {
  const toml = read('netlify.toml');
  const redirects = new Set([...toml.matchAll(/from\s*=\s*"\/([^"*]*)"/g)].map(m => m[1]));
  const published = new Set(PUBLIC_FILES);
  const externals = new Map();

  for (const page of PAGES) {
    const html = read(page);
    const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
    for (const m of html.matchAll(/<(a|link|script|img|iframe)\b([^>]*)>/gi)) {
      const [, tag, attrs] = m;
      const ref = /\b(href|src)=(["'])(.*?)\2/is.exec(attrs);
      if (!ref) continue;
      const value = ref[3].trim();
      const where = `${page}:${lineOf(html, m.index)} <${tag}> ${ref[1]}="${value.slice(0, 60)}"`;

      if (tag === 'link' && /rel=["'](preconnect|dns-prefetch|preload)["']/i.test(attrs)) continue;
      if (!value || /^(data:|mailto:|tel:|blob:)/i.test(value) || value.includes('${') || value.includes("'+") || /^['"+]/.test(value)) continue;

      if (value === '#' || /^javascript:/i.test(value)) {
        // A "#" link that does something is a button; one that does nothing is a dead link.
        if (tag === 'a' && !/\b(onclick|data-act|role=["']button["'])/i.test(attrs)) fail('links', `${where} goes nowhere`);
        continue;
      }
      if (/^https?:\/\//i.test(value)) { (externals.get(value) || externals.set(value, []).get(value)).push(where); continue; }
      if (value.startsWith('#')) { if (!ids.has(value.slice(1))) fail('links', `${where} — no element has that id`); continue; }

      const [file, anchor] = value.replace(/^\//, '').split('#');
      const target = file.split('?')[0];
      if (!target) continue;
      if (redirects.has(target) || published.has(target)) {
        if (anchor && target.endsWith('.html') && exists(target) && !new RegExp(`\\bid=["']${anchor}["']`).test(read(target))) fail('links', `${where} — anchor #${anchor} is not in ${target}`);
        continue;
      }
      if (exists(target) && !published.has(target)) fail('links', `${where} — ${target} exists but is not on the public file list in scripts/build-site.js, so the live site would 404`);
      else if (!exists(target)) fail('links', `${where} — file not found`);
    }
  }
  return externals;
}

async function checkExternal(externals) {
  await Promise.all([...externals].map(async ([url, uses]) => {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0 launch-check' } });
      if (res.status >= 400) fail('links', `${res.status} ${url} (${uses[0]})`);
    } catch (err) { fail('links', `unreachable ${url} (${uses[0]}): ${err.cause?.code || err.message}`); }
  }));
}

// ── claims ──────────────────────────────────────────────────────────────────
// Public pages may only state what is true today. Findings here are real copy to change.
// A line that is clearly sample content (a mock-up) may carry the marker "example-data".
const CLAIMS = [
  [/\bevery cleaner (passes|goes through|went through|is)\b/i, 'promises about vetting every cleaner'],
  [/\ball cleaners (carry|are|have)\b/i, 'promises about every cleaner'],
  [/satisfaction[- ]guarantee/i, 'a guarantee Sparkle does not offer'],
  [/insured (&amp;|&|and) bonded/i, 'insurance and bonding Sparkle does not check'],
  [/background[- ]checked\b/i, 'background checks are not live'],
  [/most trusted|top[- ]rated platform|#1\b/i, 'a superlative that cannot be backed up'],
  [/\b\d{1,3}(,\d{3})+\+?\s+(jobs|bookings|cleans|customers|clients|cleaners|reviews|homes)\b/i, 'an activity number that is not from real data'],
  [/\b\d+\s+jobs completed\b/i, 'a job count that is not from real data'],
  [/\b9\d(\.\d)?\s?%\s*(satisfaction|of (clients|customers))/i, 'a satisfaction figure that is not from real data'],
  [/class="testi-card/i, 'a testimonial — only real, permitted ones may be shown'],
  [/sparkle\.app/i, 'sparkle.app, a domain Sparkle does not own'],
  [/dev_placeholder|YOUR-PROJECT|lorem ipsum|\bTODO\b|\bFIXME\b/i, 'unfinished placeholder text'],
];
function checkClaims() {
  for (const page of PAGES) {
    const lines = read(page).split('\n');
    lines.forEach((line, i) => {
      if (/example-data/.test(line)) return;
      for (const [re, why] of CLAIMS) if (re.test(line)) fail('claims', `${page}:${i + 1} ${why}: "${line.trim().replace(/\s+/g, ' ').slice(0, 90)}"`);
    });
  }
}

// ── metadata ────────────────────────────────────────────────────────────────
function checkMetadata() {
  const landing = read('sparkle_landing.html');
  const urls = [
    ...[...landing.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map(m => ['canonical', m[1]]),
    ...[...landing.matchAll(/<meta (?:property|name)="(?:og:url|og:image|twitter:image)" content="([^"]+)"/g)].map(m => ['social tag', m[1]]),
    ...[...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => ['sitemap', m[1]]),
    ...[...read('robots.txt').matchAll(/^Sitemap:\s*(\S+)/gim)].map(m => ['robots.txt', m[1]]),
  ];
  for (const [kind, url] of urls) {
    let host; try { host = new URL(url).host; } catch { host = null; }
    if (host !== SITE_HOST) fail('metadata', `${kind} points at ${url}, not at ${SITE}`);
  }
  if (!urls.some(([k]) => k === 'canonical')) fail('metadata', 'the landing page has no canonical link');

  if (!exists('og-image.png')) fail('metadata', 'og-image.png is missing, so shared links show no picture');
  else {
    const png = fs.readFileSync(path.join(ROOT, 'og-image.png'));
    const ok = png.slice(1, 4).toString() === 'PNG';
    if (!ok) fail('metadata', 'og-image.png is not a PNG');
    else if (png.readUInt32BE(16) !== 1200 || png.readUInt32BE(20) !== 630) fail('metadata', `og-image.png is ${png.readUInt32BE(16)}×${png.readUInt32BE(20)}, not 1200×630`);
  }
}

// ── publish ─────────────────────────────────────────────────────────────────
function checkPublish() {
  const toml = read('netlify.toml');
  if (!/publish\s*=\s*"dist"/.test(toml)) fail('publish', 'netlify.toml must publish "dist", never the whole repository — that serves the backend source');
  if (!/build-site\.js/.test(toml)) fail('publish', 'netlify.toml must build the site with scripts/build-site.js');
  for (const file of PUBLIC_FILES) {
    if (!exists(file)) fail('publish', `${file} is on the public list but does not exist`);
    if (/(^|\/)(\.env|sparkle-backend|tests?|scripts|\.github|\.claude|node_modules)(\/|$)|\.(md|zip|db|pem|key|keystore|jks|p12)$/i.test(file)) fail('publish', `${file} must never be published`);
  }
  try {
    cp.execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-site.js')], { stdio: 'pipe' });
    const built = fs.readdirSync(path.join(ROOT, 'dist')).sort();
    const expected = [...PUBLIC_FILES].sort();
    if (JSON.stringify(built) !== JSON.stringify(expected)) fail('publish', `dist/ holds ${built.join(', ')} but the list says ${expected.join(', ')}`);
  } catch (err) { fail('publish', `the site build fails: ${String(err.stderr || err.message).trim().split('\n')[0]}`); }
}

// ── secrets ─────────────────────────────────────────────────────────────────
function trackedFiles() {
  try { return cp.execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean); }
  catch { return []; }
}
function checkSecrets() {
  const SECRET = [
    /sk_live_[0-9A-Za-z]{10,}/, /rk_live_[0-9A-Za-z]{10,}/, /sk_test_[0-9A-Za-z]{24,}/, /whsec_[0-9A-Za-z]{20,}/,
    /AIza[0-9A-Za-z_-]{35}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bgh[pousr]_[0-9A-Za-z]{30,}/, /github_pat_[0-9A-Za-z_]{40,}/,
    /xox[abprs]-[0-9A-Za-z-]{10,}/, /\bSG\.[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
  ];
  const FORBIDDEN_FILE = /(^|\/)\.env(\.|$)(?!example)|\.(pem|p12|jks|keystore|db|sqlite)$|google-services\.json$|GoogleService-Info\.plist$|serviceAccount.*\.json$/i;
  for (const file of trackedFiles()) {
    if (FORBIDDEN_FILE.test(file) && !/\.env\.example$/.test(file)) { fail('secrets', `${file} must not be committed`); continue; }
    if (/package-lock\.json$|\.(png|jpg|jpeg|gif|ico|zip|woff2?)$/i.test(file)) continue;
    let text; try { text = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
    if (text.length > 2_000_000) continue;
    text.split('\n').forEach((line, i) => {
      if (/XXXX|placeholder|example|\.\.\.|your[_-]/i.test(line)) return;
      for (const re of SECRET) if (re.test(line)) fail('secrets', `${file}:${i + 1} looks like a real secret (${re.source.slice(0, 22)}…)`);
    });
  }
}

// ── routes ──────────────────────────────────────────────────────────────────
function checkRoutes() {
  if (!fs.existsSync(path.join(BACKEND, 'scripts', 'route-inventory.js'))) return;
  const { inventory } = require(path.join(BACKEND, 'scripts', 'route-inventory.js'));
  const allowed = JSON.parse(fs.readFileSync(path.join(BACKEND, 'tests', 'public-routes.json'), 'utf8'));
  for (const r of inventory()) {
    if (!r.auth && !(`${r.method} ${r.url}` in allowed)) {
      fail('routes', `${r.method} ${r.url} (${r.file}:${r.line}) is open to everyone and not in tests/public-routes.json — add requireAuth, or list it with a reason`);
    }
  }
}

// ── leaks ───────────────────────────────────────────────────────────────────
// `res.json({ ...profile })` copies every column of a database row into the response,
// including ones added later. List the fields instead. If the object really is safe to
// send whole, say why on the same line:  // leak-ok: <reason>
function checkRowSpreads() {
  const dir = path.join(BACKEND, 'routes');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    fs.readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, i) => {
      if (/res\.(status\(\d+\)\.)?json\(\s*\{[^}]*\.\.\.\w+/.test(line) && !/leak-ok/.test(line)) {
        fail('leaks', `routes/${file}:${i + 1} spreads a whole object into a response — list the fields, or add "// leak-ok: why": ${line.trim().slice(0, 80)}`);
      }
    });
  }
}

// ── audit ───────────────────────────────────────────────────────────────────
function checkAudit() {
  try {
    const out = cp.execSync('npm audit --omit=dev --json', { cwd: BACKEND, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
    report(JSON.parse(out));
  } catch (err) {
    // npm audit exits non-zero when it finds something; the JSON is still on stdout.
    try { report(JSON.parse(err.stdout)); } catch { fail('audit', 'npm audit could not run (is the network reachable?)'); }
  }
  function report(json) {
    const v = json.metadata?.vulnerabilities || {};
    if ((v.high || 0) + (v.critical || 0) > 0) fail('audit', `${v.critical || 0} critical and ${v.high || 0} high vulnerabilities in the backend's packages — run "npm audit" in sparkle-backend/sparkle-backend`);
    if ((v.moderate || 0) > 0) console.log(`  note: ${v.moderate} moderate vulnerabilities in the backend's packages (not blocking)`);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
(async () => {
  const steps = [['syntax', checkSyntax], ['links', checkLinks], ['claims', checkClaims], ['metadata', checkMetadata],
                 ['publish', checkPublish], ['secrets', checkSecrets], ['routes', checkRoutes], ['leaks', checkRowSpreads]];
  if (FULL) steps.push(['audit', checkAudit]);
  let externals = new Map();
  for (const [name, fn] of steps) {
    const before = problems.length;
    try { const r = fn(); if (name === 'links') externals = r; }
    catch (err) { fail(name, `the check itself crashed: ${err.message}`); }
    console.log(`${problems.length === before ? '✓' : '✗'} ${name}`);
  }
  if (ONLINE) { const b = problems.length; await checkExternal(externals); console.log(`${problems.length === b ? '✓' : '✗'} external links (${externals.size})`); }

  if (problems.length) {
    console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`);
    for (const { area, message } of problems) console.log(`  [${area}] ${message}`);
    console.log('\nLaunch check FAILED.');
    process.exit(1);
  }
  console.log('\nLaunch check passed.');
})();
