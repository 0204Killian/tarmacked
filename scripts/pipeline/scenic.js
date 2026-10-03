// Builds a region's scenic.json (v0.21): the road pieces of each scenic
// drive in scenic-drives.js, from the region's finished tiles and its OSM
// route relations.
//
//   node scenic.js <region> <version dir> <routes.opl | ->
//
// scenic.json: { v: 1, drives: [{ id, name, where, blurb, need, m,
//   box: [s, w, n, e], pieces: [[way, idx, metres, idx, metres, ...], ...],
//   lines: [[lat, lon, dlat, dlon, ...], ...] }] }
// pieces: every road piece on the drive with its length (the app adds up
// what you've driven of them); lines: the route simplified for the map,
// in 1e-5 degrees, delta-coded like the tiles.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const L = require('./lib');
const { parseOplRelation } = require('./build');
const { SCENIC } = require('./scenic-drives');

const LINK_CLASSES = new Set(L.ROAD_CLASSES.filter((c) => c.endsWith('_link')).map((c) => L.ROAD_CLASSES.indexOf(c)));

// Route relations: name -> member ways and sub-relations.
async function readRoutes(file) {
  const rels = new Map();
  if (!file || file === '-' || !fs.existsSync(file)) return rels;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line[0] !== 'r') continue;
    const r = parseOplRelation(line);
    rels.set(r.id, { name: r.tags.name || '', ways: r.members.filter((m) => m.type === 'w').map((m) => m.ref), subs: r.members.filter((m) => m.type === 'r').map((m) => m.ref) });
  }
  return rels;
}

/** Way IDs of every relation whose name matches, following sub-relations. */
function waysOfRelations(rels, pattern) {
  const ways = new Set();
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const r = rels.get(id);
    if (!r) return;
    r.ways.forEach((w) => ways.add(w));
    r.subs.forEach(visit);
  };
  for (const [id, r] of rels) if (pattern.test(r.name)) visit(id);
  return ways;
}

const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
const mid = (coords) => coords[Math.floor(coords.length / 2)];
const refsOf = (name) => (name ? name.split(' ')[0].split('/') : []);

function matchesRoad(seg, rule) {
  if (!inBox(mid(seg.coords), rule.box)) return false;
  if (seg.r || LINK_CLASSES.has(seg.h)) return false; // roundabouts and slip roads
  if (rule.ref) return refsOf(seg.n).includes(rule.ref);
  if (rule.name) return !!seg.n && (seg.n === rule.name || seg.n.endsWith(` ${rule.name}`));
  return false;
}

function lengthOf(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += L.haversine(coords[i - 1], coords[i]);
  return m;
}

// Douglas-Peucker on [lat, lon] in degrees (fine for drawing).
function simplify(line, tol) {
  if (line.length <= 2) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ay, ax] = line[a];
    const [by, bx] = line[b];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let worst = -1, worstD = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = line[i];
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

// A way's pieces joined end to end (in order), for drawing.
function linesOf(segs) {
  const byWay = new Map();
  for (const s of segs) {
    if (!byWay.has(s.way)) byWay.set(s.way, []);
    byWay.get(s.way).push(s);
  }
  const lines = [];
  for (const list of byWay.values()) {
    list.sort((a, b) => a.idx - b.idx);
    let cur = null;
    let lastIdx = -2;
    for (const s of list) {
      if (cur && s.idx === lastIdx + 1) cur.push(...s.coords.slice(1));
      else {
        if (cur) lines.push(cur);
        cur = s.coords.slice();
      }
      lastIdx = s.idx;
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

const encodeLine = (line) => {
  const out = [];
  let pa = 0, po = 0;
  line.forEach(([la, lo], i) => {
    const a = Math.round(la * L.COORD_SCALE);
    const o = Math.round(lo * L.COORD_SCALE);
    if (i === 0) out.push(a, o);
    else out.push(a - pa, o - po);
    pa = a;
    po = o;
  });
  return out;
};

async function buildScenic(region, dir, routesFile, defs = SCENIC[region] ?? []) {
  if (!defs.length) return null;
  const rels = await readRoutes(routesFile);
  const segs = [];
  for (const f of fs.readdirSync(dir)) if (/^t_-?\d+_-?\d+\.json$/.test(f)) segs.push(...L.decodeTile(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
  const drives = [];
  for (const d of defs) {
    let picked = [];
    if (d.relation) {
      const ways = waysOfRelations(rels, d.relation);
      picked = segs.filter((s) => ways.has(s.way));
    }
    if (!picked.length && d.roads) picked = segs.filter((s) => d.roads.some((rule) => matchesRoad(s, rule)));
    if (!picked.length) {
      console.log(`scenic: ${d.name}: no roads found, left out`);
      continue;
    }
    // Pieces grouped by way: [way, idx, metres, idx, metres...].
    const byWay = new Map();
    let total = 0;
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const p of picked) {
      const m = Math.round(lengthOf(p.coords));
      total += m;
      if (!byWay.has(p.way)) byWay.set(p.way, []);
      byWay.get(p.way).push(p.idx, m);
      for (const [la, lo] of p.coords) {
        s = Math.min(s, la);
        n = Math.max(n, la);
        w = Math.min(w, lo);
        e = Math.max(e, lo);
      }
    }
    const lines = linesOf(picked).map((l) => encodeLine(simplify(l, 0.0002)));
    drives.push({
      id: d.id,
      name: d.name,
      where: d.where,
      blurb: d.blurb,
      need: d.need ?? 1,
      m: total,
      box: [s, w, n, e].map((x) => Math.round(x * 1e4) / 1e4),
      pieces: [...byWay.entries()].map(([way, list]) => [way, ...list]),
      lines,
    });
    console.log(`scenic: ${d.name}: ${(total / 1000).toFixed(0)} km, ${picked.length} pieces`);
  }
  if (!drives.length) return null;
  const out = { v: 1, drives };
  fs.writeFileSync(path.join(dir, 'scenic.json'), JSON.stringify(out));
  return out;
}

module.exports = { buildScenic, waysOfRelations, readRoutes, matchesRoad };

if (require.main === module) {
  const [region, dir, routes] = process.argv.slice(2);
  buildScenic(region, dir, routes).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
