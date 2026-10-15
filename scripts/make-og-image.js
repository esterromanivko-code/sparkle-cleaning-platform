'use strict';
// scripts/make-og-image.js — draws og-image.png, the 1200×630 picture shown when a
// Sparkle link is shared in iMessage, Facebook, LinkedIn, Slack and so on.
//
//   node scripts/make-og-image.js
//
// Replace og-image.png with designed artwork whenever you have it; keep it 1200×630.
// Needs `sharp`, which the backend already has installed.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let sharp;
try {
  sharp = require(path.join(ROOT, 'sparkle-backend', 'sparkle-backend', 'node_modules', 'sharp'));
} catch {
  console.error('sharp is not installed. Run: cd sparkle-backend/sparkle-backend && npm install');
  process.exit(1);
}

const STAR = 'M512 232c14 0 26 9 30 22l38 122 122 38c13 4 22 16 22 30s-9 26-22 30l-122 38-38 122'
  + 'c-4 13-16 22-30 22s-26-9-30-22l-38-122-122-38c-13-4-22-16-22-30s9-26 22-30l122-38 38-122c4-13 16-22 30-22z';

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0F6E56"/>
      <stop offset="1" stop-color="#1D9E75"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <g transform="translate(860 40) scale(.62)" fill="#ffffff" opacity=".16"><path d="${STAR}"/></g>
  <g transform="translate(70 96) scale(.18)" fill="#ffffff"><path d="${STAR}"/></g>
  <text x="70" y="330" font-family="Georgia, 'Times New Roman', serif" font-size="128" font-weight="700" fill="#ffffff">Sparkle</text>
  <text x="74" y="405" font-family="Arial, Helvetica, sans-serif" font-size="42" fill="#E1F5EE">Seattle's cleaning marketplace</text>
  <text x="74" y="520" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#ffffff" opacity=".9">Compare quotes  ·  Pay after the clean  ·  Photos on every job</text>
</svg>`;

sharp(Buffer.from(svg)).png().toFile(path.join(ROOT, 'og-image.png'))
  .then(info => console.log(`Wrote og-image.png (${info.width}×${info.height}, ${(info.size / 1024).toFixed(0)} KB)`))
  .catch(err => { console.error(err); process.exit(1); });
