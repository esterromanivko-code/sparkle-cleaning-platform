'use strict';
// tests/route-guard.js — no API route is open to the world by accident.
//
// The admin backup endpoints once let ANYONE through when one environment variable was
// unset. Nothing noticed, because nothing checked which routes need a sign-in. This
// does, on every run:
//   1. every route without requireAuth must be listed in tests/public-routes.json
//      with the reason it is safe
//   2. every listed route must still exist (a stale entry is a hole waiting to appear)
//   3. the route finder itself must see every route definition in the source
//
//   npm run test:routes      (needs no server and no database)

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { inventory } = require('../scripts/route-inventory');

const BACKEND = path.join(__dirname, '..');
const allowed = JSON.parse(fs.readFileSync(path.join(__dirname, 'public-routes.json'), 'utf8'));
delete allowed._why;

const rows = inventory();
const key = r => `${r.method} ${r.url}`;

// 1. Open routes must be listed.
const open = rows.filter(r => !r.auth);
const unlisted = [...new Set(open.map(key))].filter(k => !(k in allowed));
assert.deepEqual(unlisted, [],
  `These routes can be called without signing in, and aren't in tests/public-routes.json:\n  ${unlisted.join('\n  ')}\n` +
  'If they should need a sign-in, add requireAuth (and requireRole) to the route. Only if they are meant to be public,\n' +
  'add them to public-routes.json with the reason they are safe.');

// 2. Listed routes must exist, and must still be open (otherwise the entry is stale).
const openKeys = new Set(open.map(key));
const stale = Object.keys(allowed).filter(k => !openKeys.has(k));
assert.deepEqual(stale, [], `public-routes.json lists routes that no longer exist or now need a sign-in:\n  ${stale.join('\n  ')}\nRemove them.`);
for (const [k, why] of Object.entries(allowed)) assert.ok(typeof why === 'string' && why.length > 20, `public-routes.json: give "${k}" a real reason`);

// 3. The finder sees every definition. If a route is written in a shape it can't parse, it would
//    be invisible to this guard — so a count mismatch fails the build rather than hiding it.
const files = ['server.js', ...fs.readdirSync(path.join(BACKEND, 'routes')).map(f => path.join('routes', f))].filter(f => f.endsWith('.js'));
for (const file of files) {
  const source = fs.readFileSync(path.join(BACKEND, file), 'utf8');
  const defined = (source.match(/^\s*(router|app)\.(get|post|put|patch|delete)\(/gm) || []).length;
  const found = new Set(rows.filter(r => r.file === file.replace(/\\/g, '/')).map(r => r.line)).size;
  if (defined && !found) continue;   // a file that isn't mounted anywhere
  assert.equal(found, defined, `${file}: the route finder saw ${found} of ${defined} route definitions. Fix scripts/route-inventory.js or the route's shape.`);
}

console.log(`Route guard passed: ${rows.length} routes, ${Object.keys(allowed).length} deliberately public, none open by accident.`);
