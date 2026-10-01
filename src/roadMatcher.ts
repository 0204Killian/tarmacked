// The downloaded road network, indexed for fast matching.
import { Coord, LatLon, haversine, metersPerDegLon, METERS_PER_DEG_LAT } from './geo';

export type RoadSegment = {
  id: string; // "way/<osm id>#<chunk index along the way>"
  coords: Coord[]; // in order along the road
  // One-way: 1 = traffic flows in coords order, -1 = against it, absent = two-way.
  o?: 1 | -1;
  // County code (index into county-stats.json's list). Absent outside the Republic.
  c?: number;
  // Road name / number from OSM (e.g. "N77 Kilkenny Road"). Absent on
  // unnamed roads and in tiles made before v0.14.
  n?: string;
};

export const SNAP_THRESHOLD_METERS = 25;

// Fine lookup grid (~220m x 135m cells): a point only checks the chunks
// registered in its own cell, instead of every chunk in 9 road tiles.
const CELL_DEG = 0.002;
const CELL_PAD_LAT = 0.0003; // ~33m, a bit more than the snap distance
const CELL_PAD_LON = 0.0005;

const cellKey = (la: number, lo: number) => `${la}_${lo}`;

export function vertexKey(c: Coord) {
  return `${c[0]},${c[1]}`;
}

// Chunk ids look like "way/123#4" — the road, and position along it.
export function parseChunkId(id: string): { way: string; idx: number } | null {
  const hash = id.lastIndexOf('#');
  if (hash < 0) return null;
  const idx = parseInt(id.slice(hash + 1), 10);
  if (Number.isNaN(idx)) return null;
  return { way: id.slice(0, hash), idx };
}

// A chunk is split into sections wherever another road joins it partway
// along, so turning off at that junction still credits the part you drove.
// Section ids are "<chunk id>~<from>-<to>" (metres along the chunk); a chunk
// with no junction partway along is a single section with the chunk's own id.
export type Section = { id: string; from: number; to: number; i0: number; i1: number; atChunkStart: boolean; atChunkEnd: boolean };

export function baseChunkId(id: string): string {
  const i = id.indexOf('~');
  return i < 0 ? id : id.slice(0, i);
}

export type Match = {
  id: string | null;
  pos: number; // metres along the chunk from its first point
  // True when a road WAS in range but failed the direction check (a bridge
  // overhead, the opposite carriageway) — so the point isn't "off-road".
  nearbyRejected: boolean;
};

export class RoadNetwork {
  readonly segs = new Map<string, RoadSegment>();
  // Cumulative distance to each vertex along the chunk; last = chunk length.
  private readonly cum = new Map<string, number[]>();
  private readonly vertex = new Map<string, string[]>();
  private readonly grid = new Map<string, string[]>();

  get size() {
    return this.segs.size;
  }

  clear() {
    this.secCache.clear();
    this.joinCache.clear();
    this.segs.clear();
    this.cum.clear();
    this.vertex.clear();
    this.grid.clear();
  }

  add(segments: RoadSegment[]) {
    if (segments.length > 0) {
        this.secCache.clear();
        this.joinCache.clear(); // new roads can add junctions
    }
    for (const seg of segments) {
      if (this.segs.has(seg.id) || seg.coords.length < 2) continue;
      this.segs.set(seg.id, seg);
      const cum = [0];
      for (let i = 1; i < seg.coords.length; i++) cum.push(cum[i - 1] + haversine(seg.coords[i - 1], seg.coords[i]));
      this.cum.set(seg.id, cum);
      for (const c of seg.coords) {
        const k = vertexKey(c);
        const list = this.vertex.get(k);
        if (!list) this.vertex.set(k, [seg.id]);
        else if (!list.includes(seg.id)) list.push(seg.id);
      }
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      for (const [la, lo] of seg.coords) {
        if (la < minLat) minLat = la;
        if (la > maxLat) maxLat = la;
        if (lo < minLon) minLon = lo;
        if (lo > maxLon) maxLon = lo;
      }
      const la0 = Math.floor((minLat - CELL_PAD_LAT) / CELL_DEG);
      const la1 = Math.floor((maxLat + CELL_PAD_LAT) / CELL_DEG);
      const lo0 = Math.floor((minLon - CELL_PAD_LON) / CELL_DEG);
      const lo1 = Math.floor((maxLon + CELL_PAD_LON) / CELL_DEG);
      for (let a = la0; a <= la1; a++) {
        for (let b = lo0; b <= lo1; b++) {
          const k = cellKey(a, b);
          const list = this.grid.get(k);
          if (list) list.push(seg.id);
          else this.grid.set(k, [seg.id]);
        }
      }
    }
  }

