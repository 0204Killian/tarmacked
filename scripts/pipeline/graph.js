// The sat-nav's routing graph (graph.json): main roads only (see main in
// regions.js), plus car ferries, so the phone can route across a country
// from one file. Near the start and the end it adds the full detail from the
// normal road tiles; the two meet at junctions, which have the same rounded
// position in both.
//
// Built in two steps: each part of a region (build.js) writes a partial
// graph keyed by OSM node IDs; merge.js joins the parts (a way crossing a
// part's edge is in both, and counted once) and numbers the nodes.
//
// Final format (v2):
//   { v: 2, region, version, classes, names: [...],
//     nodes: [lat0, lon0, dlat, dlon, ...],      1e-5 degree integers, delta-coded
//     edges: [[a, b, way, flags, class, speed, length, c0, c1, name, delay, dlat, dlon, ...], ...] }
// An edge runs from node a to node b along OSM way `way` (in drawn order),
// covering that way's road pieces c0..c1 (the ids the app marks as driven:
// way/<way>#<c>). flags: 1 = one-way a→b, 2 = one-way b→a, 4 = roundabout,
// 8 = toll, 16 = unpaved, 32 = car ferry. class indexes `classes`; speed =
// the limit in km/h, 0 if unknown (a ferry's own speed); length in metres;
// name index or -1; delay = seconds lost at traffic lights, stop and yield
// signs, level crossings and toll booths along it. The trailing numbers are
// the in-between points (simplified), as differences starting from node a.
// (v1, from v0.18, is the same without `delay`.)

const L = require('./lib');

const SIMPLIFY_M = 3;
const FERRY = L.ROAD_CLASSES.length; // class index of ferries in graph.json
const GRAPH_CLASSES = [...L.ROAD_CLASSES, 'ferry'];

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
 * How many way positions use each OSM node: an open-addressing hash on
 * typed arrays, so big parts don't hit the limits of a JS Map.
 */
class NodeCounter {
  constructor(capacity = 1 << 20) {
    this.cap = capacity;
    this.keys = new Float64Array(capacity);
    this.counts = new Uint8Array(capacity);
    this.size = 0;
  }
  slot(id) {
    // Node ids are positive integers below 2^53: mix both 32-bit halves.
    const lo = id % 4294967296;
    const hi = Math.floor(id / 4294967296);
    let x = Math.imul(lo ^ (lo >>> 16), 0x45d9f3b) ^ Math.imul(hi + 0x7f4a7c15, 0x85ebca77);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    let h = (x ^ (x >>> 16)) & (this.cap - 1);
    while (this.counts[h] !== 0 && this.keys[h] !== id) h = h + 1 === this.cap ? 0 : h + 1;
    return h;
  }
  add(id, n) {
    if (this.size * 10 > this.cap * 6) this.grow();
    const h = this.slot(id);
    if (this.counts[h] === 0) {
      this.keys[h] = id;
      this.size++;
    }
    this.counts[h] = Math.min(255, this.counts[h] + n);
  }
  get(id) {
    return this.counts[this.slot(id)];
  }
  grow() {
    const oldK = this.keys, oldC = this.counts;
    this.cap *= 2;
    this.keys = new Float64Array(this.cap);
    this.counts = new Uint8Array(this.cap);
    this.size = 0;
    for (let i = 0; i < oldK.length; i++) {
      if (oldC[i] === 0) continue;
      const h = this.slot(oldK[i]);
      this.keys[h] = oldK[i];
      this.counts[h] = oldC[i];
      this.size++;
    }
  }
}

/**
 * Collects ways while build.js reads a part, then writes its partial graph.
 * Every drivable way is counted (so junctions with small roads become graph
 * nodes, where the detailed roads join); main roads and ferries are kept.
 */
class GraphBuilder {
  constructor(mainClasses = 10, nodeDelay = () => 0) {
    this.mainClasses = mainClasses;
    this.nodeDelay = nodeDelay; // OSM node id -> { s: seconds, toll: bool } | null
    this.nodeUse = new NodeCounter();
    this.main = []; // { way, nodes, coords, flags, h, sp, n }
  }

