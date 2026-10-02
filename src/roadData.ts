// Road data on the phone (v0.17): which version of the map data we're on,
// and loading tiles for the areas that are needed, from the phone's cache
// first and tiles.tarmacked.com otherwise. Nothing is loaded "all at
// launch" any more; the map, drives and re-checks ask for the areas they
// need. Pure logic with the network and storage passed in, so it can be
// tested on its own.

import type { RoadSegment } from './roadMatcher';
import { decodeTile, Manifest, TileIndex, REGION, TILE_HOST } from './tiles';

export type FetchResult = { ok: true; data: any } | { ok: false; missing: boolean };

export type RoadDataDeps = {
  fetchJson(url: string): Promise<FetchResult>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  getTiles(ids: string[]): Promise<{ tileId: string; segments: RoadSegment[]; version: string | null }[]>;
  putTiles(entries: { tileId: string; segments: RoadSegment[] }[], pinned: boolean, version: string): Promise<void>;
  clearTiles(): Promise<void>;
  beforeClear?(): Promise<void>; // a new version is about to replace the cached tiles
  onSegments(segs: RoadSegment[]): void; // new road pieces for the matcher / map
  log?(line: string): void;
};

export type VersionChange = { from: string | null; to: string };

export class RoadData {
  manifest: Manifest | null = null;
  index: TileIndex | null = null;
  private tileSet: Set<string> | null = null;
  private loaded = new Set<string>(); // tiles in memory (or known to be empty)
  private inFlight = new Map<string, Promise<'ok' | 'fail'>>();

  constructor(private deps: RoadDataDeps) {}

  get version(): string | null {
    return this.index?.version ?? null;
  }

  private base(): string | null {
    const r = this.manifest?.regions?.[REGION];
    return r ? `${TILE_HOST}${r.path}` : null;
  }

  private setIndex(index: TileIndex) {
    this.index = index;
    this.tileSet = new Set(index.tiles);
  }

  /** The cached manifest + index, so the app works offline. */
  async loadCached(): Promise<boolean> {
    try {
      const m = await this.deps.getMeta('tiles_manifest');
      const i = await this.deps.getMeta('tiles_index');
      if (m && i) {
        this.manifest = JSON.parse(m);
        this.setIndex(JSON.parse(i));
        return true;
      }
    } catch {
      // fall through to the network
    }
    return false;
  }

  /**
   * Checks tiles.tarmacked.com for a newer version of the road data. On a
   * new version, the tile cache is cleared (tiles reload by area) and the
   * change is returned so the app can re-check drives and move edits over.
   * Returns null when nothing changed or there's no connection.
   */
  async refresh(): Promise<VersionChange | null> {
    const m = await this.deps.fetchJson(`${TILE_HOST}manifest.json`);
    if (!m.ok) return null;
    const region = m.data?.regions?.[REGION];
    if (!region?.version || !region?.path) return null;
    const from = this.version;
    if (from === region.version && this.index) return null;
    const i = await this.deps.fetchJson(`${TILE_HOST}${region.path}index.json`);
    if (!i.ok || !Array.isArray(i.data?.tiles)) return null;
    this.manifest = m.data;
    this.setIndex(i.data);
    await this.deps.setMeta('tiles_manifest', JSON.stringify(m.data));
    await this.deps.setMeta('tiles_index', JSON.stringify(i.data));
    const cachedVersion = await this.deps.getMeta('tiles_version');
    if (cachedVersion !== region.version) {
      await this.deps.beforeClear?.();
      await this.deps.clearTiles();
      this.loaded.clear();
      await this.deps.setMeta('tiles_version', region.version);
      this.deps.log?.(`road data: version ${cachedVersion || 'old'} → ${region.version}`);
      return { from: cachedVersion, to: region.version };
    }
    return null;
  }

  /** Counties that have road data, for picking a home county. */
  counties(): string[] {
    return this.index ? Object.keys(this.index.counties).filter((c) => this.index!.counties[c].length > 0).sort() : [];
  }

  countyTiles(county: string): string[] {
    return this.index?.counties[county] ?? [];
  }

  isLoaded(tileId: string) {
    return this.loaded.has(tileId);
  }

  loadedCount() {
    return this.loaded.size;
  }

  /** Forgets what's in memory (after the tile cache was cleared). */
  forget() {
    this.loaded.clear();
  }

  async statsJson(): Promise<any | null> {
    const base = this.base();
    if (!base) return null;
    const r = await this.deps.fetchJson(`${base}stats.json`);
    return r.ok ? r.data : null;
  }

  /**
   * Makes sure these tiles are loaded: from the phone's cache, else
   * downloaded. Tiles the index doesn't list (sea, abroad) count as loaded
   * and empty. Returns how many couldn't be had (no connection).
   */
  async ensure(tileIds: Iterable<string>, opts: { pinned?: boolean; onProgress?: (f: number) => void } = {}): Promise<number> {
    const want = Array.from(new Set(tileIds)).filter((t) => !this.loaded.has(t));
    if (want.length === 0) return 0;
    if (!this.index) return want.length; // no road data yet (first launch offline)
    const version = this.index.version;
    const real = want.filter((t) => this.tileSet!.has(t));
    want.filter((t) => !this.tileSet!.has(t)).forEach((t) => this.loaded.add(t));
    // Cache first.
    const cached = await this.deps.getTiles(real);
    const fresh = cached.filter((c) => c.version === version);
    const segs: RoadSegment[] = [];
    for (const c of fresh) {
      this.loaded.add(c.tileId);
      segs.push(...c.segments);
    }
    if (segs.length) this.deps.onSegments(segs);
    if (opts.pinned && fresh.length) await this.deps.putTiles(fresh.map(({ tileId, segments }) => ({ tileId, segments })), true, version);
    // Then the network, 8 at a time.
    const toFetch = real.filter((t) => !this.loaded.has(t));
    let failed = 0;
    for (let i = 0; i < toFetch.length; i += 8) {
      const batch = await Promise.all(toFetch.slice(i, i + 8).map((t) => this.fetchOne(t, !!opts.pinned)));
      failed += batch.filter((r) => r === 'fail').length;
      opts.onProgress?.(Math.min(1, (i + 8) / toFetch.length));
    }
    return failed;
  }

  private fetchOne(tileId: string, pinned: boolean): Promise<'ok' | 'fail'> {
    const existing = this.inFlight.get(tileId);
    if (existing) return existing;
    const p = (async (): Promise<'ok' | 'fail'> => {
      const base = this.base();
      const version = this.index?.version;
      if (!base || !version) return 'fail';
      const r = await this.deps.fetchJson(`${base}${tileId}.json`);
      if (!r.ok) {
        if (r.missing) this.loaded.add(tileId); // listed but gone: treat as empty
        return r.missing ? 'ok' : 'fail';
      }
      if (this.index?.version !== version) return 'fail'; // the version changed meanwhile
      const segs = decodeTile(r.data);
      this.loaded.add(tileId);
      if (segs.length) {
        this.deps.onSegments(segs);
        await this.deps.putTiles([{ tileId, segments: segs }], pinned, version);
      }
      return 'ok';
    })().finally(() => this.inFlight.delete(tileId));
    this.inFlight.set(tileId, p);
    return p;
  }
}

/** fetch() wrapped for RoadData: only a 404 means "no such file". */
export async function fetchJson(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url);
    if (res.status === 404) return { ok: false, missing: true };
    if (!res.ok) return { ok: false, missing: false };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, missing: false };
  }
}
