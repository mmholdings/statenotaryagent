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
let SPONSORS = { slots: [] };
try { SPONSORS = JSON.parse(fs.readFileSync(path.join(ROOT, 'sponsors.json'), 'utf8')); } catch (_) {}

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


// ---------------------------------------------------------------
// Server-rendered location pages — the SEO engine.
// Real HTML with real listings, not JS-loaded, so search engines index it.
// ---------------------------------------------------------------
const SITE = process.env.SITE_URL || 'https://www.statenotaryagent.com';
let SHELL_CSS = '';
try {
  const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = home.match(/<style>([\s\S]*?)<\/style>/);
  if (m) SHELL_CSS = m[1];
} catch (_) {}

const slug = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usDate = d => { if (!d) return '—'; const p = String(d).split('-'); return p.length === 3 ? `${p[1]}/${p[2]}/${p[0]}` : '—'; };

// build lookup maps once
const BY_COUNTY = {}, BY_CITY = {};
DATA.notaries.forEach(n => {
  if (n.county) (BY_COUNTY[slug(n.county)] ||= { name: n.county, rows: [] }).rows.push(n);
  if (n.city)   (BY_CITY[slug(n.city)]     ||= { name: n.city, county: n.county, rows: [] }).rows.push(n);
});
Object.values(BY_COUNTY).forEach(o => o.rows.sort((a, b) => (a.last || '').localeCompare(b.last || '')));
Object.values(BY_CITY).forEach(o => o.rows.sort((a, b) => (a.last || '').localeCompare(b.last || '')));
const CITY_PAGES = Object.entries(BY_CITY).filter(([, o]) => o.rows.length >= 15);

function locationPage({ title, h1, intro, rows, canonical, crumb, related }) {
  const shown = rows.slice(0, 250);
  const body = shown.map(n => {
    const e = ENH.get(n.id) || {};
    const claimed = !!ENH.get(n.id);
    return `<tr${e.featured ? ' class="feat"' : ''}>
      <td><span class="nm">${esc(n.name)}</span></td>
      <td>${esc(n.city || '—')}<div class="sub">${esc(n.county ? n.county + ' County' : '—')}${n.zip ? ' &middot; ' + esc(n.zip) : ''}</div></td>
      <td class="mono">${esc(n.commission || '—')}</td>
      <td class="mono">${usDate(n.expires)}</td>
      <td class="mono">${esc(n.bondAgency || '—')}</td>
      <td>${e.featured ? '<span class="tag feat">Featured</span>' : ''}${claimed ? '<span class="tag claim">Claimed</span>' : '<span class="tag rec">Of record</span>'}</td>
    </tr>`;
  }).join('');

  const ld = {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: title, url: canonical,
    description: intro.replace(/<[^>]+>/g, '').slice(0, 300),
    isPartOf: { '@type': 'WebSite', name: 'State Notary Agent', url: SITE },
    about: { '@type': 'Thing', name: 'Notaries Public in Florida' },
  };

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(intro.replace(/<[^>]+>/g, '').slice(0, 155))}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${SHELL_CSS}</style></head><body>
<div class="edition">State of Florida &middot; Register of Commissioned Notaries Public &middot; 2026 Edition</div>
<header class="letterhead"><div class="wrap">
  <a href="/" style="text-decoration:none"><img src="/logo.png" alt="State Notary Agent seal">
  <div class="name" style="color:var(--green)">State Notary Agent<sup>&reg;</sup></div></a>
  <div class="tag">The Florida Notary Public Directory</div>
</div></header>
<nav class="nav"><div class="wrap">
  <a href="/#register">The Register</a><a href="/#counties">County Index</a>
  <a href="/#suppliers">Suppliers</a><a href="/#rates">Rate Card</a><a href="/#notaries">For Notaries</a>
