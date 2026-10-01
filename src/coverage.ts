// Turns a drive's GPS points into fully driven road chunks.
//
// A chunk only counts once you've covered it end to end (10m slack at each
// end; 40m at a dead end, so turning around near the end of a cul-de-sac
// still counts). Half-driving a chunk, or a stray GPS point landing on a
// side street, doesn't light it up.
//
// How it works:
//  1. Every GPS point (plus "bridge" points every 15m between consecutive
//     points) gets a few candidate roads nearby. The road for each sample
//     is chosen by route-aware matching (see push()): whole sequences are
//     weighed by distance from the GPS and by whether the road network
//     really lets you drive from one road to the next in that time. This
//     keeps you off slip roads and parallel streets you didn't take.
//  2. Consecutive samples on the same chunk form a "run": where you drove
//     on that chunk, from its lowest to highest position (roundabouts
//     drawn as a closed loop are handled as a continuous circle).
//  3. Spikes are dropped: a short run (under 30m of travel) sitting between
//     two runs that already connect to each other is GPS drift.
//  4. Moving from one run to the next, the actual route between them is
//     credited: each run is extended to where you left or joined it, and
//     short link pieces in between count between those two points only.
//  5. A chunk is split into sections wherever another road joins it partway
//     along. Each section counts once its covered stretches span it end to
//     end — so turning off at a junction still credits the part you drove.
//
// Pure logic with no React or storage, so it can be tested on its own and
// re-run over saved drives at any time.

import { RoadNetwork, Section, Match, Candidate, parseChunkId, baseChunkId } from './roadMatcher';
import { distanceMeters, headingBetween } from './geo';

// accuracy: GPS accuracy radius in metres (v0.14+; absent on older points).
export type Point = { latitude: number; longitude: number; timestamp: number; accuracy?: number | null };

// --- Wild GPS ---
// Points worse than this accuracy, or implying a jump faster than this
// speed from the last good point, are ignored for matching and distance.
export const MAX_ACCURACY_M = 30;
export const MAX_SPEED_MS = 200 / 3.6;
// After this many speed rejections in a row, the last GOOD point was
// probably the wild one — start again from the current point.
const SPEED_RESET_AFTER = 5;
// A drive is "patchy" when more than this share of its points were ignored.
export const PATCHY_SHARE = 0.2;
export const PATCHY_MIN_POINTS = 20;

const plausible = (a: Point, b: Point) =>
  distanceMeters(a, b) / (Math.max(1000, b.timestamp - a.timestamp) / 1000) <= MAX_SPEED_MS;

export class GpsFilter {
  private last: Point | null = null;
  private lastRejected: Point | null = null;
  private speedRejects = 0;
  private agreeing = 0;
  ignored = 0;
  total = 0;
  accept(p: Point): boolean {
    this.total++;
    if (p.accuracy != null && p.accuracy > MAX_ACCURACY_M) {
      this.ignored++;
      return false;
    }
    const prev = this.last;
    // A jump from the last good point is ignored — unless the points
    // rejected just before it (at least two) line up with it, which means
    // the last GOOD point was the wild one (e.g. a bad first fix).
    if (prev && !plausible(prev, p)) {
      const agrees = this.lastRejected !== null && plausible(this.lastRejected, p);
      if (!(agrees && this.agreeing >= 2) && this.speedRejects < SPEED_RESET_AFTER) {
        this.agreeing = agrees ? this.agreeing + 1 : 1;
        this.speedRejects++;
        this.ignored++;
        this.lastRejected = p;
        return false;
      }
    }
    this.agreeing = 0;
    this.speedRejects = 0;
    this.lastRejected = null;
    this.last = p;
    return true;
  }
}

export function isPatchy(ignored: number | null | undefined, total: number) {
  return !!ignored && total >= PATCHY_MIN_POINTS && ignored / total > PATCHY_SHARE;
}

// --- Road pieces ---
// Driven ids are a whole chunk ("way/1#2"), a section of one
// ("way/1#2~20-80"), or a start/stop stretch in the same form. These
// helpers keep them from overlapping, so nothing is counted twice.

