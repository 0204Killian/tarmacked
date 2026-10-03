// The new road-data pipeline (scripts/pipeline) against real road data.
//
// We can't download OpenStreetMap here, so this rebuilds the OSM roads from
// the CURRENT tiles (pieces of the same way joined back together), feeds
// them through build.js exactly as osmium would export them, and checks:
//  - every road piece comes out with the same ID and the same shape as
//    before (so nobody's driven roads have to be re-earned);
//  - the compact format reads back exactly (src/tiles.ts);
//  - counties, totals, places, turn restrictions and the manifest.
//
//   npx tsx test/pipeline.test.ts <old tiles dir>
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { decodeTile, ROAD_CLASSES } from '../src/tiles';
import { runPipeline } from './fixture';
declare const require: any;
declare const process: any;
declare const __dirname: string;

const oldDir = process.argv[2] || '/home/claude/repo/tiles';
const results: boolean[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`);
};

type Seg = { id: string; coords: [number, number][]; o?: number; c?: number; n?: string };
const old = new Map<string, Seg>();
for (const f of fs.readdirSync(oldDir)) {
  if (!f.startsWith('t_')) continue;
  for (const s of JSON.parse(fs.readFileSync(path.join(oldDir, f), 'utf8')).segments as Seg[]) old.set(s.id, s);
}

// Rebuild whole ways where every piece from #0 up is present.
const byWay = new Map<number, Seg[]>();
old.forEach((s) => {
  const m = /^way\/(\d+)#(\d+)$/.exec(s.id)!;
  const w = Number(m[1]);
  if (!byWay.has(w)) byWay.set(w, []);
  byWay.get(w)![Number(m[2])] = s;
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-'));
const data = path.join(tmp, 'data');
const out = path.join(tmp, 'out');
fs.mkdirSync(data);
const lines: string[] = [];
const expected = new Map<string, Seg>(); // pieces whose ID must come out the same
let nodeId = 1;
let ways = 0;
const wayInfo = new Map<number, { ids: number[]; coords: [number, number][]; k: number }>();
let viaWayA = 0, viaWayB = 0, viaNode = 0;
byWay.forEach((parts, w) => {
  const n = parts.length;
  for (let i = 0; i < n; i++) if (!parts[i]) return; // a gap: some pieces are in tiles we don't have
  const coords: [number, number][] = [...parts[0].coords];
  for (let i = 1; i < n; i++) {
    const prev = coords[coords.length - 1];
    const next = parts[i].coords;
    if (next[0][0] !== prev[0] || next[0][1] !== prev[1]) return; // not joined: skip this way
    coords.push(...next.slice(1));
  }
  // The last piece may continue into tiles we don't have; all others must match.
  for (let i = 0; i < n - 1; i++) expected.set(parts[i].id, parts[i]);
  const k = ways++;
  const props: any = { '@type': 'way', '@id': w, highway: k % 10 === 0 ? 'tertiary' : 'unclassified' };
  if (k % 50 === 0) props.toll = 'yes';
  if (k % 70 === 5) props.surface = 'gravel';
  if (parts[0].o === 1) props.oneway = 'yes';
  if (parts[0].o === -1) props.oneway = '-1';
  if (parts[0].n) props.name = parts[0].n;
  const ids = coords.map(() => nodeId++);
  props['@way_nodes'] = ids;
  wayInfo.set(w, { ids, coords, k });
  if (!viaWayA) {
    viaWayA = w;
    viaNode = ids[ids.length - 1];
  } else if (!viaWayB) viaWayB = w;
  // osmium writes full-precision coordinates; add sub-rounding noise to prove rounding matches.
  const geo = coords.map(([la, lo]) => [lo + 0.000001 * Math.sin(la * 1e3), la + 0.000001 * Math.cos(lo * 1e3)]);
  lines.push('\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: geo }, properties: props }));
});
// A private road (must be dropped) and a node (ignored).
lines.push('\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-7.5, 52.6], [-7.49, 52.6]] }, properties: { '@type': 'way', '@id': 999999999999, highway: 'residential', access: 'private' } }));
fs.writeFileSync(path.join(data, 'roads.geojsonseq'), lines.join('\n') + '\n');
// A fake "County Tipperary" covering the western half of the area, with a hole.
const box = (a: number, b: number, c: number, d: number) => [[b, a], [d, a], [d, c], [b, c], [b, a]];
fs.writeFileSync(
  path.join(data, 'admin.geojsonseq'),
  '\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [box(52.4, -8.0, 52.8, -7.75), box(52.5, -7.95, 52.52, -7.9)] }, properties: { name: 'County Tipperary', boundary: 'administrative', admin_level: '6' } }) + '\n' +
    // Northern Ireland's counties are only historic boundaries in OSM.
    '\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [box(52.4, -7.6, 52.8, -7.4)] }, properties: { name: 'County Antrim', boundary: 'historic' } }) + '\n' +
    // A historic boundary named like a Republic county never beats the real one.
    '\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [box(52.4, -7.6, 52.8, -7.4)] }, properties: { name: 'County Tipperary', boundary: 'historic' } }) + '\n'
);
fs.writeFileSync(
  path.join(data, 'places.geojsonseq'),
  ['Cashel|52.5159|-7.8853|town', 'Urlingford|52.7206|-7.5822|village', 'Nowhere|52.6|-7.6|farm']
    .map((x) => x.split('|'))
    .map(([name, la, lo, place]) => '\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [Number(lo), Number(la)] }, properties: { name, place } }))
    .join('\n')
);
fs.writeFileSync(path.join(data, 'restrictions.opl'), `r1 v1 Ttype=restriction,restriction=no_right_turn Mw${viaWayA}@from,n${viaNode}@via,w${viaWayB}@to\nr2 v1 Ttype=restriction,restriction=no_left_turn Mw1@from,w2@via,w3@to\n`);

// Slow-down nodes: traffic lights in the middle of a main road.
const mainWays = [...wayInfo.entries()].filter(([, w]) => w.k % 10 === 0 && w.ids.length > 4);
const [lightsWay, lw] = mainWays[1];
fs.writeFileSync(path.join(data, 'nodes.geojsonseq'), '\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [lw.coords[2][1], lw.coords[2][0]] }, properties: { '@type': 'node', '@id': lw.ids[2], highway: 'traffic_signals' } }) + '\n');
// A car ferry from the end of one main road to the start of another, and a foot-only one.
const [fa, fb] = [mainWays[2][1], mainWays[3][1]];
const ferry = (id: number, extra: any) =>
  '\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[fa.coords[fa.coords.length - 1][1], fa.coords[fa.coords.length - 1][0]], [fb.coords[0][1], fb.coords[0][0]]] }, properties: { '@type': 'way', '@id': id, route: 'ferry', duration: '0:20', '@way_nodes': [fa.ids[fa.ids.length - 1], fb.ids[0]], ...extra } });
fs.writeFileSync(path.join(data, 'ferries.geojsonseq'), [ferry(888000001, { motor_vehicle: 'yes', name: 'Test Ferry' }), ferry(888000002, { foot: 'yes' })].join('\n') + '\n');

const t0 = Date.now();
const log = runPipeline(data, out, '2026-10-03');
const dir = path.join(out, 'ie', '2026-10-03');

// Read everything back the way the app will.
const got = new Map<string, any>();
const stats = JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8'));
let newBytes = 0, oldBytes = 0;
for (const f of fs.readdirSync(dir)) {
  if (!f.startsWith('t_')) continue;
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  newBytes += text.length;
  for (const s of decodeTile(JSON.parse(text))) got.set(s.id, s);
}
for (const f of fs.readdirSync(oldDir)) if (f.startsWith('t_')) oldBytes += fs.statSync(path.join(oldDir, f)).size;

let same = 0;
const diffs: string[] = [];
expected.forEach((s, id) => {
  const g = got.get(id);
  const ok = g && JSON.stringify(g.coords) === JSON.stringify(s.coords) && (g.o ?? 0) === (s.o ?? 0) && (g.n ?? null) === (s.n ?? null);
  if (ok) same++;
  else if (diffs.length < 3) diffs.push(`${id}: ${g ? 'different shape/flags' : 'missing'}`);
});
check(`same IDs and shapes as the current tiles (${expected.size} pieces from ${lines.length - 1} ways)`, same === expected.size && expected.size > 1000, `${same}/${expected.size} ${diffs.join('; ')}`);
check('private roads left out', ![...got.keys()].some((id) => id.startsWith('way/999999999999')));
const tip = [...got.values()].filter((s) => s.c === 21);
const inHole = tip.filter((s) => {
  const m = s.coords[Math.floor(s.coords.length / 2)];
  return m[0] > 52.5 && m[0] < 52.52 && m[1] > -7.95 && m[1] < -7.9;
});
const west = [...got.values()].filter((s) => {
  const m = s.coords[Math.floor(s.coords.length / 2)];
  return m[1] < -7.76 && m[1] > -7.99 && m[0] > 52.41 && m[0] < 52.79 && !(m[0] > 52.499 && m[0] < 52.521 && m[1] > -7.951 && m[1] < -7.899);
});
check('county from the boundary (holes respected)', tip.length > 100 && inHole.length === 0 && west.every((s) => s.c === 21), `${tip.length} pieces in Tipperary, ${inHole.length} wrongly in the hole, ${west.filter((s) => s.c !== 21).length} missed`);
check('stats: Tipperary total and per road type add up', stats.totalMeters[21] > 0 && Math.abs(stats.byClass[21].reduce((a: number, b: number) => a + b, 0) - stats.totalMeters[21]) <= 13, `${(stats.totalMeters[21] / 1000).toFixed(0)} km`);
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
check('index: every tile listed, county tiles listed', index.tiles.length === fs.readdirSync(dir).filter((f) => f.startsWith('t_')).length && index.counties['County Tipperary'].length > 0);
const places = JSON.parse(fs.readFileSync(path.join(dir, 'places.json'), 'utf8'));
check('places: towns and villages kept, farms not', places.places.map((p: any) => p[0]).join() === 'Cashel,Urlingford');
const restr = JSON.parse(fs.readFileSync(path.join(dir, 'restrictions.json'), 'utf8'));
check('turn restrictions: via-node ones located, via-way ones skipped', restr.r.length === 1 && restr.r[0][0] === viaWayA && restr.r[0][3] === viaWayB, JSON.stringify(restr.r));
const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
const mainCount = [...wayInfo.values()].filter((w) => w.k % 10 === 0).length;
const graphWays = new Set(graph.edges.map((e: number[]) => e[2]));
check('routing graph (v2): main roads only, plus car ferries', graph.v === 2 && graphWays.size >= mainCount - 3 && graphWays.size <= mainCount + 1 && [...graphWays].every((w) => w === 888000001 || wayInfo.get(w as number)!.k % 10 === 0) && graphWays.has(888000001) && !graphWays.has(888000002), `${graph.edges.length} links on ${graphWays.size} ways (${mainCount} main roads)`);
const ferryEdge = graph.edges.find((e: number[]) => e[2] === 888000001);
check('ferry: flagged, with its timetable speed', !!ferryEdge && (ferryEdge[3] & 32) !== 0 && graph.classes[ferryEdge[4]] === 'ferry' && ferryEdge[5] > 0, ferryEdge ? `speed ${ferryEdge[5]} km/h` : 'none');
const tollWays = [...wayInfo.entries()].filter(([, w]) => w.k % 50 === 0).map(([id]) => id);
check('toll roads flagged in the graph', graph.edges.filter((e: number[]) => tollWays.includes(e[2])).every((e: number[]) => (e[3] & 8) !== 0) && graph.edges.some((e: number[]) => (e[3] & 8) !== 0));
const lights = graph.edges.filter((e: number[]) => e[2] === lightsWay);
check('traffic lights add a delay to their road', lights.reduce((a: number, e: number[]) => a + e[10], 0) === 12, lights.map((e: number[]) => e[10]).join(','));
const tollPieces = [...got.values()].filter((sg) => sg.t);
const gravel = [...got.values()].filter((sg) => sg.u);
check('tiles: toll and unpaved pieces flagged', tollPieces.length > 0 && tollPieces.every((sg) => tollWays.includes(Number(/way\/(\d+)/.exec(sg.id)![1]))) && gravel.length > 0, `${tollPieces.length} toll, ${gravel.length} unpaved pieces`);
check("Ireland's stats: the Republic's 26 counties as before, Northern Ireland's listed after", stats.counties.length === 26 && stats.totalMeters.length === 26 && stats.areas.length === 32 && stats.areas[26] === 'County Antrim');
check(
  "Northern Ireland's counties from historic boundaries, counted for the UK",
  stats.areaMeters[26] > 0 && stats.areaCountry[26] === 'GB' && stats.areaCountry[9] === 'IE' && stats.num === 0 && stats.areaMeters[21] > 0,
  `Antrim ${(stats.areaMeters[26] / 1000).toFixed(0)} km, Tipperary ${(stats.areaMeters[21] / 1000).toFixed(0)} km`
);
const { publish } = require('../scripts/pipeline/publish.js');
const entry = JSON.parse(fs.readFileSync(path.join(out, 'entry-ie.json'), 'utf8'));
const pub = publish({ v: 1, regions: { ie: { version: '2026-10-02', path: 'ie/2026-10-02/' }, fr: { version: '2026-09-02', path: 'fr/2026-09-02/' } } }, [entry]);
check(
  'manifest: the new version in, other regions kept, old versions to delete listed',
  pub.manifest.regions.ie.path === 'ie/2026-10-03/' && pub.manifest.regions.ie.tiles === index.tiles.length && pub.manifest.regions.ie.bbox?.length === 4 && pub.manifest.regions.fr.version === '2026-09-02' && pub.keep.join() === 'fr/2026-09-02/,ie/2026-10-02/,ie/2026-10-03/',
  pub.keep.join(' ')
);

// Big countries are built in parts: the same data cut in two (west/east,
// each part keeping every road that touches it, as osmium's "smart" cut
// does) must come out the same.
{
  const split = path.join(tmp, 'split');
  const cutLon = -7.6;
  const partDirs = ['p00', 'p01'].map((p) => path.join(split, p));
  partDirs.forEach((d) => fs.mkdirSync(d, { recursive: true }));
  const inPart = (lons: number[], i: number) => (i === 0 ? lons.some((x) => x < cutLon + 0.002) : lons.some((x) => x >= cutLon - 0.002));
  for (const f of ['roads.geojsonseq', 'ferries.geojsonseq', 'nodes.geojsonseq', 'places.geojsonseq']) {
    const rows = fs.readFileSync(path.join(data, f), 'utf8').split('\n').filter(Boolean);
    partDirs.forEach((d, i) =>
      fs.writeFileSync(
        path.join(d, f),
        rows
          .filter((r) => {
            const g = JSON.parse(r.replace(/^\x1e/, '')).geometry;
            const lons = g.type === 'Point' ? [g.coordinates[0]] : g.coordinates.map((c: number[]) => c[0]);
            return inPart(lons, i);
          })
          .join('\n') + '\n'
      )
    );
  }
  partDirs.forEach((d) => fs.copyFileSync(path.join(data, 'restrictions.opl'), path.join(d, 'restrictions.opl')));
  const areasFile = path.join(data, 'areas.json');
  const built = path.join(split, 'built');
  const P = (f: string) => path.join(__dirname, '../scripts/pipeline', f);
  partDirs.forEach((d, i) =>
    execFileSync('node', [P('build.js'), 'ie', d, path.join(built, `p0${i}`), areasFile, i === 0 ? `50,-12,56,${cutLon}` : `50,${cutLon},56,-5`, '10', 'IE'], { encoding: 'utf8' })
  );
  const out2 = path.join(split, 'out');
  execFileSync('node', [P('merge.js'), 'ie', 'split', built, areasFile, out2], { encoding: 'utf8' });
  const dir2 = path.join(out2, 'ie', 'split');
  const tiles1 = fs.readdirSync(dir).filter((f) => f.startsWith('t_')).sort();
  const tiles2 = fs.readdirSync(dir2).filter((f) => f.startsWith('t_')).sort();
  const sameTiles = tiles1.length === tiles2.length && tiles1.every((t, i) => t === tiles2[i] && fs.readFileSync(path.join(dir, t), 'utf8') === fs.readFileSync(path.join(dir2, t), 'utf8'));
  const st2 = JSON.parse(fs.readFileSync(path.join(dir2, 'stats.json'), 'utf8'));
  const g2 = JSON.parse(fs.readFileSync(path.join(dir2, 'graph.json'), 'utf8'));
  const sameStats = Math.abs(st2.areaMeters.reduce((a: number, b: number) => a + b, 0) + st2.outsideMeters - stats.areaMeters.reduce((a: number, b: number) => a + b, 0) - stats.outsideMeters) <= 2;
  const p2 = JSON.parse(fs.readFileSync(path.join(dir2, 'places.json'), 'utf8'));
  check(
    'built in two parts = built in one (tiles, totals, graph, places)',
    sameTiles && sameStats && g2.edges.length === graph.edges.length && g2.nodes.length === graph.nodes.length && p2.places.length === places.places.length,
    `${tiles2.length}/${tiles1.length} tiles identical: ${sameTiles}; totals ${sameStats}; graph ${g2.edges.length}/${graph.edges.length} links`
  );
}

// Another country: roads cut to its border, its own areas found.
{
  const cdata = path.join(tmp, 'country');
  fs.mkdirSync(cdata, { recursive: true });
  fs.copyFileSync(path.join(data, 'roads.geojsonseq'), path.join(cdata, 'roads.geojsonseq'));
  const feat = (geometry: any, properties: any) => '\x1e' + JSON.stringify({ type: 'Feature', geometry, properties });
  fs.writeFileSync(
    path.join(cdata, 'admin.geojsonseq'),
    [
      feat({ type: 'Polygon', coordinates: [box(51, -11, 56, -7.6)] }, { boundary: 'administrative', admin_level: '2', 'ISO3166-1': 'LU', name: 'Testland' }),
      feat({ type: 'Polygon', coordinates: [box(51, -11, 52.7, -7.6)] }, { boundary: 'administrative', admin_level: '6', name: 'South' }),
      feat({ type: 'Polygon', coordinates: [box(52.7, -11, 56, -7.6)] }, { boundary: 'administrative', admin_level: '6', name: 'North' }),
      feat({ type: 'Polygon', coordinates: [box(51, -7.6, 56, -5)] }, { boundary: 'administrative', admin_level: '6', name: 'Neighbour' }),
      feat({ type: 'Polygon', coordinates: [box(51, -11, 56, -9)] }, { boundary: 'administrative', admin_level: '4', name: 'Province' }),
    ].join('\n') + '\n'
  );
  const cout = path.join(cdata, 'out');
  runPipeline(cdata, cout, 'v1', 'lu');
  const cdir = path.join(cout, 'lu', 'v1');
  const cst = JSON.parse(fs.readFileSync(path.join(cdir, 'stats.json'), 'utf8'));
  const cpieces = fs.readdirSync(cdir).filter((f) => f.startsWith('t_')).flatMap((f) => decodeTile(JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8'))));
  const east = cpieces.filter((sg) => sg.coords[Math.floor(sg.coords.length / 2)][1] > -7.59);
  check(
    "another country: roads over its border left out, its own areas (not the neighbour's)",
    east.length === 0 && cpieces.length > 1000 && cst.areas.join() === 'North,South' && cst.nationalMeters > 0 && cst.areaCountry.join() === 'LU,LU' && cst.num > 0,
    `${cpieces.length} pieces kept, ${east.length} over the border; areas ${cst.areas.join(', ')}`
  );
}
// Scenic drives (v0.21): from road numbers in a box, and from route
// relations (with sub-relations, like the Wild Atlantic Way's stages).
async function scenicTest() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildScenic } = require('../scripts/pipeline/scenic.js');
  // A small region: R115 inside the box (kept), R115 outside it, a
  // roundabout and a slip road on R115 (left out), and another road.
  const sdir = path.join(tmp, 'scenic');
  fs.mkdirSync(sdir, { recursive: true });
  const link = ROAD_CLASSES.indexOf('secondary_link');
  const sec = ROAD_CLASSES.indexOf('secondary');
  const row = (way: number, idx: number, flags: number, name: number, cls: number, lat: number, lon: number) => [way, idx, flags, -1, name, cls, 0, lat, lon, 100, 100];
  fs.writeFileSync(
    path.join(sdir, 't_1062_-127.json'),
    JSON.stringify({
      v: 2,
      names: ['R115 Military Road', 'R759', 'R115/R759'],
      s: [row(1, 0, 0, 0, sec, 5313000, -630000), row(1, 1, 0, 0, sec, 5313100, -629900), row(2, 0, 0, 2, sec, 5314000, -630000), row(3, 0, 4, 0, sec, 5313500, -630000), row(4, 0, 0, 0, link, 5313600, -630000), row(5, 0, 0, 0, sec, 5340000, -630000), row(6, 0, 0, 1, sec, 5313000, -631000)],
    })
  );
  // Route relations: a super-relation and its stage (like the Wild Atlantic Way's).
  const opl = path.join(tmp, 'routes.opl');
  fs.writeFileSync(opl, 'r1 v1 Ttype=route,route=road,name=Test%20%Way Mr2@\nr2 v1 Ttype=route,route=road,name=Test%20%Way%20%-%20%Stage Mw6@,w1@\nr3 v1 Ttype=route,route=road,name=Other Mw5@\n');
  const defs = [
    { id: 'by-ref', name: 'By ref', need: 1, roads: [{ ref: 'R115', box: [53.0, -6.4, 53.21, -6.24] }] },
    { id: 'by-relation', name: 'By relation', need: 1, relation: /^Test Way\b/ },
    { id: 'nothing', name: 'Nothing', need: 1, roads: [{ ref: 'Z999', box: [50, -11, 56, -5] }] },
  ];
  await buildScenic('ie', sdir, opl, defs);
  const sc = JSON.parse(fs.readFileSync(path.join(sdir, 'scenic.json'), 'utf8'));
  const ids = (d: any) => d.pieces.flatMap((r: number[]) => r.slice(1).filter((_: number, k: number) => k % 2 === 0).map((i: number) => `${r[0]}#${i}`)).sort().join(',');
  const byRef = sc.drives.find((d: any) => d.id === 'by-ref');
  const byRel = sc.drives.find((d: any) => d.id === 'by-relation');
  check('scenic: a road number in a box (shared numbers too; no roundabouts, slip roads or bits outside)', ids(byRef) === '1#0,1#1,2#0' && byRef.m > 0, ids(byRef));
  check('scenic: a route relation and its stages', ids(byRel) === '1#0,1#1,6#0' && byRel.lines.length > 0, ids(byRel));
  check('scenic: a drive with no roads found is left out', !sc.drives.some((d: any) => d.id === 'nothing'));
}

check('tiles smaller than before', newBytes < oldBytes * 0.7, `${(newBytes / 1e6).toFixed(2)} MB vs ${(oldBytes / 1e6).toFixed(2)} MB for the same area (${Math.round((100 * newBytes) / oldBytes)}%), before Cloudflare's compression`);
console.log(`      (built in ${Date.now() - t0} ms)\n${log.split('\n').filter((l) => /roads:|counties:|tiles:/.test(l)).map((l) => '      ' + l).join('\n')}`);
scenicTest()
  .then(() => console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED'))
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true })); // ~1 GB of test output
