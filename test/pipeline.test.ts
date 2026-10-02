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
import { decodeTile } from '../src/tiles';
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
  const props: any = { '@type': 'way', '@id': w, highway: 'unclassified' };
  if (parts[0].o === 1) props.oneway = 'yes';
  if (parts[0].o === -1) props.oneway = '-1';
  if (parts[0].n) props.name = parts[0].n;
  const ids = coords.map(() => nodeId++);
  props['@way_nodes'] = ids;
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
  '\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [box(52.4, -8.0, 52.8, -7.75), box(52.5, -7.95, 52.52, -7.9)] }, properties: { name: 'County Tipperary', boundary: 'administrative', admin_level: '6' } }) + '\n'
);
fs.writeFileSync(
  path.join(data, 'places.geojsonseq'),
  ['Cashel|52.5159|-7.8853|town', 'Urlingford|52.7206|-7.5822|village', 'Nowhere|52.6|-7.6|farm']
    .map((x) => x.split('|'))
    .map(([name, la, lo, place]) => '\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [Number(lo), Number(la)] }, properties: { name, place } }))
    .join('\n')
);
fs.writeFileSync(path.join(data, 'restrictions.opl'), `r1 v1 Ttype=restriction,restriction=no_right_turn Mw${viaWayA}@from,n${viaNode}@via,w${viaWayB}@to\nr2 v1 Ttype=restriction,restriction=no_left_turn Mw1@from,w2@via,w3@to\n`);

const t0 = Date.now();
const log = execFileSync('node', [path.join(__dirname, '../scripts/pipeline/build.js'), 'ie', '2026-10-03', data, out], { encoding: 'utf8' });
const dir = path.join(out, 'ie', '2026-10-03');

// Read everything back the way the app will.
const got = new Map<string, any>();
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
const stats = JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8'));
check('stats: Tipperary total and per road type add up', stats.totalMeters[21] > 0 && Math.abs(stats.byClass[21].reduce((a: number, b: number) => a + b, 0) - stats.totalMeters[21]) <= 13, `${(stats.totalMeters[21] / 1000).toFixed(0)} km`);
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
check('index: every tile listed, county tiles listed', index.tiles.length === fs.readdirSync(dir).filter((f) => f.startsWith('t_')).length && index.counties['County Tipperary'].length > 0);
const places = JSON.parse(fs.readFileSync(path.join(dir, 'places.json'), 'utf8'));
check('places: towns and villages kept, farms not', places.places.map((p: any) => p[0]).join() === 'Cashel,Urlingford');
const restr = JSON.parse(fs.readFileSync(path.join(dir, 'restrictions.json'), 'utf8'));
check('turn restrictions: via-node ones located, via-way ones skipped', restr.r.length === 1 && restr.r[0][0] === viaWayA && restr.r[0][3] === viaWayB, JSON.stringify(restr.r));
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
check('manifest points at the new version', manifest.regions.ie.path === 'ie/2026-10-03/' && manifest.regions.ie.tiles === index.tiles.length);
check('tiles smaller than before', newBytes < oldBytes * 0.7, `${(newBytes / 1e6).toFixed(2)} MB vs ${(oldBytes / 1e6).toFixed(2)} MB for the same area (${Math.round((100 * newBytes) / oldBytes)}%), before Cloudflare's compression`);
console.log(`      (built in ${Date.now() - t0} ms)\n${log.split('\n').filter((l) => /roads:|counties:|tiles:/.test(l)).map((l) => '      ' + l).join('\n')}`);
console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
