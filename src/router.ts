// tarmacked's own routing (v0.18): works out routes on our road data, on
// the phone, with no network once the data is there.
//
// The graph is built from two sources that join up at junctions (same
// rounded position in both):
//  - graph.json: the country's main roads (motorway down to tertiary), one
//    small file, so a route can cross the country;
//  - the normal road tiles near the start and the end, for the small roads
//    you start and finish on.
// Several regions' graphs can be added (cross-border trips): they join the
// same way, where their roads share a junction.
//
// Routes respect one-way streets and turn restrictions, and are timed from
// speed limits (or a typical speed for the road type). Two kinds:
//  - 'fastest';
//  - 'new': prefers roads you've never driven (they count as quicker than
//    they are), for collecting new road.
// Pure logic (no React or native calls) so it can be tested on its own.

import type { RoadSegment } from './roadMatcher';
import type { NavRoute, RouteStep } from './nav';
import { Coord, haversine } from './geo';
import { ROAD_CLASSES } from './tiles';

export type GraphFile = { v: number; region: string; version: string; classes: string[]; names: string[]; nodes: number[]; edges: number[][] };
// [fromWay, viaLat, viaLon, toWay, kind] with kind an index into kinds.
export type RestrictionsFile = { kinds: string[]; r: [number, number, number, number, number][] };

export type RouteMode = 'fastest' | 'new';
export type TurnKind = 'straight' | 'slight-left' | 'slight-right' | 'left' | 'right' | 'sharp-left' | 'sharp-right' | 'u-turn' | 'roundabout' | 'merge' | 'exit' | 'arrive' | 'depart';
export type Step = RouteStep & { kind: TurnKind };

export type PlannedRoute = NavRoute & {
  mode: RouteMode;
  steps: Step[];
  speeds: number[]; // speed limit (km/h, 0 = not known) of each piece coords[i]→coords[i+1]
  newM: number; // metres on roads you've never driven
  roadNames: string[]; // main roads used, in order (for the summary)
};

// --- tuning ---
const SCALE = 1e5;
const SNAP_M = 80; // how far from a road the start / end may be
const KMH: Record<string, number> = {
  motorway: 110, motorway_link: 60, trunk: 90, trunk_link: 50, primary: 80, primary_link: 45,
  secondary: 70, secondary_link: 40, tertiary: 60, tertiary_link: 35, unclassified: 45,
  residential: 30, living_street: 15,
};
const DEFAULT_KMH = 40;
const MAX_KMH = 120; // for the A* estimate
const ROUNDABOUT_KMH = 25;
const NEW_ROAD_DISCOUNT = 0.45; // 'new' mode: never-driven road counts as 55% of its time
const BEARING_M = 15; // a road's direction is measured over this far from a junction

const toRad = Math.PI / 180;

// Numeric key of a position (1e-5 degree integers).
const keyOf = (la: number, lo: number) => la * 1e8 + lo;

// Compass bearing (degrees) from a to b, both integer positions.
function bearingInt(aLa: number, aLo: number, bLa: number, bLo: number): number {
  const dy = bLa - aLa;
  const dx = (bLo - aLo) * Math.cos((aLa / SCALE) * toRad);
  return (Math.atan2(dx, dy) / toRad + 360) % 360;
}
// -180..180, positive = turning right.
function turnAngle(inBearing: number, outBearing: number): number {
  let d = outBearing - inBearing;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// The road number ("N77", "R693", "M7") at the start of a name, if any.
export function refOf(name: string | null | undefined): string | null {
  if (!name) return null;
  const m = /^([MNRL]\d+[A-Z]?)\b/.exec(name);
  return m ? m[1] : null;
}
// How to say a road: "the N77", "Kilkenny Road".
export function spokenRoad(name: string | null | undefined): string | null {
  if (!name) return null;
  const ref = refOf(name);
  if (ref) return `the ${ref}`;
  return name.split('/')[0].trim();
}

class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(k: number, v: number) {
    const ks = this.keys, vs = this.vals;
    let i = ks.length;
    ks.push(k);
    vs.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p] <= k) break;
      ks[i] = ks[p];
      vs[i] = vs[p];
      i = p;
    }
    ks[i] = k;
    vs[i] = v;
  }
  peekKey() {
    return this.keys[0];
  }
  pop(): number {
    const ks = this.keys, vs = this.vals;
    const top = vs[0];
    const k = ks.pop()!;
    const v = vs.pop()!;
    if (ks.length) {
      let i = 0;
      const n = ks.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && ks[r] < ks[l] ? r : l;
        if (ks[c] >= k) break;
        ks[i] = ks[c];
        vs[i] = vs[c];
        i = c;
      }
      ks[i] = k;
      vs[i] = v;
    }
    return top;
  }
}

