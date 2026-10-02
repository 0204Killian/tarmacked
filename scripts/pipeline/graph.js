// The sat-nav's country-wide routing graph (graph.json): main roads only
// (motorway down to tertiary, with their slip roads), so the phone can
// route across the whole country from one small file. Near the start and
// the end it adds the full detail from the normal road tiles; the two meet
// at junctions, which have the same rounded position in both.
//
// Format (v1):
//   { v: 1, region, version, classes, names: [...],
//     nodes: [lat0, lon0, dlat, dlon, ...],      1e-5 degree integers, delta-coded
//     edges: [[a, b, way, flags, class, speed, length, c0, c1, name, dlat, dlon, ...], ...] }
// An edge runs from node a to node b along OSM way `way` (in drawn order),
// covering that way's road pieces c0..c1 (the ids the app marks as driven:
// way/<way>#<c>). flags: 1 = one-way a→b, 2 = one-way b→a, 4 = roundabout.
// length in metres; speed = tagged limit in km/h or 0; name index or -1.
// The trailing numbers are the in-between points (simplified), as
// differences starting from node a.

const L = require('./lib');

// Road types in the graph: motorway .. tertiary_link (lib.js order).
const MAIN_CLASSES = 10;
const SIMPLIFY_M = 3;

// Douglas-Peucker on [lat, lon] points (small area, flat-earth metres).
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const lat0 = pts[0][0];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][1] * kx, ay = pts[a][0] * ky;
    const dx = pts[b][1] * kx - ax, dy = pts[b][0] * ky - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][1] * kx - ax, py = pts[i][0] * ky - ay;
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Which road piece (chunk) each segment i→i+1 of a way is in: the same
// rule as lib.js splitIntoChunks.
function chunkOfSegments(coords) {
  const out = new Array(Math.max(0, coords.length - 1));
  let chunk = 0;
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    out[i - 1] = chunk;
    len += L.haversine(coords[i - 1], coords[i]);
    if (len >= L.CHUNK_TARGET_METERS && i < coords.length - 1) {
      chunk++;
      len = 0;
    }
  }
  return out;
}

/**
 * Collects ways while build.js reads the roads, then writes the graph.
 * Every drivable way is counted (so junctions with small roads become
 * graph nodes, where the detailed roads join); main roads are kept.
 */
class GraphBuilder {
  constructor() {
    this.nodeUse = new Map(); // OSM node id -> how many way positions use it
    this.main = []; // { way, nodes, coords, flags, h, sp, n }
  }

  addWay(wayId, nodeIds, coords, props) {
    if (!Array.isArray(nodeIds) || nodeIds.length !== coords.length || coords.length < 2) return;
    for (let i = 0; i < nodeIds.length; i++) {
      // Way ends always count twice, so they're always nodes.
      const add = i === 0 || i === nodeIds.length - 1 ? 2 : 1;
      this.nodeUse.set(nodeIds[i], (this.nodeUse.get(nodeIds[i]) || 0) + add);
    }
    if (props.h < 0 || props.h >= MAIN_CLASSES) return;
    const flags = (props.o === 1 ? 1 : 0) | (props.o === -1 ? 2 : 0) | (props.r ? 4 : 0);
    this.main.push({ way: wayId, nodes: nodeIds, coords, flags, h: props.h, sp: props.sp || 0, n: props.n || null });
  }

  build(region, version) {
    const nodeIndex = new Map(); // OSM node id -> graph node
    const nodePos = []; // [lat, lon]
    const nodeOf = (id, c) => {
      let k = nodeIndex.get(id);
      if (k === undefined) {
        k = nodePos.length;
        nodeIndex.set(id, k);
        nodePos.push(c);
      }
      return k;
    };
    const names = [];
    const nameIdx = new Map();
    const edges = [];
    let meters = 0;
    for (const w of this.main) {
      const segChunk = chunkOfSegments(w.coords);
      let ni = -1;
      if (w.n) {
        if (!nameIdx.has(w.n)) {
          nameIdx.set(w.n, names.length);
          names.push(w.n);
        }
        ni = nameIdx.get(w.n);
      }
      let start = 0;
      for (let i = 1; i < w.coords.length; i++) {
        const last = i === w.coords.length - 1;
        if (!last && (this.nodeUse.get(w.nodes[i]) || 0) < 2) continue;
        const pts = w.coords.slice(start, i + 1);
        let len = 0;
        for (let k = 1; k < pts.length; k++) len += L.haversine(pts[k - 1], pts[k]);
        if (len > 0) {
          const a = nodeOf(w.nodes[start], w.coords[start]);
          const b = nodeOf(w.nodes[i], w.coords[i]);
          const row = [a, b, w.way, w.flags, w.h, w.sp, Math.max(1, Math.round(len)), segChunk[start], segChunk[i - 1], ni];
          const mid = simplify(pts, SIMPLIFY_M).slice(1, -1);
          let plat = Math.round(pts[0][0] * L.COORD_SCALE);
          let plon = Math.round(pts[0][1] * L.COORD_SCALE);
          for (const [la, lo] of mid) {
            const x = Math.round(la * L.COORD_SCALE);
            const y = Math.round(lo * L.COORD_SCALE);
            row.push(x - plat, y - plon);
            plat = x;
            plon = y;
          }
          edges.push(row);
          meters += len;
        }
        start = i;
      }
    }
    const nodes = [];
    let plat = 0;
    let plon = 0;
    nodePos.forEach(([la, lo], i) => {
      const x = Math.round(la * L.COORD_SCALE);
      const y = Math.round(lo * L.COORD_SCALE);
      nodes.push(i === 0 ? x : x - plat, i === 0 ? y : y - plon);
      plat = x;
      plon = y;
    });
    return { graph: { v: 1, region, version, classes: L.ROAD_CLASSES.slice(0, MAIN_CLASSES), names, nodes, edges }, meters };
  }
}

module.exports = { GraphBuilder, simplify, chunkOfSegments, MAIN_CLASSES };
