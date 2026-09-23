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

const REST_OF_ROI = [
  'County Dublin', 'County Kildare', 'County Longford', 'County Louth',
  'County Meath', 'County Offaly', 'County Westmeath', 'County Wexford', 'County Wicklow',
  'County Galway', 'County Leitrim', 'County Mayo', 'County Roscommon', 'County Sligo',
  'County Clare', 'County Cork', 'County Kerry', 'County Limerick',
  'County Tipperary', 'County Waterford',
  'County Cavan', 'County Donegal', 'County Monaghan',
];

const args = process.argv.slice(2);
const COUNTIES = args[0] === '--rest-of-roi' ? REST_OF_ROI : args;

if (COUNTIES.length === 0) {
  console.error('Usage: node scripts/tile-county.js "<County Name>" ["<Another County>" ...] | --rest-of-roi');
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
  const res = await queryOverpass(buildQuery(countyName), countyName);
  const data = await res.json();

  const tiles = new Map(); // tileId -> segments[]
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.geometry) continue;
    const coords = el.geometry.map((pt) => [round(pt.lat), round(pt.lon)]);
    const chunks = splitIntoChunks(coords, CHUNK_TARGET_METERS);
    chunks.forEach((chunkCoords, i) => {
      const id = `way/${el.id}#${i}`;
      const tid = tileIdForPoint(chunkCoords[0][0], chunkCoords[0][1]);
      if (!tiles.has(tid)) tiles.set(tid, []);
      tiles.get(tid).push({ id, coords: chunkCoords });
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
    const existingIds = new Set(existingSegments.map((s) => s.id));
    const merged = [...existingSegments, ...segments.filter((s) => !existingIds.has(s.id))];
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
  if (failed.length > 0) {
    console.log(`Failed (re-run just these): node scripts/tile-county.js ${failed.map((c) => `"${c}"`).join(' ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
