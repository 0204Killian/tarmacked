// Joins a region's built parts (build.js) into the folder phones download:
//
//   out/<region>/<version>/t_<a>_<b>.json  road pieces, compact format v2
//   out/<region>/<version>/index.json      every tile, and the tiles of each area
//   out/<region>/<version>/stats.json      road totals per area (and per road type)
//   out/<region>/<version>/graph.json      routing graph (graph.js), v2
//   out/<region>/<version>/places.json     towns and villages (search)
//   out/<region>/<version>/restrictions.json  turn restrictions (routing)
//   out/entry-<region>.json                its manifest entry (publish.js)
//
//   node merge.js <region> <version> <parts dir> <areas.json> <out dir>

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { mergeGraphs } = require('./graph');
const { byId } = require('./regions');

function merge(region, version, partsDir, areas, outDir) {
  const dir = path.join(outDir, region, version);
  fs.mkdirSync(dir, { recursive: true });
  const parts = fs
    .readdirSync(partsDir)
    .filter((d) => fs.existsSync(path.join(partsDir, d, 'part.json')))
    .sort()
    .map((d) => path.join(partsDir, d));
  if (!parts.length) throw new Error(`no built parts in ${partsDir}`);

  // 1. Tiles: a tile in one part is copied; in several, its pieces are joined.
  const where = new Map(); // tile id -> part dirs
  for (const p of parts) {
    for (const f of fs.readdirSync(path.join(p, 'tiles'))) {
      const tid = f.replace(/\.json$/, '');
      if (!where.has(tid)) where.set(tid, []);
      where.get(tid).push(p);
    }
  }
  let bytes = 0;
  for (const [tid, ps] of where) {
    const out = path.join(dir, `${tid}.json`);
    if (ps.length === 1) {
      fs.copyFileSync(path.join(ps[0], 'tiles', `${tid}.json`), out);
      bytes += fs.statSync(out).size;
      continue;
    }
    const byIdMap = new Map();
    for (const p of ps) {
      for (const seg of L.decodeTile(JSON.parse(fs.readFileSync(path.join(p, 'tiles', `${tid}.json`), 'utf8')))) byIdMap.set(`${seg.way}#${seg.idx}`, seg);
    }
    const segs = [...byIdMap.values()].sort((a, b) => a.way - b.way || a.idx - b.idx);
    const json = JSON.stringify(L.encodeTile(segs));
    bytes += json.length;
    fs.writeFileSync(out, json);
  }

  // 2. Stats and the area -> tiles lists.
  const n = areas.names.length;
  const totals = new Array(n).fill(0);
  const byClass = areas.names.map(() => new Array(L.ROAD_CLASSES.length).fill(0));
  const areaTiles = areas.names.map(() => new Set());
  let outside = 0;
  const summaries = [];
  for (const p of parts) {
    const st = JSON.parse(fs.readFileSync(path.join(p, 'stats.json'), 'utf8'));
    st.totals.forEach((m, i) => (totals[i] += m));
    st.byClass.forEach((row, i) => row.forEach((m, k) => (byClass[i][k] += m)));
    st.areaTiles.forEach((list, i) => list.forEach((t) => areaTiles[i].add(t)));
    outside += st.outside;
    summaries.push(JSON.parse(fs.readFileSync(path.join(p, 'part.json'), 'utf8')));
  }
  const tiles = [...where.keys()].sort();
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      v: 2,
      region,
      version,
      tiles,
      counties: Object.fromEntries(areas.names.map((name, i) => [name, [...areaTiles[i]].sort()])),
      classes: L.ROAD_CLASSES,
    })
  );
  // Ireland: the app's "national" figures are the Republic's 26 counties
  // (Northern Ireland's are listed after them, under areas).
  const national = region === 'ie' ? L.REPUBLIC_COUNTIES : n;
  const r = (a) => a.map(Math.round);
  fs.writeFileSync(
    path.join(dir, 'stats.json'),
    JSON.stringify({
      generatedAt: Date.now(),
      version,
      counties: areas.names.slice(0, national),
      totalMeters: r(totals.slice(0, national)),
      nationalMeters: Math.round(totals.slice(0, national).reduce((a, b) => a + b, 0)),
      classes: L.ROAD_CLASSES,
      byClass: byClass.slice(0, national).map(r),
      areas: areas.names,
      areaLevel: areas.level,
      areaMeters: r(totals),
      areaByClass: byClass.map(r),
      outsideMeters: Math.round(outside),
    })
  );

  // 3. Routing graph.
  const g = mergeGraphs(
    parts.map((p) => JSON.parse(fs.readFileSync(path.join(p, 'graph.json'), 'utf8'))),
    region,
    version
  );
  const graphJson = JSON.stringify(g.graph);
  fs.writeFileSync(path.join(dir, 'graph.json'), graphJson);

  // 4. Places and restrictions (parts overlap a little: each kept once).
  const placeKeys = new Set();
  const places = [];
  const restrKeys = new Set();
  const restr = [];
  for (const p of parts) {
    for (const pl of JSON.parse(fs.readFileSync(path.join(p, 'places.json'), 'utf8'))) {
      const k = pl.join('|');
      if (placeKeys.has(k)) continue;
      placeKeys.add(k);
      places.push(pl);
    }
    for (const rs of JSON.parse(fs.readFileSync(path.join(p, 'restrictions.json'), 'utf8'))) {
      const k = rs.join('|');
      if (restrKeys.has(k)) continue;
      restrKeys.add(k);
      restr.push(rs);
    }
  }
  fs.writeFileSync(path.join(dir, 'places.json'), JSON.stringify({ kinds: L.PLACE_KINDS, places }));
  fs.writeFileSync(path.join(dir, 'restrictions.json'), JSON.stringify({ kinds: L.RESTRICTIONS, r: restr }));

  // 5. Its manifest entry, with the area it covers (for the app to pick regions).
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const t of tiles) {
    const [, a, b] = t.split('_').map(Number);
    minLat = Math.min(minLat, a * L.TILE_DEGREES);
    maxLat = Math.max(maxLat, (a + 1) * L.TILE_DEGREES);
    minLon = Math.min(minLon, b * L.TILE_DEGREES);
    maxLon = Math.max(maxLon, (b + 1) * L.TILE_DEGREES);
  }
  const entry = {
    id: region,
    name: byId(region)?.name ?? region,
    version,
    path: `${region}/${version}/`,
    tiles: tiles.length,
    builtAt: Date.now(),
    bbox: tiles.length ? [minLat, minLon, maxLat, maxLon].map((x) => Math.round(x * 100) / 100) : null,
    // 1-degree squares with roads, so the app can tell which countries a trip crosses.
    cells: [...new Set(tiles.map((t) => {
      const [, la, lo] = t.split('_').map(Number);
      return `${Math.floor(la * L.TILE_DEGREES)},${Math.floor(lo * L.TILE_DEGREES)}`;
    }))].sort(),
    km: Math.round(totals.reduce((a, b) => a + b, 0) / 1000),
  };
  fs.writeFileSync(path.join(outDir, `entry-${region}.json`), JSON.stringify(entry, null, 2));

  // Summary.
  const sum = (k) => summaries.reduce((a, s) => a + (s[k] || 0), 0);
  console.log(`\n${entry.name} (${region}) ${version}: ${parts.length} part(s)`);
  console.log(`tiles: ${tiles.length}, ${(bytes / 1e6).toFixed(1)} MB before compression; ${sum('cut')} pieces over the border left out`);
  console.log(`places: ${places.length}, turn restrictions: ${restr.length}, ferries: ${sum('ferries')}`);
  console.log(`routing graph: ${g.graph.nodes.length / 2} junctions, ${g.graph.edges.length} links, ${(g.meters / 1000).toFixed(0)} km of main road, ${(graphJson.length / 1e6).toFixed(1)} MB`);
  console.log(`\nRoad totals (areas at admin level ${areas.level}):`);
  areas.names.forEach((name, i) => console.log(`  ${name.padEnd(28)} ${(totals[i] / 1000).toFixed(0).padStart(7)} km${areas.polys[i] ? '' : '   (NO BOUNDARY FOUND)'}`));
  if (region === 'ie') console.log(`  ${'Republic'.padEnd(28)} ${(totals.slice(0, L.REPUBLIC_COUNTIES).reduce((a, b) => a + b, 0) / 1000).toFixed(0).padStart(7)} km`);
  console.log(`  ${'Total'.padEnd(28)} ${(totals.reduce((a, b) => a + b, 0) / 1000).toFixed(0).padStart(7)} km (+${(outside / 1000).toFixed(0)} km in no area)`);
  return entry;
}

module.exports = { merge };

if (require.main === module) {
  const [region, version, partsDir, areasFile, outDir] = process.argv.slice(2);
  try {
    merge(region, version, partsDir, JSON.parse(fs.readFileSync(areasFile, 'utf8')), outDir);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
