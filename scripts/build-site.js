'use strict';
// scripts/build-site.js — assembles the website into dist/, which is the ONLY thing
// Netlify publishes (see netlify.toml).
//
// Why this exists: Netlify used to publish the whole repository folder. That put the
// backend's source code, its tests, the database schema and the internal planning
// documents on the public internet, where anyone could download them. (The rule that
// was meant to hide .md files never worked: Netlify ignores a redirect when a real
// file exists at that path, unless the rule is marked "force".)
//
// An allow-list can't leak by accident. A new private folder is simply not in the
// list. To publish a new page or asset, add it to PUBLIC_FILES below — the build
// fails loudly if anything on the list is missing.
//
// SITE_URL (optional, set in Netlify → Site configuration → Environment variables)
// is where the site lives. When Sparkle moves to its own domain, set it and every
// canonical link, social preview and sitemap entry follows. It defaults to the
// current Netlify address.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DEFAULT_SITE = 'https://sparklecleaningplatform.netlify.app';
const SITE_URL = String(process.env.SITE_URL || DEFAULT_SITE).trim().replace(/\/+$/, '');

const PUBLIC_FILES = [
  'sparkle_landing.html',
  'sparkle_full.html',
  'sparkle_blog.html',
  'sparkle_api.js',
  'privacy.html',
  'terms.html',
  'accessibility.html',
  'robots.txt',
  'sitemap.xml',
  'og-image.png',
];

const TEXT_FILE = /\.(html|js|txt|xml)$/i;
// Nothing matching these may ever end up in dist, whatever the list above says.
const NEVER_PUBLISH = /(^|\/)(\.env|\.git|node_modules|sparkle-backend|tests?|scripts|\.github|\.claude)(\/|$|\.)|\.(md|zip|db|sqlite|pem|key|p12|jks|keystore)$/i;

function main() {
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(SITE_URL)) {
    console.error(`SITE_URL must look like https://example.com (got "${SITE_URL}")`);
    process.exit(1);
  }

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const missing = PUBLIC_FILES.filter(f => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.error('These files are on the public list but do not exist:\n  ' + missing.join('\n  '));
    process.exit(1);
  }

  for (const name of PUBLIC_FILES) {
    if (NEVER_PUBLISH.test(name)) {
      console.error(`Refusing to publish "${name}": it matches a pattern that must stay private.`);
      process.exit(1);
    }
    const from = path.join(ROOT, name);
    const to = path.join(DIST, name);
    if (TEXT_FILE.test(name)) {
      let text = fs.readFileSync(from, 'utf8');
      if (SITE_URL !== DEFAULT_SITE) text = text.split(DEFAULT_SITE).join(SITE_URL);
      fs.writeFileSync(to, text);
    } else {
      fs.copyFileSync(from, to);
    }
  }

  const published = fs.readdirSync(DIST).sort();
  console.log(`Built ${published.length} files into dist/ for ${SITE_URL}:`);
  for (const f of published) console.log(`  ${f}`);
}

main();
