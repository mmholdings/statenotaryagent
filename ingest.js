#!/usr/bin/env node
/**
 * State Notary Agent — Florida notary data ingest
 * ------------------------------------------------------------------
 * Source: Florida Department of State, Notaries Public daily journals.
 *   Index:    https://notaries.dos.fl.gov/notary/journaldates.asp
 *   Download: https://notaries.dos.fl.gov/notary/JournalDownload.asp?startdate=MM/DD/YYYY
 *   Spec:     https://notaries.dos.fl.gov/notdef.html   (33 fields, comma-delimited ASCII)
 *
 * These files are published free by DOS for exactly this purpose. This is the
 * sanctioned path — no scraping, no rate-limit evasion, no ToU question.
 *
 * IMPORTANT: the journals are a rolling window of *transactions* (adds/changes),
 * not a full roster. Run this daily and it accumulates. To get the historical
 * back-book you must file a Chapter 119 public-records request with DOS:
 *   PublicRecordsRequest@dos.myflorida.com  ·  850-245-6507
 *
 * ------------------------------------------------------------------
 * PRIVACY RULES — these are deliberate and load-bearing. Do not "optimize" them away.
 *
 *  1. Address Restriction flag == 'Y'  ->  RECORD IS DROPPED ENTIRELY.
 *     That flag marks people holding an active exemption under Fla. Stat.
 *     §119.071(4)(d): judges, prosecutors, law enforcement, corrections
 *     officers, DCF investigators and their families. Republishing their
 *     location is a statutory violation and a genuine safety risk.
 *
 *  2. Date of birth is NEVER retained. The state's file carries full DOB.
 *     Name + home address + phone + DOB is an identity-theft kit.
 *
 *  3. Street address is NEVER retained. City / ZIP only.
 *
 *  4. Phone numbers are NEVER retained.
 *
 *  5. Employer and mailing blocks are discarded.
 *
 *  6. Expired commissions are excluded from the published set.
 *
 * What we keep is the verification-useful, low-sensitivity core:
 *   name, notary ID, commission series + number, issue/expire date,
 *   bonding agency, city, county, ZIP.
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://notaries.dos.fl.gov';
const OUT = path.join(__dirname, 'notaries.json');
const UA = 'StateNotaryAgent-Directory/1.0 (+https://statenotaryagent.com; public-records ingest)';

// ---------------------------------------------------------------- fetch
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(new URL(res.headers.location, url).href));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let d = '';
      res.setEncoding('latin1');
      res.on('data', c => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------- CSV
// DOS emits comma-delimited ASCII. Fields may be quoted; quotes may be doubled.
function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const F = { // field index per the DOS spec, in order
  id: 0, first: 1, middle: 2, last: 3, series: 4, certno: 5,
  issue: 6, expire: 7, bondAgency: 8, agencyApplId: 9, transType: 10,
  addrRestriction: 11, address: 12, address2: 13, city: 14, state: 15,
  zip: 16, phone: 17, /* 18-24 employer, 25 dob, 26 surety, 27-32 mailing */
  surety: 26,
};

// MMDDYY -> ISO. DOS uses 2-digit years; commissions run 4 years, so a
// year > (currentYY + 10) is unambiguously last century.
function toIso(mmddyy) {
  if (!/^\d{6}$/.test(mmddyy)) return null;
  const mm = +mmddyy.slice(0, 2), dd = +mmddyy.slice(2, 4), yy = +mmddyy.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const nowYY = new Date().getUTCFullYear() % 100;
  const year = yy > nowYY + 10 ? 1900 + yy : 2000 + yy;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

const titleCase = s => (s || '').toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).trim();

