// Road data tiles (v0.17): where they come from and how they're read.
//
// tiles.tarmacked.com (Cloudflare R2) holds a manifest saying which version
// of each region is current, and a folder per version:
//   manifest.json
//   ie/<version>/index.json         every tile, and the tiles of each county
//   ie/<version>/stats.json         road totals per county
//   ie/<version>/t_<a>_<b>.json     road pieces, compact format (v2)
// A version never changes once uploaded, so tiles can be cached forever;
// a data refresh is a new version, picked up through the manifest. Other
// countries (v0.21) are more regions next to ie/, same layout.

import type { RoadSegment } from './roadMatcher';

export const TILE_HOST = 'https://tiles.tarmacked.com/';
export type RegionEntry = {
  version: string;
  path: string;
  tiles: number;
  name?: string;
  num?: number; // v0.21: area codes are num * 1000 + index
  country?: string; // v0.21: ISO code its areas mostly belong to
  bbox?: number[] | null;
  cells?: string[] | null; // 1-degree squares with roads ("53,-8")
};
export type Manifest = { v: number; regions: Record<string, RegionEntry> };
export type TileIndex = { v: number; region: string; version: string; tiles: string[]; counties: Record<string, string[]>; classes: string[] };

// Road types, in the order the pipeline numbers them (scripts/pipeline/lib.js).
export const ROAD_CLASSES = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street',
];

const SCALE = 100000;

/**
 * Road pieces from a tile file. Reads the compact v2 format:
 *   { v: 2, names: [...], s: [[way, n, flags, county, name, class, speed, lat0, lon0, dlat, dlon, ...]] }
 * (flags: 1 one-way forward, 2 one-way reverse, 4 roundabout, 8 toll, 16
 * unpaved), and the old { segments: [...] } format too. `areaOffset`
 * makes area codes unique across regions (src/areas.ts).
 */
export function decodeTile(data: any, areaOffset = 0): RoadSegment[] {
  if (!data) return [];
  if (Array.isArray(data.segments)) return data.segments as RoadSegment[];
  if (data.v !== 2 || !Array.isArray(data.s)) return [];
  const names: string[] = Array.isArray(data.names) ? data.names : [];
  const out: RoadSegment[] = [];
  for (const row of data.s as number[][]) {
    if (!Array.isArray(row) || row.length < 11) continue;
    const [way, idx, flags, county, name, cls, speed] = row;
    const coords: [number, number][] = [];
    let la = 0;
    let lo = 0;
    for (let i = 7; i + 1 < row.length; i += 2) {
      la = i === 7 ? row[i] : la + row[i];
      lo = i === 7 ? row[i + 1] : lo + row[i + 1];
      coords.push([la / SCALE, lo / SCALE]);
    }
    const seg: RoadSegment = { id: `way/${way}#${idx}`, coords };
    if (flags & 1) seg.o = 1;
    else if (flags & 2) seg.o = -1;
    if (flags & 4) seg.r = 1;
    if (flags & 8) seg.t = 1; // toll (v0.19 data)
    if (flags & 16) seg.u = 1; // unpaved (v0.19 data)
    if (county >= 0) seg.c = areaOffset + county;
    if (name >= 0 && names[name]) seg.n = names[name];
    if (cls >= 0) seg.h = cls;
    if (speed > 0) seg.sp = speed;
    out.push(seg);
  }
  return out;
}

