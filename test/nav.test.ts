// Sat-nav logic (src/nav.ts): following a route, prompts, going off route,
// arriving, units.
import { Navigator, NavRoute, spokenDistance, shortDistance, routeAhead, cumulative } from '../src/nav';
import { speedNum, dist, setUnits, getUnits } from '../src/units';
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

// Imperial (v0.21): UK sat-nav style.
{
  const sd = spokenDistance;
  const bd = shortDistance;
  const said = [100, 270, 380, 600, 900, 1300, 2600, 25000].map((m) => sd(m, 'imperial')).join(' | ');
  check('imperial spoken: yards, then quarter/half/three quarters, then miles', said === 'In 100 yards | In 300 yards | In a quarter of a mile | In a quarter of a mile | In half a mile | In three quarters of a mile | In 1.5 miles | In 16 miles', said);
  const shown = [40, 300, 640, 25000].map((m) => bd(m, 'imperial')).join(' | ');
  check('imperial banner: yards, then miles', shown === '40 yd | 350 yd | 0.4 mi | 16 mi', shown);
  check('speed limits: mph roads round-trip exactly, km/h roads converted', [48, 97, 113, 100].map((k) => speedNum(k, 'imperial')).join() === '30,60,70,62' && speedNum(100, 'metric') === 100);
  check('distances in either unit', dist(16093.44, 1, 'imperial') === '10.0 mi' && dist(12345, 1, 'metric') === '12.3 km');
  setUnits('imperial');
  const navSaid = sd(800);
  setUnits('metric');
  check('the setting switches what the sat-nav says', navSaid === 'In half a mile' && getUnits() === 'metric');
}

// Route line ahead: cut exactly at your position, mid-segment (one long
// 1 km straight: nothing behind you stays drawn).
{
  const c: Coord[] = [ll(0, 0), ll(1000, 0), ll(1000, 500)];
  const cum = cumulative(c);
  const a = routeAhead(c, cum, 300);
  const behind = (a[0][1] - LON0) * mLon;
  check('route ahead: starts where you are on a long segment', a.length === 3 && Math.abs(behind - 300) < 1, `starts ${behind.toFixed(1)} m along`);
  check('route ahead: past a corner keeps only what is left', routeAhead(c, cum, 1200).length === 2 && routeAhead(c, cum, 0).length === 3);
  check('route ahead: at the end, nothing to draw', routeAhead(c, cum, 1600).length === 1);
}

console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
