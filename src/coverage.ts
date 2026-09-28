// Turns a drive's GPS points into fully driven road chunks.
//
// A chunk only counts once you've covered it end to end (10m slack at each
// end; 40m at a dead end, so turning around near the end of a cul-de-sac
// still counts). Half-driving a chunk, or a stray GPS point landing on a
// side street, no longer lights it up.
//
// How it works:
//  1. Every GPS point (plus "bridge" points every 15m between consecutive
//     points) is snapped to the nearest eligible chunk, giving a position
//     along that chunk. The road you're already on gets a 12m head start,
//     so noisy GPS doesn't hop you onto a parallel street and back.
//  2. Consecutive samples on the same chunk form a "run". A run is where
//     you drove on that chunk, from its lowest to highest position.
//  3. Spikes are dropped: a short run (under 30m of travel) sitting between
//     two runs that already connect to each other is GPS drift — e.g. one
//     point landing on a side street as you pass it.
//  4. Moving from one run to the next means you drove through the point
//     where those chunks meet, so each run is extended to that junction.
//     Chunks skipped over on the same road were driven in full; a short
//     link between two roads counts between the two junctions only.
//  5. A chunk is split into sections wherever another road joins it partway
//     along. Each section counts once its covered stretches span it end to
//     end — so turning off at a junction still credits the part you drove.
//
// Pure logic with no React or storage, so it can be tested on its own and
// re-run over saved drives at any time.

import { RoadNetwork, Section, parseChunkId, baseChunkId } from './roadMatcher';
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

type Run = { id: string; lo: number; hi: number; tStart: number; tEnd: number };

export class DriveMatcher {
  private lastPoint: Point | null = null;
  private lastHeading: { deg: number; t: number } | null = null;
  private pending: Run[] = [];
  private done = new Set<string>();
  // Chunks whose covered stretches changed during this drive (to save).
  readonly touched = new Set<string>();
  private completedBuffer: string[] = [];
  lastChunkId: string | null = null;
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
            const m = this.net.match(q, heading, HEADING_MAX_ANGLE_DEG, this.excluded, this.lastChunkId);
            if (m.id) this.addSample(m.id, m.pos, prev.timestamp + (p.timestamp - prev.timestamp) * f);
          }
        }
      }
      const m = this.net.match(p, heading, HEADING_MAX_ANGLE_DEG, this.excluded, this.lastChunkId);
      if (m.id) {
        this.addSample(m.id, m.pos, p.timestamp);
        if (!this.firstMatch) this.firstMatch = { id: m.id, pos: m.pos };
        this.lastMatch = { id: m.id, pos: m.pos };
      } else if (!m.nearbyRejected) unmatched.push(p);
      this.lastPoint = p;
    }
    this.settle(false);
    return { completed: this.takeCompleted(), unmatched, accepted };
  }

  // End of drive: everything still pending is finalised, and the road
  // pieces where the drive started and stopped get their credit.
  finish(): string[] {
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

  private addSample(id: string, pos: number, t: number) {
    this.lastChunkId = id;
    const last = this.pending[this.pending.length - 1];
    if (last && last.id === id) {
      if (pos < last.lo) last.lo = pos;
      if (pos > last.hi) last.hi = pos;
      last.tEnd = t;
    } else {
      this.pending.push({ id, lo: pos, hi: pos, tStart: t, tEnd: t });
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
        if (p.id === n.id) {
          p.lo = Math.min(p.lo, n.lo);
          p.hi = Math.max(p.hi, n.hi);
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
    const a = parseChunkId(r.id);
    const b = parseChunkId(next.id);
    if (a && b && a.way === b.way && Math.abs(a.idx - b.idx) <= GAP_FILL_MAX_CHUNKS) {
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
    const v = net.sharedVertex(r.id, next.id);
    if (v) {
      this.extend(r, net.posOfVertex(r.id, v));
      this.extend(next, net.posOfVertex(next.id, v));
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

  private extend(r: Run, pos: number | null) {
    if (pos === null) return;
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
