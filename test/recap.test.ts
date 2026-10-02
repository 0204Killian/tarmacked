// Drive recap figures and the little map (src/recap.ts).
//   npx tsx test/recap.test.ts
import { driveGains, formatGain, fitPaths } from '../src/recap';

const results: boolean[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`);
};

const totals = { counties: ['County A', 'County B', 'County C'], totalMeters: [100_000, 1_000_000, 50_000], nationalMeters: 1_150_000 };

const g = driveGains(
  [
    { lengthM: 500, county: 1 },
    { lengthM: 700, county: 1 },
    { lengthM: 1000, county: 0 },
    { lengthM: 300, county: null },
  ],
  totals
);
check('county with the most new road is shown', g.county === 'County B', JSON.stringify(g));
check('county gain = new road there / county total', Math.abs(g.countyGain! - 0.12) < 1e-9);
check('national gain counts every piece', Math.abs(g.nationalGain! - (2500 / 1_150_000) * 100) < 1e-9);
check('no new road: nothing to show', driveGains([], totals).county === null);
check('no totals yet (offline first run): nothing to show', driveGains([{ lengthM: 5, county: 0 }], null).countyGain === null);
check('county codes outside the list ignored', driveGains([{ lengthM: 5, county: 99 }], totals).county === null);

check('gains readable at every size', [formatGain(2.345), formatGain(0.2149), formatGain(0.0123), formatGain(0.00042), formatGain(0)].join(' ') === '+2.3% +0.21% +0.012% +0.0004% +0%', [formatGain(2.345), formatGain(0.2149), formatGain(0.0123), formatGain(0.00042), formatGain(0)].join(' '));

// A drive 10 km east–west and 1 km north–south fits the width, centred.
const line: [number, number][] = [
  [52.5, -7.8],
  [52.509, -7.652],
];
const [[p]] = fitPaths([[line]], 300, 190, 14);
const nums = p.match(/-?\d+(\.\d+)?/g)!.map(Number);
const [x0, y0, x1, y1] = nums;
check('fills the width', Math.abs(x0 - 14) < 0.2 && Math.abs(x1 - 286) < 0.2, p);
check('north is up', y1 < y0);
check('centred top to bottom', Math.abs((y0 + y1) / 2 - 95) < 0.2);
check('true proportions (not stretched to fill the height)', Math.abs((y0 - y1) / (x1 - x0) - (0.009 * 111320) / (0.148 * 111320 * Math.cos((52.5045 * Math.PI) / 180))) < 0.01);
// A tiny drive isn't blown up to fill the card.
const [[q]] = fitPaths([[[[52.5, -7.8], [52.5001, -7.8]]]], 300, 190, 14);
const qy = q.match(/-?\d+(\.\d+)?/g)!.map(Number);
check('very short drives stay small', Math.abs(qy[1] - qy[3]) < 50, q);
check('no roads: no paths', fitPaths([[], []], 300, 190).every((x) => x.length === 0));

console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