</div></nav>
<div class="intro"><div class="wrap">
  <p style="font-size:12.5px;color:var(--faint);margin-bottom:10px">${crumb}</p>
  <h1>${esc(h1)}</h1><p>${intro}</p>
  <div class="ledger">
    <div><b>${rows.length.toLocaleString()}</b><span>Commissions of record</span></div>
    <div><b>${shown.length.toLocaleString()}</b><span>Listed on this page</span></div>
    <div><b>Free</b><span>Public access</span></div>
  </div>
</div></div>
<section><div class="wrap">
  <div class="tcap"><h3>Entries</h3><div class="n">${rows.length.toLocaleString()} of record</div></div>
  <div class="tblwrap"><table><thead><tr>
    <th style="width:27%">Notary Public</th><th style="width:20%">Residence</th>
    <th style="width:16%">Commission</th><th style="width:12%">Expires</th>
    <th style="width:12%">Bond Agency</th><th style="width:13%">Standing</th>
  </tr></thead><tbody>${body}</tbody></table></div>
  ${rows.length > shown.length ? `<p class="hint">Showing the first ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} entries. <a href="/#register">Search the full register &rsaquo;</a></p>` : ''}
</div></section>
${related ? `<section class="band"><div class="wrap"><div class="sechead"><h2>Nearby</h2></div><div class="cidx">${related}</div></div></section>` : ''}
<section><div class="wrap" style="text-align:center">
  <p class="lede" style="margin:0 auto 18px">Are you one of the notaries listed above? Claiming your entry is free and lets the public reach you directly.</p>
  <a class="btn" href="/#notaries">Claim Your Entry</a>
</div></section>
<footer><div class="wrap">
  <div class="fnotice"><b>Notice.</b> State Notary Agent&reg; is a privately operated directory. It is <b>not a government agency</b> and is not affiliated with or endorsed by the State of Florida. Official records are maintained by the <a href="https://notaries.dos.fl.gov/not001.html" target="_blank" rel="noopener">Florida Department of State</a>.</div>
  <div class="legal">
    <p><b>Source and privacy.</b> Entries are derived from the Florida Department of State's published Notaries Public journals, a public record. Street addresses, telephone numbers, and dates of birth are not published, and records flagged with an address restriction under Fla. Stat. &sect;119.071(4)(d) are excluded.</p>
    <p><b>No endorsement.</b> Listed notaries are independent contractors and not employees or agents of State Notary Agent&reg;. Inclusion is not a recommendation or guarantee. Verify any commission directly with the Florida Department of State.</p>
    <p style="margin-bottom:0">&copy; 2026 State Notary Agent&reg;. <a href="/">Return to the register</a>.</p>
  </div>
