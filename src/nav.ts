// Sat-nav logic (v0.16): following a route, when to speak, going off
// route, arriving, and how much never-driven road a route has. Pure logic
// (no React or native calls) so it can be tested on its own. The routes
// themselves come from Apple (modules/nav-kit) for now; anything that
// gives a line plus turn steps can replace it later.

import { RoadNetwork, Candidate, baseChunkId } from './roadMatcher';
import { rangeOf, mergeStretches } from './coverage';
import { Coord, haversine, metersPerDegLon, METERS_PER_DEG_LAT, headingBetween } from './geo';

export type RouteStep = { instruction: string; notice: string; distance: number; coords: Coord[] };
export type NavRoute = { name: string; distance: number; duration: number; coords: Coord[]; steps: RouteStep[] };

// --- tuning ---
const OFF_ROUTE_M = 45; // further than this from the line...
const OFF_ROUTE_FIXES = 3; // ...this many fixes in a row = off route
const ARRIVE_M = 35;
const SEARCH_BACK_M = 150; // where to look for you on the route, around where you were
const SEARCH_AHEAD_M = 1500;

// Metres along a polyline at each vertex.
export function cumulative(coords: Coord[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  return cum;
}

// Nearest point on segment i of the line: [metres along, metres off].
function snapToSegment(coords: Coord[], cum: number[], i: number, p: Coord): [number, number] {
  const mLon = metersPerDegLon(p[0]);
  const ax = (coords[i][1] - p[1]) * mLon, ay = (coords[i][0] - p[0]) * METERS_PER_DEG_LAT;
  const bx = (coords[i + 1][1] - p[1]) * mLon, by = (coords[i + 1][0] - p[0]) * METERS_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
  const cx = ax + t * dx, cy = ay + t * dy;
  return [cum[i] + t * (cum[i + 1] - cum[i]), Math.sqrt(cx * cx + cy * cy)];
}

// "In 300 metres" / "In 1.5 kilometres".
export function spokenDistance(m: number): string {
  if (m >= 950) {
    const km = Math.round(m / 500) / 2;
    return `In ${km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)} kilometre${km === 1 ? '' : 's'}`;
  }
  const r = m >= 200 ? Math.round(m / 100) * 100 : Math.max(50, Math.round(m / 50) * 50);
  return `In ${r} metres`;
}

// For the banner: "300 m" / "1.4 km".
export function shortDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km`;
  return `${m >= 200 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10)} m`;
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

export type Maneuver = { at: number; instruction: string; final: boolean };

export type NavUpdate = {
  along: number; // metres along the route
  offBy: number; // metres from the route line
  next: Maneuver | null; // the next thing to do
  toNext: number; // metres to it
  remainingM: number;
  remainingS: number; // rough time left, from the route's own time
  offRoute: boolean; // time to ask for a new route
  arrived: boolean;
  say: string | null; // a prompt to speak now
};

/** Follows one route: feed it GPS fixes, it says where you are and what to say. */
export class Navigator {
  readonly cum: number[];
  readonly length: number;
  readonly maneuvers: Maneuver[];
  private along = 0;
  private offCount = 0;
  private spoken = new Set<string>();
  private done = false;

  constructor(readonly route: NavRoute, private destName = '') {
    this.cum = cumulative(route.coords);
    this.length = this.cum[this.cum.length - 1] || route.distance;
    // Each step starts with its manoeuvre, where the step's own line begins:
    // found on the route line (in order), else from the step distances.
    const total = route.steps.reduce((m, s) => m + s.distance, 0) || 1;
    const k = this.length / total;
    const out: Maneuver[] = [];
    let byDistance = 0;
    let last = 0;
    route.steps.forEach((s, i) => {
      let at = byDistance;
      if (s.coords.length) {
        const found = this.project(s.coords[0], last);
        if (found[1] <= 30) at = found[0];
      }
      at = Math.max(at, last);
      last = at;
      if (i > 0 && s.instruction.trim()) out.push({ at, instruction: s.instruction.trim(), final: i === route.steps.length - 1 });
      byDistance += s.distance * k;
    });
    // Apple usually ends with an "arrive" step; make sure there is one.
    if (!out.length || !out[out.length - 1].final) out.push({ at: this.length, instruction: 'You have arrived', final: true });
    this.maneuvers = out;
  }

  // Nearest point on the route at or after `from` metres: [along, off].
  private project(p: Coord, from: number): [number, number] {
    const c = this.route.coords;
    let best: [number, number] = [from, Infinity];
    for (let i = 0; i < c.length - 1; i++) {
      if (this.cum[i + 1] < from) continue;
      const s = snapToSegment(c, this.cum, i, p);
      if (s[1] < best[1] - 0.01) best = s;
    }
    return best;
  }

  // Where you are along the route, looking near where you were last.
  private locate(p: Coord): [number, number] {
    const c = this.route.coords;
    let best: [number, number] = [this.along, Infinity];
    const scan = (lo: number, hi: number) => {
      for (let i = 0; i < c.length - 1; i++) {
        if (this.cum[i + 1] < lo || this.cum[i] > hi) continue;
        const s = snapToSegment(c, this.cum, i, p);
        if (s[1] < best[1]) best = s;
      }
    };
    scan(this.along - SEARCH_BACK_M, this.along + SEARCH_AHEAD_M);
    if (best[1] > OFF_ROUTE_M) scan(-Infinity, Infinity); // jumped (tunnel, long GPS gap)
    return best;
  }

  // The prompt for the opening of the route.
  start(): string {
    const first = this.maneuvers[0];
    const to = this.destName ? ` to ${this.destName}` : '';
    if (!first || first.final) return `Starting route${to}.`;
    const d = first.at;
    return `Starting route${to}. ${d < 150 ? first.instruction : `${spokenDistance(d)}, ${lowerFirst(first.instruction)}`}.`;
  }

  update(p: Coord, speedMs: number | null, accuracyM: number | null = null): NavUpdate {
    const [along, offBy] = this.locate(p);
    const goodFix = accuracyM === null || accuracyM <= 40;
    if (offBy > OFF_ROUTE_M && goodFix) this.offCount++;
    else if (offBy <= OFF_ROUTE_M) this.offCount = 0;
    if (offBy <= OFF_ROUTE_M) this.along = Math.max(this.along - 30, along); // no sliding backwards on noise
    const here = this.along;
    const next = this.maneuvers.find((m) => m.at > here + 5) ?? this.maneuvers[this.maneuvers.length - 1];
    const toNext = Math.max(0, next.at - here);
    const remainingM = Math.max(0, this.length - here);
    const remainingS = this.route.duration * (remainingM / (this.length || 1));
    const offRoute = this.offCount >= OFF_ROUTE_FIXES;
    const arrived = !this.done && remainingM <= ARRIVE_M && offBy <= OFF_ROUTE_M;
    let say: string | null = null;
    if (arrived) {
      this.done = true;
      say = this.destName ? `You have arrived at ${this.destName}.` : 'You have arrived.';
    } else if (!offRoute && !this.done && next) {
      const v = Math.max(8, speedMs ?? 13);
      const farAt = Math.max(400, v * 35); // ~35 s ahead, never under 400 m
      const nearAt = Math.max(60, v * 7); // ~7 s ahead
      const key = `${next.at}`;
      if (!next.final && toNext <= nearAt && !this.spoken.has(`near${key}`)) {
        this.spoken.add(`near${key}`);
        this.spoken.add(`far${key}`);
        // What comes straight after, if it's close: "then keep left".
        const after = this.maneuvers.find((m) => m.at > next.at + 1);
        const then = after && !after.final && after.at - next.at < Math.max(150, v * 10) ? `, then ${lowerFirst(after.instruction)}` : '';
        say = `${next.instruction}${then}.`;
      } else if (toNext <= farAt && toNext > nearAt * 1.6 && !this.spoken.has(`far${key}`)) {
        this.spoken.add(`far${key}`);
        say = `${spokenDistance(toNext)}, ${lowerFirst(next.instruction)}.`;
      }
    }
    return { along: here, offBy, next, toNext, remainingM, remainingS, offRoute, arrived, say };
  }

  // A new route after going off route keeps the same destination; the
  // caller makes a new Navigator, and resets this.
  resetOffRoute() {
    this.offCount = 0;
  }
}

// --- how much of a route you've never driven ---

export type NewRoad = { newM: number; knownM: number };

// Driven metres along each chunk, from the driven ids (whole chunks,
// sections and start/stop stretches).
export function drivenRanges(net: RoadNetwork, driven: Iterable<string>): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  for (const id of driven) {
    const base = baseChunkId(id);
    const r = rangeOf(id) ?? [0, net.length(base)];
    const list = out.get(base);
    if (list) list.push(r);
    else out.set(base, [r]);
  }
  return out;
}

/**
 * Metres of a route on roads you've never driven, and metres the road data
 * could place at all (knownM; the rest isn't downloaded or isn't mapped).
 * The route is sampled every 10 m and each sample put on the nearest road
 * going the same way.
 */
export function newRoadOnRoute(net: RoadNetwork, ranges: Map<string, [number, number][]>, coords: Coord[]): NewRoad {
  const covered = new Map<string, [number, number][]>();
  const cum = cumulative(coords);
  const total = cum[cum.length - 1];
  let prev: Coord | null = null;
  let heading: number | null = null;
  let lastId: string | null = null;
  let lastPos = 0;
  const add = (id: string, a: number, b: number) => {
    const r: [number, number] = [Math.max(0, Math.min(a, b)), Math.max(a, b)];
    const st = covered.get(id);
    if (st) st.push(r);
    else covered.set(id, [r]);
  };
  for (let d = 0, i = 0; d <= total; d += 10) {
    while (i < coords.length - 2 && cum[i + 1] < d) i++;
    const segLen = cum[i + 1] - cum[i];
    const f = segLen > 0 ? (d - cum[i]) / segLen : 0;
    const p: Coord = [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f];
    if (prev) heading = headingBetween({ latitude: prev[0], longitude: prev[1] }, { latitude: p[0], longitude: p[1] });
    prev = p;
    const { list } = net.near({ latitude: p[0], longitude: p[1] }, heading, 40, new Set());
    if (!list.length) {
      lastId = null;
      continue;
    }
    // Nearest; within 3 m of that, stay on the road we were on (parallel roads).
    const best = list.reduce((x, y) => (y.dist < x.dist ? y : x));
    const prevId = lastId;
    const stay = prevId ? list.find((x) => x.id === prevId) : undefined;
    const c: Candidate = stay && stay.dist <= best.dist + 3 ? stay : best;
    // Crossing from one road piece to the next: both run to where they meet.
    if (lastId && lastId !== c.id) {
      const v = net.sharedVertex(lastId, c.id);
      if (v) {
        const pa = net.posOfVertex(lastId, v);
        const pb = net.posOfVertex(c.id, v);
        if (pa !== null) add(lastId, lastPos, pa);
        if (pb !== null) add(c.id, pb, c.pos);
      }
    }
    add(c.id, c.pos - 5, c.pos + 5);
    lastId = c.id;
    lastPos = c.pos;
  }
  let newM = 0;
  let knownM = 0;
  covered.forEach((st, id) => {
    const len = net.length(id);
    const route = mergeStretches(st).map(([a, b]) => [Math.max(0, a), Math.min(len, b)] as [number, number]);
    const drv = mergeStretches(ranges.get(id) ?? []);
    for (const [a, b] of route) {
      if (b <= a) continue;
      knownM += b - a;
      let overlap = 0;
      for (const [x, y] of drv) overlap += Math.max(0, Math.min(b, y) - Math.max(a, x));
      newM += Math.max(0, b - a - overlap);
    }
  });
  return { newM, knownM };
}
