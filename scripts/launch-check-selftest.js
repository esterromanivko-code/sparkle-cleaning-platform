'use strict';
// scripts/launch-check-selftest.js — proves the launch check can actually fail.
//
// A safety check that never fails is worse than none, because it looks like protection.
// This breaks the site on purpose, one way at a time — the same ways it really broke —
// and confirms launch-check.js catches each. Every file is restored afterwards.
//
//   node scripts/launch-check-selftest.js

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHECK = path.join(__dirname, 'launch-check.js');

function runCheck() {
  const r = cp.spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const mutations = [
  {
    name: 'Netlify publishes the whole repository (leaked the backend source)',
    file: 'netlify.toml', change: s => s.replace('publish = "dist"', 'publish = "."'), expect: /\[publish\].*publish "dist"/,
  },
  {
    name: 'a private document is added to the public file list',
    file: 'scripts/build-site.js', change: s => s.replace("'og-image.png',", "'og-image.png',\n  'LAUNCH.md',"), expect: /\[publish\].*LAUNCH\.md.*never be published/,
  },
  {
    name: 'a footer link that goes nowhere',
    file: 'sparkle_landing.html', change: s => s.replace('</body>', '<a href="#">Careers</a></body>'), expect: /\[links\].*goes nowhere/,
  },
  {
    name: 'a link to a page that is not published',
    file: 'sparkle_landing.html', change: s => s.replace('</body>', '<a href="LAUNCH.md">notes</a></body>'), expect: /\[links\].*not on the public file list/,
  },
  {
    name: 'an invented statistic ("2,400+ customers")',
    file: 'sparkle_landing.html', change: s => s.replace('</body>', '<p>Join 2,400+ customers today</p></body>'), expect: /\[claims\].*activity number/,
  },
  {
    name: 'a promise that is not true ("Every cleaner passes a background check")',
    file: 'sparkle_landing.html', change: s => s.replace('</body>', '<p>Every cleaner passes a background check.</p></body>'), expect: /\[claims\]/,
  },
  {
    name: 'a fake testimonial card',
    file: 'sparkle_landing.html', change: s => s.replace('</body>', '<div class="testi-card">"Great!"</div></body>'), expect: /\[claims\].*testimonial/,
  },
  {
    name: 'the canonical link points at a domain Sparkle does not own',
    file: 'sparkle_landing.html', change: s => s.replace('rel="canonical" href="https://sparklecleaningplatform.netlify.app/"', 'rel="canonical" href="https://sparkle.app/"'), expect: /\[metadata\].*canonical/,
  },
  {
    name: 'a script with a typo',
    file: 'sparkle_landing.html', change: s => s.replace('</body>', '<script>function broken( {</script></body>'), expect: /\[syntax\]/,
  },
  {
    name: 'a route spreads a whole database row into its response',
    create: 'sparkle-backend/sparkle-backend/routes/zz_selftest.js',
    content: "router.get('/x', (req, res) => { const row = db.prepare('SELECT * FROM users').get(); res.json({ ...row, extra: 1 }); });\n",
    expect: /\[leaks\].*zz_selftest\.js/,
  },
];

let failures = 0;
const baseline = runCheck();
if (baseline.code !== 0) {
  console.error('The launch check does not pass on the untouched site, so the self-test cannot tell anything.\n' + baseline.out);
  process.exit(1);
}
console.log('baseline: launch check passes on the untouched site\n');

for (const m of mutations) {
  const target = path.join(ROOT, m.file || m.create);
  const original = m.file ? fs.readFileSync(target, 'utf8') : null;
  try {
    if (m.file) {
      const changed = m.change(original);
      if (changed === original) { console.log(`✗ ${m.name}\n    (the self-test could not apply this change; update it)`); failures++; continue; }
      fs.writeFileSync(target, changed);
    } else {
      fs.writeFileSync(target, m.content);
    }
    const { code, out } = runCheck();
    if (code === 1 && m.expect.test(out)) console.log(`✓ caught: ${m.name}`);
    else { console.log(`✗ NOT CAUGHT: ${m.name}\n${out.split('\n').slice(-8).join('\n')}`); failures++; }
  } finally {
    if (m.file) fs.writeFileSync(target, original); else fs.rmSync(target, { force: true });
  }
}

const after = runCheck();
if (after.code !== 0) { console.error('\nThe site is not back to passing after the self-test restored its files:\n' + after.out); failures++; }
console.log(failures ? `\nSelf-test FAILED (${failures}).` : `\nSelf-test passed: all ${mutations.length} deliberate mistakes were caught.`);
process.exit(failures ? 1 : 0);
