export type RoadSegment = {
  id: string;
  coords: [number, number][]; // [lat, lon] pairs, in order along the road
};

export type RoadFile = {
  county: string;
  segments: RoadSegment[];
};

export type LatLon = { latitude: number; longitude: number };

// Rough local meters-per-degree conversion — accurate enough at county
// scale, not meant for anything near the poles (Ireland is nowhere close).
const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLon(atLat: number) {
  return 111_320 * Math.cos((atLat * Math.PI) / 180);
}

function toLocalMeters(lat: number, lon: number, originLat: number, originLon: number) {
  return {
    x: (lon - originLon) * metersPerDegLon(originLat),
    y: (lat - originLat) * METERS_PER_DEG_LAT,
  };
}

// Perpendicular distance (meters) from a point to a line segment.
function pointToSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  const distX = px - closestX;
  const distY = py - closestY;
  return Math.sqrt(distX * distX + distY * distY);
}

const SNAP_THRESHOLD_METERS = 25;

/**
 * Finds the closest road chunk to a point, if one is within
 * SNAP_THRESHOLD_METERS. Pass only the segments eligible to match (i.e.
 * already filtered to exclude anything marked private/gone). Returns the
 * chunk's id, or null if nothing is close enough.
 *
 * Each chunk is a short (~100m) piece of a road, not the whole road — so a
 * match only lights up the specific stretch a point was actually near.
 *
 * This is a plain linear scan over every chunk — fine for one county's
 * worth of roads, but will need a spatial index (a grid bucketed by
 * lat/lon) once this covers all of Ireland.
 */
export function findNearestSegment(point: LatLon, segments: RoadSegment[]): string | null {
  let bestId: string | null = null;
  let bestDist = SNAP_THRESHOLD_METERS;

  for (const seg of segments) {
    for (let i = 0; i < seg.coords.length - 1; i++) {
      const [lat1, lon1] = seg.coords[i];
      const [lat2, lon2] = seg.coords[i + 1];
      const a = toLocalMeters(lat1, lon1, point.latitude, point.longitude);
      const b = toLocalMeters(lat2, lon2, point.latitude, point.longitude);
      const dist = pointToSegmentDistance(0, 0, a.x, a.y, b.x, b.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = seg.id;
      }
    }
  }

  return bestId;
}

// Haversine distance in meters between two [lat, lon] points.
function haversine(a: [number, number], b: [number, number]): number {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function segmentLengthMeters(seg: RoadSegment): number {
  let total = 0;
  for (let i = 0; i < seg.coords.length - 1; i++) {
    total += haversine(seg.coords[i], seg.coords[i + 1]);
  }
  return total;
}

export function totalLengthMeters(segments: RoadSegment[]): number {
  return segments.reduce((sum, seg) => sum + segmentLengthMeters(seg), 0);
}
