// Offline place search (src/places.ts) and the sat-nav data loader (src/routeData.ts).
//   npx tsx test/places.test.ts
import { Places, fold } from '../src/places';
import { RouteData, regionsFor } from '../src/routeData';

const results: boolean[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`);
};

const kinds = ['city', 'town', 'village', 'suburb', 'hamlet', 'neighbourhood', 'locality', 'isolated_dwelling'];
const file = {
  kinds,
  places: [
    ['Kilkenny', 52.6541, -7.2448, 0],
    ['Kilkenny West', 53.47, -7.85, 6],
    ['Kilcock', 53.4, -6.67, 1],
    ['Ballyragget', 52.7883, -7.3317, 1],
    ['Durrow', 52.8456, -7.3953, 2],
    ['Durrow', 53.33, -7.53, 4],
    ["Muine Bheag", 52.6967, -6.9592, 1],
    ['Dún Laoghaire', 53.2945, -6.1339, 1],
    ["Bennett's Bridge", 52.5939, -7.1847, 2],
  ] as [string, number, number, number][],
};
const p = new Places();
p.add('ie', file);
p.add('ie', file); // twice: ignored
check('a region is only added once', p.size === file.places.length);
check('fadas and apostrophes folded', fold('Dún Laoghaire') === 'dun laoghaire' && fold("Bennett's Bridge") === 'bennetts bridge');
const home: [number, number] = [52.75, -7.3];
const k = p.search('kilk', home);
check('prefix search, the city first', k[0]?.name === 'Kilkenny' && k.some((x) => x.name === 'Kilkenny West'), k.map((x) => `${x.name} (${x.subtitle})`).join(' · '));
check('typed without the fada', p.search('dun laog', home)[0]?.name === 'Dún Laoghaire');
check('any word of the name', p.search('bheag', home)[0]?.name === 'Muine Bheag' && p.search('bennetts', home)[0]?.name === "Bennett's Bridge");
const d = p.search('durrow', home);
check('two places with one name: both, the nearer village first', d.length === 2 && d[0].lat === 52.8456, d.map((x) => x.subtitle).join(' · '));
check('one letter: nothing yet', p.search('k', home).length === 0);
const n = p.nearest([52.79, -7.335]);
check('a dropped pin is named after the nearest town', n?.name === 'Ballyragget' && n.km < 1, JSON.stringify(n));
check('nothing near: no name', p.nearest([54.5, -9.9]) === null);

// Which countries' data a trip needs.
{
  // Squares with roads, roughly: Ireland, Britain, northern France, western Germany.
  const sq = (la0: number, la1: number, lo0: number, lo1: number) => {
    const out: string[] = [];
    for (let a = la0; a <= la1; a++) for (let b = lo0; b <= lo1; b++) out.push(`${a},${b}`);
    return out;
  };
  const all = [
    { id: 'ie', version: 'a', base: '', cells: sq(51, 55, -11, -6) },
    { id: 'gb', version: 'a', base: '', cells: [...sq(50, 52, -6, 1), ...sq(53, 55, -4, 0), ...sq(56, 58, -6, -2)] },
    { id: 'fr', version: 'a', base: '', cells: sq(43, 50, -5, 7) },
    { id: 'de', version: 'a', base: '', cells: sq(47, 54, 6, 14) },
  ];
  const ids = (pts: [number, number][]) => regionsFor(all, pts).map((r) => r.id).join();
  check('regions: home only for a trip at home', ids([[52.65, -7.25], [53.35, -6.26]]) === 'ie');
  check('regions: Kilkenny to Paris takes in Britain and France, not Germany', ids([[52.65, -7.25], [48.86, 2.35]]) === 'ie,gb,fr', ids([[52.65, -7.25], [48.86, 2.35]]));
  check('regions: old road data (no boxes) = Ireland', regionsFor([{ id: 'ie', version: 'a', base: '' }], [[48.86, 2.35]]).map((r) => r.id).join() === 'ie');
}

// The loader: downloads once per version, then from the phone; old files removed.
(async () => {
  const files = new Map<string, string>();
  const fetched: string[] = [];
  let online = true;
  const graph = { v: 1, region: 'ie', version: 'a', classes: ['tertiary'], names: [], nodes: [5265410, -724480, 10, 10], edges: [[0, 1, 1, 0, 0, 0, 15, 0, 0, -1]] };
  const served: Record<string, string> = {
    'https://x/ie/a/graph.json': JSON.stringify(graph),
    'https://x/ie/a/restrictions.json': JSON.stringify({ kinds: ['no_left_turn'], r: [] }),
    'https://x/ie/a/places.json': JSON.stringify(file),
  };
  let deleted: string[] = [];
  const rd = new RouteData({
    fetchText: async (url) => {
      fetched.push(url);
      if (!online) return { ok: false, missing: false };
      return served[url] ? { ok: true, text: served[url] } : { ok: false, missing: true };
    },
    readFile: async (name) => files.get(name) ?? null,
    writeFile: async (name, text) => {
      files.set(name, text);
    },
    deleteFiles: async (keep) => {
      deleted = [...files.keys()].filter((f) => !keep.includes(f));
      deleted.forEach((f) => files.delete(f));
    },
  });
  files.set('nav-ie-old-graph.json', '{}');
  const regions = [{ id: 'ie', version: 'a', base: 'https://x/ie/a/' }];
  const a = await rd.load(regions);
  check('first time: downloaded and kept', a.graph.edgeCount === 1 && a.places.size === file.places.length && files.size === 3 && fetched.length === 3 && deleted.join() === 'nav-ie-old-graph.json');
  const b = await rd.load(regions);
  check('again: from memory, no downloads', b === a && fetched.length === 3);
  rd.reset();
  online = false;
  const c = await rd.load(regions);
  check('after a restart, offline: from the phone', c.graph.edgeCount === 1 && c.places.size > 0 && fetched.length === 3);
  // Road data without a graph (older version): places still work, no retrying the 404.
  online = true;
  const regions2 = [{ id: 'ie', version: 'b', base: 'https://x/ie/b/' }];
  served['https://x/ie/b/places.json'] = served['https://x/ie/a/places.json'];
  const e = await rd.load(regions2);
  const before = fetched.length;
  await rd.load(regions2);
  check('road data without a graph: places only, not asked for again', e.withGraph.length === 0 && e.places.size > 0 && !e.retry && fetched.length === before);
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
})();
