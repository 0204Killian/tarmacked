// Fetches just the TOTAL road length (in meters) for each remaining Irish
// county — not the full road geometry. Used only as the denominator for a
// national "% of Ireland driven" figure. Counties we have full bundled
// data for (Kilkenny, Laois) compute their own total directly in the app
// from that data, so they're deliberately not included here.
//
// Usage: node scripts/fetch-county-totals.js

const OUT_PATH = 'assets/roads/county-totals.json';

// Republic of Ireland's 26 traditional counties, minus Kilkenny and Laois
// (already covered by full bundled data).
const COUNTIES = [
  'County Carlow', 'County Dublin', 'County Kildare', 'County Longford',
  'County Louth', 'County Meath', 'County Offaly', 'County Westmeath',
  'County Wexford', 'County Wicklow',
  'County Galway', 'County Leitrim', 'County Mayo', 'County Roscommon', 'County Sligo',
  'County Clare', 'County Cork', 'County Kerry', 'County Limerick',
  'County Tipperary', 'County Waterford',
  'County Cavan', 'County Donegal', 'County Monaghan',
];

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
const BETWEEN_COUNTIES_DELAY_MS = 3000; // be a considerate citizen of a free shared service

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildQuery(countyName) {
  return `
[out:json][timeout:180];
area["name"="${countyName}"]["boundary"="administrative"]->.searchArea;
way["highway"~"^(${HIGHWAY_CLASSES.join('|')})$"]["access"!~"^(private|no)$"](area.searchArea);
make stat total_length=sum(length());
out body;
`;
}

async function queryOverpass(query, label) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
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
  throw new Error(`All endpoints failed for ${label}. Last error: ${lastError.message}`);
}

async function main() {
  const results = [];
  const failures = [];

  for (const county of COUNTIES) {
    console.log(`Fetching total road length for ${county}...`);
    try {
      const res = await queryOverpass(buildQuery(county), county);
      const data = await res.json();
      const statElement = (data.elements || []).find((el) => el.tags && el.tags.total_length !== undefined);
      if (!statElement) {
        throw new Error('response had no "stat" element with total_length — Overpass may have changed the format');
      }
      const totalMeters = parseFloat(statElement.tags.total_length);
      console.log(`  ${county}: ${(totalMeters / 1000).toFixed(1)} km`);
      results.push({ county, totalMeters });
    } catch (e) {
      console.error(`  FAILED for ${county}: ${e.message}`);
      failures.push(county);
    }
    await sleep(BETWEEN_COUNTIES_DELAY_MS);
  }

  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(results));

  console.log(`\nWrote ${results.length}/${COUNTIES.length} counties to ${OUT_PATH}`);
  if (failures.length > 0) {
    console.log(`Failed (missing from the file, will show as 0 until re-run): ${failures.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
