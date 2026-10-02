// The sat-nav's data (v0.18): each region's main-roads graph, turn
// restrictions and places, from the road data version the phone is on.
// Downloaded once per version and kept on the phone, so routing works
// offline afterwards. Pure logic with the network and files passed in.

import { RoadGraph, GraphFile, RestrictionsFile } from './router';
import { Places, PlacesFile } from './places';
import { decodeTile } from './tiles';
import type { RoadSegment } from './roadMatcher';
import type { Coord } from './geo';

export type RouteDataDeps = {
  fetchText(url: string): Promise<{ ok: true; text: string } | { ok: false; missing: boolean }>;
  readFile(name: string): Promise<string | null>;
  writeFile(name: string, text: string): Promise<void>;
  deleteFiles(keep: string[]): Promise<void>; // removes our old files, keeping these
  log?(line: string): void;
};

export type Region = { id: string; version: string; base: string; bbox?: number[] | null; cells?: string[] | null }; // base = folder URL, ending in /

/**
 * The regions a trip needs: the ones its ends are in, and any the straight
 * line between them passes over (a cross-border trip, a ferry). Regions list
 * the 1-degree squares they have roads in; ones from before v0.19 don't, and
 * Ireland's is used.
 */
export function regionsFor(all: Region[], points: Coord[]): Region[] {
  const ie = all.filter((r) => r.id === 'ie' || !r.cells);
  if (!points.length) return ie;
  // Squares along the line (every ~10 km).
  const want = new Set<string>();
  const add = (la: number, lo: number) => want.add(`${Math.floor(la)},${Math.floor(lo)}`);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    add(p[0], p[1]);
    const q = points[i + 1];
    if (!q) continue;
    const steps = Math.ceil(Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])) / 0.1);
    for (let k = 1; k <= steps; k++) add(p[0] + ((q[0] - p[0]) * k) / steps, p[1] + ((q[1] - p[1]) * k) / steps);
  }
  // Where the ends are, exactly (no neighbours): always in.
  const exact = new Set(points.map((p) => `${Math.floor(p[0])},${Math.floor(p[1])}`));
  const out = all.filter((r) => {
    if (!r.cells) return r.id === 'ie';
    const cells = r.cells;
    return cells.some((c) => exact.has(c)) || (points.length > 1 && cells.some((c) => want.has(c)));
  });
  return out.length ? out : ie;
}

export type Loaded = {
  graph: RoadGraph; // main roads + restrictions (detail is added per route)
  places: Places;
  withGraph: string[]; // regions whose main-roads graph is in
  missing: string[]; // regions whose files couldn't be had (offline, or old road data)
  retry: boolean; // some download failed for want of a connection: try again next time
};

const FILES = ['graph', 'restrictions', 'places'] as const;

export class RouteData {
  private loaded: Loaded | null = null;
  private key = '';
  private loading: Promise<Loaded> | null = null;

  constructor(private deps: RouteDataDeps) {}

  /**
   * Everything for these regions, from the phone or downloaded. Cached in
   * memory until the regions or versions change. Missing files don't fail
   * it: routing then works on the detailed tiles alone (shorter trips).
   */
  async load(regions: Region[]): Promise<Loaded> {
    const key = regions.map((r) => `${r.id}@${r.version}`).sort().join(',');
    if (this.loaded && this.key === key && !this.loaded.retry) return this.loaded;
    if (this.loading && this.key === key) return this.loading;
    this.key = key;
    this.loading = this.build(regions).finally(() => {
      this.loading = null;
    });
    const out = await this.loading;
    this.loaded = out;
    return out;
  }

  private offline = false;

  private async getFile(r: Region, what: (typeof FILES)[number]): Promise<any | null> {
    const name = `nav-${r.id}-${r.version}-${what}.json`;
    const cached = await this.deps.readFile(name).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // damaged: download again
      }
    }
    const res = await this.deps.fetchText(`${r.base}${what}.json`);
    if (!res.ok) {
      if (!res.missing) this.offline = true;
      this.deps.log?.(`sat-nav: ${r.id} ${what}.json ${res.missing ? 'not in this road data' : 'not downloaded (offline?)'}`);
      return null;
    }
    try {
      const data = JSON.parse(res.text);
      await this.deps.writeFile(name, res.text).catch(() => undefined);
      return data;
    } catch {
      return null;
    }
  }

  private async build(regions: Region[]): Promise<Loaded> {
    const graph = new RoadGraph();
    const places = new Places();
    const withGraph: string[] = [];
    const missing: string[] = [];
    const keep: string[] = [];
    this.offline = false;
    for (const r of regions) {
      const [g, rs, pl] = await Promise.all(FILES.map((f) => this.getFile(r, f)));
      if (g) {
        graph.addGraph(g as GraphFile);
        withGraph.push(r.id);
      }
      if (rs) graph.addRestrictions(rs as RestrictionsFile);
      if (pl) places.add(r.id, pl as PlacesFile);
      if (!g || !rs || !pl) missing.push(r.id);
      FILES.forEach((f) => keep.push(`nav-${r.id}-${r.version}-${f}.json`));
    }
    await this.deps.deleteFiles(keep).catch(() => undefined);
    this.deps.log?.(`sat-nav data: ${graph.edgeCount} main-road links (${withGraph.join(', ') || 'none'}), ${places.size} places`);
    return { graph, places, withGraph, missing, retry: this.offline };
  }

  // Road tiles of other countries, for routing there (the map and drive
  // matching still use Ireland's, through RoadData). Kept in memory only.
  private foreign = new Map<string, RoadSegment[]>();

  /** Detailed roads of these tiles in another region (downloaded, or [] offline / none). */
  async foreignTiles(r: Region, tileIds: Iterable<string>): Promise<RoadSegment[]> {
    const out: RoadSegment[] = [];
    const want = [...new Set(tileIds)];
    for (let i = 0; i < want.length; i += 8) {
      const batch = await Promise.all(
        want.slice(i, i + 8).map(async (t) => {
          const key = `${r.id}/${r.version}/${t}`;
          const have = this.foreign.get(key);
          if (have) return have;
          const res = await this.deps.fetchText(`${r.base}${t}.json`);
          if (!res.ok) {
            if (res.missing) this.foreign.set(key, []);
            return [];
          }
          try {
            const segs = decodeTile(JSON.parse(res.text));
            this.foreign.set(key, segs);
            return segs;
          } catch {
            return [];
          }
        }),
      );
      batch.forEach((b) => out.push(...b));
    }
    if (this.foreign.size > 400) this.foreign.clear(); // don't grow forever
    return out;
  }

  /** Forget what's in memory (the graph also collects detailed roads per route). */
  reset() {
    this.loaded = null;
    this.key = '';
  }
}