type Snap = { edge: number; along: number; off: number; point: [number, number] };

/**
 * The road graph. Edges run between junctions along one OSM way; an "arc"
 * is an edge in one direction (edge * 2 + 0 = drawn order, + 1 = reversed).
 */
export class RoadGraph {
  // nodes
  private nodeLa: number[] = [];
  private nodeLo: number[] = [];
  private nodeByKey = new Map<number, number>();
  private out: number[][] = []; // node -> arcs leaving it
  // edges
  private eA: number[] = [];
  private eB: number[] = [];
  private eWay: number[] = [];
  private eFlags: number[] = [];
  private eClass: number[] = [];
  private eSpeed: number[] = [];
  private eLen: number[] = [];
  private eC0: number[] = [];
  private eC1: number[] = [];
  private eName: number[] = [];
  private eGeo: number[] = []; // start of the edge's points in `pool`
  private eGeoN: number[] = []; // how many points
  private pool: number[] = []; // lat, lon integer pairs
  private names: string[] = [];
  private nameIdx = new Map<string, number>();
  private mainWays = new Set<number>();
  private seenDetail = new Set<string>();
  // turn restrictions at a junction: from way -> { only?: to way, no: to ways }
  private restr = new Map<number, Map<number, { only: number[]; no: number[] }>>();
  // spatial grid (0.01 degree cells) of edges, for snapping
  private grid = new Map<number, number[]>();
  readonly regions: string[] = [];

  get edgeCount() {
    return this.eA.length;
  }
  get nodeCount() {
    return this.nodeLa.length;
  }

  private node(la: number, lo: number): number {
    const k = keyOf(la, lo);
    let n = this.nodeByKey.get(k);
    if (n === undefined) {
      n = this.nodeLa.length;
      this.nodeByKey.set(k, n);
      this.nodeLa.push(la);
      this.nodeLo.push(lo);
      this.out.push([]);
    }
    return n;
  }

  private nameId(name: string | null | undefined): number {
    if (!name) return -1;
    let i = this.nameIdx.get(name);
    if (i === undefined) {
      i = this.names.length;
      this.names.push(name);
      this.nameIdx.set(name, i);
    }
    return i;
  }

