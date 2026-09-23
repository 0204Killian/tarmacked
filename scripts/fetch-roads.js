// Fetches the road network for a given OSM administrative area (e.g. an
// Irish county) from the Overpass API and writes it out as a compact JSON
// file that gets bundled directly into the app.
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

async function main() {
  console.log(`Querying Overpass for public roads in "${AREA_NAME}"...`);
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      Accept: '*/*',
      // Overpass's public server rejects requests without a descriptive
      // User-Agent as part of its anti-abuse rules — Node's default fetch
      // sends none, which is what causes a 406 here.
      'User-Agent': 'tarmacked/0.1 (personal Ireland road-tracking project; github.com/0204Killian/tarmacked)',
    },
    body: query,
  });

  if (!res.ok) {
    throw new Error(`Overpass request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const segments = (data.elements || [])
    .filter((el) => el.type === 'way' && el.geometry)
    .map((el) => ({
      id: `way/${el.id}`,
      county: AREA_NAME,
      coords: el.geometry.map((pt) => [pt.lat, pt.lon]),
    }));

  console.log(`Got ${segments.length} public road segments.`);

  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(segments));

  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
