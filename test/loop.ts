// Roundabouts drawn as a closed loop: a quarter turn must credit only that
// quarter, whether or not it crosses the loop's start point, and whether
// the ring is one piece or two.
import { RoadNetwork, RoadSegment } from '../src/roadMatcher';
import { DriveMatcher, Point } from '../src/coverage';
import { metersPerDegLon, METERS_PER_DEG_LAT, Coord } from '../src/geo';

const LAT0 = 52.8, LON0 = -7.3, mLon = metersPerDegLon(LAT0);
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
const ll = (x: number, y: number): Coord => [r5(LAT0 + y / METERS_PER_DEG_LAT), r5(LON0 + x / mLon)];
const R = 20;

// Ring of radius R, clockwise (as in Ireland), starting at startDeg; split
// into two pieces after `splitAt` points (or one closed piece).
function ring(startDeg: number, splitAt: number | null): RoadSegment[] {
  const pts: Coord[] = [];
  for (let k = 0; k <= 36; k++) {
    const a = ((startDeg - k * 10) * Math.PI) / 180;
    pts.push(ll(R * Math.cos(a), R * Math.sin(a)));
  }
  pts[36] = pts[0];
  if (splitAt === null) return [{ id: 'way/9#0', coords: pts, o: 1 }];
  return [
    { id: 'way/9#0', coords: pts.slice(0, splitAt + 1), o: 1 },
    { id: 'way/9#1', coords: pts.slice(splitAt), o: 1 },
  ];
}
function arms(): RoadSegment[] {
  const w: Coord[] = [];
  for (let x = -200; x <= -R; x += 10) w.push(ll(x, 0));
  const s: Coord[] = [];
  for (let y = -R; y >= -200; y -= 10) s.push(ll(0, y));
  const e: Coord[] = [];
  for (let x = R; x <= 200; x += 10) e.push(ll(x, 0));
  return [{ id: 'way/1#0', coords: w }, { id: 'way/2#0', coords: s }, { id: 'way/3#0', coords: e }];
}
// From the south arm, right turn: clockwise 270° round (S → W → N → E), a
// GPS point every `stepDeg` degrees on the ring, out the east arm.
function driveRight(stepDeg: number): Point[] {
  const out: Point[] = [];
  let t = 0;
  const push = (c: Coord, dt: number) => out.push({ latitude: c[0], longitude: c[1], timestamp: (t += dt) });
  for (let y = -190; y <= -R - 5; y += 12) push(ll(0, y), 1500);
  for (let d = -90; d >= -360; d -= stepDeg) {
    const a = (d * Math.PI) / 180;
    push(ll(R * Math.cos(a), R * Math.sin(a)), 1500);
  }
  for (let x = R + 10; x <= 190; x += 12) push(ll(x, 0), 1500);
  return out;
}
// From the south arm heading north, left turn: clockwise from 270° (south)
// to 180° (west), a quarter of the ring.
function drive(): Point[] {
  const out: Point[] = [];
  let t = 0;
  const push = (c: Coord, dt: number) => out.push({ latitude: c[0], longitude: c[1], timestamp: (t += dt) });
  for (let y = -190; y <= -R - 5; y += 12) push(ll(0, y), 1500);
  for (let d = -90; d >= -180; d -= 15) {
    const a = (d * Math.PI) / 180;
    push(ll(R * Math.cos(a), R * Math.sin(a)), 1000);
  }
  for (let x = -R - 10; x >= -190; x -= 12) push(ll(x, 0), 1500);
  return out;
}

export function runLoopTests(): boolean {
  const quarter = (Math.PI * R) / 2;
  let all = true;
  const cases: [string, number, number | null][] = [
    ['roundabout, one piece, start point not crossed', 90, null],
    ['roundabout, one piece, start point crossed', 230, null],
    ['roundabout, two pieces, start point crossed', 230, 30],
  ];
  for (const [label, start, split] of cases) {
    const net = new RoadNetwork();
    net.add([...ring(start, split), ...arms()]);
    const m = new DriveMatcher(net, new Set());
    const got = new Set<string>();
    for (const p of drive()) m.feed([p]).completed.forEach((id) => got.add(id));
    m.finish().forEach((id) => got.add(id));
    const ringM = [...got].filter((id) => id.startsWith('way/9')).reduce((s, id) => s + net.length(id), 0);
    const ok = Math.abs(ringM - quarter) < 8 && got.has('way/1#0') && got.has('way/2#0');
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ring credited ${ringM.toFixed(0)} m of ${(2 * Math.PI * R).toFixed(0)} m (a quarter is ${quarter.toFixed(0)} m)`);
    all = ok && all;
  }
  // Three-quarter turns (S → W → N → E) on a ring in two pieces, where the
  // short piece (west side) gets few or no GPS points.
  const cases2: [string, number, number, number][] = [
    ['roundabout, two pieces, 3/4 turn, points every 30°', 200, 30, 30],
    ['roundabout, two pieces, 3/4 turn, points every 50°', 200, 30, 50],
    ['roundabout, two pieces, 3/4 turn, points every 70°', 200, 30, 70],
    ['roundabout, one piece, 3/4 turn, points every 50°', 200, 99, 50],
  ];
  for (const [label, start, split, step] of cases2) {
    const net = new RoadNetwork();
    net.add([...ring(start, split >= 36 ? null : split), ...arms()]);
    const m = new DriveMatcher(net, new Set());
    const got = new Set<string>();
    for (const p of driveRight(step)) m.feed([p]).completed.forEach((id) => got.add(id));
    m.finish().forEach((id) => got.add(id));
    const ringIds = [...got].filter((id) => id.startsWith('way/9'));
    const ringM = ringIds.reduce((s, id) => s + net.length(id), 0);
    const want = (Math.PI * R * 3) / 2;
    // The quarter NOT driven (east → south, 0° to -90°) must stay uncredited.
    const notDriven = ringIds.filter((id) => {
      const shape = net.shapeOf(id) ?? [];
      const mid = shape[Math.floor(shape.length / 2)];
      if (!mid) return false;
      const ang = (Math.atan2((mid[0] - LAT0) * METERS_PER_DEG_LAT, (mid[1] - LON0) * mLon) * 180) / Math.PI;
      return ang < -5 && ang > -85;
    });
    const ok = notDriven.length === 0 && Math.abs(ringM - want) < 12 && got.has('way/2#0') && got.has('way/3#0');
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ring credited ${ringM.toFixed(0)} m (three-quarters is ${want.toFixed(0)} m)${notDriven.length ? `, wrongly incl. ${notDriven.join(' ')}` : ''} -> ${ringIds.sort().join(' ')}`);
    all = ok && all;
  }
  return all;
}
