// Driven roads as a few long map lines instead of thousands of 100 m pieces.
import { Coord } from './geo';
import { parseChunkId } from './roadMatcher';

export type Chain = { coords: Coord[]; minLat: number; maxLat: number; minLon: number; maxLon: number };

// Joins driven chunks of the same road into continuous lines, so the map
// draws a few long lines instead of thousands of 100m pieces.
export function buildChains(ids: Iterable<string>, shapeOf: (id: string) => Coord[] | undefined): Chain[] {
  const byWay = new Map<string, { idx: number; coords: Coord[] }[]>();
  const loose: Coord[][] = [];
  for (const id of ids) {
    const coords = shapeOf(id);
    if (!coords || coords.length < 2) continue;
    const p = parseChunkId(id);
    if (!p) {
      loose.push(coords);
      continue;
    }
    const list = byWay.get(p.way);
    if (list) list.push({ idx: p.idx, coords });
    else byWay.set(p.way, [{ idx: p.idx, coords }]);
  }
  const lines: Coord[][] = [...loose];
  byWay.forEach((parts) => {
    parts.sort((a, b) => a.idx - b.idx);
    let cur = parts[0].coords.slice();
    for (let i = 1; i < parts.length; i++) {
      const prevEnd = cur[cur.length - 1];
      const next = parts[i].coords;
      if (parts[i].idx === parts[i - 1].idx + 1 && prevEnd[0] === next[0][0] && prevEnd[1] === next[0][1]) {
        cur.push(...next.slice(1));
      } else {
        lines.push(cur);
        cur = next.slice();
      }
    }
    lines.push(cur);
  });
  return stitchLines(lines).map((coords) => {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [la, lo] of coords) {
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
    }
    return { coords, minLat, maxLat, minLon, maxLon };
  });
}

// Joins lines end to end wherever exactly two of them meet (e.g. where one
// road continues as another, or around a roundabout), so the map draws one
// smooth line instead of separate pieces with visible joins.
export function stitchLines(input: Coord[][]): Coord[][] {
  let lines = input.filter((l) => l.length >= 2);
  const key = (c: Coord) => `${c[0]},${c[1]}`;
  for (let pass = 0; pass < 50; pass++) {
    const ends = new Map<string, { i: number; atStart: boolean }[]>();
    lines.forEach((l, i) => {
      for (const [c, atStart] of [[l[0], true], [l[l.length - 1], false]] as [Coord, boolean][]) {
        const k = key(c);
        const list = ends.get(k);
        if (list) list.push({ i, atStart });
        else ends.set(k, [{ i, atStart }]);
      }
    });
    const used = new Set<number>();
    const out: Coord[][] = [];
    ends.forEach((list) => {
      if (list.length !== 2) return;
      const [a, b] = list;
      if (a.i === b.i || used.has(a.i) || used.has(b.i)) return;
      used.add(a.i);
      used.add(b.i);
      // Orient so the first line ends at the shared point and the second starts there.
      const first = a.atStart ? lines[a.i].slice().reverse() : lines[a.i];
      const second = b.atStart ? lines[b.i] : lines[b.i].slice().reverse();
      out.push([...first, ...second.slice(1)]);
    });
    if (used.size === 0) return lines;
    lines.forEach((l, i) => {
      if (!used.has(i)) out.push(l);
    });
    lines = out;
  }
  return lines;
}
