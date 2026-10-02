// The drive recap (v0.17): figures for the card shown after a drive, and
// the little map on it. Pure functions, so they can be tested on their own.

import { Coord, METERS_PER_DEG_LAT, metersPerDegLon } from './geo';

export type Recap = {
  driveId: number;
  startedAt: number;
  endedAt: number;
  distanceM: number;
  newM: number;
  newShapes: Coord[][]; // roads driven for the first time (green)
  oldShapes: Coord[][]; // roads driven before (grey)
  county: string | null; // the county with the most new road this drive
  countyGain: number | null; // percentage points of that county gained
  nationalGain: number | null; // percentage points of the whole country gained
};

export type Totals = { counties: string[]; totalMeters: number[]; nationalMeters: number };

/**
 * How much of a county and of the country this drive added: the new road
 * per county, over that county's total. The county shown is the one with
 * the most new road.
 */
export function driveGains(
  fresh: { lengthM: number; county: number | null }[],
  totals: Totals | null
): { county: string | null; countyGain: number | null; nationalGain: number | null } {
  if (!totals || fresh.length === 0) return { county: null, countyGain: null, nationalGain: null };
  const per = new Map<number, number>();
  let all = 0;
  for (const f of fresh) {
    all += f.lengthM;
    if (f.county !== null && f.county >= 0 && f.county < totals.counties.length) per.set(f.county, (per.get(f.county) ?? 0) + f.lengthM);
  }
  let best: number | null = null;
  per.forEach((m, c) => {
    if (best === null || m > per.get(best)!) best = c;
  });
  const nationalGain = totals.nationalMeters > 0 ? (all / totals.nationalMeters) * 100 : null;
  if (best === null) return { county: null, countyGain: null, nationalGain };
  const total = totals.totalMeters[best];
  return { county: totals.counties[best], countyGain: total > 0 ? (per.get(best)! / total) * 100 : null, nationalGain };
}

/** "+0.21%" with enough decimals that a short drive doesn't show as 0. */
export function formatGain(pct: number): string {
  if (pct <= 0) return '+0%';
  const decimals = pct >= 1 ? 1 : pct >= 0.1 ? 2 : pct >= 0.01 ? 3 : 4;
  const s = pct.toFixed(decimals);
  return Number(s) === 0 ? '+<0.0001%' : `+${s}%`;
}

/**
 * SVG paths for the recap map: every line fitted into w × h with some
 * padding, north up, keeping real proportions (a long east–west drive
 * comes out wide, not squashed).
 */
export function fitPaths(groups: Coord[][][], w: number, h: number, pad = 14): string[][] {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const g of groups)
    for (const line of g)
      for (const [la, lo] of line) {
        if (la < minLat) minLat = la;
        if (la > maxLat) maxLat = la;
        if (lo < minLon) minLon = lo;
        if (lo > maxLon) maxLon = lo;
      }
  if (!Number.isFinite(minLat)) return groups.map(() => []);
  const midLat = (minLat + maxLat) / 2;
  const kx = metersPerDegLon(midLat);
  const ky = METERS_PER_DEG_LAT;
  const spanX = Math.max((maxLon - minLon) * kx, 50); // at least 50 m across
  const spanY = Math.max((maxLat - minLat) * ky, 50);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const offX = (w - spanX * scale) / 2 - ((maxLon - minLon) * kx - spanX) * scale * 0.5;
  const offY = (h - spanY * scale) / 2 - ((maxLat - minLat) * ky - spanY) * scale * 0.5;
  const x = (lo: number) => offX + (lo - minLon) * kx * scale;
  const y = (la: number) => offY + (maxLat - la) * ky * scale;
  return groups.map((g) =>
    g
      .filter((line) => line.length >= 2)
      .map((line) => line.map(([la, lo], i) => `${i ? 'L' : 'M'}${x(lo).toFixed(1)} ${y(la).toFixed(1)}`).join(''))
  );
}
