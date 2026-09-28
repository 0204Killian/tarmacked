import { RoadNetwork, RoadSegment } from '../src/roadMatcher';
import { recheckDrives } from '../src/recheck';
import { metersPerDegLon, METERS_PER_DEG_LAT, Coord } from '../src/geo';
const LAT0 = 52.8, LON0 = -7.3, mLon = metersPerDegLon(LAT0);
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
const ll = (x: number, y: number): Coord => [r5(LAT0 + y / METERS_PER_DEG_LAT), r5(LON0 + x / mLon)];
const segs: RoadSegment[] = [];
let w = 0;
for (let k = 0; k <= 10000; k += 200) {
  for (const vertical of [true, false]) {
    w++;
    const pts: Coord[] = [];
    for (let s = 0; s <= 10000; s += 20) pts.push(vertical ? ll(k, s) : ll(s, k));
    for (let i = 0, c = 0; i < pts.length - 1; i += 5, c++) segs.push({ id: `way/${w}#${c}`, coords: pts.slice(i, i + 6) });
  }
}
const t0 = Date.now();
const net = new RoadNetwork(); net.add(segs);
console.log(`network: ${segs.length} chunks built in ${Date.now() - t0}ms`);
const drives = [];
for (let d = 0; d < 10; d++) {
  const pts = []; let x = 0, y = (d * 1000) % 10000, t = d * 1e7;
  for (let i = 0; i < 1800; i++) { x = (x + 25) % 10000; const [la, lo] = ll(x + Math.random() * 6, y + Math.random() * 6); pts.push({ latitude: la, longitude: lo, timestamp: t }); t += 2000; }
  drives.push({ id: d, startedAt: d * 1e7, points: pts });
}
(async () => {
  const t1 = Date.now();
  const r = await recheckDrives(net, drives, new Map(), new Set(), new Map());
  console.log(`re-check of 10 one-hour drives (18k points): ${Date.now() - t1}ms, ${r.driven.size} chunks`);
})();
