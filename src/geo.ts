// Small geometry helpers shared by matching, stats and rendering.

export type LatLon = { latitude: number; longitude: number };
export type Coord = [number, number]; // [lat, lon]

export const METERS_PER_DEG_LAT = 111_320;

export function metersPerDegLon(atLat: number) {
  return METERS_PER_DEG_LAT * Math.cos((atLat * Math.PI) / 180);
}

const toRad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: Coord, b: Coord): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function distanceMeters(a: LatLon, b: LatLon): number {
  return haversine([a.latitude, a.longitude], [b.latitude, b.longitude]);
}

export function lineLengthMeters(coords: Coord[]): number {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) total += haversine(coords[i], coords[i + 1]);
  return total;
}

// Compass-style bearing (0 = north, 90 = east) from a to b.
export function headingBetween(a: LatLon, b: LatLon) {
  const dx = (b.longitude - a.longitude) * metersPerDegLon(a.latitude);
  const dy = (b.latitude - a.latitude) * METERS_PER_DEG_LAT;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

// --- Road data tiles (must match scripts/tile-county.js exactly) ---

export const TILE_DEGREES = 0.05;

export function tileIdForPoint(lat: number, lon: number): string {
  return `t_${Math.floor(lat / TILE_DEGREES)}_${Math.floor(lon / TILE_DEGREES)}`;
}

// The point's own tile plus its 8 neighbours — a road chunk is filed under
// the tile its first point is in, but can run ~100m into the next one.
export function neighbourTileIds(lat: number, lon: number): string[] {
  const la = Math.floor(lat / TILE_DEGREES);
  const lo = Math.floor(lon / TILE_DEGREES);
  const ids: string[] = [];
  for (let d1 = -1; d1 <= 1; d1++) for (let d2 = -1; d2 <= 1; d2++) ids.push(`t_${la + d1}_${lo + d2}`);
  return ids;
}

// Drops points that don't change a line's shape by more than `tolerance`
// (in degrees) — Ramer–Douglas–Peucker. Used to draw less detail when
// zoomed out.
export function simplifyLine(coords: Coord[], tolerance: number): Coord[] {
  if (coords.length <= 2) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ay, ax] = coords[a];
    const [by, bx] = coords[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1, worstD = tol2;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = coords[i];
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return coords.filter((_, i) => keep[i] === 1);
}
