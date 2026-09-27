// Fetches one or more counties' public roads and splits them into small
// geographic tiles, written to tiles/<tileId>.json. Also maintains
// tiles/county-index.json, a map of county name -> tile IDs, which the app
// uses to bulk-download a whole county up front (e.g. during onboarding)
// rather than only discovering tiles reactively as GPS points land in them.
//
// These all get committed to the repo and served live over GitHub's raw
// file CDN — no server required.
//
// Usage:
//   node scripts/tile-county.js "County Carlow"
//   node scripts/tile-county.js "County Cork" "County Kerry"
//   node scripts/tile-county.js --rest-of-roi
//   node scripts/tile-county.js --all-roi   (all 26 counties — use this for
//     a full re-tile after the data format changes)

const REST_OF_ROI = [
  'County Dublin', 'County Kildare', 'County Longford', 'County Louth',
  'County Meath', 'County Offaly', 'County Westmeath', 'County Wexford', 'County Wicklow',
  'County Galway', 'County Leitrim', 'County Mayo', 'County Roscommon', 'County Sligo',
  'County Clare', 'County Cork', 'County Kerry', 'County Limerick',
  'County Tipperary', 'County Waterford',
  'County Cavan', 'County Donegal', 'County Monaghan',
];

const ALL_ROI = ['County Kilkenny', 'County Laois', 'County Carlow', ...REST_OF_ROI];

const args = process.argv.slice(2);
const COUNTIES =
  args[0] === '--all-roi' ? ALL_ROI : args[0] === '--rest-of-roi' ? REST_OF_ROI : args;

if (COUNTIES.length === 0) {
  console.error('Usage: node scripts/tile-county.js "<County Name>" ["<Another County>" ...] | --rest-of-roi | --all-roi');
  process.exit(1);
}