// Metres along the chunk, or null for the whole chunk.
export function rangeOf(id: string): [number, number] | null {
  const m = /~(\d+)-(\d+)$/.exec(id);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function pieceContains(outer: string, inner: string): boolean {
  if (baseChunkId(outer) !== baseChunkId(inner)) return false;
  const o = rangeOf(outer);
  if (!o) return true;
  const i = rangeOf(inner);
  if (!i) return false;
  return i[0] >= o[0] - 1 && i[1] <= o[1] + 1;
}

// Driven ids grouped by chunk, for quick overlap checks.
export class PieceIndex {
  private byBase = new Map<string, Set<string>>();
  constructor(ids: Iterable<string> = []) {
    for (const id of ids) this.add(id);
  }
  has(id: string) {
    return this.byBase.get(baseChunkId(id))?.has(id) ?? false;
  }
  add(id: string) {
    const b = baseChunkId(id);
    const set = this.byBase.get(b);
    if (set) set.add(id);
    else this.byBase.set(b, new Set([id]));
  }
  delete(id: string) {
    this.byBase.get(baseChunkId(id))?.delete(id);
  }
  // An existing piece that already covers this one (or itself).
  coveredBy(id: string): string | null {
    for (const other of this.byBase.get(baseChunkId(id)) || []) if (pieceContains(other, id)) return other;
    return null;
  }
  // Existing pieces this one would cover (not counting itself).
  within(id: string): string[] {
    const out: string[] = [];
    for (const other of this.byBase.get(baseChunkId(id)) || []) if (other !== id && pieceContains(id, other)) out.push(other);
    return out;
  }
}

export const END_TOLERANCE_M = 10;
export const DEAD_END_TOLERANCE_M = 40;

const BRIDGE_STEP_M = 15;
const BRIDGE_MAX_M = 250; // bigger gaps (tunnel, signal loss) aren't bridged
const BRIDGE_MAX_MS = 30_000;
const LINK_MAX_MS = 60_000;
const GAP_FILL_MAX_CHUNKS = 8; // ~800m along the same road
const CONNECT_MAX_CHUNKS = 3;
const HEADING_MAX_ANGLE_DEG = 55;
const HEADING_MIN_MOVE_M = 8; // below this, direction is too noisy to trust
const HEADING_STALE_MS = 10_000;
const SPIKE_MAX_EXTENT_M = 30;
const STITCH_M = 5; // stretches this close are stored as one
// When checking if a section is covered, gaps up to this size between
// stretches are forgiven — e.g. where one drive ended and a later one
// started (parking at home), the GPS points rarely meet exactly.
const GAP_OK_M = 25;
// Start/stop credit: a drive that starts or ends within this distance of
// the end of a road section gets the whole section; further away, just the
// stretch actually driven.
export const STUB_WHOLE_M = 35;
const STUB_MIN_M = 5;
// A drive counts as having driven a chunk (for the heatmap) when it
// covered at least this share of it.
const HEAT_MIN_SHARE = 0.5;

// lo/hi: extent driven on the chunk. On a roundabout drawn as a closed
// loop they're "unwrapped" (can run below 0 or past its length) so an arc
// across the loop's start point stays one continuous stretch.
// at: the latest position, in the same unwrapped terms.
type Run = { id: string; lo: number; hi: number; at: number; first: number; tStart: number; tEnd: number };

// Route-aware matching (see push()).
const WINDOW_MAX = 80; // most samples held back before a road is decided (~1.2 km)
const GPS_SIGMA_M = 10; // typical GPS error
const ROUTE_BETA_M = 5; // how strictly the route must match the distance travelled
const JUMP_COST = 40; // cost of a jump the road network can't explain (GPS spike, missing road)
const REACH_SLACK_M = 60;
const LINK_ROUTE_MAX_M = 400;
const WRAP_BACK_M = 15; // further back than GPS jitter on a one-way piece = went round
const emissionCost = (dist: number) => (dist * dist) / (2 * GPS_SIGMA_M * GPS_SIGMA_M);

type Layer = {
  p: { latitude: number; longitude: number };
  t: number;
  cands: Candidate[];
  trans: number[][] | null; // [previous layer's candidate][this layer's candidate]
  real: boolean; // a GPS point (not an in-between sample)
};

export class DriveMatcher {
  private lastPoint: Point | null = null;
  private lastHeading: { deg: number; t: number } | null = null;
  private pending: Run[] = [];
  private done = new Set<string>();
  // Chunks whose covered stretches changed during this drive (to save).
  readonly touched = new Set<string>();
  private completedBuffer: string[] = [];
  lastChunkId: string | null = null;
  private lastLayer: Layer | null = null; // last emitted sample, to link the next window to it
  private lastChoice: number | null = null;
  // Where this drive itself went on each chunk (for the heatmap).
  private own = new Map<string, [number, number][]>();
  private firstMatch: { id: string; pos: number } | null = null;
  private lastMatch: { id: string; pos: number } | null = null;
  private stubList: string[] = [];
  readonly gps = new GpsFilter();

  /**
   * `coverage` holds the stretches of each chunk covered so far. Pass the
   * same map from drive to drive and coverage adds up across drives: drive
   * to your house one day and away from it the next, and the road outside
   * it counts once both halves are done.
   */
  constructor(
    private net: RoadNetwork,
    private excluded: Set<string>,
    private coverage: Map<string, [number, number][]> = new Map()
  ) {}

  // Chunks completed so far this drive.
  get completed(): ReadonlySet<string> {
    return this.done;
  }

  // `accepted`: the points that passed the wild-GPS filter.
  feed(points: Point[]): { completed: string[]; unmatched: Point[]; accepted: Point[] } {
    const unmatched: Point[] = [];
    const accepted: Point[] = [];
    for (const p of points) {
      if (!this.gps.accept(p)) continue;
      accepted.push(p);
      const prev = this.lastPoint;
      let heading: number | null = null;
      if (prev && distanceMeters(prev, p) >= HEADING_MIN_MOVE_M) {
        heading = headingBetween(prev, p);
        this.lastHeading = { deg: heading, t: p.timestamp };
      } else if (this.lastHeading && p.timestamp - this.lastHeading.t <= HEADING_STALE_MS) {
        heading = this.lastHeading.deg;
      }

      if (prev && p.timestamp - prev.timestamp <= BRIDGE_MAX_MS) {
        const dist = distanceMeters(prev, p);
        if (dist > BRIDGE_STEP_M && dist <= BRIDGE_MAX_M) {
          for (let s = 1; s * BRIDGE_STEP_M < dist; s++) {
            const f = (s * BRIDGE_STEP_M) / dist;
            const q = {
              latitude: prev.latitude + (p.latitude - prev.latitude) * f,
              longitude: prev.longitude + (p.longitude - prev.longitude) * f,
            };
            this.push(q, heading, prev.timestamp + (p.timestamp - prev.timestamp) * f, false);
          }
        }
      }
      const m = this.push(p, heading, p.timestamp, true);
      if (!m.id && !m.nearbyRejected) unmatched.push(p);
      this.lastPoint = p;
    }
    this.settle(false);
    return { completed: this.takeCompleted(), unmatched, accepted };
  }

  // End of drive: everything still pending is finalised, and the road
  // pieces where the drive started and stopped get their credit.
  finish(): string[] {
    this.flush();
    this.settle(true);
    for (const end of [this.firstMatch, this.lastMatch]) if (end) this.creditEnd(end.id, end.pos);
    return this.takeCompleted();
  }

  // Part-driven stretches earned at the start/stop of the drive
  // ("<chunk>~<a>-<b>"), available after finish().
  get stubs(): readonly string[] {
    return this.stubList;
  }

  // Chunks this drive itself covered at least half of (for the heatmap).
  roadsCovered(): string[] {
    const out: string[] = [];
    this.own.forEach((st, id) => {
      const len = this.net.length(id);
      const got = mergeStretches(st).reduce((m, [a, b]) => m + (b - a), 0);
      if (len > 0 && got >= len * HEAT_MIN_SHARE) out.push(id);
    });
    return out;
  }

  // The drive started or stopped at `pos` on chunk `id`. If the section
  // there is driven from one of its ends up to near that point, credit it:
  // the whole section if within STUB_WHOLE_M of its end, else just the
  // stretch driven.
  private creditEnd(id: string, pos: number) {
    const sec = this.net.sections(id).find((x) => pos >= x.from - 0.5 && pos <= x.to + 0.5);
    if (!sec || this.done.has(sec.id)) return;
    const st = this.coverage.get(id);
    if (!st || st.length === 0) return;
    const around = stretchAround(st, pos);
    if (!around) return;
    const lo = Math.max(around[0], sec.from);
    const hi = Math.min(around[1], sec.to);
    const tol0 = sec.atChunkStart && this.net.isDeadEnd(id, 'start') ? DEAD_END_TOLERANCE_M : END_TOLERANCE_M;
    const tol1 = sec.atChunkEnd && this.net.isDeadEnd(id, 'end') ? DEAD_END_TOLERANCE_M : END_TOLERANCE_M;
    const reachesFrom = lo <= sec.from + tol0;
    const reachesTo = hi >= sec.to - tol1;
    let piece: [number, number] | null = null;
    if (reachesFrom && reachesTo) piece = [sec.from, sec.to];
    else if (reachesTo) piece = lo - sec.from <= STUB_WHOLE_M ? [sec.from, sec.to] : [lo, sec.to];
    else if (reachesFrom) piece = sec.to - hi <= STUB_WHOLE_M ? [sec.from, sec.to] : [sec.from, hi];
    if (!piece) return;
    if (piece[0] === sec.from && piece[1] === sec.to) {
      this.done.add(sec.id);
      this.completedBuffer.push(sec.id);
      return;
    }
    if (piece[1] - piece[0] < STUB_MIN_M) return;
    const pid = `${id}~${Math.round(piece[0])}-${Math.round(piece[1])}`;
    if (!this.stubList.includes(pid)) this.stubList.push(pid);
  }

  private takeCompleted() {
    const out = this.completedBuffer;
    this.completedBuffer = [];
    return out;
  }

  // ---- Choosing roads: route-aware matching (a hidden Markov model) ----
  //
  // Each GPS sample has a few candidate roads nearby. Rather than taking
  // the nearest road point by point, the matcher weighs whole sequences:
  // how far each sample is from its road, and whether you could really
  // have driven from one road to the next in the time between samples
  // (network distance vs straight-line distance, one-way rules included).
  // A slip road running 10 m beside the motorway loses, because getting
  // onto it would mean going back to where it split off. Decisions are
  // made WINDOW samples late, once the samples after them have been seen.

  private win: Layer[] = [];
  private anchor: number | null = null; // chosen candidate of the last emitted layer (row into win[0].trans)

  private push(p: { latitude: number; longitude: number }, heading: number | null, t: number, real: boolean): Match {
    const { list, rejected } = this.net.near(p, heading, HEADING_MAX_ANGLE_DEG, this.excluded);
    if (list.length === 0) {
      this.flush();
      return { id: null, pos: 0, nearbyRejected: rejected };
    }
    const prev = this.win[this.win.length - 1] ?? this.lastLayer;
    let trans: number[][] | null = null;
    if (prev && t - prev.t <= LINK_MAX_MS) {
      const straight = distanceMeters(prev.p, p);
      trans = prev.cands.map((a) => list.map((b) => this.transCost(a, b, straight)));
    } else {
      this.flush();
    }
    if (this.win.length === 0) this.anchor = trans && this.lastChoice !== null ? this.lastChoice : null;
    this.win.push({ p: { latitude: p.latitude, longitude: p.longitude }, t, cands: list, trans: this.win.length || this.anchor !== null ? trans : null, real });
    // Decide the samples every possible route agrees on so far; if the
    // window gets very long without agreeing, decide the oldest anyway.
    const settled = this.converged();
    if (settled > 0) this.emit(settled);
    else if (this.win.length > WINDOW_MAX) this.emit(1);
    return { id: list[0].id, pos: list[0].pos, nearbyRejected: false };
  }

  // Emits the oldest n layers along the best path through the window.
  private emit(n: number) {
    const path = this.bestPath();
    for (let i = 0; i < n && this.win.length; i++) {
      const layer = this.win.shift()!;
      const c = layer.cands[path[i]];
      this.anchor = path[i];
      this.lastLayer = layer;
      this.lastChoice = path[i];
      this.addSample(c.id, c.pos, layer.t);
      if (layer.real) {
        if (!this.firstMatch) this.firstMatch = { id: c.id, pos: c.pos };
        this.lastMatch = { id: c.id, pos: c.pos };
      }
    }
  }

  private flush() {
    if (this.win.length) this.emit(this.win.length);
    this.anchor = null;
    this.lastLayer = null;
    this.lastChoice = null;
  }

  // How many of the oldest layers are settled: every candidate in the
  // newest layer traces back through the same choices for them.
  private converged(): number {
    const L = this.win.length;
    if (L < 2) return 0;
    const { back } = this.viterbi();
    const paths = this.win[L - 1].cands.map((_, j) => {
      const path = new Array(L);
      for (let i = L - 1; i >= 0; i--) {
        path[i] = j;
        j = back[i][j];
      }
      return path;
    });
    let n = 0;
    while (n < L - 1 && paths.every((pa) => pa[n] === paths[0][n])) n++;
    return n;
  }

  private bestPath(): number[] {
    const L = this.win.length;
    const { cost, back } = this.viterbi();
    const path = new Array(L).fill(0);
    let j = 0;
    for (let k = 1; k < cost[L - 1].length; k++) if (cost[L - 1][k] < cost[L - 1][j]) j = k;
    for (let i = L - 1; i >= 0; i--) {
      path[i] = j;
      j = back[i][j];
    }
    return path;
  }

  // Viterbi over the window: lowest total cost to reach each candidate.
  private viterbi(): { cost: number[][]; back: number[][] } {
    const L = this.win.length;
    const cost: number[][] = [];
    const back: number[][] = [];
    for (let i = 0; i < L; i++) {
      const layer = this.win[i];
      cost.push([]);
      back.push([]);
      for (let j = 0; j < layer.cands.length; j++) {
        const e = emissionCost(layer.cands[j].dist);
        if (i === 0) {
          const tr = this.anchor !== null && layer.trans ? layer.trans[this.anchor]?.[j] ?? 0 : 0;
          cost[0].push(e + tr);
          back[0].push(-1);
          continue;
        }
        let best = Infinity;
        let arg = 0;
        const tr = layer.trans;
        for (let k = 0; k < this.win[i - 1].cands.length; k++) {
          const c = cost[i - 1][k] + (tr ? tr[k][j] : 0);
          if (c < best) {
            best = c;
            arg = k;
          }
        }
        cost[i].push(e + best);
        back[i].push(arg);
      }
    }
    return { cost, back };
  }

  // How implausible it is to get from candidate a to candidate b, given
  // the straight-line distance between their GPS samples.
  private transCost(a: Candidate, b: Candidate, straight: number): number {
    let route: number;
    if (a.id === b.id) route = this.alongCost(a.id, a.pos, b.pos);
    else {
      const r = this.net.reach(a.id, a.pos, straight * 2 + REACH_SLACK_M).get(b.id);
      route = r ? r.cost + this.alongCost(b.id, r.at, b.pos) : Infinity;
    }
    if (!Number.isFinite(route)) return JUMP_COST;
    return Math.min(JUMP_COST, Math.abs(route - straight) / ROUTE_BETA_M);
  }

  // Metres driven along a chunk from one position to another; Infinity if
  // that would mean going the wrong way up a one-way road (beyond GPS jitter).
  private alongCost(id: string, from: number, to: number): number {
    const o = this.net.segs.get(id)?.o;
    let d = to - from;
    if (this.net.isLoop(id)) {
      const len = this.net.length(id);
      if (o === 1 && d < -10) d += len;
      else if (!o && Math.abs(d) > len / 2) d = len - Math.abs(d);
    }
    if (o === 1 && d < -10) return Infinity;
    if (o === -1 && d > 10) return Infinity;
    return Math.abs(d);
  }

  // A position on a closed loop brought back into 0..length.
  private wrap(id: string, pos: number): number {
    if (!this.net.isLoop(id)) return pos;
    const len = this.net.length(id);
    return len > 0 ? ((pos % len) + len) % len : pos;
  }

  // On a closed loop, the copy of pos (pos, pos ± length) nearest to ref.
  private unwrap(id: string, pos: number, ref: number): number {
    if (!this.net.isLoop(id)) return pos;
    const len = this.net.length(id);
    if (len <= 0) return pos;
    const k = Math.round((ref - pos) / len);
    return pos + k * len;
  }

  // Did you come back onto a one-way piece behind where you last were on
  // it? Then you went round a ring drawn in several pieces (the pieces in
  // between may have had no GPS points at all).
  private wrapsBack(id: string, from: number, to: number): boolean {
    if (this.net.isLoop(id)) return false; // one closed piece: unwrap() handles it
    const o = this.net.segs.get(id)?.o;
    return (o === 1 && to < from - WRAP_BACK_M) || (o === -1 && to > from + WRAP_BACK_M);
  }

  // Would going straight from run p onto run n mean driving backwards along
  // one-way n (joining it before the point where p meets it)?
  private joinsBehind(p: Run, n: Run): boolean {
    const o = this.net.segs.get(n.id)?.o;
    if (!o || this.net.isLoop(n.id)) return false;
    const v = this.junctionBetween(p, n);
    if (!v) return false;
    const at = this.net.posOfVertex(n.id, v);
    if (at === null) return false;
    return this.wrapsBack(n.id, at, n.first);
  }

  private addSample(id: string, pos: number, t: number) {
    this.lastChunkId = id;
    const last = this.pending[this.pending.length - 1];
    if (last && last.id === id && !this.wrapsBack(id, last.at, pos)) {
      const u = this.unwrap(id, pos, last.at);
      if (u < last.lo) last.lo = u;
      if (u > last.hi) last.hi = u;
      last.at = u;
      last.tEnd = t;
    } else {
      this.pending.push({ id, lo: pos, hi: pos, at: pos, first: pos, tStart: t, tEnd: t });
    }
  }

  private touches(a: string, b: string) {
    return a === b || this.net.sharedVertex(a, b) !== null;
  }

  private removeSpikes() {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 1; i < this.pending.length - 1; i++) {
        const p = this.pending[i - 1];
        const r = this.pending[i];
        const n = this.pending[i + 1];
        if (r.hi - r.lo >= SPIKE_MAX_EXTENT_M) continue;
        if (n.tStart - p.tEnd > LINK_MAX_MS) continue;
        if (!this.touches(p.id, n.id)) continue;
        if (p.id === n.id && this.wrapsBack(p.id, p.at, n.first)) continue; // went round: keep both
        // Joining p straight onto n would mean going the wrong way along n
        // (you joined n behind where p meets it): r is the way round, not noise.
        if (p.id !== n.id && this.joinsBehind(p, n)) continue;
        if (p.id === n.id) {
          const shift = this.unwrap(p.id, n.at, p.at) - n.at;
          p.lo = Math.min(p.lo, n.lo + shift);
          p.hi = Math.max(p.hi, n.hi + shift);
          p.at = n.at + shift;
          p.tEnd = n.tEnd;
          this.pending.splice(i, 2);
        } else {
          this.pending.splice(i, 1);
        }
        changed = true;
        break;
      }
    }
  }

  private settle(final: boolean) {
    this.removeSpikes();
    // A run is safe to finalise once the run after it has been checked for
    // being a spike, i.e. there are two more runs behind it.
    const keep = final ? 0 : 2;
    while (this.pending.length > keep) {
      const r = this.pending.shift()!;
      this.finalise(r, this.pending[0] ?? null);
    }
  }

  private finalise(r: Run, next: Run | null) {
    const full: string[] = [];
    const partial: [string, number, number][] = [];
    if (next && next.tStart - r.tEnd <= LINK_MAX_MS) this.link(r, next, full, partial);
    this.cover(r.id, r.lo, r.hi);
    for (const id of full) this.cover(id, 0, this.net.length(id));
    for (const [id, lo, hi] of partial) this.cover(id, lo, hi);
  }

  // You drove from run r to run next: extend both to where they meet, and
  // collect chunks in between that were driven in full.
  private link(r: Run, next: Run, full: string[], partial: [string, number, number][]) {
    const net = this.net;
    // Back onto the same one-way piece behind where you left it: round the
    // rest of the ring.
    if (r.id === next.id && this.wrapsBack(r.id, r.at, next.first)) {
      const around = net.routeAround(r.id, next.first, LINK_ROUTE_MAX_M);
      if (around) {
        this.extend(r, net.length(r.id));
        this.extend(next, around.back);
        for (const leg of around.legs) partial.push([leg.id, Math.min(leg.from, leg.to), Math.max(leg.from, leg.to)]);
      }
      return;
    }
    // Best: the actual route between where you left one road and joined
    // the next (so a roundabout is credited the way you went round it).
    if (r.id !== next.id) {
      const legs = net.route(r.id, this.wrap(r.id, r.at), next.id, next.first, LINK_ROUTE_MAX_M);
      const last = legs?.[legs.length - 1];
      // Joined next "behind" its end: carry on round the ring back to it.
      if (legs && last && !Number.isFinite(this.alongCost(next.id, last.from, next.first))) {
        const around = net.routeAround(next.id, next.first, LINK_ROUTE_MAX_M);
        if (around) {
          this.extend(r, legs[0].to);
          for (const leg of legs.slice(1, -1)) partial.push([leg.id, Math.min(leg.from, leg.to), Math.max(leg.from, leg.to)]);
          partial.push([next.id, last.from, net.length(next.id)]);
          for (const leg of around.legs) partial.push([leg.id, Math.min(leg.from, leg.to), Math.max(leg.from, leg.to)]);
          this.extend(next, around.back);
          return;
        }
      }
      if (legs && last && Number.isFinite(this.alongCost(next.id, last.from, next.first))) {
        this.extend(r, legs[0].to);
        this.extend(next, last.from);
        for (const leg of legs.slice(1, -1)) {
          if (this.net.isLoop(leg.id) && leg.to < leg.from) partial.push([leg.id, leg.from, leg.to + net.length(leg.id)]);
          else partial.push([leg.id, Math.min(leg.from, leg.to), Math.max(leg.from, leg.to)]);
        }
        return;
      }
    }
    const a = parseChunkId(r.id);
    const b = parseChunkId(next.id);
    // Pieces that meet directly join at that point — this also stops a
    // roundabout split into several pieces from being "filled in" the long
    // way round, from its last piece back to its first.
    const direct = r.id !== next.id ? this.junctionBetween(r, next) : null;
    if (direct) {
      this.extend(r, net.posOfVertex(r.id, direct));
      this.extend(next, net.posOfVertex(next.id, direct));
      return;
    }
    if (a && b && a.way === b.way && a.idx !== b.idx && Math.abs(a.idx - b.idx) <= GAP_FILL_MAX_CHUNKS) {
      const forward = b.idx > a.idx;
      const lo = Math.min(a.idx, b.idx);
      const hi = Math.max(a.idx, b.idx);
      for (let k = lo + 1; k < hi; k++) {
        const mid = `${a.way}#${k}`;
        if (net.segs.has(mid) && !this.excluded.has(mid)) full.push(mid);
      }
      this.extend(r, forward ? net.length(r.id) : 0);
      this.extend(next, forward ? 0 : net.length(next.id));
      return;
    }
    const path = this.connect(r.id, next.id);
    if (path) {
      // Each link chunk is only covered between where you joined it and
      // where you left it — a junction can sit partway along a chunk.
      const chain = [r.id, ...path, next.id];
      const at: (number | null)[][] = chain.map(() => []);
      for (let i = 0; i < chain.length - 1; i++) {
        const v = net.sharedVertex(chain[i], chain[i + 1]);
        if (!v) return;
        at[i].push(net.posOfVertex(chain[i], v));
        at[i + 1].push(net.posOfVertex(chain[i + 1], v));
      }
      this.extend(r, at[0][0]);
      this.extend(next, at[chain.length - 1][0]);
      for (let i = 1; i < chain.length - 1; i++) {
        const [p0, p1] = at[i];
        if (p0 !== null && p1 !== null) partial.push([chain[i], Math.min(p0, p1), Math.max(p0, p1)]);
      }
    }
  }

  // Where you crossed from one run's road to the next: of the points the
  // two roads share, the one closest to where you left the first and
  // joined the second.
  private junctionBetween(r: Run, next: Run): [number, number] | null {
    const shared = this.net.sharedVertices(r.id, next.id);
    if (shared.length <= 1) return shared[0] ?? null;
    const gap = (run: Run, pos: number | null) => {
      if (pos === null) return Infinity;
      const len = this.net.length(run.id);
      const copies = this.net.isLoop(run.id) ? [pos - len, pos, pos + len] : [pos];
      return Math.min(...copies.map((x) => (x < run.lo ? run.lo - x : x > run.hi ? x - run.hi : 0)));
    };
    let best = shared[0];
    let bestCost = Infinity;
    for (const v of shared) {
      const cost = gap(r, this.net.posOfVertex(r.id, v)) + gap(next, this.net.posOfVertex(next.id, v));
      if (cost < bestCost) {
        bestCost = cost;
        best = v;
      }
    }
    return best;
  }

  private extend(r: Run, pos: number | null) {
    if (pos === null) return;
    if (this.net.isLoop(r.id)) {
      // The copy of that point nearest the stretch already driven.
      const len = this.net.length(r.id);
      const c = [pos - len, pos, pos + len];
      const gap = (x: number) => (x < r.lo ? r.lo - x : x > r.hi ? x - r.hi : 0);
      pos = c.reduce((a, b) => (gap(b) < gap(a) ? b : a));
    }
    if (pos < r.lo) r.lo = pos;
    if (pos > r.hi) r.hi = pos;
  }

  // Shortest chain of connected chunks between two that don't touch;
  // returns the chunks strictly in between, or null.
  private connect(fromId: string, toId: string): string[] | null {
    let frontier: { id: string; path: string[] }[] = [{ id: fromId, path: [] }];
    const seen = new Set<string>([fromId]);
    for (let depth = 0; depth <= CONNECT_MAX_CHUNKS; depth++) {
      const next: { id: string; path: string[] }[] = [];
      for (const node of frontier) {
        const seg = this.net.segs.get(node.id);
        if (!seg) continue;
        for (const c of seg.coords) {
          for (const nid of this.net.chunksAt(c)) {
            if (seen.has(nid)) continue;
            if (nid === toId) return node.path.length > 0 ? node.path : null;
            if (this.excluded.has(nid)) continue;
            seen.add(nid);
            if (depth < CONNECT_MAX_CHUNKS) next.push({ id: nid, path: [...node.path, nid] });
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  // Records a covered stretch of a chunk, and reports any of its sections
  // that are now covered end to end.
  private cover(id: string, lo: number, hi: number) {
    if (this.net.isLoop(id)) {
      const len = this.net.length(id);
      if (hi - lo >= len) {
        lo = 0;
        hi = len;
      } else if (lo < 0 || hi > len) {
        const k = Math.floor(lo / len);
        lo -= k * len;
        hi -= k * len;
        if (hi > len) {
          this.cover(id, 0, hi - len);
          hi = len;
        }
      }
    }
    const secs = this.net.sections(id);
    if (secs.length === 0) return;
    this.own.set(id, [...(this.own.get(id) || []), [lo, hi]]);
    const merged = mergeStretches([...(this.coverage.get(id) || []), [lo, hi]]);
    this.coverage.set(id, merged);
    this.touched.add(id);
    let allDone = true;
    for (const sec of secs) {
      if (this.done.has(sec.id)) continue;
      if (isSectionCovered(this.net, id, sec, merged)) {
        this.done.add(sec.id);
        this.completedBuffer.push(sec.id);
      } else {
        allDone = false;
      }
    }
    // Fully driven chunks don't need their stretches kept any more.
    if (allDone) this.coverage.delete(id);
  }
}

// Sorts and joins overlapping (or nearly touching) stretches.
export function mergeStretches(stretches: [number, number][]): [number, number][] {
  const sorted = stretches.slice().sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + STITCH_M) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Is this section covered end to end? 10m slack at each end; 40m at the
// end of a dead-end road.
export function isSectionCovered(net: RoadNetwork, chunkId: string, sec: Section, stretches: [number, number][]): boolean {
  const tol0 = sec.atChunkStart && net.isDeadEnd(chunkId, 'start') ? DEAD_END_TOLERANCE_M : END_TOLERANCE_M;
  const tol1 = sec.atChunkEnd && net.isDeadEnd(chunkId, 'end') ? DEAD_END_TOLERANCE_M : END_TOLERANCE_M;
  let need0 = sec.from + tol0;
  let need1 = sec.to - tol1;
  if (need0 >= need1) need0 = need1 = (sec.from + sec.to) / 2; // tiny section: just its middle
  return spans(stretches, need0, need1);
}

// Whole-chunk version (every section covered).
export function isCovered(net: RoadNetwork, id: string, stretches: [number, number][]): boolean {
  return net.sections(id).every((sec) => isSectionCovered(net, id, sec, stretches));
}

// The joined-up stretch (gaps up to GAP_OK_M forgiven) that contains pos.
function stretchAround(stretches: [number, number][], pos: number): [number, number] | null {
  const sorted = stretches.slice().sort((x, y) => x[0] - y[0]);
  let lo = sorted[0][0];
  let hi = sorted[0][1];
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i][0] <= hi + GAP_OK_M) {
      hi = Math.max(hi, sorted[i][1]);
      continue;
    }
    if (pos >= lo - 1 && pos <= hi + 1) return [lo, hi];
    if (i === sorted.length) break;
    lo = sorted[i][0];
    hi = sorted[i][1];
  }
  return null;
}

function spans(stretches: [number, number][], need0: number, need1: number): boolean {
  const sorted = stretches.slice().sort((x, y) => x[0] - y[0]);
  let lo = sorted[0][0];
  let hi = sorted[0][1];
  for (let i = 1; i <= sorted.length; i++) {
    if (lo <= need0 && hi >= need1) return true;
    if (i === sorted.length) break;
    const [a, b] = sorted[i];
    if (a <= hi + GAP_OK_M) hi = Math.max(hi, b);
    else {
      lo = a;
      hi = b;
    }
  }
  return false;
}
