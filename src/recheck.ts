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
import { DriveMatcher, Point } from './coverage';
import { Coord, haversine, distanceMeters } from './geo';

const NEAR_TRAIL_M = 20;
const TRAIL_CELL = 0.0005; // ~55m x 33m
const MAX_STEP_MS = 60_000; // longer gaps in a trail don't count towards distance

export type DriveInput = { id: number; startedAt: number; points: Point[] };
export type DriveStats = { id: number; endedAt: number | null; distanceM: number; newM: number };

export type RecheckResult = {
  driven: Set<string>;
  add: string[];
  remove: string[];
  stats: DriveStats[];
  unmatched: Point[];
};

export function driveDistanceMeters(points: Point[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp - points[i - 1].timestamp <= MAX_STEP_MS) d += distanceMeters(points[i - 1], points[i]);
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
  current.forEach((shape, id) => {
    const s = shape ?? net.shapeOf(id);
    if (!net.segs.has(baseChunkId(id)) || !s || !trail.touches(s)) driven.add(id);
  });

  const stats: DriveStats[] = [];
  const unmatched: Point[] = [];
  const totalPoints = drives.reduce((n, d) => n + d.points.length, 0) || 1;
  let donePoints = 0;
  const sorted = drives.slice().sort((a, b) => a.startedAt - b.startedAt);

  for (const d of sorted) {
    const m = new DriveMatcher(net, excluded);
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
    completed.forEach((id) => {
      const base = baseChunkId(id);
      const unmarkedAt = unmarked.get(id) ?? unmarked.get(base);
      if (unmarkedAt !== undefined && unmarkedAt >= d.startedAt) return; // you un-marked it after this drive
      if (driven.has(id) || (base !== id && driven.has(base))) return; // already counted (whole chunk)
      driven.add(id);
      newM += net.length(id);
    });
    const last = d.points[d.points.length - 1];
    stats.push({ id: d.id, endedAt: last ? last.timestamp : null, distanceM: driveDistanceMeters(d.points), newM });
  }

  // A road you already had as one whole piece that's now earned section by
  // section stays as the whole piece — no churn, nothing double-counted.
  current.forEach((_, id) => {
    if (driven.has(id) || baseChunkId(id) !== id) return;
    const secs = net.sections(id);
    if (secs.length > 1 && secs.every((x) => driven.has(x.id))) {
      secs.forEach((x) => driven.delete(x.id));
      driven.add(id);
    }
  });

  const add: string[] = [];
  const remove: string[] = [];
  driven.forEach((id) => {
    if (!current.has(id)) add.push(id);
  });
  current.forEach((_, id) => {
    if (!driven.has(id)) remove.push(id);
  });
  return { driven, add, remove, stats, unmatched };
}
