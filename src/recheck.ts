// Re-checks every saved drive against the current matching rules and works
// out which roads should be marked as driven.
//
// Roads marked before GPS trails were saved (no trail to re-check them
// against) are kept. Any road a saved GPS trail came within 20m of is
// re-checked — that's what catches the old short stubs at junctions. The
// catch: a road you drove before trails were saved, and have since only
// crossed, gets re-checked too and may be removed. Everything removed is
// kept aside and can be put back from Dev.

import { RoadNetwork, baseChunkId } from './roadMatcher';
import { DriveMatcher, GpsFilter, PieceIndex, Point } from './coverage';
import { Coord, haversine, distanceMeters } from './geo';

const NEAR_TRAIL_M = 20;
const TRAIL_CELL = 0.0005; // ~55m x 33m
const MAX_STEP_MS = 60_000; // longer gaps in a trail don't count towards distance

export type DriveInput = { id: number; startedAt: number; points: Point[] };
export type DriveStats = { id: number; endedAt: number | null; distanceM: number; newM: number; ignoredN: number };

export type RecheckResult = {
  driven: Set<string>;
  add: string[];
  remove: string[];
  stats: DriveStats[];
  unmatched: Point[];
  // Partly-driven chunks: what's been covered so far, across all drives.
  partials: Map<string, [number, number][]>;
  // Chunks each drive covered (for the heatmap and showing a drive).
  driveRoads: Map<number, string[]>;
};

// Distance over the points that pass the wild-GPS filter.
export function driveDistanceMeters(points: Point[]): number {
  const f = new GpsFilter();
  let d = 0;
  let prev: Point | null = null;
  for (const p of points) {
    if (!f.accept(p)) continue;
    if (prev && p.timestamp - prev.timestamp <= MAX_STEP_MS) d += distanceMeters(prev, p);
    prev = p;
  }
  return d;
}

class TrailIndex {
  private cells = new Map<string, Point[]>();
  constructor(drives: DriveInput[]) {
    for (const d of drives) {
      for (const p of d.points) {
        const k = `${Math.floor(p.latitude / TRAIL_CELL)}_${Math.floor(p.longitude / TRAIL_CELL)}`;
        const list = this.cells.get(k);
        if (list) list.push(p);
        else this.cells.set(k, [p]);
      }
    }
  }
  near(c: Coord): boolean {
    const la = Math.floor(c[0] / TRAIL_CELL);
    const lo = Math.floor(c[1] / TRAIL_CELL);
    for (let a = la - 1; a <= la + 1; a++) {
      for (let b = lo - 2; b <= lo + 2; b++) {
        for (const p of this.cells.get(`${a}_${b}`) || []) {
          if (haversine(c, [p.latitude, p.longitude]) <= NEAR_TRAIL_M) return true;
        }
      }
    }
    return false;
  }
  // Does any part of this shape come within NEAR_TRAIL_M of the trail?
  // Sampled every ~10m.
  touches(shape: Coord[]): boolean {
    for (let i = 0; i < shape.length - 1; i++) {
      const [a, b] = [shape[i], shape[i + 1]];
      const n = Math.max(1, Math.round(haversine(a, b) / 10));
      for (let k = 0; k <= n; k++) {
        const f = k / n;
        if (this.near([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])) return true;
      }
    }
    return false;
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function recheckDrives(
  net: RoadNetwork,
  drives: DriveInput[],
  current: Map<string, Coord[] | null>, // driven id -> stored shape
  excluded: Set<string>,
  unmarked: Map<string, number>, // id -> when you un-marked it
  onProgress?: (fraction: number) => void,
  // GPS trails of drives that were deleted: they no longer earn roads, but
  // roads near them are re-checked (so a deleted drive's roads go away).
  forgottenTrails: Point[][] = []
): Promise<RecheckResult> {
  const trail = new TrailIndex([...drives, ...forgottenTrails.map((points, i) => ({ id: -1 - i, startedAt: 0, points }))]);

  // Roads we keep regardless: not from a saved drive, or not in the
  // downloaded road data (can't be re-checked, so never removed).
  const driven = new Set<string>();
  // A road piece whose id is gone from the road data (OSM changed since it
  // was driven) but that sits in a downloaded area next to a trail is
  // stale: the replay re-earns it under its new id, so the old one is
  // dropped (kept aside, can be put back) rather than counted twice.
  current.forEach((shape, id) => {
    const s = shape ?? net.shapeOf(id);
    if (!s || !trail.touches(s)) {
      driven.add(id);
      return;
    }
    if (net.segs.has(baseChunkId(id))) return; // re-checked by the replay
    const areaLoaded = s.some(([la, lo]) => net.candidates({ latitude: la, longitude: lo }).length > 0);
    if (!areaLoaded) driven.add(id); // no road data here: can't judge, keep
  });

  const stats: DriveStats[] = [];
  const unmatched: Point[] = [];
  const totalPoints = drives.reduce((n, d) => n + d.points.length, 0) || 1;
  let donePoints = 0;
  const sorted = drives.slice().sort((a, b) => a.startedAt - b.startedAt);
  // Shared by every drive, oldest first, so coverage adds up across drives.
  const partials = new Map<string, [number, number][]>();
  const driveRoads = new Map<number, string[]>();
  const index = new PieceIndex(driven);
  // Adds a road piece unless one already covers it; drops pieces it now
  // covers. Returns the metres it adds.
  const addPiece = (id: string): number => {
    if (index.coveredBy(id)) return 0;
    let m = net.length(id);
    for (const old of index.within(id)) {
      m -= net.length(old);
      index.delete(old);
      driven.delete(old);
    }
    index.add(id);
    driven.add(id);
    return Math.max(0, m);
  };

  for (const d of sorted) {
    const m = new DriveMatcher(net, excluded, partials);
    const completed = new Set<string>();
    for (let i = 0; i < d.points.length; i += 200) {
      const r = m.feed(d.points.slice(i, i + 200));
      r.completed.forEach((id) => completed.add(id));
      unmatched.push(...r.unmatched);
      donePoints += Math.min(200, d.points.length - i);
      onProgress?.(donePoints / totalPoints);
      await tick(); // keep the app responsive
    }
    m.finish().forEach((id) => completed.add(id));

    let newM = 0;
    [...completed, ...m.stubs].forEach((id) => {
      const base = baseChunkId(id);
      const unmarkedAt = unmarked.get(id) ?? unmarked.get(base);
      if (unmarkedAt !== undefined && unmarkedAt >= d.startedAt) return; // you un-marked it after this drive
      newM += addPiece(id);
    });
    driveRoads.set(d.id, m.roadsCovered());
    const last = d.points[d.points.length - 1];
    stats.push({ id: d.id, endedAt: last ? last.timestamp : null, distanceM: driveDistanceMeters(d.points), newM, ignoredN: m.gps.ignored });
  }

  // A road you already had as one whole piece that's now earned section by
  // section stays as the whole piece — no churn, nothing double-counted.
  current.forEach((_, id) => {
    if (driven.has(id) || baseChunkId(id) !== id) return;
    const secs = net.sections(id);
    if (secs.length > 1 && secs.every((x) => driven.has(x.id))) addPiece(id);
  });

  const add: string[] = [];
  const remove: string[] = [];
  driven.forEach((id) => {
    if (!current.has(id)) add.push(id);
  });
  current.forEach((_, id) => {
    if (!driven.has(id)) remove.push(id);
  });
  return { driven, add, remove, stats, unmatched, partials, driveRoads };
}
