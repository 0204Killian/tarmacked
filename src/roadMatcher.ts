export type RoadSegment = {
  id: string;
  coords: [number, number][]; // [lat, lon] pairs, in order along the road
  // One-way: 1 = traffic flows in coords order, -1 = against coords order,
  // absent = two-way. Comes from OSM's oneway / motorway / roundabout tags.
  o?: 1 | -1;
};

export type LatLon = { latitude: number; longitude: number };

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

export type AlignedMatch = {
  id: string | null;
  // True when a road WAS within range but got rejected on direction — i.e.
  // the point is on a road, just not an eligible one (a bridge overhead,
  // the opposite carriageway). Such points shouldn't count as "unmatched".
  nearbyRejected: boolean;
};

/**
 * Like findNearestSegment, but when a direction of travel is known it only
 * accepts roads you could actually be driving along:
 *  - two-way roads: within maxAngleDeg of your heading, either direction
 *    (stops bridges crossing over/under you being marked)
 *  - one-way roads: within maxAngleDeg of their direction of flow only
 *    (stops the opposite motorway carriageway being marked)
 */
export function findNearestSegmentAligned(
  point: LatLon,
  segments: RoadSegment[],
  headingDeg: number | null,
  maxAngleDeg: number
): AlignedMatch {
  if (headingDeg === null) return { id: findNearestSegment(point, segments), nearbyRejected: false };
  let bestId: string | null = null;
  let bestDist = SNAP_THRESHOLD_METERS;
  let nearbyRejected = false;

  for (const seg of segments) {
    for (let i = 0; i < seg.coords.length - 1; i++) {
      const [lat1, lon1] = seg.coords[i];
      const [lat2, lon2] = seg.coords[i + 1];
      const a = toLocalMeters(lat1, lon1, point.latitude, point.longitude);
      const b = toLocalMeters(lat2, lon2, point.latitude, point.longitude);
      const dist = pointToSegmentDistance(0, 0, a.x, a.y, b.x, b.y);
      if (dist >= bestDist) continue;
      if (b.x === a.x && b.y === a.y) continue;
      const bearing = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
      let diff: number;
      if (seg.o) {
        // Directed: compare against the direction traffic actually flows.
        const flow = seg.o === 1 ? bearing : bearing + 180;
        diff = Math.abs(((headingDeg - flow) % 360 + 540) % 360 - 180);
      } else {
        // Undirected: either way along the road counts.
        diff = Math.abs(headingDeg - bearing) % 180;
        diff = Math.min(diff, 180 - diff);
      }
      if (diff > maxAngleDeg) {
        nearbyRejected = true;
        continue;
      }
      bestDist = dist;
      bestId = seg.id;
    }
  }

  return { id: bestId, nearbyRejected: bestId === null && nearbyRejected };
}

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
