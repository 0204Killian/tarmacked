// Sat-nav logic (v0.16): following a route, when to speak, going off
// route and arriving. Pure logic
// (no React or native calls) so it can be tested on its own. Since v0.18
// the routes come from our own router (src/router.ts).

import { Coord, haversine, metersPerDegLon, METERS_PER_DEG_LAT } from './geo';

export type RouteStep = { instruction: string; notice: string; distance: number; coords: Coord[]; kind?: string };
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

// The part of a route still ahead of `along` metres, starting exactly there
// (cut mid-segment, so nothing you've driven past stays drawn).
export function routeAhead(coords: Coord[], cum: number[], along: number): Coord[] {
  if (coords.length < 2 || along <= 0) return coords;
  const total = cum[cum.length - 1];
  if (along >= total) return [coords[coords.length - 1]];
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] <= along) i++;
  const len = cum[i + 1] - cum[i];
  const f = len > 0 ? (along - cum[i]) / len : 0;
  const p: Coord = [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f];
  return [p, ...coords.slice(i + 1)];
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

// "In 300 metres" / "In 1.5 kilometres" (or yards and miles): src/units.ts.
export { spokenDistance, shortDistance } from './units';
import { spokenDistance } from './units';

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

export type Maneuver = { at: number; instruction: string; final: boolean; kind?: string };

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
      if (i > 0 && s.instruction.trim()) out.push({ at, instruction: s.instruction.trim(), final: i === route.steps.length - 1, kind: s.kind });
      byDistance += s.distance * k;
    });
    // Apple usually ends with an "arrive" step; make sure there is one.
    if (!out.length || !out[out.length - 1].final) out.push({ at: this.length, instruction: 'You have arrived', final: true, kind: 'arrive' });
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
