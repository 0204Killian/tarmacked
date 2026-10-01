// Simulated drives over a synthetic street grid, to check the coverage rule.
import { RoadNetwork, RoadSegment } from '../src/roadMatcher';
import { DriveMatcher, Point, isPatchy, PieceIndex } from '../src/coverage';
import { rankRoads, heatStep, heatColorAt } from '../src/heat';
import { runLoopTests } from './loop';
import { runSlipTests } from './slip';
import { recheckDrives } from '../src/recheck';
import { metersPerDegLon, METERS_PER_DEG_LAT, Coord } from '../src/geo';

const LAT0 = 53.33, LON0 = -6.265;
const mLon = metersPerDegLon(LAT0);
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
// x = metres east, y = metres north
const ll = (x: number, y: number): Coord => [r5(LAT0 + y / METERS_PER_DEG_LAT), r5(LON0 + x / mLon)];

// Build a way from a polyline of (x,y) points every ~10m, chunked at 100m like tile-county.js
function way(id: number, pts: [number, number][], chunkM = 100): RoadSegment[] {
  const dense: Coord[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const d = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(1, Math.round(d / 10));
    for (let k = 0; k < n; k++) dense.push(ll(x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n));
  }
  dense.push(ll(...pts[pts.length - 1]));
  const chunks: Coord[][] = [];
  let cur: Coord[] = [dense[0]], len = 0;
  for (let i = 1; i < dense.length; i++) {
    const a = dense[i - 1], b = dense[i];
    len += Math.hypot((b[0] - a[0]) * METERS_PER_DEG_LAT, (b[1] - a[1]) * mLon);
    cur.push(b);
    if (len >= chunkM) { chunks.push(cur); cur = [b]; len = 0; }
  }
  if (cur.length > 1) chunks.push(cur);
  return chunks.map((c, i) => ({ id: `way/${id}#${i}`, coords: c }));
}

// Network: main road (way 1) x=0, y 0..600 north.
// Parallel street (way 2) x=120, y 0..600.
// Side streets E-W at y=100,220,340,460 from x=0 to x=120 (ways 10..13).
// Cul-de-sac (way 50): west from main road at y=280, 90m long, dead end.
// Long cul-de-sac (way 51): west at y=520, 180m long (2 chunks), dead end.
const segs: RoadSegment[] = [
  ...way(1, [[0, 0], [0, 600]]),
  ...way(2, [[120, 0], [120, 600]]),
  ...way(10, [[0, 100], [120, 100]]),
  ...way(11, [[0, 220], [120, 220]]),
  ...way(12, [[0, 340], [120, 340]]),
  ...way(13, [[0, 460], [120, 460]]),
  ...way(50, [[0, 280], [-90, 280]]),
  ...way(51, [[0, 520], [-180, 520]]),
  // Narrow lane 20m east of the main road, joining side streets 10 and 11.
  ...way(60, [[20, 100], [20, 220]]),
];
// Main road must share the exact nodes at junctions: the densified vertices
// at multiples of 10m line up, so y=100/220/280/340/460/520 exist on way 1.
const net = new RoadNetwork();
net.add(segs);

// Seeded noise
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// Drive along a path of (x,y) waypoints at speed m/s, a GPS point every 2s, noise sigma metres.
function drive(path: [number, number][], speed = 11, sigma = 4, t0 = 1_000_000): Point[] {
  const out: Point[] = [];
  let t = t0, carry = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const [x1, y1] = path[i], [x2, y2] = path[i + 1];
    const d = Math.hypot(x2 - x1, y2 - y1);
    let s = carry;
    while (s <= d) {
      const f = s / d;
      const [la, lo] = ll(x1 + (x2 - x1) * f + gauss() * sigma, y1 + (y2 - y1) * f + gauss() * sigma);
      out.push({ latitude: la, longitude: lo, timestamp: t });
      t += 2000;
      s += speed * 2;
    }
    carry = s - d;
  }
  return out;
}

