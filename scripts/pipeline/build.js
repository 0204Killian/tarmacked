// Builds one PART of a region's road data from an OpenStreetMap extract
// (Geofabrik), after run.sh has cut the part and exported it with osmium.
// Small regions are one part; big countries are cut into several so a part
// never needs more memory than Ireland does. merge.js then joins the parts.
//
//   node build.js <region> <data dir> <part out dir> <areas.json> [bbox] [main] [country]
//     bbox     minLat,minLon,maxLat,maxLon: road totals only count pieces
//              whose middle is in it (parts overlap where roads cross)
//     main     road types in the routing graph (regions.js), default 10
//     country  ISO code, for what "DE:rural"-style limits mean
//
// Reads from the data dir: roads.geojsonseq (with node IDs), nodes.geojsonseq
// (traffic lights, signs, level crossings, toll booths), ferries.geojsonseq,
// places.geojsonseq, restrictions.opl. Writes to the part dir: tiles/*.json
// (compact v2, see lib.js), graph.json (partial, by OSM node ID),
// stats.json, places.json, restrictions.json.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const L = require('./lib');
const { GraphBuilder, FERRY } = require('./graph');

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

// --- areas (counties etc.): polygons with a grid of candidates per cell ---
const CELL = 0.05;
function indexAreas(areas) {
  const cells = new Map();
  const shapes = areas.polys.map((rings, code) => {
    if (!rings) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const ring of rings) {
      for (const [la, lo] of ring) {
        if (la < minLat) minLat = la;
        if (la > maxLat) maxLat = la;
        if (lo < minLon) minLon = lo;
        if (lo > maxLon) maxLon = lo;
      }
    }
    for (let x = Math.floor(minLat / CELL); x <= Math.floor(maxLat / CELL); x++) {
      for (let y = Math.floor(minLon / CELL); y <= Math.floor(maxLon / CELL); y++) {
        const k = `${x},${y}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(code);
      }
    }
    return bandIndex(rings);
  });
  return (lat, lon) => {
    for (const code of cells.get(`${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`) ?? []) {
      if (insideBands(shapes[code], lat, lon)) return code;
    }
    return -1;
  };
}

// Ray casting over edges bucketed by latitude band; holes work because
// every ring's edges count.
const BAND = 0.01;
function bandIndex(rings) {
  const bands = new Map();
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [y1, x1] = ring[i];
      const [y2, x2] = ring[i + 1];
      const seg = [y1, x1, y2, x2];
      for (let k = Math.floor(Math.min(y1, y2) / BAND); k <= Math.floor(Math.max(y1, y2) / BAND); k++) {
        if (!bands.has(k)) bands.set(k, []);
        bands.get(k).push(seg);
      }
    }
  }
  return bands;
}
function insideBands(bands, lat, lon) {
  if (!bands) return false;
  const list = bands.get(Math.floor(lat / BAND));
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

async function buildPart(opts) {
  const { region, dataDir, outDir, areas, bbox = null, main = 10, country = '' } = opts;
  fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true });
  const areaAt = indexAreas(areas);
  const clip = areas.clip ? bandIndex(areas.clip) : null;
  const inClip = (la, lo) => !clip || insideBands(clip, la, lo);
  const inPart = (la, lo) => !bbox || (la >= bbox[0] && lo >= bbox[1] && la < bbox[2] && lo < bbox[3]);
  const nAreas = areas.names.length;

  // 1. Nodes that cost time (and toll booths).
  const delays = new Map(); // OSM node id -> { s, toll }
  for await (const f of features(path.join(dataDir, 'nodes.geojsonseq'))) {
    const p = f.properties || {};
    const kind = L.nodeKind(p);
    if (!kind || p['@id'] === undefined) continue;
    delays.set(Number(p['@id']), { s: L.NODE_DELAY_S[kind], toll: kind === 'toll_booth' });
  }

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

  // 3. Roads -> pieces -> tiles; every way also goes to the routing graph.
  const tiles = new Map(); // tile id -> segments
  const totals = new Array(nAreas).fill(0);
  const byClass = areas.names.map(() => new Array(L.ROAD_CLASSES.length).fill(0));
  let outside = 0; // metres in no area (or the area of a part's neighbour)
  let ways = 0, pieces = 0, skipped = 0, cut = 0;
  const graph = new GraphBuilder(main, (id) => delays.get(id) ?? null);
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
    const sp = L.speedOf(p, country);
    const r = p.junction === 'roundabout' || p.junction === 'circular';
    const t = L.tollOf(p);
    const u = L.unpavedOf(p);
    graph.addWay(wayId, nodes, coords, { o, h, sp, r, n, t, u });
    L.splitIntoChunks(coords).forEach((cc, i) => {
      if (cc.length < 2) return;
      const mid = cc[Math.floor(cc.length / 2)];
      if (!inClip(mid[0], mid[1])) {
        cut++;
        return; // the neighbouring country's road: its own region has it
      }
      const c = areaAt(mid[0], mid[1]);
      const seg = { way: wayId, idx: i, coords: cc, o, n, h, sp, r, t, u, c: c >= 0 ? c : undefined };
      const tid = L.tileIdForPoint(cc[0][0], cc[0][1]);
      if (!tiles.has(tid)) tiles.set(tid, []);
      tiles.get(tid).push(seg);
      pieces++;
      if (!inPart(mid[0], mid[1])) return; // counted by the part it's in
      let len = 0;
      for (let k = 0; k < cc.length - 1; k++) len += L.haversine(cc[k], cc[k + 1]);
      if (c >= 0) {
        totals[c] += len;
        byClass[c][h] += len;
      } else outside += len;
    });
  }

  // 3b. Car ferries: routing graph only (they aren't roads you drive).
  let ferries = 0;
  for await (const f of features(path.join(dataDir, 'ferries.geojsonseq'))) {
    const p = f.properties || {};
    if (!f.geometry || f.geometry.type !== 'LineString' || !L.carFerry(p)) continue;
    const coords = f.geometry.coordinates.map(([lon, lat]) => [L.round(lat), L.round(lon)]);
    graph.addWay(Number(p['@id']), p['@way_nodes'], coords, { o: L.onewayOf(p), h: FERRY, sp: 0, r: false, n: p.name || null, ferryTags: p });
    ferries++;
  }

  // 4. Tiles, and which tiles each area has (to download a home county).
  let bytes = 0;
  const areaTiles = areas.names.map(() => new Set());
  for (const [tid, segs] of tiles) {
    segs.sort((a, b) => a.way - b.way || a.idx - b.idx);
    for (const sg of segs) if (sg.c !== undefined) areaTiles[sg.c].add(tid);
    const json = JSON.stringify(L.encodeTile(segs));
    bytes += json.length;
    fs.writeFileSync(path.join(outDir, 'tiles', `${tid}.json`), json);
  }

  // 5. Places (ones inside the part's box; the border cut applies too).
  const places = [];
  for await (const f of features(path.join(dataDir, 'places.geojsonseq'))) {
    const p = f.properties || {};
    const kind = L.PLACE_KINDS.indexOf(p.place);
    if (kind < 0 || !p.name || !f.geometry || f.geometry.type !== 'Point') continue;
    const [lon, lat] = f.geometry.coordinates;
    if (!inPart(lat, lon) || !inClip(lat, lon)) continue;
    places.push([p.name, L.round(lat), L.round(lon), kind]);
  }
  const rOut = restrictions.filter(([, via]) => viaNodes.get(via)).map(([from, via, to, kind]) => [from, ...viaNodes.get(via), to, kind]);
  const g = graph.buildPart();

  fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify({ nodes: g.nodes, edges: g.edges }));
  fs.writeFileSync(path.join(outDir, 'places.json'), JSON.stringify(places));
  fs.writeFileSync(path.join(outDir, 'restrictions.json'), JSON.stringify(rOut));
  fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify({ totals, byClass, outside, areaTiles: areaTiles.map((t) => [...t]) }));
  const summary = { region, ways, skipped, pieces, cut, ferries, tiles: tiles.size, bytes, graphLinks: g.edges.length, graphKm: Math.round(g.meters / 1000), places: places.length, restrictions: rOut.length };
  fs.writeFileSync(path.join(outDir, 'part.json'), JSON.stringify(summary));
  return summary;
}

module.exports = { buildPart, parseOplRelation, indexAreas, bandIndex, insideBands };

if (require.main === module) {
  const [region, dataDir, outDir, areasFile, bboxArg, mainArg, country] = process.argv.slice(2);
  const t0 = Date.now();
  const bbox = bboxArg && bboxArg !== '-' ? bboxArg.split(',').map(Number) : null;
  buildPart({ region, dataDir, outDir, areas: JSON.parse(fs.readFileSync(areasFile, 'utf8')), bbox, main: Number(mainArg) || 10, country: country || '' })
    .then((s) =>
      console.log(
        `  part: ${s.ways} roads (${s.skipped} not public), ${s.pieces} pieces in ${s.tiles} tiles, ${(s.bytes / 1e6).toFixed(1)} MB` +
          `${s.cut ? `, ${s.cut} pieces over the border left out` : ''}; graph ${s.graphLinks} links / ${s.graphKm} km, ${s.ferries} ferries; ${((Date.now() - t0) / 1000).toFixed(0)} s`
      )
    )
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
