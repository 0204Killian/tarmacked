// The sat-nav's data (v0.18): each region's main-roads graph, turn
// restrictions and places, from the road data version the phone is on.
// Downloaded once per version and kept on the phone, so routing works
// offline afterwards. Pure logic with the network and files passed in.

import { RoadGraph, GraphFile, RestrictionsFile } from './router';
import { Places, PlacesFile } from './places';

export type RouteDataDeps = {
  fetchText(url: string): Promise<{ ok: true; text: string } | { ok: false; missing: boolean }>;
  readFile(name: string): Promise<string | null>;
  writeFile(name: string, text: string): Promise<void>;
  deleteFiles(keep: string[]): Promise<void>; // removes our old files, keeping these
  log?(line: string): void;
};

export type Region = { id: string; version: string; base: string }; // base = folder URL, ending in /

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

  /** Forget what's in memory (the graph also collects detailed roads per route). */
  reset() {
    this.loaded = null;
    this.key = '';
  }
}