  // Length of a chunk, or of one of its sections.
  length(id: string): number {
    const base = baseChunkId(id);
    if (base !== id) {
      const sec = this.sections(base).find((x) => x.id === id);
      if (sec) return sec.to - sec.from;
      const m = /~(\d+)-(\d+)$/.exec(id);
      return m ? Number(m[2]) - Number(m[1]) : 0;
    }
    const cum = this.cum.get(id);
    return cum ? cum[cum.length - 1] : 0;
  }

  private secCache = new Map<string, Section[]>();

  sections(id: string): Section[] {
    const cached = this.secCache.get(id);
    if (cached) return cached;
    const seg = this.segs.get(id);
    const cum = this.cum.get(id);
    if (!seg || !cum) return [];
    const cuts = [0];
    for (let i = 1; i < seg.coords.length - 1; i++) {
      if (this.chunksAt(seg.coords[i]).some((other) => other !== id)) cuts.push(i);
    }
    cuts.push(seg.coords.length - 1);
    const out: Section[] = [];
    for (let k = 0; k < cuts.length - 1; k++) {
      const i0 = cuts[k];
      const i1 = cuts[k + 1];
      const from = cum[i0];
      const to = cum[i1];
      out.push({
        id: cuts.length === 2 ? id : `${id}~${Math.round(from)}-${Math.round(to)}`,
        from,
        to,
        i0,
        i1,
        atChunkStart: i0 === 0,
        atChunkEnd: i1 === seg.coords.length - 1,
      });
    }
    this.secCache.set(id, out);
    return out;
  }

  // Shape of a chunk, a section, or any stretch "<chunk>~<a>-<b>" (metres
  // along the chunk), if its chunk is downloaded.
  shapeOf(id: string): Coord[] | null {
    const base = baseChunkId(id);
    const seg = this.segs.get(base);
    if (!seg) return null;
    if (base === id) return seg.coords;
    const sec = this.sections(base).find((x) => x.id === id);
    if (sec) return seg.coords.slice(sec.i0, sec.i1 + 1);
    const m = /~(\d+)-(\d+)$/.exec(id);
    return m ? this.subShape(base, Number(m[1]), Number(m[2])) : null;
  }

