// State Notary Agent — static server + notary search API. Zero dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ---- load the notary dataset once into memory ----
let DATA = { total: 0, counties: {}, notaries: [], generated: null };
try {
  DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'notaries.json'), 'utf8'));
  DATA.notaries.forEach(n => {
    n._h = `${n.name} ${n.city || ''} ${n.county || ''} ${n.zip || ''} ${n.commission}`.toLowerCase();
  });
  console.log(`Loaded ${DATA.total} notary records (${Object.keys(DATA.counties).length} counties).`);
} catch (e) {
  console.warn('notaries.json not loaded:', e.message);
}

// Agents who have claimed/enhanced their listing. Featured sorts first.
let ENHANCED = [];
try { ENHANCED = JSON.parse(fs.readFileSync(path.join(ROOT, 'enhanced.json'), 'utf8')); } catch (_) {}
const ENH = new Map(ENHANCED.map(e => [e.id, e]));

// An enhanced listing may belong to a notary whose commission predates the
// journal window we've accumulated. Merge those in so they're searchable.
const known = new Set(DATA.notaries.map(n => n.id));
ENHANCED.filter(e => !known.has(e.id)).forEach(e => {
  DATA.notaries.push({
    ...e,
    state: 'FL',
    source: 'Claimed listing',
    _h: `${e.name} ${e.city || ''} ${e.county || ''} ${e.zip || ''} ${e.commission || ''}`.toLowerCase(),
  });
  if (e.county) DATA.counties[e.county] = (DATA.counties[e.county] || 0) + 1;
  DATA.total++;
});

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length,
    'Cache-Control': 'public, max-age=300' }).end(b);
}

function search(params) {
  const q = (params.get('q') || '').trim().toLowerCase();
  const county = (params.get('county') || '').trim();
  const city = (params.get('city') || '').trim().toLowerCase();
  const service = (params.get('service') || '').trim();
  const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
  const per = Math.min(60, Math.max(1, parseInt(params.get('per') || '24', 10) || 24));

  let list = DATA.notaries;
  if (county) list = list.filter(n => n.county === county);
  if (city) list = list.filter(n => (n.city || '').toLowerCase() === city);
  if (q) list = list.filter(n => n._h.includes(q));
  if (service) list = list.filter(n => { const e = ENH.get(n.id); return e && e.services && e.services.includes(service); });

  // enhanced/featured listings float to the top of every result set
  const score = n => { const e = ENH.get(n.id); return e ? (e.featured ? 2 : 1) : 0; };
  list = [...list].sort((a, b) => score(b) - score(a));

  const total = list.length;
  const slice = list.slice((page - 1) * per, page * per).map(n => {
    const e = ENH.get(n.id) || {};
    const { _h, ...rest } = n;
    return { ...rest, ...e, claimed: !!ENH.get(n.id), featured: !!e.featured };
  });
  return { total, page, per, pages: Math.ceil(total / per) || 1, results: slice };
}

http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  let p = decodeURIComponent(u.pathname);

  if (p === '/api/notaries') return json(res, search(u.searchParams));
  if (p === '/api/meta') return json(res, {
    total: DATA.total, counties: DATA.counties, generated: DATA.generated,
    source: DATA.source, privacy: DATA.privacy, claimed: ENHANCED.length,
  });
  if (p === '/api/health') return json(res, { ok: true, records: DATA.total });

  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end('Forbidden');
  // never serve the raw dataset or the ingest script
  if (/notaries\.json|enhanced\.json|ingest\.js|package\.json/i.test(path.basename(file)))
    return res.writeHead(404).end('Not found');

  fs.readFile(file, (err, data) => {
    if (err) {
      return fs.readFile(path.join(ROOT, 'index.html'), (e2, home) =>
        e2 ? res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
           : res.writeHead(200, { 'Content-Type': TYPES['.html'] }).end(home));
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    }).end(data);
  });
}).listen(PORT, '0.0.0.0', () => console.log(`State Notary Agent listening on :${PORT}`));
