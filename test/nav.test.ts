// Sat-nav logic (src/nav.ts): following a route, prompts, going off route,
// arriving, and never-driven road on a route.
import { Navigator, NavRoute, spokenDistance, shortDistance, newRoadOnRoute, drivenRanges } from '../src/nav';
import { RoadNetwork, RoadSegment } from '../src/roadMatcher';
import { metersPerDegLon, METERS_PER_DEG_LAT, Coord } from '../src/geo';

const LAT0 = 52.7, LON0 = -7.4;
const mLon = metersPerDegLon(LAT0);
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
const ll = (x: number, y: number): Coord => [r5(LAT0 + y / METERS_PER_DEG_LAT), r5(LON0 + x / mLon)];
let seed = 3;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const line = (pts: [number, number][], step = 20): Coord[] => {
  const out: Coord[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / step));
    for (let k = 0; k < n; k++) out.push(ll(x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n));
  }
  out.push(ll(...pts[pts.length - 1]));
  return out;
};

const results: boolean[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`);
};

// Route: north 2 km, right turn, east 1.5 km, then left, north 300 m to the destination.
const coords = line([[0, 0], [0, 2000], [1500, 2000], [1500, 2300]]);
const route: NavRoute = {
  name: 'R639',
  distance: 3800,
  duration: 3800 / 20,
  coords,
  steps: [
    { instruction: '', notice: '', distance: 0, coords: [ll(0, 0)] },
    { instruction: 'Proceed to R639', notice: '', distance: 2000, coords: line([[0, 0], [0, 2000]]) },
    { instruction: 'Turn right onto Main Street', notice: '', distance: 1500, coords: line([[0, 2000], [1500, 2000]]) },
    { instruction: 'Turn left onto Mill Road', notice: '', distance: 300, coords: line([[1500, 2000], [1500, 2300]]) },
    { instruction: 'Arrive at the destination', notice: '', distance: 0, coords: [ll(1500, 2300)] },
  ],
};

// Drives a path at speed v (m/s), a fix every 2 s with GPS noise; returns everything said.
function drive(nav: Navigator, path: [number, number][], v: number, sigma = 5) {
  const pts = line(path, v * 2);
  const said: string[] = [];
  let off = -1, arrivedAt = -1;
  pts.forEach((p, i) => {
    const q: Coord = [p[0] + (gauss() * sigma) / METERS_PER_DEG_LAT, p[1] + (gauss() * sigma) / mLon];
    const u = nav.update(q, v, 8);
    if (u.say) said.push(u.say);
    if (u.offRoute && off < 0) off = i;
    if (u.arrived && arrivedAt < 0) arrivedAt = i;
  });
  return { said, off, arrivedAt, n: pts.length };
}

{
  const nav = new Navigator(route, 'Home');
  check('start prompt names the destination and the first instruction', nav.start() === 'Starting route to Home. Proceed to R639.', nav.start());
  check('manoeuvres placed on the route', nav.maneuvers.map((m) => Math.round(m.at / 10) * 10).join() === '0,2000,3500,3800', nav.maneuvers.map((m) => `${m.instruction}@${Math.round(m.at)}`).join(' | '));
  const r = drive(nav, [[0, 0], [0, 2000], [1500, 2000], [1500, 2300]], 20);
  const right = r.said.filter((s) => /turn right onto Main Street/i.test(s));
  const left = r.said.filter((s) => /turn left onto Mill Road/i.test(s));
  check('each turn: one early prompt, then one at the turn', right.length === 2 && /^In \d+ metres, turn right/.test(right[0]) && /^Turn right onto Main Street/.test(right[1]) && left.length >= 1, r.said.join(' / '));
  check('arrival announced once, at the end', r.said.filter((s) => /arrived/.test(s)).length === 1 && r.arrivedAt >= r.n - 3, `arrived at fix ${r.arrivedAt} of ${r.n}`);
  check('GPS noise (5 m) never counts as off route', r.off < 0);
}

{
  // Missing the right turn: carry on north.
  seed = 9;
  const nav = new Navigator(route);
  const r = drive(nav, [[0, 0], [0, 2000], [0, 2600]], 20);
  const fixesPast = r.off - Math.round(2000 / 40);
  check('missed turn: off route within a few fixes of leaving the line', r.off > 0 && fixesPast <= 6, `off route at fix ${r.off} (${fixesPast} fixes after the junction)`);
}

{
  // Heavy noise (12 m) on the right road: still not off route.
  seed = 21;
  const nav = new Navigator(route);
  const r = drive(nav, [[0, 0], [0, 2000], [1500, 2000], [1500, 2300]], 20, 12);
  check('heavy GPS noise (12 m) on the route: not off route', r.off < 0);
}

{
  // Slow town driving: the early prompt is still at least ~400 m out.
  seed = 4;
  const nav = new Navigator(route);
  const r = drive(nav, [[0, 0], [0, 2000], [1500, 2000], [1500, 2300]], 8);
  const early = r.said.find((s) => /^In \d+ metres, turn right/.test(s));
  const m = early ? Number(/In (\d+)/.exec(early)![1]) : 0;
  check('slow driving: early prompt about 400 m before the turn', m >= 300 && m <= 500, early ?? 'none');
}

check('spoken distances', [spokenDistance(320), spokenDistance(75), spokenDistance(1480), spokenDistance(2000)].join(' | ') === 'In 300 metres | In 100 metres | In 1.5 kilometres | In 2 kilometres', [spokenDistance(320), spokenDistance(75), spokenDistance(1480), spokenDistance(2000)].join(' | '));
check('banner distances', [shortDistance(320), shortDistance(42), shortDistance(1480), shortDistance(25300)].join(' | ') === '300 m | 40 m | 1.5 km | 25 km', [shortDistance(320), shortDistance(42), shortDistance(1480), shortDistance(25300)].join(' | '));

// --- never-driven road on a route ---
{
  const segs: RoadSegment[] = [];
  const way = (id: number, pts: [number, number][]) => {
    const c = line(pts, 10);
    for (let i = 0, k = 0; i < c.length - 1; i += 10, k++) segs.push({ id: `way/${id}#${k}`, coords: c.slice(i, i + 11) });
  };
  way(1, [[0, 0], [0, 2000]]);
  way(2, [[0, 2000], [1500, 2000]]);
  way(3, [[1500, 2000], [1500, 2300]]);
  way(4, [[15, 0], [15, 2000]]); // a parallel road 15 m away (service road)
  const net = new RoadNetwork();
  net.add(segs);
  // Driven: the first km of way 1 (chunks 0-9), and half of chunk way/2#0 as a section stretch.
  const driven = [...Array.from({ length: 10 }, (_, i) => `way/1#${i}`), 'way/2#0~0-50'];
  const r = newRoadOnRoute(net, drivenRanges(net, driven), coords);
  check('new road on a route: only the parts never driven', Math.abs(r.newM - (1000 + 1450 + 300)) < 60 && Math.abs(r.knownM - 3800) < 60, `new ${r.newM.toFixed(0)} m of ${r.knownM.toFixed(0)} m`);
  const r2 = newRoadOnRoute(new RoadNetwork(), new Map(), coords);
  check('no road data: nothing known, nothing claimed', r2.knownM === 0 && r2.newM === 0);
}

console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
