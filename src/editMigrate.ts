// Moving your map edits onto a new version of the road data (v0.17).
//
// Road pieces keep their IDs between versions as long as the road itself
// didn't change in OpenStreetMap. When it did (re-drawn, split, joined),
// an edit made on the old piece — "this isn't a road", "I didn't drive
// this" — is moved to whichever new pieces lie along the same stretch.

import type { RoadSegment } from './roadMatcher';
import { Coord, METERS_PER_DEG_LAT, metersPerDegLon } from './geo';

export type OldEdit = { id: string; shape: Coord[] };

export type EditNetwork = {
  shapeOf(id: string): Coord[] | null;
  inBox(minLat: number, minLon: number, maxLat: number, maxLon: number): RoadSegment[];
};

const SAME_M = 8; // old and new shape this close everywhere = same piece
const ON_M = 12; // a new piece point this close to the old shape is "on it"
const SHARE = 0.6; // share of a new piece that must lie on the old shape

// Distance (m) from a point to a polyline, on a flat local projection.
function distToLine(p: Coord, line: Coord[]): number {
  const kx = metersPerDegLon(p[0]);
  const ky = METERS_PER_DEG_LAT;
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    const ax = (line[i][1] - p[1]) * kx;
    const ay = (line[i][0] - p[0]) * ky;
    if (i === line.length - 1) {
      best = Math.min(best, Math.hypot(ax, ay));
      break;
    }
    const bx = (line[i + 1][1] - p[1]) * kx;
    const by = (line[i + 1][0] - p[0]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// Points along a line every ~step metres (always including both ends).
function samples(line: Coord[], step = 10): Coord[] {
  const out: Coord[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const d = Math.hypot((b[0] - a[0]) * METERS_PER_DEG_LAT, (b[1] - a[1]) * metersPerDegLon(a[0]));
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

function sameShape(a: Coord[], b: Coord[]) {
  return samples(a).every((p) => distToLine(p, b) <= SAME_M) && samples(b).every((p) => distToLine(p, a) <= SAME_M);
}

/**
 * Where each old edit goes in the new road data:
 *  - [id] itself when the piece is unchanged (the usual case);
 *  - the new pieces that lie along the old one, when it changed;
 *  - [] when the road is gone (the edit has nothing left to apply to).
 * Needs the new road data loaded around each edit.
 */
export function migrateEdits(edits: OldEdit[], net: EditNetwork): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edits) {
    if (!e.shape || e.shape.length < 2) {
      out.set(e.id, [e.id]); // no shape to go on: keep it as it was
      continue;
    }
    const now = net.shapeOf(e.id);
    if (now && sameShape(now, e.shape)) {
      out.set(e.id, [e.id]);
      continue;
    }
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (const [la, lo] of e.shape) {
      minLat = Math.min(minLat, la);
      maxLat = Math.max(maxLat, la);
      minLon = Math.min(minLon, lo);
      maxLon = Math.max(maxLon, lo);
    }
    const pad = 0.0003; // ~30 m
    const found: string[] = [];
    for (const s of net.inBox(minLat - pad, minLon - pad, maxLat + pad, maxLon + pad)) {
      const pts = samples(s.coords);
      const on = pts.filter((p) => distToLine(p, e.shape) <= ON_M).length;
      if (on / pts.length >= SHARE) found.push(s.id);
    }
    out.set(e.id, found.sort());
  }
  return out;
}
