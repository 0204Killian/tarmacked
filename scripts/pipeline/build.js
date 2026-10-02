// Builds tarmacked's road data from an OpenStreetMap extract (Geofabrik),
// after run.sh has filtered and exported it with osmium. Writes a
// versioned folder of tiles plus a manifest, ready to upload to R2:
//
//   out/manifest.json                      which version each region is on
//   out/<region>/<version>/t_<a>_<b>.json  road pieces, compact format v2
//   out/<region>/<version>/index.json      every tile, and the tiles of each county
//   out/<region>/<version>/stats.json      road totals per county (and per road type)
//   out/<region>/<version>/places.json     towns and villages (for search later)
//   out/<region>/<version>/restrictions.json  turn restrictions (for routing)
//   out/<region>/<version>/graph.json     main-roads routing graph (graph.js)
//
// Usage (run.sh does this): node build.js <region> <version> <data dir> <out dir>

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const L = require('./lib');
const { GraphBuilder } = require('./graph');

const [region = 'ie', version = new Date().toISOString().slice(0, 10), dataDir = 'data', outDir = 'out'] = process.argv.slice(2);

// osmium writes GeoJSON Text Sequences: one feature per line, optionally
// starting with an ASCII record separator.
async function* features(file) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (let line of rl) {
    if (line.charCodeAt(0) === 0x1e) line = line.slice(1);
    line = line.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // skip a broken line rather than the whole build
    }
  }
}

// --- county boundaries (Republic only) ---
const BAND = 0.01;
function buildCounty(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  const bands = new Map();
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        minLat = Math.min(minLat, y1); maxLat = Math.max(maxLat, y1);
        minLon = Math.min(minLon, x1); maxLon = Math.max(maxLon, x1);
        const seg = [y1, x1, y2, x2];
        for (let k = Math.floor(Math.min(y1, y2) / BAND); k <= Math.floor(Math.max(y1, y2) / BAND); k++) {
          if (!bands.has(k)) bands.set(k, []);
          bands.get(k).push(seg);
        }
      }
    }
  }
  return { bands, minLat, maxLat, minLon, maxLon };
}
// Ray casting; holes work because every ring's edges count.
function inside(county, lat, lon) {
  if (lat < county.minLat || lat > county.maxLat || lon < county.minLon || lon > county.maxLon) return false;
  const list = county.bands.get(Math.floor(lat / BAND));
  if (!list) return false;
  let ins = false;
  for (const [y1, x1, y2, x2] of list) {
    if (y1 > lat !== y2 > lat && x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1) > lon) ins = !ins;
  }
  return ins;
}

