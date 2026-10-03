// Road data on the phone (src/roadData.ts) and moving edits onto a new
// version of the road data (src/editMigrate.ts), with a fake server and a
// fake tile cache built from real tiles.
//
//   npx tsx test/roadData.test.ts <old tiles dir>
import * as fs from 'fs';
import * as path from 'path';
import { RoadData, FetchResult } from '../src/roadData';
import { TILE_HOST } from '../src/tiles';
import { RoadNetwork, RoadSegment } from '../src/roadMatcher';
import { migrateEdits } from '../src/editMigrate';
declare const process: any;

const tilesDir = process.argv[2] || '/home/claude/repo/tiles';
const results: boolean[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`);
};

// A few real tiles, served in the old {segments} format (decodeTile reads both).
const real = fs.readdirSync(tilesDir).filter((f) => f.startsWith('t_')).slice(0, 12).map((f) => f.replace('.json', ''));
const tileData = new Map<string, any>(real.map((t) => [t, JSON.parse(fs.readFileSync(path.join(tilesDir, `${t}.json`), 'utf8'))]));

function server(version: string, opts: { offline?: boolean; missing?: string[] } = {}) {
  const calls: string[] = [];
  const fetchJson = async (url: string): Promise<FetchResult> => {
    calls.push(url.replace(TILE_HOST, ''));
    if (opts.offline) return { ok: false, missing: false };
    if (url === `${TILE_HOST}manifest.json`) return { ok: true, data: { v: 1, regions: { ie: { version, path: `ie/${version}/`, tiles: real.length } } } };
    if (url === `${TILE_HOST}ie/${version}/index.json`)
      return { ok: true, data: { v: 2, region: 'ie', version, tiles: real, counties: { 'County Kilkenny': real.slice(0, 4), 'County Nowhere': [] }, classes: [] } };
    if (url === `${TILE_HOST}ie/${version}/stats.json`) return { ok: true, data: { version } };
    const m = new RegExp(`^${TILE_HOST}ie/${version}/(t_[-0-9_]+)\\.json$`).exec(url);
    if (m && tileData.has(m[1]) && !opts.missing?.includes(m[1])) return { ok: true, data: tileData.get(m[1]) };
    return { ok: false, missing: true };
  };
  return { fetchJson, calls };
}

function phone() {
  const meta = new Map<string, string>();
  const tiles = new Map<string, { segments: RoadSegment[]; version: string | null; pinned: boolean }>();
  const got: RoadSegment[] = [];
  let cleared = 0;
  return {
    meta,
    tiles,
    got,
    cleared: () => cleared,
    deps: (fetchJson: any) => ({
      fetchJson,
      getMeta: async (k: string) => meta.get(k) ?? null,
      setMeta: async (k: string, v: string) => void meta.set(k, v),
      getTiles: async (ids: string[]) => ids.filter((i) => tiles.has(i)).map((i) => ({ tileId: i, ...tiles.get(i)! })),
      putTiles: async (e: { tileId: string; segments: RoadSegment[] }[], pinned: boolean, version: string) =>
        e.forEach((x) => tiles.set(x.tileId, { segments: x.segments, version, pinned: pinned || !!tiles.get(x.tileId)?.pinned })),
      clearTiles: async () => {
        cleared++;
        tiles.clear();
      },
      onSegments: (s: RoadSegment[]) => got.push(...s),
    }),
  };
}

(async () => {
  // First launch, online.
  const p = phone();
  const s1 = server('2026-10-01');
  const rd = new RoadData(p.deps(s1.fetchJson));
  check('nothing cached at first', !(await rd.loadCached()));
  const change = await rd.refresh();
  check('first refresh reports the version', change?.to === '2026-10-01' && change?.from === null);
  check('counties with roads listed', rd.counties().join() === 'County Kilkenny');
  const failed = await rd.ensure(rd.countyTiles('County Kilkenny'), { pinned: true });
  const n4 = real.slice(0, 4).reduce((a, t) => a + tileData.get(t).segments.length, 0);
  check('home county downloaded, cached and pinned', failed === 0 && p.got.length === n4 && real.slice(0, 4).every((t) => p.tiles.get(t)?.pinned && p.tiles.get(t)?.version === '2026-10-01'));
  // Asking again costs nothing.
  const before = s1.calls.length;
  await rd.ensure(real.slice(0, 4));
  check('loaded tiles not fetched twice', s1.calls.length === before);
  // Tiles outside the index (the sea) count as loaded without asking.
  await rd.ensure(['t_9999_9999']);
  check('unlisted tiles never fetched', rd.isLoaded('t_9999_9999') && !s1.calls.some((c) => c.includes('t_9999_9999')));
  // Same tile asked for twice at once: one download.
  const t5 = real[5];
  await Promise.all([rd.ensure([t5]), rd.ensure([t5])]);
  check('simultaneous requests share one download', s1.calls.filter((c) => c.endsWith(`${t5}.json`)).length === 1);
  check('no change when the version is the same', (await rd.refresh()) === null && p.cleared() === 1);

  // Next launch, offline: everything from the phone.
  const off = server('2026-10-01', { offline: true });
  const rd2 = new RoadData(p.deps(off.fetchJson));
  p.got.length = 0;
  check('cached index used offline', await rd2.loadCached());
  check('refresh offline does nothing', (await rd2.refresh()) === null);
  const f2 = await rd2.ensure([...real.slice(0, 4), real[5]]);
  check('cached tiles load offline, others reported as failed', p.got.length > 0 && f2 === 0 && !off.calls.some((c) => c.includes('t_')), `failed ${f2}`);
  const f3 = await rd2.ensure(real.slice(6, 8));
  check('uncached tiles offline: counted as failed and retried later', f3 === 2 && !rd2.isLoaded(real[6]));

  // A new version comes out.
  const s2 = server('2026-11-01');
  const rd3 = new RoadData(p.deps(s2.fetchJson));
  await rd3.loadCached();
  const ch = await rd3.refresh();
  check('new version: change reported, old tiles cleared', ch?.from === '2026-10-01' && ch?.to === '2026-11-01' && p.tiles.size === 0);
  await rd3.ensure(real.slice(0, 2));
  check('tiles come from the new version folder', s2.calls.some((c) => c.startsWith('ie/2026-11-01/t_')));
  check('stats from the current version', (await rd3.statsJson())?.version === '2026-11-01');

  // Old cache from before 0.17 (no version): not trusted once online.
  const p4 = phone();
  p4.tiles.set(real[0], { segments: [], version: null, pinned: true });
  const s4 = server('2026-10-01');
  const rd4 = new RoadData(p4.deps(s4.fetchJson));
  await rd4.refresh();
  await rd4.ensure([real[0]]);
  check('pre-0.17 cache replaced by the new data', p4.tiles.get(real[0])?.version === '2026-10-01' && p4.got.length > 0);

  // A listed tile that 404s counts as empty (not a connection problem).
  const p5 = phone();
  const s5 = server('2026-10-01', { missing: [real[1]] });
  const rd5 = new RoadData(p5.deps(s5.fetchJson));
  await rd5.refresh();
  check('a missing tile is not a failure', (await rd5.ensure([real[1]])) === 0 && rd5.isLoaded(real[1]));

  // ---- More than one region (v0.21) ----
  {
    const { cellOfTile, splitHome, joinHome } = await import('../src/roadData');
    const gbTile = 't_1025_5'; // 51.25, 0.25: south-east England
    const shared = real[0]; // a square both regions have (a border)
    const v2 = (way: number, county: number, lat: number, lon: number) => ({ v: 2, names: [], s: [[way, 0, 0, county, -1, 11, 0, lat, lon, 50, 50]] });
    const gbTiles: Record<string, any> = { [gbTile]: v2(777, 3, 5126000, 26000), [shared]: v2(778, 0, 5300000, -700000) };
    let gbVersion = 'g1';
    const calls: string[] = [];
    const fetchJson = async (url: string): Promise<FetchResult> => {
      const u = url.replace(TILE_HOST, '');
      calls.push(u);
      if (u === 'manifest.json')
        return { ok: true, data: { v: 1, regions: {
          ie: { version: 'i1', path: 'ie/i1/', tiles: real.length, num: 0, cells: [...new Set(real.map((t) => cellOfTile(t)!))] },
          gb: { version: gbVersion, path: `gb/${gbVersion}/`, tiles: 2, num: 1, country: 'GB', cells: [cellOfTile(gbTile)!, cellOfTile(shared)!] },
        } } };
      if (u === 'ie/i1/index.json') return { ok: true, data: { v: 2, region: 'ie', version: 'i1', tiles: real, counties: { 'County Kilkenny': real.slice(0, 4) }, classes: [] } };
      if (u === `gb/${gbVersion}/index.json`) return { ok: true, data: { v: 2, region: 'gb', version: gbVersion, tiles: Object.keys(gbTiles), counties: { Kent: [gbTile] }, classes: [] } };
      let m = /^ie\/i1\/(t_[-0-9_]+)\.json$/.exec(u);
      if (m && tileData.has(m[1])) return { ok: true, data: tileData.get(m[1]) };
      m = new RegExp(`^gb/${gbVersion}/(t_[-0-9_]+)\\.json$`).exec(u);
      if (m && gbTiles[m[1]]) return { ok: true, data: gbTiles[m[1]] };
      return { ok: false, missing: true };
    };
    const pm = phone();
    const rm = new RoadData(pm.deps(fetchJson));
    await rm.loadCached();
    await rm.refresh();
    check('a fresh phone starts with Ireland only', rm.regionsInUse().join() === 'ie' && !calls.some((c) => c.startsWith('gb/')));
    const f = await rm.ensure([gbTile]);
    const kent = pm.got.find((sg) => sg.id === 'way/777#0');
    check('driving into another region: its index and tiles fetched as needed', f === 0 && rm.regionsInUse().join() === 'ie,gb' && pm.tiles.has(`gb:${gbTile}`) && !!kent, calls.filter((c) => c.startsWith('gb/')).join(' '));
    check("that region's area codes don't clash with Ireland's (1000 + index)", kent?.c === 1003, `c=${kent?.c}`);
    pm.got.length = 0;
    await rm.ensure([shared]);
    check('a square both regions have: both loaded, kept apart on the phone', pm.got.some((sg) => sg.id === 'way/778#0') && pm.got.some((sg) => sg.id !== 'way/778#0') && pm.tiles.has(shared) && pm.tiles.has(`gb:${shared}`));
    check('both versions shown', rm.version === 'ie i1 · gb g1', String(rm.version));
    gbVersion = 'g2';
    const ch = await rm.refresh();
    check('a new version of one region: only that region changes', ch?.regions.join() === 'gb' && ch?.to === 'g2' && ch?.from === 'g1');
    // Next launch: both regions straight from the phone.
    const rm2 = new RoadData(pm.deps(async () => ({ ok: false, missing: false })));
    check('regions in use remembered offline', (await rm2.loadCached()) && rm2.regionsInUse().join() === 'ie,gb' && rm2.version === 'ie i1 · gb g2');
    check('home areas: Ireland by name, others with their region', splitHome('County Kilkenny').region === 'ie' && splitHome('gb/Kent').name === 'Kent' && joinHome('gb', 'Kent') === 'gb/Kent' && joinHome('ie', 'County Cork') === 'County Cork');
    check("another region's area tiles", rm.countyTiles('gb/Kent').join() === gbTile && rm.areas('gb').join() === 'Kent');
  }

  // ---- Moving edits onto new road data ----
  const all: RoadSegment[] = real.flatMap((t) => tileData.get(t).segments);
  const net = new RoadNetwork();
  net.add(all);
  const pick = all.filter((s) => s.coords.length >= 3).slice(0, 40);
  // Unchanged road: stays.
  const same = migrateEdits(pick.map((s) => ({ id: s.id, shape: s.coords })), net);
  check('unchanged pieces keep their edits', pick.every((s) => same.get(s.id)!.join() === s.id));
  // Road re-drawn in OSM under new IDs: the edit follows it by position.
  const victim = pick[7];
  const renamed: RoadSegment[] = all.map((s) => (s.id === victim.id ? { ...s, id: 'way/1#0' } : s));
  const net2 = new RoadNetwork();
  net2.add(renamed);
  const moved = migrateEdits([{ id: victim.id, shape: victim.coords }], net2);
  check('a re-drawn road: the edit moves to the new piece', moved.get(victim.id)!.includes('way/1#0'), JSON.stringify(moved.get(victim.id)));
  // Split in two: both halves get the edit.
  const mid = Math.floor(victim.coords.length / 2);
  const split: RoadSegment[] = all
    .filter((s) => s.id !== victim.id)
    .concat([
      { id: 'way/2#0', coords: victim.coords.slice(0, mid + 1) },
      { id: 'way/2#1', coords: victim.coords.slice(mid) },
    ]);
  const net3 = new RoadNetwork();
  net3.add(split);
  const halves = migrateEdits([{ id: victim.id, shape: victim.coords }], net3);
  check('a split road: both halves get the edit', ['way/2#0', 'way/2#1'].every((i) => halves.get(victim.id)!.includes(i)), JSON.stringify(halves.get(victim.id)));
  // Same ID but moved 60 m away (a different road now): don't keep it blindly.
  const shifted = all.map((s) => (s.id === victim.id ? { ...s, coords: s.coords.map(([a, b]) => [a + 0.0006, b] as [number, number]) } : s));
  const net4 = new RoadNetwork();
  net4.add(shifted);
  const sh = migrateEdits([{ id: victim.id, shape: victim.coords }], net4);
  check('same ID somewhere else: not kept', !sh.get(victim.id)!.includes(victim.id));
  // Road removed from OSM.
  const net5 = new RoadNetwork();
  net5.add(all.filter((s) => s.id !== victim.id));
  const gone = migrateEdits([{ id: victim.id, shape: victim.coords }], net5);
  check('a removed road: nothing to move to (crossing roads not grabbed)', gone.get(victim.id)!.length === 0, JSON.stringify(gone.get(victim.id)));
  // Real neighbours never pick up an edit they don't lie along.
  const wrong = pick.filter((s) => same.get(s.id)!.length !== 1);
  check('no neighbouring road wrongly included', wrong.length === 0);

  console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
})();
