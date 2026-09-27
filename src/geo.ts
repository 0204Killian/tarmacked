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

// --- Web Mercator, for the rendered map-image tiles ---

export function lonToWorldX(lon: number, z: number) {
  return ((lon + 180) / 360) * 256 * 2 ** z;
}

export function latToWorldY(lat: number, z: number) {
  const s = Math.sin(toRad(Math.max(-85, Math.min(85, lat))));
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
}

export function worldXToLon(x: number, z: number) {
  return (x / (256 * 2 ** z)) * 360 - 180;
}

export function worldYToLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / (256 * 2 ** z);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}