// --- OPL (restrictions): "r1 v1 ... Ttype=restriction,restriction=no_left_turn Mw1@from,n2@via,w3@to"
const unescapeOpl = (s) => s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
function parseOplRelation(line) {
  const out = { id: 0, tags: {}, members: [] };
  for (const field of line.split(' ')) {
    const k = field[0];
    const v = field.slice(1);
    if (k === 'r') out.id = Number(v);
    else if (k === 'T' && v) {
      for (const kv of v.split(',')) {
        const eq = kv.indexOf('=');
        if (eq > 0) out.tags[unescapeOpl(kv.slice(0, eq))] = unescapeOpl(kv.slice(eq + 1));
      }
    } else if (k === 'M' && v) {
      for (const m of v.split(',')) {
        const at = m.indexOf('@');
        if (at < 1) continue;
        out.members.push({ type: m[0], ref: Number(m.slice(1, at)), role: unescapeOpl(m.slice(at + 1)) });
      }
    }
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const dir = path.join(outDir, region, version);
  fs.mkdirSync(dir, { recursive: true });

  // 1. Counties.
  const counties = new Map(); // code -> boundary
  for await (const f of features(path.join(dataDir, 'admin.geojsonseq'))) {
    const p = f.properties || {};
    const code = L.COUNTY_CODES.indexOf(p.name);
    if (code < 0 || p.boundary !== 'administrative' || !f.geometry) continue;
    // Prefer the county level when a name appears at two levels.
    if (counties.has(code) && p.admin_level !== '6') continue;
    counties.set(code, buildCounty(f.geometry));
  }
  console.log(`counties: ${counties.size}/${L.COUNTY_CODES.length}`);
  const countyAt = (lat, lon) => {
    for (const [code, c] of counties) if (inside(c, lat, lon)) return code;
    return -1;
  };

  // 2. Turn restrictions (via a node): which nodes we need positions for.
  const restrictions = [];
  const viaNodes = new Map(); // node id -> [lat, lon]
  const oplFile = path.join(dataDir, 'restrictions.opl');
  if (fs.existsSync(oplFile)) {
    const rl = readline.createInterface({ input: fs.createReadStream(oplFile), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.startsWith('r')) continue;
      const r = parseOplRelation(line);
      const kind = L.RESTRICTIONS.indexOf(r.tags.restriction || r.tags['restriction:motorcar'] || '');
      const from = r.members.find((m) => m.type === 'w' && m.role === 'from');
      const via = r.members.find((m) => m.role === 'via');
      const to = r.members.find((m) => m.type === 'w' && m.role === 'to');
      if (kind < 0 || !from || !to || !via || via.type !== 'n') continue;
      restrictions.push([from.ref, via.ref, to.ref, kind]);
      viaNodes.set(via.ref, null);
    }
  }

  // 3. Roads -> pieces -> tiles.
  const tiles = new Map(); // tile id -> segments
  const totals = new Array(L.COUNTY_CODES.length).fill(0);
  const byClass = L.COUNTY_CODES.map(() => new Array(L.ROAD_CLASSES.length).fill(0));
  let ways = 0, pieces = 0, skipped = 0;
  const graph = new GraphBuilder();
  for await (const f of features(path.join(dataDir, 'roads.geojsonseq'))) {
    const p = f.properties || {};
    if (!f.geometry || f.geometry.type !== 'LineString' || p['@type'] === 'node') continue;
    if (!L.drivable(p)) {
      skipped++;
      continue;
    }
    const wayId = Number(p['@id']);
    const coords = f.geometry.coordinates.map(([lon, lat]) => [L.round(lat), L.round(lon)]);
    // Positions of turn-restriction junctions, from this way's nodes.
    const nodes = p['@way_nodes'];
    if (Array.isArray(nodes) && viaNodes.size) {
      nodes.forEach((n, i) => {
        if (viaNodes.has(n) && viaNodes.get(n) === null && f.geometry.coordinates[i]) viaNodes.set(n, coords[i]);
      });
    }
    ways++;
    const o = L.onewayOf(p);
    const n = L.roadName(p);
    const h = L.ROAD_CLASSES.indexOf(p.highway);
    const sp = L.speedOf(p);
    const r = p.junction === 'roundabout' || p.junction === 'circular';
    graph.addWay(wayId, nodes, coords, { o, h, sp, r, n });
    L.splitIntoChunks(coords).forEach((cc, i) => {
      if (cc.length < 2) return;
      const mid = cc[Math.floor(cc.length / 2)];
      const c = countyAt(mid[0], mid[1]);
      const seg = { way: wayId, idx: i, coords: cc, o, n, h, sp, r, c: c >= 0 ? c : undefined };
      const tid = L.tileIdForPoint(cc[0][0], cc[0][1]);
      if (!tiles.has(tid)) tiles.set(tid, []);
      tiles.get(tid).push(seg);
      pieces++;
      if (c >= 0) {
        let len = 0;
        for (let k = 0; k < cc.length - 1; k++) len += L.haversine(cc[k], cc[k + 1]);
        totals[c] += len;
        byClass[c][h] += len;
      }
    });
  }
  console.log(`roads: ${ways} ways kept (${skipped} not public/drivable), ${pieces} pieces, ${tiles.size} tiles`);

  // 4. Write tiles + index.
  const countyTiles = L.COUNTY_CODES.map(() => new Set());
  let bytes = 0;
  for (const [tid, segs] of tiles) {
    segs.sort((a, b) => a.way - b.way || a.idx - b.idx);
    for (const s of segs) if (s.c !== undefined) countyTiles[s.c].add(tid);
    const json = JSON.stringify(L.encodeTile(segs));
    bytes += json.length;
    fs.writeFileSync(path.join(dir, `${tid}.json`), json);
  }
  const index = {
    v: 2,
    region,
    version,
    tiles: Array.from(tiles.keys()).sort(),
    counties: Object.fromEntries(L.COUNTY_CODES.map((name, i) => [name, Array.from(countyTiles[i]).sort()])),
    classes: L.ROAD_CLASSES,
  };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));

  // 5. Stats (same shape the app already reads, plus per road type).
  const national = totals.reduce((a, b) => a + b, 0);
  fs.writeFileSync(
    path.join(dir, 'stats.json'),
    JSON.stringify({
      generatedAt: Date.now(),
      version,
      counties: L.COUNTY_CODES,
      totalMeters: totals.map(Math.round),
      nationalMeters: Math.round(national),
      classes: L.ROAD_CLASSES,
      byClass: byClass.map((row) => row.map(Math.round)),
    })
  );

  // 6. Places and restrictions (used by the sat-nav later).
  const places = [];
  for await (const f of features(path.join(dataDir, 'places.geojsonseq'))) {
    const p = f.properties || {};
    const kind = L.PLACE_KINDS.indexOf(p.place);
    if (kind < 0 || !p.name || !f.geometry || f.geometry.type !== 'Point') continue;
    const [lon, lat] = f.geometry.coordinates;
    places.push([p.name, L.round(lat), L.round(lon), kind]);
  }
  fs.writeFileSync(path.join(dir, 'places.json'), JSON.stringify({ kinds: L.PLACE_KINDS, places }));
  const rOut = restrictions
    .filter(([, via]) => viaNodes.get(via))
    .map(([from, via, to, kind]) => [from, ...viaNodes.get(via), to, kind]);
  fs.writeFileSync(path.join(dir, 'restrictions.json'), JSON.stringify({ kinds: L.RESTRICTIONS, r: rOut }));

  // 6b. Routing graph (main roads) for the sat-nav.
  const g = graph.build(region, version);
  const graphJson = JSON.stringify(g.graph);
  fs.writeFileSync(path.join(dir, 'graph.json'), graphJson);

  // 7. Manifest (other regions kept as they are).
  const manifestPath = path.join(outDir, 'manifest.json');
  let manifest = { v: 1, regions: {} };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    // first build
  }
  manifest.regions = manifest.regions || {};
  manifest.regions[region] = { version, path: `${region}/${version}/`, tiles: tiles.size, builtAt: Date.now() };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Summary.
  console.log(`tiles: ${(bytes / 1e6).toFixed(1)} MB before compression`);
  console.log(`places: ${places.length}, turn restrictions: ${rOut.length}/${restrictions.length}`);
  console.log(`routing graph: ${g.graph.nodes.length / 2} junctions, ${g.graph.edges.length} links, ${(g.meters / 1000).toFixed(0)} km of main road, ${(graphJson.length / 1e6).toFixed(1)} MB`);
  console.log('\nRoad totals:');
  L.COUNTY_CODES.forEach((c, i) => console.log(`  ${c.padEnd(18)} ${(totals[i] / 1000).toFixed(0).padStart(6)} km${counties.has(i) ? '' : '   (NO BOUNDARY FOUND)'}`));
  console.log(`  ${'Republic'.padEnd(18)} ${(national / 1000).toFixed(0).padStart(6)} km`);
  const missing = L.COUNTY_CODES.filter((_, i) => !counties.has(i) || totals[i] === 0);
  if (missing.length) console.log(`\nWARNING: check these counties: ${missing.join(', ')}`);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${dir}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { parseOplRelation, buildCounty, inside };
