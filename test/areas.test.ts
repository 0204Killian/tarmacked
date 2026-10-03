// Areas, countries and badges across road-data regions (src/areas.ts).
//   npx tsx test/areas.test.ts
import { regionStatsFrom, buildBook, figures, byCompletion, badgeFor, nextBadge, areaCode, regionNumOf, countryName } from '../src/areas';

const results: boolean[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`);
};

const names32 = Array.from({ length: 32 }, (_, i) => (i < 26 ? `County R${i}` : `County N${i}`));
const meters32 = names32.map(() => 1000);

// Ireland's live stats before v0.21: areas, but no countries.
const ie = regionStatsFrom({ counties: names32.slice(0, 26), totalMeters: meters32.slice(0, 26), areas: names32, areaMeters: meters32 }, 'ie', 0, 'IE')!;
check('old Ireland data: Republic counts for Ireland, Northern Ireland for the UK', ie.countries[0] === 'IE' && ie.countries[25] === 'IE' && ie.countries[26] === 'GB' && ie.names.length === 32);
// Even older: only the Republic's counties.
const old = regionStatsFrom({ counties: ['County Cork'], totalMeters: [500], nationalMeters: 500 }, 'ie', 0, 'IE')!;
check('oldest data (26 counties only) still reads', old.names.join() === 'County Cork' && old.countries.join() === 'IE');
// New data from the v0.21 pipeline.
const gb = regionStatsFrom({ areas: ['Kent', 'Fife'], areaMeters: [4000, 2000], areaCountry: ['GB', 'GB'], num: 1 }, 'gb', 1, 'GB')!;
check('new data: countries and region number from the file', gb.num === 1 && gb.countries.join() === 'GB,GB');
check('broken stats ignored', regionStatsFrom({ areas: ['A'], areaMeters: [1, 2] }, 'xx', 5, 'XX') === null && regionStatsFrom(null, 'xx', 5, 'XX') === null);

const book = buildBook([ie, gb]);
check('area codes unique across regions', book.areas.get(areaCode(1, 0))?.name === 'Kent' && book.areas.get(26)?.name === 'County N26' && regionNumOf(1001) === 1);
check('the UK adds up across two regions (Northern Ireland + Great Britain)', book.countries.get('GB')!.meters === 6 * 1000 + 6000 && book.countries.get('IE')!.meters === 26 * 1000);
check('country names', countryName('GB') === 'United Kingdom' && countryName('IE') === 'Ireland' && countryName('ZZ') === 'ZZ');

const driven = new Map<number, number>([[0, 500], [26, 1000], [1000, 1000]]);
const excluded = new Map<number, number>([[0, 500]]); // half of County R0 is private
const f = figures(book, driven, excluded);
const r0 = f.areas.find((a) => a.code === 0)!;
check('private/gone roads come off the total (100% reachable)', r0.total === 500 && r0.percent === 100);
const uk = f.countries.find((c) => c.iso === 'GB')!;
check('country figures from their areas', uk.driven === 2000 && uk.total === 12000 && Math.abs(uk.percent - (2000 / 12000) * 100) < 1e-9);
const empty = figures(buildBook([{ id: 'ie', num: 0, names: ['County Gone'], meters: [0], countries: ['IE'] }]), new Map(), new Map());
check('areas with no road (no boundary in the data) left out', empty.areas.length === 0);
const sorted = byCompletion(f.areas);
check('sorted by completion', sorted[0].percent >= sorted[1].percent && sorted[sorted.length - 1].percent === 0);

// Badges.
const at = (percent: number) => ({ percent, driven: percent * 1000, total: 100_000 });
check('no badge under 10%', badgeFor(at(9.99)) === null);
check('bronze, silver, gold', badgeFor(at(10))?.badge === 'bronze' && badgeFor(at(30))?.badge === 'silver' && badgeFor(at(99.99))?.badge === 'gold');
check('platinum only with every road (not 99.999% rounded up)', badgeFor(at(100))?.badge === 'platinum' && badgeFor({ percent: 99.999, driven: 99_999, total: 100_001 })?.badge === 'gold');
check('next badge and how far off', nextBadge(at(12))?.badge.badge === 'silver' && Math.abs(nextBadge(at(12))!.toGo - 18) < 1e-9 && nextBadge(at(100)) === null);

console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