  // pts: integer [la, lo, la, lo, ...] including both ends.
  private addEdge(pts: number[], way: number, flags: number, cls: number, speed: number, len: number, c0: number, c1: number, name: number) {
    const n = pts.length / 2;
    const a = this.node(pts[0], pts[1]);
    const b = this.node(pts[pts.length - 2], pts[pts.length - 1]);
    const e = this.eA.length;
    this.eA.push(a);
    this.eB.push(b);
    this.eWay.push(way);
    this.eFlags.push(flags);
    this.eClass.push(cls);
    this.eSpeed.push(speed);
    this.eLen.push(len);
    this.eC0.push(c0);
    this.eC1.push(c1);
    this.eName.push(name);
    this.eGeo.push(this.pool.length / 2);
    this.eGeoN.push(n);
    for (let i = 0; i < pts.length; i++) this.pool.push(pts[i]);
    if (!(flags & 2)) this.out[a].push(e * 2); // a -> b allowed
    if (!(flags & 1)) this.out[b].push(e * 2 + 1); // b -> a allowed
    // grid
    let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minLa) minLa = pts[i];
      if (pts[i] > maxLa) maxLa = pts[i];
      if (pts[i + 1] < minLo) minLo = pts[i + 1];
      if (pts[i + 1] > maxLo) maxLo = pts[i + 1];
    }
    for (let x = Math.floor(minLa / 1000); x <= Math.floor(maxLa / 1000); x++) {
      for (let y = Math.floor(minLo / 1000); y <= Math.floor(maxLo / 1000); y++) {
        const k = x * 100000 + y;
        const list = this.grid.get(k);
        if (list) list.push(e);
        else this.grid.set(k, [e]);
      }
    }
  }

  /** Adds a region's main-roads graph (graph.json). */
  addGraph(g: GraphFile) {
    if (!g || g.v !== 1 || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return;
    if (this.regions.includes(g.region)) return;
    this.regions.push(g.region);
    const nLa: number[] = [];
    const nLo: number[] = [];
    let la = 0, lo = 0;
    for (let i = 0; i < g.nodes.length; i += 2) {
      la = i === 0 ? g.nodes[0] : la + g.nodes[i];
      lo = i === 0 ? g.nodes[1] : lo + g.nodes[i + 1];
      nLa.push(la);
      nLo.push(lo);
    }
    // Road types: the file's own list, mapped onto ours.
    const clsMap = (g.classes ?? []).map((c) => ROAD_CLASSES.indexOf(c));
    for (const row of g.edges) {
      const [a, b, way, flags, cls, speed, len, c0, c1, name] = row;
      const pts = [nLa[a], nLo[a]];
      let pla = nLa[a], plo = nLo[a];
      for (let i = 10; i + 1 < row.length; i += 2) {
        pla += row[i];
        plo += row[i + 1];
        pts.push(pla, plo);
      }
      pts.push(nLa[b], nLo[b]);
      this.addEdge(pts, way, flags, clsMap[cls] ?? cls, speed, len, c0, c1, this.nameId(name >= 0 ? g.names[name] : null));
      this.mainWays.add(way);
    }
  }

  /** Adds turn restrictions (restrictions.json). */
  addRestrictions(file: RestrictionsFile) {
    if (!file || !Array.isArray(file.r)) return;
    for (const [from, lat, lon, to, kind] of file.r) {
      const name = file.kinds?.[kind] ?? '';
      const only = name.startsWith('only_');
      const no = name.startsWith('no_');
      if (!only && !no) continue;
      const k = keyOf(Math.round(lat * SCALE), Math.round(lon * SCALE));
      let at = this.restr.get(k);
      if (!at) this.restr.set(k, (at = new Map()));
      let r = at.get(from);
      if (!r) at.set(from, (r = { only: [], no: [] }));
      (only ? r.only : r.no).push(to);
    }
  }

  /**
   * Adds detailed road pieces (from the road tiles). Pieces of ways that
   * are already in a main-roads graph are skipped (the graph has them),
   * except where no graph is loaded.
   */
  addDetail(segs: Iterable<RoadSegment>) {
    const fresh: { s: RoadSegment; way: number; idx: number; pts: number[] }[] = [];
    const use = new Map<number, number>();
    for (const s of segs) {
      if (this.seenDetail.has(s.id) || s.coords.length < 2) continue;
      const m = /^way\/(\d+)#(\d+)/.exec(s.id);
      if (!m) continue;
      const way = Number(m[1]);
      this.seenDetail.add(s.id);
      if (this.mainWays.has(way)) continue;
      const pts: number[] = [];
      for (const [la, lo] of s.coords) pts.push(Math.round(la * SCALE), Math.round(lo * SCALE));
      fresh.push({ s, way, idx: Number(m[2]), pts });
      for (let i = 0; i < pts.length; i += 2) {
        const k = keyOf(pts[i], pts[i + 1]);
        const end = i === 0 || i === pts.length - 2;
        use.set(k, (use.get(k) ?? 0) + (end ? 2 : 1));
      }
    }
    for (const { s, way, idx, pts } of fresh) {
      const flags = (s.o === 1 ? 1 : 0) | (s.o === -1 ? 2 : 0) | (s.r ? 4 : 0);
      const name = this.nameId(s.n);
      const cls = s.h ?? -1;
      let start = 0;
      for (let i = 2; i < pts.length; i += 2) {
        const last = i === pts.length - 2;
        const k = keyOf(pts[i], pts[i + 1]);
        if (!last && (use.get(k) ?? 0) < 2 && !this.nodeByKey.has(k)) continue;
        const part = pts.slice(start, i + 2);
        let len = 0;
        for (let j = 2; j < part.length; j += 2) len += haversine([part[j - 2] / SCALE, part[j - 1] / SCALE], [part[j] / SCALE, part[j + 1] / SCALE]);
        if (len > 0) this.addEdge(part, way, flags, cls, s.sp ?? 0, len, idx, idx, name);
        start = i;
      }
    }
  }

  // --- edges and arcs ---

  private point(e: number, i: number): [number, number] {
    const p = (this.eGeo[e] + i) * 2;
    return [this.pool[p], this.pool[p + 1]];
  }

  /** Points of an arc, in travel order, as integer pairs. */
  private arcPoints(arc: number): [number, number][] {
    const e = arc >> 1;
    const n = this.eGeoN[e];
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) out.push(this.point(e, i));
    if (arc & 1) out.reverse();
    return out;
  }

  private arcFrom(arc: number) {
    return arc & 1 ? this.eB[arc >> 1] : this.eA[arc >> 1];
  }
  private arcTo(arc: number) {
    return arc & 1 ? this.eA[arc >> 1] : this.eB[arc >> 1];
  }

  // Bearings are cached per arc: [leaving its start, arriving at its end].
  private bearCache: Float32Array = new Float32Array(0);
  private arcBearing(arc: number, atEnd: boolean): number {
    const slot = arc * 2 + (atEnd ? 1 : 0);
    if (this.bearCache.length < this.eA.length * 4) {
      const grown = new Float32Array(this.eA.length * 4 + 4096).fill(NaN);
      grown.set(this.bearCache);
      this.bearCache = grown;
    }
    let v = this.bearCache[slot];
    if (Number.isNaN(v)) {
      v = this.measureBearing(arc, atEnd);
      this.bearCache[slot] = v;
    }
    return v;
  }

  // Direction leaving the arc's start (atEnd = false) or arriving at its end (atEnd = true).
  private measureBearing(arc: number, atEnd: boolean): number {
    const e = arc >> 1;
    const n = this.eGeoN[e];
    // Walk from the junction end until BEARING_M away.
    const fromStart = (arc & 1) === 0 ? !atEnd : atEnd; // walk from point 0?
    const idx = (i: number) => (fromStart ? i : n - 1 - i);
    const [la0, lo0] = this.point(e, idx(0));
    let far = this.point(e, idx(1));
    for (let i = 1; i < n; i++) {
      far = this.point(e, idx(i));
      if (haversine([la0 / SCALE, lo0 / SCALE], [far[0] / SCALE, far[1] / SCALE]) >= BEARING_M) break;
    }
    // Leaving the start: junction -> far. Arriving at the end: far -> junction.
    return atEnd ? bearingInt(far[0], far[1], la0, lo0) : bearingInt(la0, lo0, far[0], far[1]);
  }

  private speedMs(e: number): number {
    const cls = ROAD_CLASSES[this.eClass[e]] ?? '';
    let kmh = KMH[cls] ?? DEFAULT_KMH;
    const sp = this.eSpeed[e];
    if (sp > 0) kmh = Math.min(sp * 0.92, kmh * 1.25);
    if (this.eFlags[e] & 4) kmh = Math.min(kmh, ROUNDABOUT_KMH);
    return Math.max(5, kmh) / 3.6;
  }

  private allowed(fromWay: number, node: number, toWay: number): boolean {
    const at = this.restr.get(keyOf(this.nodeLa[node], this.nodeLo[node]));
    if (!at) return true;
    const r = at.get(fromWay);
    if (!r) return true;
    if (r.only.length && !r.only.includes(toWay)) return false;
    return !r.no.includes(toWay);
  }

  // Seconds for the turn from arc a into arc b (Ireland drives on the left:
  // right turns cross traffic).
  private turnCost(a: number, b: number): number {
    const d = turnAngle(this.arcBearing(a, true), this.arcBearing(b, false));
    const ad = Math.abs(d);
    if (ad < 30) return 0;
    if (this.eFlags[a >> 1] & 4 || this.eFlags[b >> 1] & 4) return 0; // round the roundabout
    if (ad > 150) return 40;
    return d > 0 ? 9 : 5;
  }

  // --- snapping ---

  /** Nearest road to a point (optionally going roughly `heading`). */
  snap(lat: number, lon: number, heading: number | null = null, maxM = SNAP_M): Snap | null {
    const la = Math.round(lat * SCALE), lo = Math.round(lon * SCALE);
    const cx = Math.floor(la / 1000), cy = Math.floor(lo / 1000);
    const kx = Math.cos(lat * toRad) * 1.11320; // metres per integer unit, lon
    const ky = 1.1132;
    let best: Snap | null = null;
    let bestScore = Infinity;
    const seen = new Set<number>();
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const e of this.grid.get(x * 100000 + y) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const n = this.eGeoN[e];
          let along = 0;
          for (let i = 0; i < n - 1; i++) {
            const [aLa, aLo] = this.point(e, i);
            const [bLa, bLo] = this.point(e, i + 1);
            const ax = (aLo - lo) * kx, ay = (aLa - la) * ky;
            const bx = (bLo - lo) * kx, by = (bLa - la) * ky;
            const dx = bx - ax, dy = by - ay;
            const l2 = dx * dx + dy * dy;
            const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
            const px = ax + t * dx, py = ay + t * dy;
            const off = Math.hypot(px, py);
            const segLen = Math.sqrt(l2);
            if (off <= maxM) {
              let score = off;
              if (heading !== null) {
                const b = bearingInt(aLa, aLo, bLa, bLo);
                const fwd = Math.abs(turnAngle(heading, b));
                const flags = this.eFlags[e];
                // Facing either way is fine on a two-way road; on a one-way the right way only.
                const diff = flags & 1 ? fwd : flags & 2 ? 180 - fwd : Math.min(fwd, 180 - fwd);
                score += diff > 60 ? 40 : diff / 6;
              }
              if (score < bestScore) {
                bestScore = score;
                best = { edge: e, along: along + t * segLen, off, point: [aLa + t * (bLa - aLa), aLo + t * (bLo - aLo)] };
              }
            }
            along += segLen;
          }
        }
      }
    }
    if (best) {
      // Scale "along" (measured flat) to the edge's stored length.
      const n = this.eGeoN[best.edge];
      let flat = 0;
      for (let i = 0; i < n - 1; i++) {
        const [aLa, aLo] = this.point(best.edge, i);
        const [bLa, bLo] = this.point(best.edge, i + 1);
        flat += Math.hypot((bLo - aLo) * kx, (bLa - aLa) * ky);
      }
      if (flat > 0) best.along = (best.along / flat) * this.eLen[best.edge];
    }
    return best;
  }

  // Points of an edge between two distances along it (in drawn order).
  private slice(e: number, from: number, to: number): [number, number][] {
    const n = this.eGeoN[e];
    const pts = Array.from({ length: n }, (_, i) => this.point(e, i));
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + haversine([pts[i - 1][0] / SCALE, pts[i - 1][1] / SCALE], [pts[i][0] / SCALE, pts[i][1] / SCALE]));
    const total = cum[n - 1] || 1;
    const k = total / (this.eLen[e] || total);
    const a = Math.max(0, Math.min(total, from * k));
    const b = Math.max(0, Math.min(total, to * k));
    const at = (d: number): [number, number] => {
      let i = 0;
      while (i < n - 2 && cum[i + 1] < d) i++;
      const f = cum[i + 1] > cum[i] ? (d - cum[i]) / (cum[i + 1] - cum[i]) : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
    };
    const out: [number, number][] = [at(Math.min(a, b))];
    for (let i = 0; i < n; i++) if (cum[i] > Math.min(a, b) && cum[i] < Math.max(a, b)) out.push(pts[i]);
    out.push(at(Math.max(a, b)));
    return a <= b ? out : out.reverse();
  }

  // --- routing ---

  /**
   * A route from one point to another, or null (no road near, or no way
   * through). heading: which way you're facing at the start (degrees), so
   * a route doesn't begin with a U-turn. isDriven(way, piece) says whether
   * you've driven a road piece (for 'new' mode and the new-road total).
   */
  route(
    from: { lat: number; lon: number; heading?: number | null },
    to: { lat: number; lon: number },
    mode: RouteMode,
    isDriven: (way: number, piece: number) => boolean = () => false,
  ): PlannedRoute | null {
    const s = this.snap(from.lat, from.lon, from.heading ?? null);
    const t = this.snap(to.lat, to.lon, null, 500);
    if (!s || !t) return null;
    const newFrac = new Map<number, number>();
    const fracNew = (e: number) => {
      let f = newFrac.get(e);
      if (f === undefined) {
        const c0 = this.eC0[e], c1 = this.eC1[e];
        let n = 0;
        for (let c = c0; c <= c1; c++) if (!isDriven(this.eWay[e], c)) n++;
        f = n / (c1 - c0 + 1);
        newFrac.set(e, f);
      }
      return f;
    };
    const cost = (e: number, metres: number) => {
      const sec = metres / this.speedMs(e);
      return mode === 'new' ? sec * (1 - NEW_ROAD_DISCOUNT * fracNew(e)) : sec;
    };
    const hFactor = mode === 'new' ? 1 - NEW_ROAD_DISCOUNT : 1;
    const tLat = t.point[0] / SCALE, tLon = t.point[1] / SCALE;
    const h = (node: number) => (haversine([this.nodeLa[node] / SCALE, this.nodeLo[node] / SCALE], [tLat, tLon]) / (MAX_KMH / 3.6)) * hFactor;

    const arcs = this.eA.length * 2;
    const g = new Float64Array(arcs).fill(Infinity);
    const prev = new Int32Array(arcs).fill(-1);
    const done = new Uint8Array(arcs);
    const heap = new Heap();
    const START = -2;

    // Start: along the start edge to either end (one-ways and heading allowing).
    const se = s.edge;
    const sLen = this.eLen[se];
    const startArcs: number[] = [];
    for (const dir of [0, 1]) {
      const flags = this.eFlags[se];
      if ((dir === 0 && flags & 2) || (dir === 1 && flags & 1)) continue;
      const arc = se * 2 + dir;
      let c = cost(se, dir === 0 ? sLen - s.along : s.along);
      if (from.heading !== null && from.heading !== undefined) {
        // Starting against the way you're facing costs a turn-round.
        const b = this.arcBearing(arc, false);
        if (Math.abs(turnAngle(from.heading, b)) > 100) c += 45;
      }
      g[arc] = c;
      prev[arc] = START;
      startArcs.push(arc);
      heap.push(c + h(this.arcTo(arc)), arc);
    }
    // Finish: reaching an end of the target edge, then along it to the point.
    const te = t.edge;
    const tLen = this.eLen[te];
    let best = Infinity;
    let bestArc = -1; // last full arc before the target edge, or START
    let bestDirect = -1; // direction along the start edge when start and end share an edge
    const finishVia = (arc: number, gArc: number) => {
      const node = this.arcTo(arc);
      for (const dir of [0, 1]) {
        const flags = this.eFlags[te];
        if ((dir === 0 && flags & 2) || (dir === 1 && flags & 1)) continue;
        const entry = dir === 0 ? this.eA[te] : this.eB[te];
        if (entry !== node || arc >> 1 === te) continue;
        const tarc = te * 2 + dir;
        if (!this.allowed(this.eWay[arc >> 1], node, this.eWay[te])) continue;
        const c = gArc + this.turnCost(arc, tarc) + cost(te, dir === 0 ? t.along : tLen - t.along);
        if (c < best) {
          best = c;
          bestArc = arc;
          bestDirect = dir;
        }
      }
    };
    if (se === te) {
      for (const dir of [0, 1]) {
        const flags = this.eFlags[se];
        if ((dir === 0 && flags & 2) || (dir === 1 && flags & 1)) continue;
        if ((dir === 0 && t.along >= s.along) || (dir === 1 && t.along <= s.along)) {
          const c = cost(se, Math.abs(t.along - s.along));
          if (c < best) {
            best = c;
            bestArc = START;
            bestDirect = dir;
          }
        }
      }
    }
    for (const arc of startArcs) finishVia(arc, g[arc]);

    let pops = 0;
    while (heap.size) {
      if (heap.peekKey() >= best) break;
      const arc = heap.pop();
      if (done[arc]) continue;
      done[arc] = 1;
      pops++;
      const node = this.arcTo(arc);
      const wayIn = this.eWay[arc >> 1];
      const outs = this.out[node];
      for (const nxt of outs) {
        let extra = 0;
        if (nxt >> 1 === arc >> 1 && nxt !== arc) {
          if (outs.length > 1) continue; // no U-turns, except at a dead end
          extra = 60;
        }
        if (!this.allowed(wayIn, node, this.eWay[nxt >> 1])) continue;
        const e = nxt >> 1;
        const c = g[arc] + extra + this.turnCost(arc, nxt) + cost(e, this.eLen[e]);
        if (c < g[nxt]) {
          g[nxt] = c;
          prev[nxt] = arc;
          heap.push(c + h(this.arcTo(nxt)), nxt);
          finishVia(nxt, c);
        }
      }
    }
    if (best === Infinity) return null;

    // Path: arcs from the start to the last full arc.
    const path: number[] = [];
    if (bestArc !== START) {
      for (let a = bestArc; a !== START && a >= 0; a = prev[a]) path.push(a);
      path.reverse();
    }
    return this.describe(s, t, path, bestDirect, mode, from, to, fracNew);
  }

  // --- turning a path into a route (line, steps, times) ---

  private describe(
    s: Snap,
    t: Snap,
    path: number[],
    endDir: number,
    mode: RouteMode,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    fracNew: (e: number) => number,
  ): PlannedRoute {
    // Legs: [edge, points] in travel order. First leg: the start edge from
    // the snap point to its far end (the first path arc's direction);
    // middle legs: whole arcs (minus the first, which is the start edge);
    // last leg: the target edge to the snap point.
    type Leg = { e: number; pts: [number, number][]; len: number; arc: number };
    const legs: Leg[] = [];
    if (path.length === 0) {
      // Same edge.
      const pts = this.slice(s.edge, s.along, t.along);
      legs.push({ e: s.edge, pts, len: Math.abs(t.along - s.along), arc: s.edge * 2 + endDir });
    } else {
      const first = path[0];
      const fdir = first & 1;
      legs.push({ e: s.edge, pts: this.slice(s.edge, s.along, fdir === 0 ? this.eLen[s.edge] : 0), len: fdir === 0 ? this.eLen[s.edge] - s.along : s.along, arc: first });
      for (let i = 1; i < path.length; i++) legs.push({ e: path[i] >> 1, pts: this.arcPoints(path[i]), len: this.eLen[path[i] >> 1], arc: path[i] });
      legs.push({ e: t.edge, pts: this.slice(t.edge, endDir === 0 ? 0 : this.eLen[t.edge], t.along), len: endDir === 0 ? t.along : this.eLen[t.edge] - t.along, arc: t.edge * 2 + endDir });
    }

    // Route line, with the junction index where each leg starts.
    const coords: Coord[] = [];
    const speeds: number[] = [];
    const legStart: number[] = [];
    let duration = 0;
    let newM = 0;
    let distance = 0;
    const push = (p: [number, number]) => {
      const c: Coord = [p[0] / SCALE, p[1] / SCALE];
      const last = coords[coords.length - 1];
      if (last && last[0] === c[0] && last[1] === c[1]) return false;
      coords.push(c);
      return true;
    };
    for (const leg of legs) {
      legStart.push(Math.max(0, coords.length - 1));
      for (const p of leg.pts) if (push(p) && coords.length > 1) speeds.push(this.eSpeed[leg.e]);
      duration += leg.len / this.speedMs(leg.e);
      distance += leg.len;
      newM += leg.len * fracNew(leg.e);
    }
    // The end of the line: where you asked to go, if it's off the road a bit.
    const endOff = haversine(coords[coords.length - 1], [to.lat, to.lon]);

    // Steps: start, one per manoeuvre, arrive.
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    const total = cum[cum.length - 1];
    type M = { idx: number; instruction: string; kind: TurnKind };
    const maneuvers: M[] = [];
    const nameOf = (leg: Leg) => (this.eName[leg.e] >= 0 ? this.names[this.eName[leg.e]] : null);
    const roadNames: string[] = [];
    const notePassing = (n: string | null) => {
      const r = refOf(n) ?? n;
      if (r && roadNames[roadNames.length - 1] !== r) roadNames.push(r);
    };
    notePassing(nameOf(legs[0]));
    // Bearing along the line around index i: before (over ~BEARING_M) or after.
    const lineBearing = (i: number, after: boolean): number => {
      const p = coords[i];
      let j = i;
      if (after) {
        while (j < coords.length - 1 && cum[j] - cum[i] < BEARING_M) j++;
      } else {
        while (j > 0 && cum[i] - cum[j] < BEARING_M) j--;
      }
      const q = coords[j];
      if (j === i) return 0;
      const a = after ? p : q, b = after ? q : p;
      return bearingInt(a[0] * SCALE, a[1] * SCALE, b[0] * SCALE, b[1] * SCALE);
    };
    const roundaboutSince = { leg: -1 };
    for (let li = 1; li < legs.length; li++) {
      const a = legs[li - 1], b = legs[li];
      const node = this.arcFrom(b.arc);
      const idx = legStart[li];
      const inRb = !!(this.eFlags[a.e] & 4), outRb = !!(this.eFlags[b.e] & 4);
      const nameA = nameOf(a), nameB = nameOf(b);
      const roadB = spokenRoad(nameB);
      const onto = roadB ? ` onto ${roadB}` : '';
      if (!inRb && outRb) {
        roundaboutSince.leg = li;
        continue;
      }
      if (inRb && outRb) continue;
      if (inRb && !outRb) {
        // Leaving a roundabout: count the exits passed since entering.
        let exits = 0;
        for (let k = roundaboutSince.leg; k <= li && k >= 1; k++) {
          const nd = this.arcFrom(legs[k].arc);
          for (const o of this.out[nd]) {
            if (this.eFlags[o >> 1] & 4) continue;
            if (o >> 1 === legs[k - 1].e) continue;
            exits++;
          }
        }
        exits = Math.max(1, exits);
        const ord = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'][exits - 1] ?? `${exits}th`;
        const entryIdx = roundaboutSince.leg >= 1 ? legStart[roundaboutSince.leg] : idx;
        maneuvers.push({ idx: entryIdx, instruction: `At the roundabout, take the ${ord} exit${onto}`, kind: 'roundabout' });
        notePassing(nameB);
        roundaboutSince.leg = -1;
        continue;
      }
      // Other ways you could go here (not back the way you came).
      const options = this.out[node].filter((o) => o >> 1 !== a.e);
      const d = turnAngle(lineBearing(idx, false), lineBearing(idx, true));
      const ad = Math.abs(d);
      const clsA = ROAD_CLASSES[this.eClass[a.e]] ?? '', clsB = ROAD_CLASSES[this.eClass[b.e]] ?? '';
      const sameRoad = (nameA ?? '') === (nameB ?? '') && nameA !== null;
      if (options.length <= 1) {
        // No choice here: the road just bends (or changes name).
        if (nameB !== nameA) notePassing(nameB);
        continue;
      }
      let kind: TurnKind | null = null;
      let text = '';
      const side = d > 0 ? 'right' : 'left';
      if (clsB.endsWith('_link') && (clsA === 'motorway' || clsA === 'trunk') ) {
        kind = 'exit';
        text = `Take the exit on the ${side === 'left' ? 'left' : 'right'}`;
      } else if (clsA.endsWith('_link') && (clsB === 'motorway' || clsB === 'trunk')) {
        kind = 'merge';
        text = `Join ${roadB ?? 'the motorway'}`;
      } else if (ad < 20) {
        if (sameRoad || !nameB) {
          // Straight on along the same road: nothing to say, unless the
          // other options are also nearly straight (a fork).
          const fork = options.some((o) => o !== b.arc && Math.abs(turnAngle(lineBearing(idx, false), this.arcBearing(o, false))) < 35);
          if (fork) {
            kind = d >= 0 ? 'slight-right' : 'slight-left';
            text = `Keep ${d >= 0 ? 'right' : 'left'}`;
          }
        } else {
          kind = 'straight';
          text = `Continue${onto}`;
        }
      } else if (ad < 50) {
        const fork = options.some((o) => o !== b.arc && Math.abs(turnAngle(lineBearing(idx, false), this.arcBearing(o, false))) < 50);
        kind = d > 0 ? 'slight-right' : 'slight-left';
        text = fork ? `Keep ${side}${onto}` : `Bear ${side}${onto}`;
      } else if (ad < 140) {
        kind = d > 0 ? 'right' : 'left';
        text = `Turn ${side}${onto}`;
      } else {
        kind = d > 0 ? 'sharp-right' : 'sharp-left';
        text = `Turn sharp ${side}${onto}`;
      }
      if (nameB !== nameA) notePassing(nameB);
      if (kind) maneuvers.push({ idx, instruction: text, kind });
    }
    maneuvers.sort((x, y) => x.idx - y.idx);

    const startName = spokenRoad(nameOf(legs[0]));
    const steps: Step[] = [];
    const stepAt = (idx: number, instruction: string, kind: TurnKind, notice: string): Step => ({ instruction, notice, distance: 0, coords: coords.slice(idx), kind });
    steps.push(stepAt(0, startName ? `Head along ${startName}` : 'Head off', 'depart', ''));
    for (const m of maneuvers) steps.push(stepAt(m.idx, m.instruction, m.kind, ''));
    steps.push(stepAt(coords.length - 1, endOff > 40 ? 'Your destination is nearby' : 'You have arrived', 'arrive', ''));
    // Step distances: from its start to the next step's start.
    const at = (st: Step) => cum[coords.length - st.coords.length];
    for (let i = 0; i < steps.length; i++) {
      steps[i].distance = (i + 1 < steps.length ? at(steps[i + 1]) : total) - at(steps[i]);
      // Keep the step lines short: they're only used to place the manoeuvre.
      steps[i].coords = steps[i].coords.slice(0, 3);
    }

    return {
      name: mode === 'new' ? 'New roads' : 'Fastest',
      mode,
      distance,
      duration,
      coords,
      steps,
      speeds,
      newM,
      roadNames,
    };
  }
}

/** Same arcs, more or less: two routes that are the same road. */
export function sameRoute(a: PlannedRoute, b: PlannedRoute): boolean {
  if (Math.abs(a.distance - b.distance) > 50) return false;
  // Sample both lines and compare.
  const n = 20;
  const pick = (r: PlannedRoute, f: number) => r.coords[Math.min(r.coords.length - 1, Math.floor(f * (r.coords.length - 1)))];
  for (let i = 0; i <= n; i++) if (haversine(pick(a, i / n), pick(b, i / n)) > 200) return false;
  return true;
}