function run(name: string, pts: Point[], expectIn: string[], expectOut: string[], batch = 1) {
  const m = new DriveMatcher(net, new Set());
  const got = new Set<string>();
  for (let i = 0; i < pts.length; i += batch) m.feed(pts.slice(i, i + batch)).completed.forEach((id) => got.add(id));
  m.finish().forEach((id) => got.add(id));
  const missing = expectIn.filter((id) => !got.has(id));
  const wrong = expectOut.filter((id) => got.has(id));
  const ok = missing.length === 0 && wrong.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      got: ${[...got].sort().join(' ')}` +
    (missing.length ? `\n      missing: ${missing.join(' ')}` : '') + (wrong.length ? `\n      wrongly marked: ${wrong.join(' ')}` : ''));
  return ok;
}

const rawChunks = (w: number) => segs.filter((s) => s.id.startsWith(`way/${w}#`)).map((s) => s.id);
const chunks = (w: number) =>
  segs.filter((s) => s.id.startsWith(`way/${w}#`)).flatMap((s) => net.sections(s.id).map((x) => x.id));
const sideStreets = [10, 11, 12, 13, 50, 51].flatMap(chunks);
let all = true;

// 1. Straight down the main road, whole length, with noise. All 6 main chunks, no side streets.
all = run('main road end to end', drive([[0, -5], [0, 605]]), chunks(1), [...sideStreets, ...chunks(2)]) && all;

// 2. Same, with GPS drift spikes: 3 points thrown ~25m east (onto/near side streets).
{
  const pts = drive([[0, -5], [0, 605]]);
  for (const i of [5, 12, 20]) pts[i] = { ...pts[i], longitude: pts[i].longitude + 25 / mLon };
  all = run('main road with drift spikes', pts, chunks(1), [...sideStreets, ...chunks(2)]) && all;
}

// 3. Heavier noise (urban canyon, sigma 9m), batches of 1 like the live 2s poll.
{
  seed = 7;
  all = run('main road, heavy noise', drive([[0, -5], [0, 605]], 11, 9), chunks(1), [...chunks(10), ...chunks(11), ...chunks(12), ...chunks(13), ...chunks(50), ...chunks(51)]) && all;
}

// 4. Only half of the main road's first chunk: start at y=0, stop (park) at y=150.
all = run('stop halfway along a chunk', drive([[0, -5], [0, 150]]), ['way/1#0'], ['way/1#1']) && all;

// 5. Cul-de-sac: turn in at y=280, drive to 25m from the end, turn around, come back.
all = run('cul-de-sac, turn 25m short of end', drive([[0, 240], [0, 280], [-65, 280], [0, 280], [0, 330]], 6), chunks(50), []) && all;

// 6. Long cul-de-sac (2 chunks), turn 30m short of the end.
all = run('long cul-de-sac, turn 30m short', drive([[0, 490], [0, 520], [-150, 520], [0, 520], [0, 560]], 6), chunks(51), []) && all;

// 7. Side street half driven then turned back (not a dead end) — must NOT count.
// (the first 20m, up to where the lane joins, WAS driven and now counts)
all = run('side street half driven, turned back', drive([[0, 190], [0, 220], [60, 220], [0, 220], [0, 250]], 6), ['way/11#0~0-20'], chunks(11).filter((id) => id !== 'way/11#0~0-20')) && all;

// 8. Proper turn: main road north, right onto side street at y=340, all the way to the parallel street, then north on it.
all = run('turn onto side street and through', drive([[0, 300], [0, 340], [120, 340], [120, 420]], 9), chunks(12), [...chunks(10), ...chunks(11), ...chunks(13)]) && all;

// 8b. Junction partway along a chunk: north on the main road from y=150, turn
// right at y=220 (side street 11 joins chunk 1#2 partway along) — the stretch
// of 1#2 up to the junction counts, the rest of 1#2 doesn't.
{
  const secs = net.sections('way/1#2').map((x) => x.id);
  console.log(`      sections of way/1#2: ${secs.join(' ')}`);
  all = run('turn off partway along a chunk (junction split)', drive([[0, 150], [0, 220], [120, 220], [120, 280]], 9), [secs[0], ...chunks(11)], secs.slice(1)) && all;
}

// 8c. Home in the middle of a road piece: drive 1 arrives from the south and
// parks at y=250 (inside chunk 1#2's middle section 220-280); drive 2 leaves
// from there going north. Neither covers the section alone; together they do.
{
  const mid = net.sections('way/1#2')[1].id;
  const shared = new Map<string, [number, number][]>();
  const got = new Set<string>();
  for (const pts of [drive([[0, 150], [0, 250]], 9), drive([[0, 250], [0, 330]], 9, 4, 9_000_000)]) {
    const m = new DriveMatcher(net, new Set(), shared);
    for (const p of pts) m.feed([p]).completed.forEach((id) => got.add(id));
    m.finish().forEach((id) => got.add(id));
    if (got.size && pts === undefined) break;
  }
  const alone = new Set<string>();
  const m1 = new DriveMatcher(net, new Set());
  for (const p of drive([[0, 150], [0, 250]], 9)) m1.feed([p]).completed.forEach((id) => alone.add(id));
  m1.finish().forEach((id) => alone.add(id));
  const ok = got.has(mid) && !alone.has(mid);
  if (!ok) console.log("      mid", mid, "got", [...got].join(" "), "alone", [...alone].join(" "), "shared", JSON.stringify([...shared]));
  console.log(`${ok ? 'PASS' : 'FAIL'}  coverage adds up across drives (to and from home)`);
  all = ok && all;
}

// 9. Batch of 5 points per poll behaves the same as 1.
{
  seed = 42;
  const pts = drive([[0, -5], [0, 605]]);
  all = run('batching (5/poll) same result', pts, chunks(1), sideStreets, 5) && all;
}

// 10. Monte Carlo: 60 noisy drives down the main road next to the 20m-away lane.
{
  let falsePos = 0, falseNeg = 0;
  const others = [...sideStreets, ...chunks(2), ...chunks(60)];
  for (let k = 0; k < 60; k++) {
    seed = 1000 + k;
    const sigma = k < 30 ? 6 : 10;
    const m = new DriveMatcher(net, new Set());
    const got = new Set<string>();
    const pts = drive([[0, -5], [0, 605]], 8 + (k % 5) * 3, sigma);
    for (const p of pts) m.feed([p]).completed.forEach((id) => got.add(id));
    m.finish().forEach((id) => got.add(id));
    const fp = others.filter((id) => got.has(id)); falsePos += fp.length; if (fp.length) console.log(`      seed ${k} sigma ${sigma}: wrong ${fp.join(" ")}; missed ${chunks(1).filter((id) => !got.has(id)).join(" ")}`);
    falseNeg += chunks(1).filter((id) => !got.has(id)).length;
  }
  console.log(`MC    60 noisy drives: ${falsePos} wrong chunks marked, ${falseNeg} of ${60 * 6} main-road chunks missed`);
}

// 11. Re-check: old data has stubs (10#0, 60#0) plus a road with no trail nearby (2#3).
(async () => {
  seed = 42;
  const pts = drive([[0, -5], [0, 605]]);
  const current = new Map<string, Coord[] | null>();
  for (const id of [...rawChunks(1), 'way/10#0', 'way/60#0', 'way/2#3', 'way/999#0']) current.set(id, net.segs.get(id)?.coords ?? [[53.4, -6.3], [53.401, -6.3]]);
  const unmarked = new Map([['way/1#3', pts[0].timestamp + 1]]); // un-marked by hand after this drive
  const r = await recheckDrives(net, [{ id: 1, startedAt: pts[0].timestamp, points: pts }], current, new Set(), unmarked);
  const ok = r.remove.sort().join() === ['way/1#3', 'way/10#0', 'way/60#0'].join() && r.add.length === 0 && r.driven.has('way/2#3') && r.driven.has('way/999#0');
  console.log(`${ok ? 'PASS' : 'FAIL'}  re-check removes stubs, keeps pre-trail roads, respects un-marks`);
  console.log(`      remove: ${r.remove.join(' ')}  add: ${r.add.join(' ')}  stats: ${JSON.stringify(r.stats)}`);
  // 11b. A wrong piece far from any trail (e.g. the far side of a roundabout):
  // kept when it's older than the saved trails, removed when it was marked since.
  {
    const cur = new Map<string, Coord[] | null>();
    for (const id of rawChunks(1)) cur.set(id, net.segs.get(id)!.coords);
    cur.set('way/51#1', net.segs.get('way/51#1')!.coords); // 100m+ from the main-road trail
    const since = pts[0].timestamp;
    const firstAt = new Map([...cur.keys()].map((id) => [id, since + 5000] as [string, number]));
    const rNew = await recheckDrives(net, [{ id: 1, startedAt: since, points: pts }], cur, new Set(), new Map(), undefined, [], { firstAt, trailsSince: since });
    const firstOld = new Map(firstAt);
    firstOld.set('way/51#1', since - 1000);
    const rOld = await recheckDrives(net, [{ id: 1, startedAt: since, points: pts }], cur, new Set(), new Map(), undefined, [], { firstAt: firstOld, trailsSince: since });
    const okFar = rNew.remove.includes('way/51#1') && !rOld.remove.includes('way/51#1');
    console.log(`${okFar ? 'PASS' : 'FAIL'}  re-check: a piece far from any trail is removed if marked since trails began (kept if older)`);
    all = okFar && all;
    // v0.15.2: a wrong stub RIGHT BESIDE the trail (like a slip-road taper),
    // marked since trails began, is removed — even if it was once put back by hand.
    const cur2 = new Map(cur);
    cur2.set('way/10#0', net.segs.get('way/10#0')!.coords);
    const firstAt2 = new Map(firstAt);
    firstAt2.set('way/10#0', since + 5000);
    const rNear = await recheckDrives(net, [{ id: 1, startedAt: since, points: pts }], cur2, new Set(), new Map(), undefined, [], { firstAt: firstAt2, trailsSince: since });
    const okNear = rNear.remove.includes('way/10#0');
    console.log(`${okNear ? 'PASS' : 'FAIL'}  re-check: a stub beside the trail is removed (put-back roads no longer kept)`);
    all = okNear && all;
  }
  // 12. Deleting a drive removes the roads only it earned.
  seed = 5;
  const keepDrive = drive([[0, -5], [0, 605]]); // main road
  const goneDrive = drive([[0, 300], [0, 340], [120, 340], [120, 420]], 9, 4, 5_000_000); // side street 12
  const cur = new Map<string, Coord[] | null>();
  for (const id of [...chunks(1), ...chunks(12)]) cur.set(id, net.shapeOf(id)!);
  const r2 = await recheckDrives(net, [{ id: 1, startedAt: keepDrive[0].timestamp, points: keepDrive }], cur, new Set(), new Map(), undefined, [goneDrive]);
  const ok2 = chunks(12).every((id) => r2.remove.includes(id)) && chunks(1).every((id) => r2.driven.has(id));
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  deleting a drive removes the roads only it earned\n      remove: ${r2.remove.join(' ')}`);

  // ---------- v0.14 ----------
  const v14: boolean[] = [];
  const check = (name: string, ok: boolean, info = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`);
    v14.push(ok);
  };
  const oneDrive = (pts: Point[], shared = new Map<string, [number, number][]>()) => {
    const m = new DriveMatcher(net, new Set(), shared);
    const got = new Set<string>();
    for (const p of pts) m.feed([p]).completed.forEach((id) => got.add(id));
    m.finish().forEach((id) => got.add(id));
    return { m, got, stubs: [...m.stubs] };
  };

  // Start/stop credit. way/1#1 = y 100..200 (one section, no junction partway).
  seed = 11;
  let r1 = oneDrive(drive([[0, 125], [0, 330]], 9, 1));
  check('start 25m into a section: whole section credited', r1.got.has('way/1#1'), `got ${[...r1.got].join(' ')} stubs ${r1.stubs.join(' ')}`);
  seed = 11;
  r1 = oneDrive(drive([[0, 160], [0, 330]], 9, 1));
  check(
    'start 60m into a section: only the driven stretch',
    !r1.got.has('way/1#1') && r1.stubs.length === 1 && /^way\/1#1~(5[5-9]|6[0-5])-100$/.test(r1.stubs[0]),
    `stubs ${r1.stubs.join(' ')}`
  );
  // Stop inside section way/1#2~20-80 (y 220..280).
  seed = 12;
  r1 = oneDrive(drive([[0, 142], [0, 250]], 9, 1)); // samples every 18m: last one at y=250
  const mid = net.sections('way/1#2')[1].id;
  check('stop 30m short of section end: whole section credited', r1.got.has(mid), `got ${[...r1.got].join(' ')} stubs ${r1.stubs.join(' ')}`);
  seed = 12;
  r1 = oneDrive(drive([[0, 147], [0, 237]], 9, 1)); // last sample y=237
  check(
    'stop 43m short of section end: only the driven stretch',
    !r1.got.has(mid) && r1.stubs.some((x) => /^way\/1#2~20-3[3-9]$/.test(x)),
    `stubs ${r1.stubs.join(' ')}`
  );
  seed = 12;
  r1 = oneDrive(drive([[0, 150], [0, 222]], 9, 1)); // last sample y=222, 2m past the junction
  check('stop just past a junction: nothing extra (too short)', !r1.stubs.some((x) => x.startsWith('way/1#2')), `stubs ${r1.stubs.join(' ')}`);

  // Re-check: a stretch from drive 1 is replaced once drive 2 drives the whole section.
  seed = 13;
  const dA = drive([[0, 147], [0, 237]], 9, 1, 1_000_000);
  const dB = drive([[0, 150], [0, 330]], 9, 1, 8_000_000);
  const rA = await recheckDrives(net, [{ id: 1, startedAt: dA[0].timestamp, points: dA }], new Map(), new Set(), new Map());
  const pieceA = [...rA.driven].find((id) => id.startsWith('way/1#2~20-3'));
  const rAB = await recheckDrives(
    net,
    [{ id: 1, startedAt: dA[0].timestamp, points: dA }, { id: 2, startedAt: dB[0].timestamp, points: dB }],
    new Map(),
    new Set(),
    new Map()
  );
  check(
    're-check: start/stop stretch replaced by the full section later',
    !!pieceA && rAB.driven.has(mid) && ![...rAB.driven].some((id) => id.startsWith('way/1#2~20-3')),
    `after A: ${pieceA}; after A+B: ${[...rAB.driven].filter((id) => id.startsWith('way/1#2')).join(' ')}; newM ${rAB.stats.map((x) => x.newM.toFixed(0)).join('/')}`
  );
  const drivenM = [...rAB.driven].reduce((m, id) => m + net.length(id), 0);
  const newTotal = rAB.stats.reduce((m, x) => m + x.newM, 0);
  check('re-check: new km per drive adds up to km driven (nothing double counted)', Math.abs(drivenM - newTotal) < 1, `${drivenM.toFixed(1)} vs ${newTotal.toFixed(1)}`);

  // Wild GPS: bad-accuracy points and a 2km jump are ignored.
  seed = 42;
  const clean = drive([[0, -5], [0, 605]]);
  const wild = clean.map((p, i) =>
    i === 8 || i === 14 ? { ...p, longitude: p.longitude + 60 / mLon, accuracy: 80 } :
    i === 20 ? { ...p, latitude: p.latitude + 2000 / METERS_PER_DEG_LAT, accuracy: 10 } : { ...p, accuracy: 8 }
  );
  const rc = oneDrive(clean), rw = oneDrive(wild);
  check(
    'wild GPS points ignored, same roads',
    rw.m.gps.ignored === 3 && [...rc.got].sort().join() === [...rw.got].sort().join(),
    `ignored ${rw.m.gps.ignored}; clean ${rc.got.size} wild ${rw.got.size}`
  );
  const lost = clean.map((p, i) => (i % 3 === 0 ? { ...p, accuracy: 65 } : p));
  const rl = oneDrive(lost);
  check('patchy GPS tagged (>20% ignored), not tagged when clean', isPatchy(rl.m.gps.ignored, lost.length) && !isPatchy(rw.m.gps.ignored, wild.length), `${rl.m.gps.ignored}/${lost.length}`);
  // A wild FIRST point must not make every later point look like a jump.
  const badStart = [{ ...clean[0], latitude: clean[0].latitude + 0.05 }, ...clean.slice(1)];
  const rs = oneDrive(badStart);
  check('wild first point recovers', rs.got.size >= rc.got.size - 1 && rs.m.gps.ignored <= 6, `ignored ${rs.m.gps.ignored}, got ${rs.got.size}/${rc.got.size}`);
  const pair = clean.map((p, i) => (i === 10 || i === 11 ? { ...p, longitude: p.longitude + 400 / mLon, accuracy: 10 } : p));
  const rp = oneDrive(pair);
  check('two wild points in a row: no wrong roads', [...rp.got].every((id) => id.startsWith('way/1#')), `got ${[...rp.got].join(' ')} ignored ${rp.m.gps.ignored}`);
  const legacy = oneDrive(clean.map(({ accuracy, ...p }) => p));
  check('old points without accuracy still work', legacy.got.size === rc.got.size && legacy.m.gps.ignored === 0);

  // Heatmap: roads each drive covered, counts, and the most-driven list.
  const covered = rc.m.roadsCovered();
  check(
    'drive covers main road chunks only',
    rawChunks(1).every((id) => covered.includes(id)) && !covered.some((id) => !id.startsWith('way/1#')),
    covered.join(' ')
  );
  const rH = await recheckDrives(
    net,
    [
      { id: 1, startedAt: 1, points: drive([[0, -5], [0, 605]], 11, 4, 1_000_000) },
      { id: 2, startedAt: 2, points: drive([[0, -5], [0, 305]], 11, 4, 5_000_000) },
      { id: 3, startedAt: 3, points: drive([[0, 300], [0, 340], [120, 340], [120, 420]], 9, 4, 9_000_000) },
    ],
    new Map(),
    new Set(),
    new Map()
  );
  const counts = new Map<string, number>();
  rH.driveRoads.forEach((passes) => passes.forEach((n, id) => counts.set(id, (counts.get(id) ?? 0) + n)));
  for (const seg of segs) if (seg.id.startsWith('way/1#')) seg.n = 'N77 Main Road';
  for (const seg of segs) if (seg.id.startsWith('way/12#')) seg.n = 'Side Street';
  const ranks = rankRoads(net, counts);
  check(
    'most-driven list: road name, count and hottest bit',
    ranks[0].name === 'N77 Main Road' && ranks[0].count === 2 && ranks[0].hotChunks.includes('way/1#0') && !ranks[0].hotChunks.includes('way/1#5'),
    ranks.slice(0, 3).map((r) => `${r.name} ${r.count}x [${r.hotChunks.join(',')}] ${r.hotM.toFixed(0)}m`).join(' | ')
  );
  check('heat colours: 1 green, max red', heatColorAt(0) === '#39d353' && heatColorAt(1) === '#e5332a' && heatStep(1, 50) === 0 && heatStep(50, 50) === 11);

  // Piece bookkeeping.
  const idx = new PieceIndex(['way/9#0~20-80', 'way/9#0~0-15']);
  check(
    'piece index: containment',
    idx.coveredBy('way/9#0~30-60') === 'way/9#0~20-80' && idx.coveredBy('way/9#0~10-30') === null && idx.within('way/9#0').length === 2
  );

  // Re-tile: an old id OSM no longer has, next to a trail, is dropped; one
  // far from any road data is kept.
  {
    seed = 42;
    const pts = drive([[0, -5], [0, 605]]);
    const cur = new Map<string, Coord[] | null>();
    for (const id of rawChunks(1)) cur.set(id, net.segs.get(id)!.coords);
    cur.set('way/777#0', net.segs.get('way/1#2')!.coords); // same road, old id
    cur.set('way/888#0', [[53.5, -6.5], [53.501, -6.5]]); // somewhere not downloaded
    const r = await recheckDrives(net, [{ id: 1, startedAt: 0, points: pts }], cur, new Set(), new Map());
    check('re-tile: stale old id dropped, undownloaded area kept', r.remove.includes('way/777#0') && r.driven.has('way/888#0') && !r.remove.some((id) => id.startsWith('way/1#')), `remove ${r.remove.join(' ')}`);
  }
  // ---------- v0.15.2: heatmap counts every pass within a drive ----------
  {
    const passesOf = (pts: Point[]) => {
      const m = new DriveMatcher(net, new Set());
      const got = new Set<string>();
      for (let i = 0; i < pts.length; i += 50) m.feed(pts.slice(i, i + 50)).completed.forEach((id) => got.add(id));
      m.finish().forEach((id) => got.add(id));
      return { passes: m.roadPasses(), got };
    };
    const show = (p: Map<string, number>) => [...p].sort().map(([id, n]) => `${id}:${n}`).join(' ');
    // Up the main road and back down it.
    seed = 11;
    const upDown = passesOf(drive([[0, -5], [0, 605], [0, -5]]));
    const mainIds = rawChunks(1);
    check('heat: up a road and back down it in one drive = 2', mainIds.every((id) => upDown.passes.get(id) === 2), show(upDown.passes));
    seed = 11;
    const upOnly = passesOf(drive([[0, -5], [0, 605]]));
    check('heat: one way along it = 1', mainIds.every((id) => upOnly.passes.get(id) === 1), show(upOnly.passes));
    check('heat: turning back doesn\'t change which roads count as driven', [...upDown.got].sort().join() === [...upOnly.got].sort().join(), `${[...upDown.got].sort().join(' ')} vs ${[...upOnly.got].sort().join(' ')}`);
    // Stopped at lights for a minute: GPS wobbles back and forth, still one pass.
    seed = 12;
    const a = drive([[0, -5], [0, 300]]);
    const tStop = a[a.length - 1].timestamp;
    const wobble: Point[] = [];
    for (let k = 1; k <= 30; k++) {
      const [la, lo] = ll(gauss() * 6, 300 + gauss() * 8);
      wobble.push({ latitude: la, longitude: lo, timestamp: tStop + k * 2000 });
    }
    const b = drive([[0, 300], [0, 605]], 11, 4, tStop + 62_000);
    const lights = passesOf([...a, ...wobble, ...b]);
    check('heat: GPS wobble while stopped at lights is still one pass', mainIds.every((id) => lights.passes.get(id) === 1), show(lights.passes));
    // Round the block twice: main road y 220..340 driven twice, the rest once.
    seed = 13;
    const block: [number, number][] = [[0, -5], [0, 340], [120, 340], [120, 220], [0, 220], [0, 340], [120, 340], [120, 220], [0, 220], [0, 100]];
    const twice = passesOf(drive(block, 9));
    const p = twice.passes;
    check(
      'heat: round the block twice counts the block twice',
      (p.get('way/12#0') ?? 0) === 2 && (p.get('way/11#0') ?? 0) === 2 && (p.get('way/1#0') ?? 0) === 1,
      show(p)
    );
  }

  // ---------- v0.15.2: matching only the new drive ----------
  // Adding drives one at a time on top of the map (as App's matchQueued
  // does: own DriveMatcher, shared partly-driven stretches, PieceIndex
  // merge like markDriven) gives the same map as replaying them all.
  {
    const ds = [
      { id: 1, path: [[0, -5], [0, 330]] as [number, number][], t0: 1_000_000 },
      { id: 2, path: [[0, 300], [0, 605]] as [number, number][], t0: 9_000_000 }, // finishes the main road
      { id: 3, path: [[0, 95], [0, 100], [120, 100], [120, 300]] as [number, number][], t0: 19_000_000 },
    ].map((d, i) => {
      seed = 100 + i;
      return { id: d.id, startedAt: d.t0, points: drive(d.path, 11, 4, d.t0) };
    });
    const full = await recheckDrives(net, ds, new Map(), new Set(), new Map());
    const partials = new Map<string, [number, number][]>();
    const driven = new Set<string>();
    for (const d of ds) {
      const m = new DriveMatcher(net, new Set(), partials);
      const ids: string[] = [];
      for (let i = 0; i < d.points.length; i += 200) ids.push(...m.feed(d.points.slice(i, i + 200)).completed);
      ids.push(...m.finish(), ...m.stubs);
      const index = new PieceIndex(driven);
      for (const id of ids) {
        if (index.coveredBy(id)) continue;
        for (const old of index.within(id)) {
          index.delete(old);
          driven.delete(old);
        }
        index.add(id);
        driven.add(id);
      }
    }
    const a = [...full.driven].sort().join(' ');
    const b = [...driven].sort().join(' ');
    check('matching just the new drive = replaying every drive', a === b && driven.size > 5, a === b ? `${driven.size} pieces` : `full: ${a}\n      incremental: ${b}`);
  }

  // ---------- v0.14.1: route-aware matching ----------
  const loopsOk = runLoopTests();
  const slipsOk = runSlipTests();
  v14.push(loopsOk, slipsOk);

  const allV14 = v14.every(Boolean);
  console.log(all && ok && ok2 && allV14 ? '\nALL PASS' : '\nSOME FAILED');
})();
if (0) console.log(all ? '\nALL PASS' : '\nSOME FAILED');
