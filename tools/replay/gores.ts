// Slip-road check on REAL road data: finds every place a one-way road
// splits (diverge) or joins (merge) at a shallow angle — motorway and
// dual-carriageway slip roads — and drives simulated GPS through each
// one every possible way (stay on the main road / take the slip). Counts
// road credited that the simulated car never drove.
//
//   npx tsx tools/replay/gores.ts <tiles dir> [seeds] [--list] [--json out.json]
import * as fs from 'fs';
import { RoadNetwork, RoadSegment, baseChunkId, vertexKey } from '../../src/roadMatcher';
import { DriveMatcher, Point, rangeOf } from '../../src/coverage';
import { Coord, haversine, metersPerDegLon, METERS_PER_DEG_LAT } from '../../src/geo';
declare const process: any;

const dir = process.argv[2];
const SEEDS = Number(process.argv[3] || 6);
const LIST = process.argv.includes('--list');
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

const segs: RoadSegment[] = [];
for (const f of fs.readdirSync(dir)) if (f.startsWith('t_')) segs.push(...JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')).segments);
const net = new RoadNetwork();
net.add(segs);
const byId = new Map(segs.map((s) => [s.id, s]));
const at = new Map<string, { id: string; i: number }[]>();
for (const s of byId.values())
  s.coords.forEach((c, i) => {
    const k = vertexKey(c);
    const l = at.get(k);
    if (l) l.push({ id: s.id, i });
    else at.set(k, [{ id: s.id, i }]);
  });

const bearing = (a: Coord, b: Coord) => {
  const dx = (b[1] - a[1]) * metersPerDegLon(a[0]);
  const dy = (b[0] - a[0]) * METERS_PER_DEG_LAT;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
};
const turn = (a: number, b: number) => {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// A way of leaving vertex (id,i): step +1 or -1 along the chunk.
type Step = { id: string; i: number; d: 1 | -1 };
// Allowed travel steps from a vertex. backward=true: moves you could have
// ARRIVED by (walking the network in reverse).
function stepsFrom(c: Coord, backward: boolean): Step[] {
  const out: Step[] = [];
  for (const { id, i } of at.get(vertexKey(c)) || []) {
    const s = byId.get(id)!;
    for (const d of [1, -1] as const) {
      const j = i + d;
      if (j < 0 || j >= s.coords.length) continue;
      const travel = backward ? -d : d; // direction of real travel along coords
      if (s.o === 1 && travel !== 1) continue;
      if (s.o === -1 && travel !== -1) continue;
      out.push({ id, i, d });
    }
  }
  return out;
}

// Walks from a step for up to maxM, straightest at every junction.
// Returns the coords visited (in walking order) and per-chunk ranges.
function walk(first: Step, maxM: number, backward: boolean): { coords: Coord[]; ranges: Map<string, [number, number]> } {
  const coords: Coord[] = [];
  const ranges = new Map<string, [number, number]>();
  let cur = first;
  let m = 0;
  let guard = 0;
  const cum = (id: string, i: number) => {
    const s = byId.get(id)!;
    let d = 0;
    for (let k = 1; k <= i; k++) d += haversine(s.coords[k - 1], s.coords[k]);
    return d;
  };
  const note = (id: string, i: number) => {
    const p = cum(id, i);
    const r = ranges.get(id);
    if (r) {
      r[0] = Math.min(r[0], p);
      r[1] = Math.max(r[1], p);
    } else ranges.set(id, [p, p]);
  };
  let s = byId.get(cur.id)!;
  coords.push(s.coords[cur.i]);
  note(cur.id, cur.i);
  while (m < maxM && guard++ < 2000) {
    s = byId.get(cur.id)!;
    const a = s.coords[cur.i];
    const b = s.coords[cur.i + cur.d];
    m += haversine(a, b);
    coords.push(b);
    note(cur.id, cur.i);
    note(cur.id, cur.i + cur.d);
    const h = bearing(a, b);
    // Next step: straightest allowed move from b that isn't straight back.
    let best: Step | null = null;
    let bestTurn = 75; // sharper than this = we've hit a junction we don't follow
    for (const st of stepsFrom(b, backward)) {
      const ss = byId.get(st.id)!;
      if (st.id === cur.id && st.i + st.d === cur.i) continue; // back where we came from
      const t = turn(h, bearing(ss.coords[st.i], ss.coords[st.i + st.d]));
      if (t < bestTurn) {
        bestTurn = t;
        best = st;
      }
    }
    if (!best) break;
    cur = best;
  }
  return { coords, ranges };
}

// ---- find gores ----
type Gore = { kind: 'diverge' | 'merge'; at: Coord; main: Step; slip: Step; before: Step };
const gores: Gore[] = [];
const seen = new Set<string>();
at.forEach((list, k) => {
  if (list.length < 2) return;
  const c = byId.get(list[0].id)!.coords[list[0].i];
  if (list.some(({ id }) => !byId.get(id)!.o)) return; // only one-way junctions (motorway / dual carriageway)
  for (const kind of ['diverge', 'merge'] as const) {
    // diverge: one way in, two ways out. merge: two in, one out.
    const outs = stepsFrom(c, kind === 'merge');
    const ins = stepsFrom(c, kind === 'diverge');
    if (outs.length !== 2 || ins.length !== 1) continue;
    const dirOf = (st: Step) => {
      const s = byId.get(st.id)!;
      return bearing(s.coords[st.i], s.coords[st.i + st.d]);
    };
    const [o1, o2] = outs;
    if (turn(dirOf(o1), dirOf(o2)) > 35) continue;
    // Main road = the branch that continues straightest from the way in.
    const inS = byId.get(ins[0].id)!;
    const hin = bearing(inS.coords[ins[0].i + ins[0].d], inS.coords[ins[0].i]) + 180;
    const t1 = turn(hin, dirOf(o1));
    const t2 = turn(hin, dirOf(o2));
    const [main, slip] = t1 <= t2 ? [o1, o2] : [o2, o1];
    const key = `${kind}:${k}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gores.push({ kind, at: c, main, slip, before: ins[0] });
  }
});

// ---- simulate ----
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}
function gps(coords: Coord[], seed: number, kmh: number): Point[] {
  const r = rng(seed);
  const pts: Point[] = [];
  const v = kmh / 3.6;
  let t = 1_700_000_000_000 + seed * 1e6;
  let bx = gauss(r) * 3, by = gauss(r) * 3; // slowly drifting bias
  let carry = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const L = haversine(a, b);
    let d = carry;
    while (d < L) {
      const f = d / L;
      const la = a[0] + (b[0] - a[0]) * f, lo = a[1] + (b[1] - a[1]) * f;
      bx = bx * 0.95 + gauss(r) * BIAS;
      by = by * 0.95 + gauss(r) * BIAS;
      const nx = bx + gauss(r) * WHITE, ny = by + gauss(r) * WHITE;
      pts.push({ latitude: la + ny / METERS_PER_DEG_LAT, longitude: lo + nx / metersPerDegLon(la), timestamp: t, accuracy: 5 });
      t += 2000;
      d += v * 2;
    }
    carry = d - L;
  }
  return pts;
}

type Bad = { id: string; m: number };
let lastRun: any = null;
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',').map(Number) : null;
const dumps: any[] = [];
function run(coords: Coord[], truth: Map<string, [number, number]>, seed: number, kmh: number, coverage: Map<string, [number, number][]> = new Map()): Bad[] {
  const m = new DriveMatcher(net, new Set(), coverage);
  const got = new Set<string>();
  const pts = gps(coords, seed, kmh);
  for (let i = 0; i < pts.length; i += 50) m.feed(pts.slice(i, i + 50)).completed.forEach((x) => got.add(x));
  m.finish().forEach((x) => got.add(x));
  m.stubs.forEach((x) => got.add(x));
  lastRun = { pts, got: [...got].map((id) => ({ id, shape: net.shapeOf(id) })) };
  const bad: Bad[] = [];
  got.forEach((id) => {
    const base = baseChunkId(id);
    const rg = rangeOf(id) ?? [0, net.length(base)];
    const tr = truth.get(base);
    let wrong: number;
    if (!tr) wrong = rg[1] - rg[0];
    else wrong = Math.max(0, tr[0] - rg[0] - 10) + Math.max(0, rg[1] - tr[1] - 10);
    // Start/stop credit near the ends of the simulated drive is by design.
    const shape = net.shapeOf(id) || [];
    const nearEnd = shape.some((c) => haversine(c, coords[0]) < 150 || haversine(c, coords[coords.length - 1]) < 150);
    if (wrong > 15 && !nearEnd) bad.push({ id, m: Math.round(wrong) });
  });
  return bad;
}

const RUN_M = 900;
const BIAS = Number(process.env.BIAS ?? 0.7), WHITE = Number(process.env.WHITE ?? 2.5);
let totalBad = 0, totalRuns = 0, badRuns = 0;
const report: any[] = [];
for (const g of gores) {
  if (ONLY && haversine(g.at, [ONLY[0], ONLY[1]]) > 30) continue;
  for (const route of ['main', 'slip'] as const) {
    // Path: up to RUN_M before the gore (walked backwards), then RUN_M after it along main or slip.
    const backStep: Step = g.kind === 'diverge' ? g.before : route === 'main' ? g.main : g.slip;
    const fwdStep: Step = g.kind === 'diverge' ? (route === 'main' ? g.main : g.slip) : g.before;
    const back = walk(backStep, RUN_M, true);
    const fwd = walk(fwdStep, RUN_M, false);
    const coords = [...back.coords.slice().reverse(), ...fwd.coords.slice(1)];
    const lenOf = (cs: Coord[]) => cs.reduce((m, c, i) => (i ? m + haversine(cs[i - 1], c) : 0), 0);
    if (lenOf(back.coords) < 400 || lenOf(fwd.coords) < 400) continue; // not a real slip road (roundabout flare etc.)
    const truth = new Map<string, [number, number]>();
    for (const rs of [back.ranges, fwd.ranges])
      rs.forEach((r, id) => {
        const t = truth.get(id);
        truth.set(id, t ? [Math.min(t[0], r[0]), Math.max(t[1], r[1])] : [r[0], r[1]]);
      });
    const fails: Bad[][] = [];
    // ACCUM: the same coverage map for every repeat, as on a phone where
    // partly-driven stretches add up across drives.
    const shared = process.argv.includes('--accum') ? new Map<string, [number, number][]>() : undefined;
    for (let s = 1; s <= SEEDS; s++) {
      const bad = run(coords, truth, s * 7919 + gores.indexOf(g), route === 'slip' ? 75 : 105, shared ?? new Map());
      totalRuns++;
      if (ONLY) dumps.push({ route, seed: s, bad, coords, ...lastRun });
      if (bad.length) {
        badRuns++;
        totalBad += bad.reduce((n, b) => n + b.m, 0);
        fails.push(bad);
      }
    }
    report.push({ kind: g.kind, route, at: g.at, fails: fails.length, examples: fails.slice(0, 2), coords });
    if (LIST && fails.length) console.log(`${g.kind} ${route} @ ${g.at[0].toFixed(5)},${g.at[1].toFixed(5)}: ${fails.length}/${SEEDS} wrong`, JSON.stringify(fails[0]));
  }
}
console.log(`gores: ${gores.length} (${gores.filter((g) => g.kind === 'diverge').length} diverge, ${gores.filter((g) => g.kind === 'merge').length} merge)`);
console.log(`runs: ${totalRuns}, with wrong road credited: ${badRuns} (${((100 * badRuns) / Math.max(1, totalRuns)).toFixed(1)}%), wrong metres total: ${totalBad}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(ONLY ? { at: ONLY, dumps, roads: segs.filter((x) => x.coords.some((c) => haversine(c, [ONLY[0], ONLY[1]]) < 1200)) } : report));
