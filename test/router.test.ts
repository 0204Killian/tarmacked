// The sat-nav router (src/router.ts) on real Irish roads (test/fixture.ts).
//   npx tsx test/router.test.ts
import * as fs from 'fs';
import * as path from 'path';
import { buildFixture } from './fixture';
import { RoadGraph, GraphFile, sameRoute, PlannedRoute } from '../src/router';
import { Navigator } from '../src/nav';
import { decodeTile } from '../src/tiles';
import { haversine, tileIdForPoint, Coord } from '../src/geo';
import type { RoadSegment } from '../src/roadMatcher';

const results: boolean[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`);
};
const ms = (t0: number) => `${Date.now() - t0} ms`;
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const mins = (s: number) => `${Math.round(s / 60)} min`;

const dir = buildFixture();
const graphFile: GraphFile = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
let t0 = Date.now();
const full = new RoadGraph();
full.addGraph(graphFile);
console.log(`      graph: ${full.nodeCount} junctions, ${full.edgeCount} links, loaded in ${ms(t0)} (whole country, every road: a worst case)`);

const KILKENNY = { lat: 52.6541, lon: -7.2448 };
const DUBLIN = { lat: 53.3498, lon: -6.2603 };
const CORK = { lat: 51.8985, lon: -8.4756 };
const LETTERKENNY = { lat: 54.9558, lon: -7.7342 };

// 1. Kilkenny -> Dublin.
t0 = Date.now();
const kd = full.route(KILKENNY, DUBLIN, 'fastest');
const kdMs = Date.now() - t0;
const straight = haversine([KILKENNY.lat, KILKENNY.lon], [DUBLIN.lat, DUBLIN.lon]);
check(
  'Kilkenny → Dublin: a route, a sensible length',
  !!kd && kd.distance > straight * 1.05 && kd.distance < straight * 1.5,
  kd ? `${km(kd.distance)} (straight line ${km(straight)}), ${mins(kd.duration)} at typical speeds, ${kd.steps.length - 2} manoeuvres, worked out in ${kdMs} ms` : 'none',
);
const lineOk = (r: PlannedRoute) => {
  let worst = 0;
  for (let i = 1; i < r.coords.length; i++) worst = Math.max(worst, haversine(r.coords[i - 1], r.coords[i]));
  return worst < 2000 && r.speeds.length === r.coords.length - 1;
};
check('the route line is joined up (no jumps) and has a speed per piece', !!kd && lineOk(kd));
if (kd) {
  console.log('      first steps: ' + kd.steps.slice(0, 7).map((s) => `${s.instruction} (${km(s.distance)})`).join(' · '));
}

// 2. Across the country.
t0 = Date.now();
const cl = full.route(CORK, LETTERKENNY, 'fastest');
const clMs = Date.now() - t0;
check('Cork → Letterkenny (across the country)', !!cl && cl.distance > 300_000 && cl.distance < 600_000 && clMs < 8000, cl ? `${km(cl.distance)}, ${mins(cl.duration)}, worked out in ${clMs} ms` : 'none');

// 3. One-way streets.
const anyEdges = graphFile.edges.filter((e) => (e[3] & 1) && e[6] > 150 && !(e[3] & 4));
let onewayOk = 0, onewayTried = 0;
const nodesLL: Coord[] = [];
{
  let la = 0, lo = 0;
  for (let i = 0; i < graphFile.nodes.length; i += 2) {
    la = i === 0 ? graphFile.nodes[0] : la + graphFile.nodes[i];
    lo = i === 0 ? graphFile.nodes[1] : lo + graphFile.nodes[i + 1];
    nodesLL.push([la / 1e5, lo / 1e5]);
  }
}
const lerp = (a: Coord, b: Coord, f: number) => ({ lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f });
for (const e of anyEdges.filter((x) => x.length === 10).slice(0, 2000).filter((_, i) => i % 200 === 0)) { // straight ones only, so the in-between point is on the road
  const A = nodesLL[e[0]], B = nodesLL[e[1]];
  const p30 = lerp(A, B, 0.3), p70 = lerp(A, B, 0.7);
  const fwd = full.route(p30, p70, 'fastest');
  const back = full.route(p70, p30, 'fastest');
  onewayTried++;
  const direct = haversine([p30.lat, p30.lon], [p70.lat, p70.lon]);
  if (fwd && Math.abs(fwd.distance - direct) < 5 && (!back || back.distance > direct + 50)) onewayOk++;
}
check('one-way streets: along them directly, never back against them', onewayTried > 3 && onewayOk === onewayTried, `${onewayOk}/${onewayTried}`);

// 4. Main roads + detail near the ends join up.
const near = (c: Coord, p: { lat: number; lon: number }, m: number) => haversine(c, [p.lat, p.lon]) < m;
const START = { lat: 52.6302, lon: -7.2765 }; // outside Kilkenny city
const END = { lat: 53.2706, lon: -6.2005 }; // south Dublin
const thinned: GraphFile = { ...graphFile, region: 'thin', edges: graphFile.edges.filter((e) => !near(nodesLL[e[0]], START, 6000) && !near(nodesLL[e[1]], START, 6000) && !near(nodesLL[e[0]], END, 6000) && !near(nodesLL[e[1]], END, 6000)) };
const segs: RoadSegment[] = [];
const wantTiles = new Set<string>();
for (const p of [START, END]) for (let dy = -0.07; dy <= 0.07; dy += 0.025) for (let dx = -0.1; dx <= 0.1; dx += 0.025) wantTiles.add(tileIdForPoint(p.lat + dy, p.lon + dx));
for (const t of wantTiles) {
  const f = path.join(dir, `${t}.json`);
  if (fs.existsSync(f)) segs.push(...decodeTile(JSON.parse(fs.readFileSync(f, 'utf8'))));
}
const hybrid = new RoadGraph();
hybrid.addGraph(thinned);
// The thinned graph doesn't have these ways' pieces near the ends, so the
// detail must not be skipped as "already in the graph": use a fresh graph
// that only knows the thinned ways.
const removedWays = new Set(graphFile.edges.filter((e) => !thinned.edges.includes(e)).map((e) => e[2]));
t0 = Date.now();
(hybrid as any).mainWays = new Set([...(hybrid as any).mainWays].filter((w: number) => !removedWays.has(w)));
hybrid.addDetail(segs);
const hy = hybrid.route(START, END, 'fastest');
const ref = full.route(START, END, 'fastest');
check(
  'main roads + detail tiles near the ends join up like the full map',
  !!hy && !!ref && Math.abs(hy.duration - ref.duration) / ref.duration < 0.03,
  hy && ref ? `${km(hy.distance)} / ${mins(hy.duration)} vs ${km(ref.distance)} / ${mins(ref.duration)} on the full map (${segs.length} detail pieces from ${wantTiles.size} tiles, ${ms(t0)})` : `${!!hy} ${!!ref}`,
);

// 5. Turn restrictions: forbid the first real turn of Kilkenny -> Dublin.
if (kd) {
  const turn = kd.steps.find((s) => s.kind === 'left' || s.kind === 'right');
  if (turn) {
    const g2 = new RoadGraph();
    g2.addGraph(graphFile);
    // The ways either side of the turn: nearest edges just before and after.
    const at = turn.coords[0];
    const idx = kd.coords.findIndex((c) => c[0] === at[0] && c[1] === at[1]);
    const before = kd.coords[Math.max(0, idx - 1)], after = kd.coords[Math.min(kd.coords.length - 1, idx + 1)];
    const mid = (a: Coord, b: Coord) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const sb = (g2 as any).snap(...mid(before, at));
    const sa = (g2 as any).snap(...mid(at, after));
    const wb = (g2 as any).eWay[sb.edge], wa = (g2 as any).eWay[sa.edge];
    g2.addRestrictions({ kinds: ['no_left_turn', 'no_right_turn'], r: [[wb, at[0], at[1], wa, turn.kind === 'left' ? 0 : 1]] });
    const kd2 = g2.route(KILKENNY, DUBLIN, 'fastest');
    // The banned move: arriving at the junction from `before`, leaving towards `after`.
    const same = (a: Coord, b: Coord) => a[0] === b[0] && a[1] === b[1];
    const stillTurns = !!kd2 && kd2.coords.some((c, i) => i > 0 && i < kd2.coords.length - 1 && same(c, at) && same(kd2.coords[i - 1], before) && same(kd2.coords[i + 1], after));
    check('a "no turn" restriction is obeyed', !!kd2 && !stillTurns && !sameRoute(kd, kd2), `banned "${turn.instruction}"; new route ${kd2 ? km(kd2.distance) : 'none'} vs ${km(kd.distance)}`);
  } else check('a "no turn" restriction is obeyed', false, 'no turn found to ban');
}

// 6. New roads: pretend you've driven the fastest route.
if (kd) {
  const g3 = new RoadGraph();
  g3.addGraph(graphFile);
  const drivenWays = new Set<number>();
  for (let i = 0; i < kd.coords.length; i += 3) {
    const sn = (g3 as any).snap(kd.coords[i][0], kd.coords[i][1]);
    if (sn) drivenWays.add((g3 as any).eWay[sn.edge]);
  }
  const isDriven = (way: number) => drivenWays.has(way);
  const fast = g3.route(KILKENNY, DUBLIN, 'fastest', isDriven)!;
  const fresh = g3.route(KILKENNY, DUBLIN, 'new', isDriven)!;
  check(
    'New roads route: more never-driven road than the fastest, at a cost in time',
    !!fresh && fresh.newM > fast.newM + 20_000 && fresh.duration >= fast.duration && !sameRoute(fast, fresh),
    `fastest ${km(fast.newM)} new of ${km(fast.distance)}, ${mins(fast.duration)} · new roads ${km(fresh.newM)} new of ${km(fresh.distance)}, ${mins(fresh.duration)}`,
  );
}

// 7. Following a route: prompts, no false "off route", arriving.
if (kd) {
  const nav = new Navigator(kd, 'Dublin');
  const said: string[] = [nav.start()];
  let off = 0, arrived = false;
  const cum = [0];
  for (let i = 1; i < kd.coords.length; i++) cum.push(cum[i - 1] + haversine(kd.coords[i - 1], kd.coords[i]));
  let j = 0;
  for (let d = 0; d <= cum[cum.length - 1] + 20; d += 25) {
    while (j < kd.coords.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j];
    const f = seg > 0 ? Math.min(1, (d - cum[j]) / seg) : 0;
    const p: Coord = [kd.coords[j][0] + (kd.coords[j + 1][0] - kd.coords[j][0]) * f, kd.coords[j][1] + (kd.coords[j + 1][1] - kd.coords[j][1]) * f];
    const u = nav.update(p, 20, 5);
    if (u.offRoute) off++;
    if (u.say) said.push(u.say);
    if (u.arrived) arrived = true;
  }
  check('driving the route: prompts spoken, never "off route", arrives', off === 0 && arrived && said.length > 5, `${said.length} prompts, e.g. ${said.slice(0, 4).map((x) => `"${x}"`).join(' ')}`);
}

// 8. Roundabouts get "take the Nth exit" (the old tiles have no roundabout
// flags, so a made-up one: four arms, traffic clockwise as in Ireland).
{
  const C: Coord = [53.0, -7.0];
  const at = (bearing: number, m: number): Coord => {
    const b = (bearing * Math.PI) / 180;
    const la = C[0] + (m * Math.cos(b)) / 111320;
    const lo = C[1] + (m * Math.sin(b)) / (111320 * Math.cos((C[0] * Math.PI) / 180));
    return [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5];
  };
  const ring: Coord[] = [];
  for (let b = 180; b <= 540; b += 15) ring.push(at(b % 360, 20));
  const segsR: RoadSegment[] = [{ id: 'way/1#0', coords: ring, o: 1, r: 1, h: 8 }];
  const arms: Record<string, number> = { S: 180, W: 270, N: 0, E: 90 };
  Object.entries(arms).forEach(([name, b], i) => segsR.push({ id: `way/${10 + i}#0`, coords: [at(b, 400), at(b, 200), at(b, 20)], h: 8, n: `Road ${name}` }));
  const gr = new RoadGraph();
  gr.addDetail(segsR);
  const from = at(180, 380);
  const exitOf = (b: number) => gr.route({ lat: from[0], lon: from[1] }, { lat: at(b, 380)[0], lon: at(b, 380)[1] }, 'fastest')?.steps.find((s) => s.kind === 'roundabout')?.instruction ?? 'none';
  const got = [exitOf(270), exitOf(0), exitOf(90)];
  check('roundabouts: "take the Nth exit", counted clockwise', got[0].includes('1st exit onto Road W') && got[1].includes('2nd exit onto Road N') && got[2].includes('3rd exit onto Road E'), got.join(' · '));
}

// 10. The graph's road pieces (c0..c1) are the tiles' piece ids, so driven
// roads line up with the map.
{
  const pieces = new Map<string, Coord[]>();
  for (const sg of segs) pieces.set(sg.id, sg.coords);
  const has = (id: string, c: Coord) => (pieces.get(id) ?? []).some((x) => Math.abs(x[0] - c[0]) < 1e-6 && Math.abs(x[1] - c[1]) < 1e-6);
  let tried = 0, ok = 0;
  for (const e of graphFile.edges) {
    const [a, b, way, , , , , c0, c1] = e;
    if (!pieces.has(`way/${way}#${c0}`) || !pieces.has(`way/${way}#${c1}`)) continue;
    tried++;
    if (has(`way/${way}#${c0}`, nodesLL[a]) && has(`way/${way}#${c1}`, nodesLL[b])) ok++;
    if (tried >= 2000) break;
  }
  check("graph links name the same road pieces as the tiles", tried > 500 && ok === tried, `${ok}/${tried}`);
}

// 9. Nothing near: no route rather than a wrong one.
check('a point far from any road gives no route', full.route({ lat: 53.5, lon: -10.5 }, DUBLIN, 'fastest') === null);

console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