const HIGHWAY_CLASSES = [
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAY_MS = 5000;
const BETWEEN_COUNTIES_DELAY_MS = 5000;

const CHUNK_TARGET_METERS = 100;
const COORD_DECIMALS = 100000; // ~1.1m precision

// Must match tileIdForPoint() in App.tsx exactly.
const TILE_DEGREES = 0.05;

const INDEX_PATH = 'tiles/county-index.json';
const STATS_PATH = 'tiles/county-stats.json';

// Fixed county codes — each road chunk stores its county as a small number
// (index into this list) to keep tile files small. Never reorder this list:
// the app and already-generated tiles depend on the numbers.
const COUNTY_CODES = [
  'County Carlow', 'County Cavan', 'County Clare', 'County Cork', 'County Donegal',
  'County Dublin', 'County Galway', 'County Kerry', 'County Kildare', 'County Kilkenny',
  'County Laois', 'County Leitrim', 'County Limerick', 'County Longford', 'County Louth',
  'County Mayo', 'County Meath', 'County Monaghan', 'County Offaly', 'County Roscommon',
  'County Sligo', 'County Tipperary', 'County Waterford', 'County Westmeath', 'County Wexford',
  'County Wicklow',
];

// --- County boundaries ---
// A road crossing a county line is returned in BOTH counties' downloads,
// so "which download did it come from" isn't good enough. Instead each
// chunk's midpoint is tested against the county's actual boundary shape.

const BAND_DEGREES = 0.01;

function boundaryQuery(countyName) {
  return `
[out:json][timeout:180];
rel["name"="${countyName}"]["boundary"="administrative"];
out geom;
`;
}

// Turns the boundary relation into line segments, bucketed into thin
// latitude bands so each point test only checks nearby boundary segments.
function buildBoundary(data, countyName) {
  const rels = (data.elements || []).filter((e) => e.type === 'relation');
  if (rels.length === 0) throw new Error(`no boundary found for ${countyName}`);
  // Prefer the county-level boundary if the name matches more than one.
  const rel = rels.find((r) => r.tags && r.tags.admin_level === '6') || rels[0];
  const bands = new Map();
  let segCount = 0;
  for (const m of rel.members || []) {
    if (m.type !== 'way' || !m.geometry) continue;
    for (let i = 0; i < m.geometry.length - 1; i++) {
      const a = m.geometry[i];
      const b = m.geometry[i + 1];
      if (!a || !b) continue;
      const seg = [a.lat, a.lon, b.lat, b.lon];
      const lo = Math.floor(Math.min(a.lat, b.lat) / BAND_DEGREES);
      const hi = Math.floor(Math.max(a.lat, b.lat) / BAND_DEGREES);
      for (let k = lo; k <= hi; k++) {
        if (!bands.has(k)) bands.set(k, []);
        bands.get(k).push(seg);
      }
      segCount++;
    }
  }
  if (segCount === 0) throw new Error(`boundary for ${countyName} has no geometry`);
  return bands;
}

// Standard ray-casting point-in-polygon: count how many boundary lines a
// ray heading due east from the point crosses. Odd = inside.
function insideBoundary(bands, lat, lon) {
  const list = bands.get(Math.floor(lat / BAND_DEGREES));
  if (!list) return false;
  let inside = false;
  for (const [y1, x1, y2, x2] of list) {
    if (y1 > lat !== y2 > lat) {
      const x = x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1);
      if (x > lon) inside = !inside;
    }
  }
  return inside;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function haversine(a, b) {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function round(n) {
  return Math.round(n * COORD_DECIMALS) / COORD_DECIMALS;
}

function tileIdForPoint(lat, lon) {
  const latIdx = Math.floor(lat / TILE_DEGREES);
  const lonIdx = Math.floor(lon / TILE_DEGREES);
  return `t_${latIdx}_${lonIdx}`;
}

// Direction traffic may flow, relative to the way's drawn order:
// 1 = with it, -1 = against it, 0 = both ways. Motorways and roundabouts
// are one-way by default in OSM even without an explicit oneway tag.
function onewayOf(tags) {
  const t = tags || {};
  const ow = t.oneway;
  if (ow === 'no') return 0;
  if (ow === 'yes' || ow === 'true' || ow === '1') return 1;
  if (ow === '-1' || ow === 'reverse') return -1;
  if (t.highway === 'motorway') return 1;
  if (t.junction === 'roundabout' || t.junction === 'circular') return 1;
  return 0;
}

function splitIntoChunks(coords, targetMeters) {
  if (coords.length < 2) return [coords];
  const chunks = [];
  let current = [coords[0]];
  let currentLen = 0;
  for (let i = 1; i < coords.length; i++) {
    currentLen += haversine(coords[i - 1], coords[i]);
    current.push(coords[i]);
    if (currentLen >= targetMeters) {
      chunks.push(current);
      current = [coords[i]];
      currentLen = 0;
    }
  }
  if (current.length > 1) chunks.push(current);
  return chunks;
}

function buildQuery(countyName) {
  return `
[out:json][timeout:180];
area["name"="${countyName}"]["boundary"="administrative"]->.searchArea;
(
  way["highway"~"^(${HIGHWAY_CLASSES.join('|')})$"]["access"!~"^(private|no)$"](area.searchArea);
);
out geom;
`;
}

async function queryOverpass(query, label) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`  [${label}] querying ${endpoint} (attempt ${attempt})...`);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            Accept: '*/*',
            'User-Agent': 'tarmacked/0.1 (personal Ireland road-tracking project; github.com/0204Killian/tarmacked)',
          },
          body: query,
        });
        if (res.ok) return res;
        lastError = new Error(`${endpoint} responded ${res.status} ${res.statusText}`);
        if (!RETRYABLE_STATUS.has(res.status)) throw lastError;
        console.warn(`  [${label}] ${lastError.message} — retrying...`);
      } catch (e) {
        lastError = e;
        console.warn(`  [${label}] ${e.message} — retrying...`);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`All endpoints failed. Last error: ${lastError.message}`);
}

