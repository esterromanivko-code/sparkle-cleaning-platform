'use strict';
// scripts/route-inventory.js — finds every API route in the backend, with the URL it is
// served at and whether it asks for a signed-in user.
//
// Used by the launch check (is any route open that shouldn't be?) and by the leak
// crawl test (call every GET as strangers and look for private data). Reading the
// source rather than the running app keeps it simple and lets it run before the
// server exists.
//
//   node scripts/route-inventory.js        prints the table

const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');

// "/api/profile" ← app.use('/api/profile', profileRoutes) where profileRoutes is
// require('./routes/profiles'). A router mounted twice appears twice.
function mounts(serverSource) {
  const idents = {};
  for (const m of serverSource.matchAll(/const\s+(\w+)\s*=\s*require\(\s*['"]\.\/(routes\/[\w.]+|authExtended)['"]\s*\)/g)) idents[m[1]] = m[2];
  const out = [];
  for (const m of serverSource.matchAll(/app\.use\(\s*(['"`])(\/[^'"`]*)\1\s*,([^;]*?)\);/g)) {
    const args = m[3];
    const inline = /require\(\s*['"]\.\/(routes\/[\w.]+)['"]\s*\)/.exec(args);
    const lastIdent = [...args.matchAll(/\b(\w+)\s*(?:,|$)/g)].map(x => x[1]).reverse().find(n => idents[n]);
    const file = inline ? inline[1] : (lastIdent ? idents[lastIdent] : null);
    if (file) out.push({ prefix: m[2], file: file.endsWith('.js') ? file : file + '.js' });
  }
  return out;
}

// The routes defined in one file. `authedFromHere` is true for every route after a
// `router.use(requireAuth)`, which protects everything below it.
function routesIn(source) {
  const lines = source.split('\n');
  let blanketAuthAt = Infinity;
  lines.forEach((l, i) => { if (/\brouter\.use\(\s*requireAuth\b/.test(l) && i < blanketAuthAt) blanketAuthAt = i; });

  const routes = [];
  // The handler is the first arrow function (or `function`) after the path. Stopping at
  // any `=>` rather than only `=> {` matters: a one-line handler such as
  // `(req, res) => res.json(...)` would otherwise run on into the NEXT route and hide it.
  const re = /\b(router|app)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\3([\s\S]{0,900}?)(?:=>|function\s*\()/g;
  let m;
  while ((m = re.exec(source))) {
    const line = source.slice(0, m.index).split('\n').length;
    const head = m[5];
    const role = /requireRole\(([^)]*)\)/.exec(head);
    routes.push({
      owner: m[1], method: m[2].toUpperCase(), route: m[4], line,
      auth: /requireAuth|requireAdminAuth/.test(head) || line - 1 > blanketAuthAt,
      roles: role ? role[1].replace(/['"\s]/g, '').split(',').filter(Boolean) : [],
    });
  }
  return routes;
}

function inventory() {
  const serverSource = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
  const all = [];
  for (const r of routesIn(serverSource)) {
    all.push({ ...r, file: 'server.js', url: r.route });                     // defined directly on app
  }
  for (const { prefix, file } of mounts(serverSource)) {
    const full = path.join(BACKEND, file);
    if (!fs.existsSync(full)) continue;
    for (const r of routesIn(fs.readFileSync(full, 'utf8'))) {
      if (r.owner !== 'router') continue;
      all.push({ ...r, file, url: (prefix + (r.route === '/' ? '' : r.route)).replace(/\/+/g, '/') });
    }
  }
  return all;
}

module.exports = { inventory, routesIn, mounts };

if (require.main === module) {
  const rows = inventory();
  console.log(`${rows.length} routes\n`);
  for (const r of rows) console.log(`${r.method.padEnd(6)} ${r.url.padEnd(54)} ${r.auth ? (r.roles.join('|') || 'signed in') : 'PUBLIC'}   ${r.file}:${r.line}`);
}
