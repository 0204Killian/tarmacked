// Scenic drives on the phone (src/scenic.ts).
//   npx tsx test/scenic.test.ts
import { parseScenic, scenicProgress, drivenMeters } from '../src/scenic';

const results: boolean[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`);
};

const json = {
  v: 1,
  drives: [
    { id: 'sally', name: 'Sally Gap', where: 'Wicklow', blurb: 'x', need: 1, m: 600, box: [53, -6.4, 53.2, -6.2], pieces: [[1, 0, 100, 1, 200], [2, 0, 300]], lines: [[5313000, -630000, 100, 100, 50, 50]] },
    { id: 'broken', pieces: [] },
    { id: 'loose', name: 'Loose', need: 0.9, pieces: [[3, 0, 1000]] },
  ],
};
const drives = parseScenic(json, 'ie');
const sally = drives.find((d) => d.id === 'sally')!;
check('drives read, broken ones skipped', drives.map((d) => d.id).join() === 'sally,loose' && sally.meters === 600 && sally.pieces.get('way/1#1') === 200);
check('route line decoded', sally.lines[0].length === 3 && Math.abs(sally.lines[0][2][0] - 53.1315) < 1e-9);
check('old or unknown files ignored', parseScenic({ v: 2, drives: [] }, 'ie').length === 0 && parseScenic(null, 'ie').length === 0);

const len = new Map([['way/2#0~0-150', 150]]);
let p = scenicProgress(sally, drivenMeters(['way/1#0', 'way/2#0~0-150'], (id) => len.get(id)), new Set());
check('progress counts whole pieces and parts of pieces', Math.abs(p.percent - (250 / 600) * 100) < 1e-9 && !p.done, `${p.percent}`);
p = scenicProgress(sally, drivenMeters(['way/1#0', 'way/1#1'], () => 0), new Set(['way/2#0']));
check('a road marked private or gone doesn\'t count against you', p.done && p.percent === 100 && p.total === 300);
p = scenicProgress(sally, drivenMeters(['way/1#0', 'way/1#1', 'way/2#0~0-299'], () => 299), new Set());
check('all or nothing: 99.8% isn\'t done... unless it\'s just rounding (under a metre a piece)', !scenicProgress(sally, drivenMeters(['way/1#0', 'way/1#1', 'way/2#0~0-250'], () => 250), new Set()).done && p.done);
const loose = drives.find((d) => d.id === 'loose')!;
check('a drive the data marks as 90% needed', scenicProgress(loose, drivenMeters(['way/3#0~0-900'], () => 900), new Set()).done);

console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