function loadIndex() {
  const fs = require('fs');
  if (!fs.existsSync(INDEX_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveIndex(index) {
  const fs = require('fs');
  fs.mkdirSync('tiles', { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
}

async function tileOneCounty(countyName) {
  const code = COUNTY_CODES.indexOf(countyName);
  if (code < 0) throw new Error(`${countyName} isn't in the county code list`);

  const res = await queryOverpass(buildQuery(countyName), countyName);
  const data = await res.json();

  await sleep(BETWEEN_COUNTIES_DELAY_MS);
  const bRes = await queryOverpass(boundaryQuery(countyName), `${countyName} boundary`);
  const boundary = buildBoundary(await bRes.json(), countyName);

  const tiles = new Map(); // tileId -> segments[]
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.geometry) continue;
    const coords = el.geometry.map((pt) => [round(pt.lat), round(pt.lon)]);
    const chunks = splitIntoChunks(coords, CHUNK_TARGET_METERS);
    const oneway = onewayOf(el.tags);
    chunks.forEach((chunkCoords, i) => {
      const id = `way/${el.id}#${i}`;
      const tid = tileIdForPoint(chunkCoords[0][0], chunkCoords[0][1]);
      if (!tiles.has(tid)) tiles.set(tid, []);
      const chunk = { id, coords: chunkCoords };
      if (oneway !== 0) chunk.o = oneway; // omitted for two-way roads to keep files small
      // County = whichever county the chunk's midpoint is actually in.
      // Chunks outside this county (the far end of a road that crosses the
      // border) are left untagged here; that county's own run tags them.
      const mid = chunkCoords[Math.floor(chunkCoords.length / 2)];
      if (insideBoundary(boundary, mid[0], mid[1])) chunk.c = code;
      tiles.get(tid).push(chunk);
    });
  }

  const fs = require('fs');
  fs.mkdirSync('tiles', { recursive: true });
  for (const [tid, segments] of tiles) {
    let existingSegments = [];
    const tilePath = `tiles/${tid}.json`;
    if (fs.existsSync(tilePath)) {
      try {
        existingSegments = JSON.parse(fs.readFileSync(tilePath, 'utf8')).segments || [];
      } catch {
        // corrupt/unexpected existing file — just overwrite it below
      }
    }
    // Fresh data wins: a chunk re-fetched now replaces the old copy (so a
    // re-tile actually updates things like the one-way flag), while chunks
    // from a neighbouring county sharing this tile are kept.
    const byId = new Map(existingSegments.map((s) => [s.id, s]));
    for (const seg of segments) {
      const prev = byId.get(seg.id);
      // Keep a county tag set by the neighbouring county's run.
      if (prev && prev.c !== undefined && seg.c === undefined) byId.set(seg.id, { ...seg, c: prev.c });
      else byId.set(seg.id, seg);
    }
    const merged = Array.from(byId.values());
    fs.writeFileSync(tilePath, JSON.stringify({ segments: merged }));
  }

  const index = loadIndex();
  index[countyName] = Array.from(tiles.keys());
  saveIndex(index);

  const totalSegments = Array.from(tiles.values()).reduce((sum, s) => sum + s.length, 0);
  return { tileCount: tiles.size, segmentCount: totalSegments };
}

async function main() {
  const succeeded = [];
  const failed = [];

  for (const county of COUNTIES) {
    console.log(`\nTiling ${county}...`);
    try {
      const result = await tileOneCounty(county);
      console.log(`  ${county}: ${result.tileCount} tiles, ${result.segmentCount} segments`);
      succeeded.push(county);
    } catch (e) {
      console.error(`  FAILED for ${county}: ${e.message}`);
      failed.push(county);
    }
    await sleep(BETWEEN_COUNTIES_DELAY_MS);
  }

  console.log(`\nDone. ${succeeded.length}/${COUNTIES.length} counties tiled successfully.`);
  writeCountyStats();
  if (failed.length > 0) {
    console.log(`Failed (re-run just these): node scripts/tile-county.js ${failed.map((c) => `"${c}"`).join(' ')}`);
  }
}

// Totals every road chunk across all tiles, once each, by county — the real
// denominators for the app's county and national percentages.
function writeCountyStats() {
  const fs = require('fs');
  const totals = new Array(COUNTY_CODES.length).fill(0);
  let outside = 0;
  const seen = new Set();
  for (const name of fs.readdirSync('tiles')) {
    if (!name.startsWith('t_') || !name.endsWith('.json')) continue;
    const { segments } = JSON.parse(fs.readFileSync(`tiles/${name}`, 'utf8'));
    for (const seg of segments || []) {
      if (seen.has(seg.id)) continue;
      seen.add(seg.id);
      let len = 0;
      for (let i = 0; i < seg.coords.length - 1; i++) len += haversine(seg.coords[i], seg.coords[i + 1]);
      if (seg.c === undefined) outside += len;
      else totals[seg.c] += len;
    }
  }
  const national = totals.reduce((a, b) => a + b, 0);
  fs.writeFileSync(
    STATS_PATH,
    JSON.stringify({ generatedAt: Date.now(), counties: COUNTY_CODES, totalMeters: totals.map(Math.round), nationalMeters: Math.round(national) })
  );
  console.log(`\nCounty totals written to ${STATS_PATH}:`);
  COUNTY_CODES.forEach((c, i) => console.log(`  ${c}: ${(totals[i] / 1000).toFixed(0)} km`));
  console.log(`  Republic of Ireland: ${(national / 1000).toFixed(0)} km`);
  if (outside > 0) console.log(`  (${(outside / 1000).toFixed(0)} km just over the border/outside the Republic — not counted)`);
  const empty = COUNTY_CODES.filter((_, i) => totals[i] === 0);
  if (empty.length > 0) console.log(`  WARNING: no roads counted yet for: ${empty.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