  // The part of a chunk between two distances along it.
  subShape(id: string, a: number, b: number): Coord[] | null {
    const seg = this.segs.get(id);
    const cum = this.cum.get(id);
    if (!seg || !cum || b <= a) return null;
    const at = (d: number): Coord => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const span = cum[i] - cum[i - 1];
      const f = span > 0 ? Math.max(0, Math.min(1, (d - cum[i - 1]) / span)) : 0;
      const p = seg.coords[i - 1], q = seg.coords[i];
      return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
    };
    const out: Coord[] = [at(a)];
    for (let i = 0; i < cum.length; i++) if (cum[i] > a && cum[i] < b) out.push(seg.coords[i]);
    out.push(at(b));
    return out;
  }

  nameOf(id: string): string | null {
    return this.segs.get(baseChunkId(id))?.n ?? null;
  }

  countyOf(id: string): number | null {
    return this.segs.get(baseChunkId(id))?.c ?? null;
  }

  // Chunks near a point (within roughly the snap distance of its cell).
  candidates(p: LatLon): string[] {
    return this.grid.get(cellKey(Math.floor(p.latitude / CELL_DEG), Math.floor(p.longitude / CELL_DEG))) || [];
  }

  // Chunks within a lat/lon box (for drawing), via the grid.
  inBox(minLat: number, minLon: number, maxLat: number, maxLon: number): RoadSegment[] {
    const out = new Map<string, RoadSegment>();
    const la0 = Math.floor(minLat / CELL_DEG), la1 = Math.floor(maxLat / CELL_DEG);
    const lo0 = Math.floor(minLon / CELL_DEG), lo1 = Math.floor(maxLon / CELL_DEG);
    if ((la1 - la0 + 1) * (lo1 - lo0 + 1) > 4000) return []; // too zoomed out to be useful
    for (let a = la0; a <= la1; a++) {
      for (let b = lo0; b <= lo1; b++) {
        for (const id of this.grid.get(cellKey(a, b)) || []) {
          if (!out.has(id)) out.set(id, this.segs.get(id)!);
        }
      }
    }
    return Array.from(out.values());
  }

  // Chunks sharing this exact point (roads that meet share an OSM node).
  chunksAt(c: Coord): string[] {
    return this.vertex.get(vertexKey(c)) || [];
  }

  // Distance along chunk `id` to vertex `c`, or null if it isn't on it.
  posOfVertex(id: string, c: Coord): number | null {
    const seg = this.segs.get(id);
    const cum = this.cum.get(id);
    if (!seg || !cum) return null;
    for (let i = 0; i < seg.coords.length; i++) {
      if (seg.coords[i][0] === c[0] && seg.coords[i][1] === c[1]) return cum[i];
    }
    return null;
  }

  // Every point two chunks share (two pieces of a roundabout share both ends).
  sharedVertices(a: string, b: string): Coord[] {
    const sa = this.segs.get(a);
    if (!sa) return [];
    const out: Coord[] = [];
    for (const c of sa.coords) if (this.chunksAt(c).includes(b) && !out.some((o) => o[0] === c[0] && o[1] === c[1])) out.push(c);
    return out;
  }

  // First shared point between two chunks, if they touch.
  sharedVertex(a: string, b: string): Coord | null {
    const sa = this.segs.get(a);
    if (!sa) return null;
    for (const c of sa.coords) {
      if (this.chunksAt(c).includes(b)) return c;
    }
    return null;
  }


  // An end of a chunk that no other road touches — a cul-de-sac or dead end.
  isDeadEnd(id: string, end: 'start' | 'end'): boolean {
    const seg = this.segs.get(id);
    if (!seg) return false;
    const c = end === 'start' ? seg.coords[0] : seg.coords[seg.coords.length - 1];
    return this.chunksAt(c).every((other) => other === id);
  }

  // Is this chunk drawn as a closed loop (a roundabout in one piece)?
  isLoop(id: string): boolean {
    const c = this.segs.get(id)?.coords;
    return !!c && c.length > 2 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
  }

  /**
   * Every chunk within the snap distance of a point, with its nearest
   * position and distance. When a direction of travel is known it only
   * accepts roads you could actually be driving along:
   *  - two-way roads: within maxAngleDeg of your heading, either direction
   *  - one-way roads: within maxAngleDeg of their direction of flow
   * `rejected` is set when a road was in range but failed that check
   * (a bridge overhead, the opposite carriageway).
   */
  near(p: LatLon, headingDeg: number | null, maxAngleDeg: number, excluded: Set<string>): { list: Candidate[]; rejected: boolean } {
    const best = new Map<string, Candidate>();
    let rejected = false;
    const mLon = metersPerDegLon(p.latitude);
    for (const id of this.candidates(p)) {
      if (excluded.has(id)) continue;
      const seg = this.segs.get(id)!;
      const cum = this.cum.get(id)!;
      for (let i = 0; i < seg.coords.length - 1; i++) {
        const ax = (seg.coords[i][1] - p.longitude) * mLon;
        const ay = (seg.coords[i][0] - p.latitude) * METERS_PER_DEG_LAT;
        const bx = (seg.coords[i + 1][1] - p.longitude) * mLon;
        const by = (seg.coords[i + 1][0] - p.latitude) * METERS_PER_DEG_LAT;
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        const dist = Math.sqrt(cx * cx + cy * cy);
        if (dist >= SNAP_THRESHOLD_METERS) continue;
        const prev = best.get(id);
        if (prev && prev.dist <= dist) continue;
        if (headingDeg !== null) {
          const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
          let diff: number;
          if (seg.o) {
            const flow = seg.o === 1 ? bearing : bearing + 180;
            diff = Math.abs((((headingDeg - flow) % 360) + 540) % 360 - 180);
          } else {
            diff = Math.abs(headingDeg - bearing) % 180;
            diff = Math.min(diff, 180 - diff);
          }
          if (diff > maxAngleDeg) {
            rejected = true;
            continue;
          }
        }
        best.set(id, { id, pos: cum[i] + t * (cum[i + 1] - cum[i]), dist });
      }
    }
    return { list: Array.from(best.values()), rejected };
  }

  /**
   * Road pieces you could reach from position `pos` on chunk `from` by
   * driving at most `maxM` metres along the network (one-way rules
   * respected), with the distance to each, where you'd join it, and the
   * piece you'd come from. Looks up to `hops` junctions ahead.
   */
  // v0.15.2: the vertices of a chunk that other chunks share, and where
  // they join them — worked out once per chunk instead of on every reach()
  // (the matcher's hottest path; ~30% faster re-checks).
  private joinCache = new Map<string, { i: number; other: string; at: number }[]>();
  private joins(id: string) {
    let j = this.joinCache.get(id);
    if (j) return j;
    j = [];
    const seg = this.segs.get(id)!;
    for (let i = 0; i < seg.coords.length; i++) {
      for (const other of this.chunksAt(seg.coords[i])) {
        if (other === id) continue;
        const at = this.posOfVertex(other, seg.coords[i]);
        if (at !== null) j.push({ i, other, at });
      }
    }
    this.joinCache.set(id, j);
    return j;
  }

  reach(from: string, pos: number, maxM: number, hops = 3): Map<string, Reach> {
    const out = new Map<string, Reach>();
    out.set(from, { cost: 0, at: pos, prev: null, leave: 0 });
    let frontier: { id: string; at: number; cost: number }[] = [{ id: from, at: pos, cost: 0 }];
    for (let hop = 0; hop < hops && frontier.length; hop++) {
      const next: { id: string; at: number; cost: number }[] = [];
      for (const f of frontier) {
        const seg = this.segs.get(f.id);
        const cum = this.cum.get(f.id);
        if (!seg || !cum) continue;
        const loop = this.isLoop(f.id);
        const len = cum[cum.length - 1];
        // Only the points where other roads join matter (cached per chunk).
        for (const { i, other, at } of this.joins(f.id)) {
          let d = cum[i] - f.at;
          if (loop && seg.o === 1 && d < -3) d += len; // on round the roundabout
          if (seg.o === 1 && d < -3) continue;
          if (seg.o === -1 && d > 3) continue;
          const cost = f.cost + Math.abs(d);
          if (cost > maxM) continue;
          const known = out.get(other);
          if (known && known.cost <= cost) continue;
          out.set(other, { cost, at, prev: f.id, leave: cum[i] });
          next.push({ id: other, at, cost });
        }
      }
      frontier = next;
    }
    return out;
  }

  /**
   * Round a ring drawn in several pieces: leaving one-way piece `id` at its
   * end and coming back onto it at or before `toPos` (you went round the
   * rest of the roundabout). Returns the pieces in between and where you
   * rejoined `id`, or null.
   */
  routeAround(id: string, toPos: number, maxM: number): { legs: Leg[]; back: number } | null {
    const seg = this.segs.get(id);
    if (!seg || seg.o !== 1) return null;
    const endV = seg.coords[seg.coords.length - 1];
    let best: { legs: Leg[]; back: number } | null = null;
    let bestCost = Infinity;
    for (const x of this.chunksAt(endV)) {
      if (x === id) continue;
      const xAt = this.posOfVertex(x, endV);
      if (xAt === null) continue;
      const r = this.reach(x, xAt, maxM, 4);
      r.forEach((info, y) => {
        if (y === id) return;
        const ys = this.segs.get(y);
        const ycum = this.cum.get(y);
        if (!ys || !ycum) return;
        for (let i = 0; i < ys.coords.length; i++) {
          const back = this.posOfVertex(id, ys.coords[i]);
          if (back === null || back > toPos + 3) continue;
          const along = ycum[i] - info.at;
          if (ys.o === 1 && along < -3) continue;
          if (ys.o === -1 && along > 3) continue;
          const cost = info.cost + Math.abs(along) + (toPos - back);
          if (cost >= bestCost) continue;
          bestCost = cost;
          const legs: Leg[] = [{ id: y, from: info.at, to: ycum[i] }];
          let cur = info;
          let guard = 0;
          while (cur.prev && guard++ < 10) {
            const prev = r.get(cur.prev)!;
            legs.unshift({ id: cur.prev, from: prev.at, to: cur.leave });
            cur = prev;
          }
          best = { legs, back };
        }
      });
    }
    return best;
  }

  /**
   * The pieces driven getting from `fromPos` on `from` to `toPos` on `to`:
   * each with where you joined it and left it (metres along it), shortest
   * route first. null if there's no such route within maxM.
   */
  route(from: string, fromPos: number, to: string, toPos: number, maxM: number): { id: string; from: number; to: number }[] | null {
    const r = this.reach(from, fromPos, maxM, 4);
    const end = r.get(to);
    if (!end || to === from) return null;
    const legs: { id: string; from: number; to: number }[] = [{ id: to, from: end.at, to: toPos }];
    let cur = end;
    let guard = 0;
    while (cur.prev && guard++ < 10) {
      const prev = r.get(cur.prev)!;
      legs.unshift({ id: cur.prev, from: prev.at, to: cur.leave });
      cur = prev;
    }
    return legs;
  }
}

export type Leg = { id: string; from: number; to: number };
export type Reach = { cost: number; at: number; prev: string | null; leave: number };
export type Candidate = { id: string; pos: number; dist: number };
