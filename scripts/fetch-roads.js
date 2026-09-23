// Fetches the road network for a given OSM administrative area (e.g. an
// Irish county) from the Overpass API and writes it out as a compact JSON
// file that gets bundled directly into the app.
//
// Each OSM "way" can represent a very long stretch of road (sometimes
// kilometers, right up to the next junction), so we split each one into
// short chunks before saving. Otherwise matching a single point to a way
// would light up the road's entire length, not just the part driven.
//
// Usage: node scripts/fetch-roads.js "County Kilkenny" assets/roads/kilkenny.json

const AREA_NAME = process.argv[2];
const OUT_PATH = process.argv[3];

if (!AREA_NAME || !OUT_PATH) {
  console.error('Usage: node scripts/fetch-roads.js "<OSM area name>" <output path>');
  process.exit(1);
}

// Public road classes only — deliberately excludes tracks, service roads,
// driveways and paths, since those shouldn't count toward "roads driven".
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

// Overpass is a shared free service — the main server occasionally times
// out (504) or rate-limits (429) under load. Falling back to a different
// mirror, and retrying, makes this reliable instead of a coin flip.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAY_MS = 5000;

const CHUNK_TARGET_METERS = 100;
// ~1.1m precision at this latitude — far tighter than the 25m match
// threshold needs, but keeps the file much smaller than full float
// precision would.
const COORD_DECIMALS = 100000;

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

// Splits a way's coordinate list into consecutive chunks, each roughly
// targetMeters long. Chunks share an endpoint with their neighbor so the
// road stays visually continuous if adjacent chunks are both driven.
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
        if (!RETRYABLE_STATUS.has(res.status)) throw lastError; // not worth retrying, e.g. a bad query
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
  const segments = [];

  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.geometry) continue;
    const coords = el.geometry.map((pt) => [round(pt.lat), round(pt.lon)]);
    const chunks = splitIntoChunks(coords, CHUNK_TARGET_METERS);
    chunks.forEach((chunkCoords, i) => {
      segments.push({ id: `way/${el.id}#${i}`, coords: chunkCoords });
    });
  }

  console.log(`Got ${segments.length} road segments (chunked to ~${CHUNK_TARGET_METERS}m each).`);

  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ county: AREA_NAME, segments }));

  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
