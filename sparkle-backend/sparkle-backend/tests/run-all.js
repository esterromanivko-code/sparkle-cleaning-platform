'use strict';
// tests/run-all.js — runs every backend test suite, one after another, and reports.
//
//   npm test          (or: node tests/run-all.js)
//
// Each suite starts its own server on its own port with a throwaway database, so they
// can't interfere. The first line of the summary tells you if anything failed; the
// output of a failing suite is printed in full.

const cp = require('child_process');
const path = require('path');

// Cheap, important guards first, so a basic mistake fails in seconds.
const SUITES = [
  ['route-guard',           'no API route is open by accident'],
  ['marketplace',           'job posting, open-job privacy, profiles, expiry, request filter'],
  ['leak-crawl',            'no endpoint returns private data to strangers'],
  ['payments',              'cards, holds, charges, payout accounts, webhooks'],
  ['job-photos',            'photos, disputes, cashouts, refunds'],
  ['tracking-and-account',  'location tracking, account deletion, retention'],
  ['mobile',                'phone apps: devices and push'],
  ['password-reset',        'forgotten passwords, email links, honest failure when mail cannot be sent'],
  ['run',                   'sign-in, profile, messages, reviews, billing'],
];

let failed = 0;
const started = Date.now();
for (const [name, what] of SUITES) {
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, ['--experimental-sqlite', path.join(__dirname, `${name}.js`)], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 26, timeout: 5 * 60 * 1000,
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) {
    console.log(`✓ ${name.padEnd(22)} ${seconds.padStart(5)}s  ${what}`);
  } else {
    failed++;
    console.log(`✗ ${name.padEnd(22)} ${seconds.padStart(5)}s  ${what}`);
    const noise = /ExperimentalWarning|trace-warnings|\[BACKUP\]|\[CREDENTIALS\]|injected env|\[AUDIT\]|Fees:|running on port|MOCK STRIPE/;
    const lines = ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => l.trim() && !noise.test(l));
    console.log(lines.slice(-30).map(l => '    ' + l).join('\n'));
  }
}
console.log(failed
  ? `\n${failed} of ${SUITES.length} suites FAILED.`
  : `\nAll ${SUITES.length} suites passed in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
process.exit(failed ? 1 : 0);
