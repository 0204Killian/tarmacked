// Motorway slip roads that run alongside the carriageway before curving off.
// Driving past must not credit the slip (or lose the motorway); really
// taking the exit must credit it.
import { RoadNetwork, RoadSegment } from '../src/roadMatcher';
import { DriveMatcher, Point } from '../src/coverage';
import { metersPerDegLon, METERS_PER_DEG_LAT, Coord } from '../src/geo';

const LAT0 = 53.0, LON0 = -7.3, mLon = metersPerDegLon(LAT0);
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
const ll = (x: number, y: number): Coord => [r5(LAT0 + y / METERS_PER_DEG_LAT), r5(LON0 + x / mLon)];

function chunked(id: number, pts: Coord[]): RoadSegment[] {
  const out: RoadSegment[] = [];
  for (let i = 0, c = 0; i < pts.length - 1; i += 10, c++) out.push({ id: `way/${id}#${c}`, coords: pts.slice(i, i + 11), o: 1 });
  return out;
}

let seed = 3;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// Main carriageway x=0 northbound. The slip leaves at y=200, widens to `off`
// metres over 100 m, runs alongside for 400 m, then curves away.
function network(off: number) {
  const main: Coord[] = [];
  for (let y = 0; y <= 1000; y += 10) main.push(ll(0, y));
  const slip: Coord[] = [];
  for (let y = 200; y <= 900; y += 10) {
    const d = y < 300 ? (off * (y - 200)) / 100 : y < 700 ? off : off + ((y - 700) / 200) ** 2 * 80;
    slip.push(ll(d, y));
  }
  const net = new RoadNetwork();
  net.add([...chunked(1, main), ...chunked(70, slip)]);
  return { net, slip };
}

const sectionsOf = (net: RoadNetwork, prefix: string, maxIdx: number) =>
  [...net.segs.keys()].filter((i) => i.startsWith(prefix) && Number(i.split('#')[1]) <= maxIdx).flatMap((i) => net.sections(i).map((s) => s.id));

export function runSlipTests(): boolean {
  let all = true;
  for (const off of [8, 12, 20]) {
    for (const lane of [4, 7]) {
      // lane = how far the car drives from the motorway's centre line, toward the slip
      const { net } = network(off);
      let slipCredited = 0, motorwayMissed = 0;
      for (let k = 0; k < 40; k++) {
        seed = 100 + k;
        const m = new DriveMatcher(net, new Set());
        const got = new Set<string>();
        for (let y = 0, t = 0; y <= 1000; y += 60, t += 2000) {
          const c = ll(lane + g() * 5, y + g() * 5);
          m.feed([{ latitude: c[0], longitude: c[1], timestamp: t }]).completed.forEach((i) => got.add(i));
        }
        m.finish().forEach((i) => got.add(i));
        if ([...got].some((i) => i.startsWith('way/70'))) slipCredited++;
        if (sectionsOf(net, 'way/1#', 8).some((i) => !got.has(i))) motorwayMissed++;
      }
      const ok = slipCredited === 0 && motorwayMissed <= 1;
      console.log(`${ok ? 'PASS' : 'FAIL'}  driving past a slip ${off} m away (car ${lane} m toward it): slip credited ${slipCredited}/40, motorway partly missed ${motorwayMissed}/40`);
      all = ok && all;
    }
    // Taking the exit.
    const { net, slip } = network(off);
    let took = 0, wrong = 0;
    for (let k = 0; k < 40; k++) {
      seed = 500 + k;
      const m = new DriveMatcher(net, new Set());
      const got = new Set<string>();
      let t = 0;
      const feed = (p: Point) => m.feed([p]).completed.forEach((i) => got.add(i));
      for (let y = 0; y < 200; y += 60, t += 2000) {
        const c = ll(4 + g() * 5, y + g() * 5);
        feed({ latitude: c[0], longitude: c[1], timestamp: t });
      }
      for (let i = 0; i < slip.length; i += 6, t += 2000) {
        const [la, lo] = slip[i];
        feed({ latitude: la + (g() * 5) / METERS_PER_DEG_LAT, longitude: lo + (g() * 5) / mLon, timestamp: t });
      }
      m.finish().forEach((i) => got.add(i));
      if (sectionsOf(net, 'way/70#', 5).every((i) => got.has(i))) took++;
      if ([...got].some((i) => /^way\/1#[4-9]/.test(i))) wrong++;
    }
    const ok = took === 40 && wrong === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  taking the exit (slip ${off} m away): slip credited ${took}/40, motorway beyond the exit wrongly credited ${wrong}/40`);
    all = ok && all;
  }
  return all;
}
