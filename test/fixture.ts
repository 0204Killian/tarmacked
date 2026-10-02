// Real Irish road data for the sat-nav tests, built through the real
// pipeline (scripts/pipeline/build.js).
//
// We can't download OpenStreetMap here, so this rebuilds OSM-like roads
// from the old tiles in the repo (tiles/, from before v0.17): pieces of the
// same way are joined back together, points at the same position share a
// node ID (as junctions do in OSM). The old tiles have no road names or
// types, so every road goes in as 'tertiary': the routing graph then holds
// the whole country (about three times what the real main-roads graph will
// hold), which makes it a worst case for size and speed.
//
// The build is cached in /tmp/tarmacked-fixture (delete it to rebuild).
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
declare const __dirname: string;

export const FIXTURE_DIR = '/tmp/tarmacked-fixture';
export const FIXTURE_OUT = path.join(FIXTURE_DIR, 'out', 'ie', 'fixture');

type Seg = { id: string; coords: [number, number][]; o?: number; c?: number; n?: string };

const P = (f: string) => path.join(__dirname, '../scripts/pipeline', f);
/** The pipeline's steps as run.sh runs them, on exported data in one folder (one part). */
export function runPipeline(data: string, out: string, version: string, region = 'ie') {
  const run = (args: string[]) => execFileSync('node', ['--max-old-space-size=6144', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const areas = path.join(data, 'areas.json');
  run([P('areas.js'), region, path.join(data, 'admin.geojsonseq'), areas]);
  const built = path.join(data, 'built');
  fs.rmSync(built, { recursive: true, force: true });
  run([P('build.js'), region, data, path.join(built, 'p00'), areas, '-', '10', region === 'ie' ? 'IE' : '']);
  return run([P('merge.js'), region, version, built, areas, out]);
}

export function buildFixture(oldDir = '/home/claude/repo/tiles'): string {
  if (fs.existsSync(path.join(FIXTURE_OUT, 'graph.json'))) return FIXTURE_OUT;
  const old = new Map<string, Seg>();
  for (const f of fs.readdirSync(oldDir)) {
    if (!f.startsWith('t_')) continue;
    for (const s of JSON.parse(fs.readFileSync(path.join(oldDir, f), 'utf8')).segments as Seg[]) old.set(s.id, s);
  }
  const byWay = new Map<number, Seg[]>();
  old.forEach((s) => {
    const m = /^way\/(\d+)#(\d+)$/.exec(s.id)!;
    const w = Number(m[1]);
    if (!byWay.has(w)) byWay.set(w, []);
    byWay.get(w)![Number(m[2])] = s;
  });
  type Way = { id: number; coords: [number, number][]; o: number; n?: string; cls: string };
  const ways: Way[] = [];
  byWay.forEach((parts, w) => {
    for (let i = 0; i < parts.length; i++) if (!parts[i]) return;
    const coords: [number, number][] = [...parts[0].coords];
    for (let i = 1; i < parts.length; i++) {
      const prev = coords[coords.length - 1];
      const next = parts[i].coords;
      if (next[0][0] !== prev[0] || next[0][1] !== prev[1]) return;
      coords.push(...next.slice(1));
    }
    ways.push({ id: w, coords, o: parts[0].o ?? 0, n: parts[0].n, cls: 'tertiary' });
  });
  // Shared positions = shared nodes.
  const key = (c: [number, number]) => `${Math.round(c[0] * 1e5)},${Math.round(c[1] * 1e5)}`;
  const nodeIds = new Map<string, number>();
  for (const w of ways) {
    for (const c of w.coords) {
      const k = key(c);
      if (!nodeIds.has(k)) nodeIds.set(k, nodeIds.size + 1);
    }
  }
  const data = path.join(FIXTURE_DIR, 'data');
  fs.mkdirSync(data, { recursive: true });
  const lines = ways.map((w) => {
    const props: any = { '@type': 'way', '@id': w.id, highway: w.cls, '@way_nodes': w.coords.map((c) => nodeIds.get(key(c))) };
    if (w.o === 1) props.oneway = 'yes';
    if (w.o === -1) props.oneway = '-1';
    if (w.n) {
      const [ref, ...rest] = w.n.split(' ');
      if (/^[MNRL]\d/.test(ref)) {
        props.ref = ref;
        if (rest.length) props.name = rest.join(' ');
      } else props.name = w.n;
    }
    return '\x1e' + JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: w.coords.map(([la, lo]) => [lo, la]) }, properties: props });
  });
  fs.writeFileSync(path.join(data, 'roads.geojsonseq'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(data, 'admin.geojsonseq'), '');
  fs.writeFileSync(path.join(data, 'places.geojsonseq'), '');
  runPipeline(data, path.join(FIXTURE_DIR, 'out'), 'fixture');
  return FIXTURE_OUT;
}

declare const require: any;
declare const module: any;
if (require.main === module) {
  const t0 = Date.now();
  console.log(buildFixture(), `${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