// ------------------------------------------------- FL city -> county
// Covers the metros where the overwhelming majority of notaries sit.
// Anything unmatched is left null and simply isn't county-filterable yet.
const CITY_COUNTY = {
  // Central / Orlando
  'orlando':'Orange','winter park':'Orange','apopka':'Orange','ocoee':'Orange','winter garden':'Orange',
  'maitland':'Orange','windermere':'Orange','gotha':'Orange','oakland':'Orange',
  'sanford':'Seminole','altamonte springs':'Seminole','lake mary':'Seminole','longwood':'Seminole',
  'oviedo':'Seminole','winter springs':'Seminole','casselberry':'Seminole','heathrow':'Seminole',
  'kissimmee':'Osceola','st cloud':'Osceola','saint cloud':'Osceola','celebration':'Osceola',
  'deltona':'Volusia','daytona beach':'Volusia','deland':'Volusia','ormond beach':'Volusia',
  'port orange':'Volusia','new smyrna beach':'Volusia','edgewater':'Volusia','debary':'Volusia',
  'clermont':'Lake','leesburg':'Lake','eustis':'Lake','tavares':'Lake','mount dora':'Lake','groveland':'Lake',
  'ocala':'Marion','belleview':'Marion','dunnellon':'Marion',
  'the villages':'Sumter','wildwood':'Sumter','bushnell':'Sumter',
  // Tampa Bay
  'tampa':'Hillsborough','brandon':'Hillsborough','riverview':'Hillsborough','plant city':'Hillsborough',
  'valrico':'Hillsborough','lutz':'Hillsborough','apollo beach':'Hillsborough','ruskin':'Hillsborough',
  'st petersburg':'Pinellas','saint petersburg':'Pinellas','clearwater':'Pinellas','largo':'Pinellas',
  'pinellas park':'Pinellas','dunedin':'Pinellas','palm harbor':'Pinellas','seminole':'Pinellas',
  'tarpon springs':'Pinellas','gulfport':'Pinellas','safety harbor':'Pinellas','oldsmar':'Pinellas',
  'new port richey':'Pasco','port richey':'Pasco','wesley chapel':'Pasco','land o lakes':'Pasco',
  'zephyrhills':'Pasco','hudson':'Pasco','dade city':'Pasco','trinity':'Pasco',
  'brooksville':'Hernando','spring hill':'Hernando',
  'sarasota':'Sarasota','venice':'Sarasota','north port':'Sarasota','osprey':'Sarasota','nokomis':'Sarasota',
  'bradenton':'Manatee','palmetto':'Manatee','lakewood ranch':'Manatee','parrish':'Manatee',
  'lakeland':'Polk','winter haven':'Polk','bartow':'Polk','haines city':'Polk','auburndale':'Polk',
  'davenport':'Polk','lake wales':'Polk','poinciana':'Polk',
  // South Florida
  'miami':'Miami-Dade','miami beach':'Miami-Dade','hialeah':'Miami-Dade','coral gables':'Miami-Dade',
  'doral':'Miami-Dade','aventura':'Miami-Dade','homestead':'Miami-Dade','kendall':'Miami-Dade',
  'miami gardens':'Miami-Dade','north miami':'Miami-Dade','north miami beach':'Miami-Dade',
  'cutler bay':'Miami-Dade','palmetto bay':'Miami-Dade','pinecrest':'Miami-Dade','miami lakes':'Miami-Dade',
  'hialeah gardens':'Miami-Dade','sunny isles beach':'Miami-Dade','key biscayne':'Miami-Dade',
  'fort lauderdale':'Broward','ft lauderdale':'Broward','hollywood':'Broward','pembroke pines':'Broward',
  'coral springs':'Broward','miramar':'Broward','plantation':'Broward','sunrise':'Broward',
  'davie':'Broward','weston':'Broward','pompano beach':'Broward','deerfield beach':'Broward',
  'coconut creek':'Broward','tamarac':'Broward','margate':'Broward','lauderhill':'Broward',
  'hallandale beach':'Broward','dania beach':'Broward','oakland park':'Broward','parkland':'Broward',
  'west palm beach':'Palm Beach','boca raton':'Palm Beach','delray beach':'Palm Beach',
  'boynton beach':'Palm Beach','jupiter':'Palm Beach','wellington':'Palm Beach',
  'palm beach gardens':'Palm Beach','lake worth':'Palm Beach','royal palm beach':'Palm Beach',
  'greenacres':'Palm Beach','riviera beach':'Palm Beach','palm beach':'Palm Beach',
  'port st lucie':'St. Lucie','fort pierce':'St. Lucie','stuart':'Martin','palm city':'Martin',
  'vero beach':'Indian River','sebastian':'Indian River',
  // Southwest
  'naples':'Collier','marco island':'Collier','immokalee':'Collier','bonita springs':'Lee',
  'fort myers':'Lee','ft myers':'Lee','cape coral':'Lee','estero':'Lee','lehigh acres':'Lee',
  'fort myers beach':'Lee','punta gorda':'Charlotte','port charlotte':'Charlotte',
  // Northeast / North
  'jacksonville':'Duval','jacksonville beach':'Duval','atlantic beach':'Duval','neptune beach':'Duval',
  'orange park':'Clay','fleming island':'Clay','middleburg':'Clay','green cove springs':'Clay',
  'st augustine':'St. Johns','saint augustine':'St. Johns','ponte vedra':'St. Johns',
  'ponte vedra beach':'St. Johns','st johns':'St. Johns','fernandina beach':'Nassau','yulee':'Nassau',
  'gainesville':'Alachua','alachua':'Alachua','newberry':'Alachua',
  'tallahassee':'Leon','crawfordville':'Wakulla','quincy':'Gadsden',
  'lake city':'Columbia','palatka':'Putnam','starke':'Bradford',
  // Panhandle
  'pensacola':'Escambia','gulf breeze':'Santa Rosa','milton':'Santa Rosa','navarre':'Santa Rosa',
  'fort walton beach':'Okaloosa','destin':'Okaloosa','crestview':'Okaloosa','niceville':'Okaloosa',
  'panama city':'Bay','panama city beach':'Bay','lynn haven':'Bay',
  'santa rosa beach':'Walton','defuniak springs':'Walton','inlet beach':'Walton',
  // Space Coast
  'melbourne':'Brevard','palm bay':'Brevard','titusville':'Brevard','cocoa':'Brevard',
  'cocoa beach':'Brevard','merritt island':'Brevard','rockledge':'Brevard','viera':'Brevard',
  'satellite beach':'Brevard','indialantic':'Brevard',
  // Other
  'key west':'Monroe','key largo':'Monroe','marathon':'Monroe',
  'sebring':'Highlands','avon park':'Highlands','okeechobee':'Okeechobee',
  'crystal river':'Citrus','inverness':'Citrus','homosassa':'Citrus',
};
const countyFor = city => CITY_COUNTY[(city || '').toLowerCase().replace(/[.,]/g, '').trim()] || null;

