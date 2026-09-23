// Fetches a county's public roads and splits them into small geographic
// tiles, written to tiles/<tileId>.json. These get committed to the repo
// and served live over GitHub's raw file CDN — the app fetches whichever
// tile it needs on demand as it enters new areas, no server required.
//
// Usage: node scripts/tile-county.js "County Carlow"

const AREA_NAME = process.argv[2];

if (!AREA_NAME) {
  console.error('Usage: node scripts/tile-county.js "<OSM area name>"');
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

const query = `
[out:json][timeout:180];
area["name"="${AREA_NAME}"]["boundary"="administrative"]->.searchArea;
(
  way["highway"~"^(${HIGHWAY_CLASSES.join('|')})$"]["access"!~"^(private|no)$"](area.searchArea);
);
out geom;
`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAY_MS = 5000;

const CHUNK_TARGET_METERS = 100;
const COORD_DECIMALS = 100000; // ~1.1m precision

// Must match tileIdForPoint() in App.tsx exactly — 0.05° cells, ~5.5km x
// ~3.5km at Irish latitudes.
const TILE_DEGREES = 0.05;

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

async function queryOverpass() {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`Querying ${endpoint} (attempt ${attempt})...`);
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
        console.warn(`${lastError.message} — retrying...`);
      } catch (e) {
        lastError = e;
        console.warn(`${e.message} — retrying...`);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`All Overpass endpoints failed. Last error: ${lastError.message}`);
}

async function main() {
  console.log(`Querying Overpass for public roads in "${AREA_NAME}"...`);
  const res = await queryOverpass();
  const data = await res.json();

  const tiles = new Map(); // tileId -> segments[]

  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.geometry) continue;
    const coords = el.geometry.map((pt) => [round(pt.lat), round(pt.lon)]);
    const chunks = splitIntoChunks(coords, CHUNK_TARGET_METERS);
    chunks.forEach((chunkCoords, i) => {
      const id = `way/${el.id}#${i}`;
      // Tile is decided by the chunk's first point — chunks are ~100m and
      // tiles are ~5km, so a chunk straddling a tile edge is rare enough
      // to not worry about for now.
      const tid = tileIdForPoint(chunkCoords[0][0], chunkCoords[0][1]);
      if (!tiles.has(tid)) tiles.set(tid, []);
      tiles.get(tid).push({ id, coords: chunkCoords });
    });
  }

  const fs = require('fs');
  fs.mkdirSync('tiles', { recursive: true });
  for (const [tid, segments] of tiles) {
    fs.writeFileSync(`tiles/${tid}.json`, JSON.stringify({ segments }));
  }

  const totalSegments = Array.from(tiles.values()).reduce((sum, s) => sum + s.length, 0);
  console.log(`Wrote ${tiles.size} tiles covering ${AREA_NAME} (${totalSegments} segments total).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
