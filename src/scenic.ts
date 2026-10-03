// Scenic drives (v0.21): famous routes (Wild Atlantic Way, Sally Gap...)
// from each region's scenic.json, and how much of each you've driven. A
// drive is complete once every road on it is driven (all or nothing; the
// data can loosen that per drive with `need`). Roads you've marked private
// or gone don't count against you. Pure logic, so it can be tested.

import type { Coord } from './geo';

export type ScenicDrive = {
  id: string;
  region: string;
  name: string;
  where: string;
  blurb: string;
  need: number; // share of the route that completes it
  meters: number;
  box: [number, number, number, number]; // south, west, north, east
  pieces: Map<string, number>; // road piece id -> its length (m)
  lines: Coord[][]; // the route, simplified, for the map
};

const SCALE = 100000;

function decodeLine(flat: number[]): Coord[] {
  const out: Coord[] = [];
  let la = 0;
  let lo = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    la = i === 0 ? flat[0] : la + flat[i];
    lo = i === 0 ? flat[1] : lo + flat[i + 1];
    out.push([la / SCALE, lo / SCALE]);
  }
  return out;
}

/** A region's scenic.json, read. Anything malformed is skipped. */
export function parseScenic(json: any, region: string): ScenicDrive[] {
  if (!json || json.v !== 1 || !Array.isArray(json.drives)) return [];
  const out: ScenicDrive[] = [];
  for (const d of json.drives) {
    if (!d || typeof d.id !== 'string' || !Array.isArray(d.pieces)) continue;
    const pieces = new Map<string, number>();
    for (const row of d.pieces as number[][]) {
      if (!Array.isArray(row) || row.length < 3) continue;
      for (let i = 1; i + 1 < row.length; i += 2) pieces.set(`way/${row[0]}#${row[i]}`, row[i + 1]);
    }
    if (!pieces.size) continue;
    out.push({
      id: d.id,
      region,
      name: String(d.name ?? d.id),
      where: String(d.where ?? ''),
      blurb: String(d.blurb ?? ''),
      need: typeof d.need === 'number' && d.need > 0 && d.need <= 1 ? d.need : 1,
      meters: [...pieces.values()].reduce((a, b) => a + b, 0),
      box: Array.isArray(d.box) && d.box.length === 4 ? (d.box as [number, number, number, number]) : [0, 0, 0, 0],
      pieces,
      lines: Array.isArray(d.lines) ? (d.lines as number[][]).map(decodeLine).filter((l) => l.length >= 2) : [],
    });
  }
  return out;
}

export type ScenicProgress = { id: string; driven: number; total: number; percent: number; done: boolean };

/**
 * How much of a drive you've done. `drivenOf(id)` is how many metres of a
 * road piece you've driven (the whole piece, part of it, or none);
 * `excluded` holds pieces marked private or gone.
 */
export function scenicProgress(drive: ScenicDrive, drivenOf: (id: string, length: number) => number, excluded: Set<string>): ScenicProgress {
  let total = 0;
  let driven = 0;
  drive.pieces.forEach((len, id) => {
    if (excluded.has(id)) return;
    total += len;
    driven += Math.min(len, Math.max(0, drivenOf(id, len)));
  });
  const percent = total > 0 ? (driven / total) * 100 : 0;
  // A metre or so per piece is rounding in the data, not road left to drive.
  const done = total > 0 && driven >= total * drive.need - Math.min(drive.pieces.size, 50);
  return { id: drive.id, driven, total, percent: done ? 100 : Math.min(percent, 99.99), done };
}

/**
 * Metres driven of each piece from the driven road ids: a whole piece
 * ("way/1#0"), or parts of one ("way/1#0~0-55", lengths from `lengthOf`).
 */
export function drivenMeters(drivenIds: Iterable<string>, lengthOf: (id: string) => number | undefined): (id: string, length: number) => number {
  const whole = new Set<string>();
  const parts = new Map<string, number>();
  for (const id of drivenIds) {
    const t = id.indexOf('~');
    if (t < 0) whole.add(id);
    else {
      const base = id.slice(0, t);
      parts.set(base, (parts.get(base) ?? 0) + (lengthOf(id) ?? 0));
    }
  }
  return (id, length) => (whole.has(id) ? length : Math.min(length, parts.get(id) ?? 0));
}
