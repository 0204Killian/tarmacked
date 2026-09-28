// Heatmap: how many drives covered each road, as colours and a
// most-driven roads list. Pure logic, so it can be tested on its own.

import { RoadNetwork, baseChunkId, parseChunkId } from './roadMatcher';

// Green -> yellow -> orange -> red.
const STOPS: [number, [number, number, number]][] = [
  [0, [0x39, 0xd3, 0x53]],
  [0.4, [0xf5, 0xd9, 0x0a]],
  [0.7, [0xff, 0x8c, 0x1a]],
  [1, [0xe5, 0x33, 0x2a]],
];
export const HEAT_STEPS = 12; // colours actually drawn (keeps map lines few)

const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');

// t in 0..1 along the gradient.
export function heatColorAt(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    const [t0, c0] = STOPS[i - 1];
    if (x <= t1) {
      const f = (x - t0) / (t1 - t0);
      return `#${hex(c0[0] + (c1[0] - c0[0]) * f)}${hex(c0[1] + (c1[1] - c0[1]) * f)}${hex(c0[2] + (c1[2] - c0[2]) * f)}`;
    }
  }
  return '#e5332a';
}

// Where a drive count sits on the scale, 0..1. Log scale, so one road
// driven 200 times (outside home) doesn't turn everything else green.
export function heatT(count: number, max: number): number {
  if (max <= 1 || count <= 1) return 0;
  return Math.log(Math.min(count, max)) / Math.log(max);
}

// Snapped to one of HEAT_STEPS colours (0..HEAT_STEPS-1).
export function heatStep(count: number, max: number): number {
  return Math.round(heatT(count, max) * (HEAT_STEPS - 1));
}
export const stepColor = (step: number) => heatColorAt(step / (HEAT_STEPS - 1));

export type RoadRank = {
  key: string;
  name: string; // "N77 Kilkenny Road", or "Unnamed road"
  county: number | null;
  count: number; // drives on its most-driven bit
  hotChunks: string[]; // chunks at that count (the most-driven bit)
  hotM: number; // length of the most-driven bit
};

/**
 * Most-driven roads. Roads are grouped by name within a county (unnamed
 * roads by their OSM way); each road's figure is its most-driven bit.
 * Only chunks whose road data is downloaded can be named and placed.
 */
export function rankRoads(net: RoadNetwork, counts: Map<string, number>, limit = 30): RoadRank[] {
  const groups = new Map<string, RoadRank>();
  counts.forEach((count, id) => {
    if (count <= 0) return;
    const base = baseChunkId(id);
    const seg = net.segs.get(base);
    if (!seg) return;
    const name = seg.n ?? null;
    const way = parseChunkId(base)?.way ?? base;
    const county = seg.c ?? null;
    const key = name ? `${name}|${county ?? ''}` : way;
    let g = groups.get(key);
    if (!g) {
      g = { key, name: name ?? 'Unnamed road', county, count: 0, hotChunks: [], hotM: 0 };
      groups.set(key, g);
    }
    const len = net.length(base);
    if (count > g.count) {
      g.count = count;
      g.hotChunks = [base];
      g.hotM = len;
    } else if (count === g.count) {
      g.hotChunks.push(base);
      g.hotM += len;
    }
  });
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count || b.hotM - a.hotM)
    .slice(0, limit);
}