// ---------------------------------------------------------------- main
async function main() {
  console.log('Fetching journal index…');
  const index = await get(`${BASE}/notary/journaldates.asp`);

  const dates = [...new Set(
    [...index.matchAll(/startdate=(\d{2}\/\d{2}\/\d{4})/g)].map(m => m[1])
  )];
  if (!dates.length) {
    console.error('No journal dates found. DOS may have changed the page. Aborting without touching existing data.');
    process.exit(1);
  }
  console.log(`Found ${dates.length} journal date(s): ${dates[dates.length - 1]} → ${dates[0]}`);

  // Load whatever we've already accumulated. This is the whole point — the
  // journals are a rolling window, so the local store IS the database.
  let store = {};
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      (prev.notaries || []).forEach(n => (store[n.id] = n));
      console.log(`Loaded ${Object.keys(store).length} existing record(s).`);
    } catch (e) { console.warn('Existing notaries.json unreadable, starting fresh:', e.message); }
  }

  const stats = { rows: 0, restricted: 0, expired: 0, malformed: 0, upserted: 0 };

  for (const d of dates) {
    let body;
    try {
      body = await get(`${BASE}/notary/JournalDownload.asp?startdate=${encodeURIComponent(d)}`);
    } catch (e) { console.warn(`  ${d}: download failed — ${e.message}`); continue; }

    let kept = 0;
    for (const raw of body.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const f = parseCsvLine(raw);
      if (f.length < 18 || !/^\d+$/.test(f[F.id] || '')) { stats.malformed++; continue; }
      stats.rows++;

      // RULE 1 — protected persons are dropped entirely.
      if ((f[F.addrRestriction] || '').toUpperCase() === 'Y') { stats.restricted++; continue; }

      const expire = toIso(f[F.expire]);
      // RULE 6 — no expired commissions in the published set.
      if (!expire || new Date(expire) < new Date()) { stats.expired++; continue; }

      const city = titleCase(f[F.city]);
      const first = titleCase(f[F.first]);
      const last = titleCase(f[F.last]);
      if (!first && !last) { stats.malformed++; continue; }

      store[f[F.id]] = {
        id: f[F.id],
        name: [first, titleCase(f[F.middle]), last].filter(Boolean).join(' '),
        first, last,
        commission: `${(f[F.series] || '').toUpperCase()} ${f[F.certno] || ''}`.trim(),
        issued: toIso(f[F.issue]),
        expires: expire,
        bondAgency: (f[F.bondAgency] || '').trim() || null,
        surety: (f[F.surety] || '').trim() || null,
        city: city || null,
        county: countyFor(city),
        state: (f[F.state] || 'FL').toUpperCase(),
        zip: (f[F.zip] || '').slice(0, 5) || null,
        source: 'FL DOS notary journal',
        // deliberately absent: address, phone, dob, employer, mailing
        claimed: false,
        featured: false,
      };
      kept++; stats.upserted++;
    }
    console.log(`  ${d}: ${kept} record(s) kept`);
  }

  const notaries = Object.values(store)
    .sort((a, b) => (a.last || '').localeCompare(b.last || '') || (a.first || '').localeCompare(b.first || ''));

  const counties = {};
  notaries.forEach(n => { if (n.county) counties[n.county] = (counties[n.county] || 0) + 1; });

  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'Florida Department of State — Notaries Public daily journals',
    sourceUrl: 'https://notaries.dos.fl.gov/notary/journaldates.asp',
    privacy: 'Address-restricted records excluded. No DOB, street address, or phone retained.',
    total: notaries.length,
    counties,
    notaries,
  }, null, 2));

  console.log('\n──────── ingest complete ────────');
  console.log(`rows parsed      ${stats.rows}`);
  console.log(`protected/dropped ${stats.restricted}   (§119.071(4)(d) exemption holders)`);
  console.log(`expired/skipped  ${stats.expired}`);
  console.log(`malformed        ${stats.malformed}`);
  console.log(`TOTAL IN STORE   ${notaries.length}`);
  console.log(`counties mapped  ${Object.keys(counties).length}`);
  console.log(`written → ${OUT}`);
}

main().catch(e => { console.error('Ingest failed:', e); process.exit(1); });