  addWay(wayId, nodeIds, coords, props) {
    if (!Array.isArray(nodeIds) || nodeIds.length !== coords.length || coords.length < 2) return;
    for (let i = 0; i < nodeIds.length; i++) {
      // Way ends always count twice, so they're always nodes.
      this.nodeUse.add(nodeIds[i], i === 0 || i === nodeIds.length - 1 ? 2 : 1);
    }
    const ferry = props.h === FERRY;
    if (!ferry && (props.h < 0 || props.h >= this.mainClasses)) return;
    const flags = (props.o === 1 ? 1 : 0) | (props.o === -1 ? 2 : 0) | (props.r ? 4 : 0) | (props.t ? 8 : 0) | (props.u ? 16 : 0) | (ferry ? 32 : 0);
    this.main.push({ way: wayId, nodes: nodeIds, coords, flags, h: props.h, sp: props.sp || 0, n: props.n || null, ferryTags: ferry ? props.ferryTags : undefined });
  }

  /** The part's graph: nodes by OSM id, edges between OSM node ids. */
  buildPart() {
    const nodes = new Map(); // OSM id -> [lat, lon]
    const edges = [];
    let meters = 0;
    for (const w of this.main) {
      const segChunk = chunkOfSegments(w.coords);
      let start = 0;
      for (let i = 1; i < w.coords.length; i++) {
        const last = i === w.coords.length - 1;
        if (!last && this.nodeUse.get(w.nodes[i]) < 2) continue;
        const pts = w.coords.slice(start, i + 1);
        let len = 0;
        for (let k = 1; k < pts.length; k++) len += L.haversine(pts[k - 1], pts[k]);
        if (len > 0) {
          nodes.set(w.nodes[start], w.coords[start]);
          nodes.set(w.nodes[i], w.coords[i]);
          // Delays at nodes along it (the end node counts, the start doesn't,
          // so a junction's lights are paid once, on the way in).
          let delay = 0;
          let flags = w.flags;
          for (let k = start + 1; k <= i; k++) {
            const d = this.nodeDelay(w.nodes[k]);
            if (d) {
              delay += d.s;
              if (d.toll) flags |= 8;
            }
          }
          const sp = w.flags & 32 ? L.ferrySpeed(w.ferryTags || {}, len) : w.sp;
          const row = [w.nodes[start], w.nodes[i], w.way, flags, w.h, sp, Math.max(1, Math.round(len)), segChunk[start], segChunk[i - 1], w.n ?? '', delay];
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
    return { nodes: Array.from(nodes, ([id, [la, lo]]) => [id, la, lo]), edges, meters };
  }
}

/**
 * Joins parts' graphs into graph.json (v2): an edge that's in two parts
 * (its way crosses between them) is kept once; nodes are numbered.
 */
function mergeGraphs(parts, region, version) {
  const nodeIndex = new Map(); // OSM id -> index
  const nodePos = [];
  const names = [];
  const nameIdx = new Map();
  const seen = new Set();
  const edges = [];
  let meters = 0;
  for (const part of parts) {
    const pos = new Map(part.nodes.map(([id, la, lo]) => [id, [la, lo]]));
    const idx = (id) => {
      let k = nodeIndex.get(id);
      if (k === undefined) {
        k = nodePos.length;
        nodeIndex.set(id, k);
        nodePos.push(pos.get(id));
      }
      return k;
    };
    for (const row of part.edges) {
      const [aId, bId, way, flags, cls, sp, len, c0, c1, name, delay] = row;
      const key = `${way}:${aId}:${bId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let ni = -1;
      if (name) {
        if (!nameIdx.has(name)) {
          nameIdx.set(name, names.length);
          names.push(name);
        }
        ni = nameIdx.get(name);
      }
      edges.push([idx(aId), idx(bId), way, flags, cls, sp, len, c0, c1, ni, delay, ...row.slice(11)]);
      meters += len;
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
  return { graph: { v: 2, region, version, classes: GRAPH_CLASSES, names, nodes, edges }, meters };
}

module.exports = { GraphBuilder, NodeCounter, mergeGraphs, simplify, chunkOfSegments, FERRY, GRAPH_CLASSES };