</div></footer></body></html>`;
}

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
  const sort = (params.get('sort') || '').trim();
  const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
  const per = Math.min(60, Math.max(1, parseInt(params.get('per') || '24', 10) || 24));

  let list = DATA.notaries;
  if (county) list = list.filter(n => n.county === county);
  if (city) list = list.filter(n => (n.city || '').toLowerCase() === city);
  if (q) list = list.filter(n => n._h.includes(q));
  if (service) list = list.filter(n => { const e = ENH.get(n.id); return e && e.services && e.services.includes(service); });

  // enhanced/featured listings float to the top of every result set
  const score = n => { const e = ENH.get(n.id); return e ? (e.featured ? 2 : 1) : 0; };
  list = [...list].sort((a, b) => {
    const d = score(b) - score(a);
    if (d) return d;
    if (sort === 'recent') return String(b.issued || '').localeCompare(String(a.issued || ''));
    if (sort === 'expiring') return String(a.expires || '').localeCompare(String(b.expires || ''));
    return 0;
  });

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
  if (p === '/api/sponsors') return json(res, {
    slots: (SPONSORS.slots || []).map(x => x.live
      ? x
      : { id: x.id, category: x.category, live: false, rate: x.rate, reach: x.reach }),
  });
  if (p === '/api/stats') {
    const now = new Date();
    const in90 = new Date(now.getTime() + 90 * 864e5).toISOString().slice(0, 10);
    const cut = new Date(now.getTime() - 30 * 864e5).toISOString().slice(0, 10);
    let newly = 0, expiring = 0;
    DATA.notaries.forEach(n => {
      if (n.issued && n.issued >= cut && n.issued <= now.toISOString().slice(0, 10)) newly++;
      if (n.expires && n.expires <= in90) expiring++;
    });
    return json(res, { total: DATA.total, newly, expiring });
  }


  // ---- SEO location pages ----
  let m;
  if ((m = p.match(/^\/notaries\/([a-z0-9-]+)-county\/?$/i))) {
    const c = BY_COUNTY[m[1].toLowerCase()];
    if (c) {
      const near = Object.entries(BY_COUNTY).filter(([k]) => k !== m[1].toLowerCase())
        .sort((a, b) => b[1].rows.length - a[1].rows.length).slice(0, 12)
        .map(([k, o]) => `<button onclick="location.href='/notaries/${k}-county'">${esc(o.name)} County<span>${o.rows.length}</span></button>`).join('');
      return res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'public, max-age=3600' })
        .end(locationPage({
          title: `Notaries Public in ${c.name} County, Florida | State Notary Agent`,
          h1: `Notaries Public in ${c.name} County, Florida`,
          intro: `A public register of <b>${c.rows.length.toLocaleString()} commissioned notaries public</b> in ${esc(c.name)} County, Florida, compiled from Florida Department of State records. Each entry shows the commission number and expiration date so it can be verified independently. Free to search.`,
          rows: c.rows, canonical: `${SITE}/notaries/${m[1].toLowerCase()}-county`,
          crumb: `<a href="/">Register</a> &rsaquo; <a href="/#counties">Counties</a> &rsaquo; ${esc(c.name)} County`,
          related: near,
        }));
    }
  }
  if ((m = p.match(/^\/notaries\/([a-z0-9-]+)-fl\/?$/i))) {
    const c = BY_CITY[m[1].toLowerCase()];
    if (c) {
      const near = CITY_PAGES.filter(([k]) => k !== m[1].toLowerCase() && c.county && BY_CITY[k].county === c.county)
        .slice(0, 12)
        .map(([k, o]) => `<button onclick="location.href='/notaries/${k}-fl'">${esc(o.name)}<span>${o.rows.length}</span></button>`).join('');
      return res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'public, max-age=3600' })
        .end(locationPage({
          title: `Notaries Public in ${c.name}, FL | Mobile & Online Notaries | State Notary Agent`,
          h1: `Notaries Public in ${c.name}, Florida`,
          intro: `A public register of <b>${c.rows.length.toLocaleString()} commissioned notaries public</b> in ${esc(c.name)}${c.county ? `, ${esc(c.county)} County` : ''}, Florida. Compiled from Florida Department of State records and free to search. Includes mobile notaries, remote online notaries, and loan signing agents.`,
          rows: c.rows, canonical: `${SITE}/notaries/${m[1].toLowerCase()}-fl`,
          crumb: `<a href="/">Register</a> &rsaquo; ${c.county ? `<a href="/notaries/${slug(c.county)}-county">${esc(c.county)} County</a> &rsaquo; ` : ''}${esc(c.name)}`,
          related: near,
        }));
    }
  }
  if (p === '/sitemap.xml') {
    const urls = [`${SITE}/`]
      .concat(Object.keys(BY_COUNTY).map(k => `${SITE}/notaries/${k}-county`))
      .concat(CITY_PAGES.map(([k]) => `${SITE}/notaries/${k}-fl`));
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map(u => `  <url><loc>${u}</loc><changefreq>weekly</changefreq></url>`).join('\n') + `\n</urlset>`;
    return res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' }).end(xml);
  }
  if (p === '/robots.txt') {
    return res.writeHead(200, { 'Content-Type': 'text/plain' })
      .end(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITE}/sitemap.xml\n`);
  }

  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end('Forbidden');
  // never serve the raw dataset or the ingest script
  if (/notaries\.json|enhanced\.json|sponsors\.json|ingest\.js|package\.json/i.test(path.basename(file)))
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
