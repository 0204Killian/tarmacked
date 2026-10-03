// Road data on the phone (v0.17, every country since v0.21): which version
// of each region's map data we're on, and loading tiles for the areas that
// are needed, from the phone's cache first and tiles.tarmacked.com
// otherwise. Nothing is loaded "all at launch": the map, drives and
// re-checks ask for the areas they need, and the regions (countries) those
// areas are in are picked up as they're needed. Pure logic with the
// network and storage passed in, so it can be tested on its own.
//
// Tiles are filed on the phone under the region they came from
// ("gb:t_1030_-30"), except Ireland's, which keep their plain names from
// before v0.21 ("t_1050_-150"): two regions can share a tile square at a
// border. Area (county) codes are made unique across regions as they're
// read (src/areas.ts).

import type { RoadSegment } from './roadMatcher';
import { decodeTile, Manifest, RegionEntry, TileIndex, TILE_HOST } from './tiles';
import { AREA_BLOCK } from './areas';
import { TILE_DEGREES } from './geo';

export type FetchResult = { ok: true; data: any } | { ok: false; missing: boolean };

export type RoadDataDeps = {
  fetchJson(url: string): Promise<FetchResult>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  getTiles(keys: string[]): Promise<{ tileId: string; segments: RoadSegment[]; version: string | null }[]>;
  putTiles(entries: { tileId: string; segments: RoadSegment[] }[], pinned: boolean, version: string): Promise<void>;
  clearTiles(region?: string): Promise<void>; // one region's cached tiles (all if none given)
  beforeClear?(): Promise<void>; // a new version is about to replace cached tiles
  onRegionAdded?(region: string): void; // a region (country) is used for the first time
  onSegments(segs: RoadSegment[]): void; // new road pieces for the matcher / map
  log?(line: string): void;
};

export type VersionChange = { from: string | null; to: string; regions: string[] };

/** The region Ireland's data has always been (codes 0..., plain tile names). */
export const HOME_REGION = 'ie';

/** Where a region's tile is kept on the phone. */
export const tileKey = (region: string, tile: string) => (region === HOME_REGION ? tile : `${region}:${tile}`);

// Meta keys: Ireland keeps the names it had before v0.21.
const metaKey = (what: 'index' | 'version', region: string) =>
  region === HOME_REGION ? `tiles_${what}` : `tiles_${what}_${region}`;

/** The 1-degree square ("53,-8") a tile ("t_1060_-150") is in. */
export function cellOfTile(tile: string): string | null {
  const m = /^t_(-?\d+)_(-?\d+)$/.exec(tile);
  if (!m) return null;
  // The middle of the tile, so floating point never puts it in the next square.
  return `${Math.floor((Number(m[1]) + 0.5) * TILE_DEGREES)},${Math.floor((Number(m[2]) + 0.5) * TILE_DEGREES)}`;
}

type Held = { index: TileIndex; set: Set<string> };

export class RoadData {
  manifest: Manifest | null = null;
  private held = new Map<string, Held>(); // region id -> its index
  private used: string[] = []; // regions in use on this phone (kept up to date)
  private loaded = new Set<string>(); // tile keys in memory (or known to be empty)
  private done = new Set<string>(); // plain tile ids fully handled (every region that has it)
  private inFlight = new Map<string, Promise<'ok' | 'fail'>>();
  private indexInFlight = new Map<string, Promise<boolean>>();

  constructor(private deps: RoadDataDeps) {}

  /** The version(s) in use: "2026-10-03", or "ie 2026-10-03 · gb 2026-11-02". */
  get version(): string | null {
    const list = [...this.held.entries()];
    if (list.length === 0) return null;
    if (list.length === 1) return list[0][1].index.version;
    return list.map(([id, h]) => `${id} ${h.index.version}`).join(' · ');
  }

  /** Any road data at all (false on a first launch with no signal). */
  hasData(): boolean {
    return this.held.size > 0;
  }

  /** Regions this phone uses (in the order they were first needed). */
  regionsInUse(): string[] {
    return [...this.held.keys()];
  }

  /** Every region tiles.tarmacked.com has, with its number. */
  allRegions(): (RegionEntry & { id: string; num: number })[] {
    const out: (RegionEntry & { id: string; num: number })[] = [];
    for (const [id, r] of Object.entries(this.manifest?.regions ?? {})) {
      const num = typeof r.num === 'number' ? r.num : id === HOME_REGION ? 0 : null;
      if (num === null || !r.path) continue; // from before v0.21: can't be numbered
      out.push({ ...r, id, num });
    }
    return out.sort((a, b) => a.num - b.num);
  }

  regionInfo(id: string) {
    return this.allRegions().find((r) => r.id === id) ?? null;
  }

  /** The region an area code belongs to. */
  regionOfArea(code: number): string | null {
    const num = Math.floor(code / AREA_BLOCK);
    return this.allRegions().find((r) => r.num === num)?.id ?? (num === 0 ? HOME_REGION : null);
  }

  private base(id: string): string | null {
    const r = this.manifest?.regions?.[id];
    return r?.path ? `${TILE_HOST}${r.path}` : null;
  }

  private hold(id: string, index: TileIndex) {
    this.held.set(id, { index, set: new Set(index.tiles) });
  }

  private async markUsed(id: string) {
    if (this.used.includes(id)) return;
    this.used.push(id);
    await this.deps.setMeta('regions_used', JSON.stringify(this.used));
    this.deps.onRegionAdded?.(id);
  }

  /** The cached manifest + indexes, so the app works offline. */
  async loadCached(): Promise<boolean> {
    try {
      const m = await this.deps.getMeta('tiles_manifest');
      if (m) this.manifest = JSON.parse(m);
      const usedRaw = await this.deps.getMeta('regions_used');
      this.used = usedRaw ? (JSON.parse(usedRaw) as string[]) : [HOME_REGION];
      for (const id of this.used) {
        const i = await this.deps.getMeta(metaKey('index', id));
        if (i) this.hold(id, JSON.parse(i));
      }
      if (!usedRaw && this.held.size) await this.deps.setMeta('regions_used', JSON.stringify(this.used));
    } catch {
      // fall through to the network
    }
    return !!this.manifest && this.held.size > 0;
  }

  /**
   * Checks tiles.tarmacked.com for newer road data in the regions in use.
   * On a new version, that region's cached tiles are cleared (they reload
   * by area) and the change is returned so the app can re-check drives and
   * move edits over. Returns null when nothing changed or there's no
   * connection.
   */
  async refresh(): Promise<VersionChange | null> {
    const m = await this.deps.fetchJson(`${TILE_HOST}manifest.json`);
    if (!m.ok || !m.data?.regions) return null;
    this.manifest = m.data;
    await this.deps.setMeta('tiles_manifest', JSON.stringify(m.data));
    if (this.used.length === 0) this.used = [HOME_REGION];
    const changes: { id: string; from: string | null; to: string }[] = [];
    let cleared = false;
    for (const id of [...this.used]) {
      const region = this.manifest!.regions[id];
      if (!region?.version || !region?.path) continue;
      const have = this.held.get(id)?.index.version ?? null;
      if (have !== region.version) {
        const i = await this.deps.fetchJson(`${TILE_HOST}${region.path}index.json`);
        if (!i.ok || !Array.isArray(i.data?.tiles)) continue;
        this.hold(id, i.data);
        await this.deps.setMeta(metaKey('index', id), JSON.stringify(i.data));
      }
      const cachedVersion = await this.deps.getMeta(metaKey('version', id));
      if (cachedVersion !== region.version) {
        if (!cleared) await this.deps.beforeClear?.();
        cleared = true;
        await this.deps.clearTiles(id);
        this.forgetRegion(id);
        await this.deps.setMeta(metaKey('version', id), region.version);
        this.deps.log?.(`road data ${id}: version ${cachedVersion || 'old'} → ${region.version}`);
        changes.push({ id, from: cachedVersion, to: region.version });
      }
    }
    if (!this.used.every((id) => this.held.has(id) || !this.manifest!.regions[id])) {
      // A region dropped from the manifest is simply not used any more.
      this.used = this.used.filter((id) => this.manifest!.regions[id]);
    }
    await this.deps.setMeta('regions_used', JSON.stringify(this.used));
    if (!changes.length) return null;
    if (changes.length === 1) return { from: changes[0].from, to: changes[0].to, regions: [changes[0].id] };
    return {
      from: changes.map((c) => `${c.id} ${c.from ?? 'none'}`).join(', '),
      to: changes.map((c) => `${c.id} ${c.to}`).join(', '),
      regions: changes.map((c) => c.id),
    };
  }

  /**
   * Starts using a region (a country you've driven into, or picked as
   * home): its index from the phone or downloaded. False with no signal.
   */
  useRegion(id: string): Promise<boolean> {
    if (this.held.has(id)) return this.markUsed(id).then(() => true);
    const existing = this.indexInFlight.get(id);
    if (existing) return existing;
    const p = (async () => {
      const cached = await this.deps.getMeta(metaKey('index', id));
      const want = this.manifest?.regions?.[id];
      if (cached) {
        try {
          const index = JSON.parse(cached) as TileIndex;
          if (!want || index.version === want.version) {
            this.hold(id, index);
            await this.markUsed(id);
            return true;
          }
        } catch {
          // download it again
        }
      }
      if (!want?.path) return false;
      const i = await this.deps.fetchJson(`${TILE_HOST}${want.path}index.json`);
      if (!i.ok || !Array.isArray(i.data?.tiles)) return false;
      this.hold(id, i.data);
      await this.deps.setMeta(metaKey('index', id), JSON.stringify(i.data));
      // Tiles cached from an older version of this region aren't used.
      const cachedVersion = await this.deps.getMeta(metaKey('version', id));
      if (cachedVersion !== want.version) {
        if (cachedVersion) await this.deps.clearTiles(id);
        await this.deps.setMeta(metaKey('version', id), want.version);
      }
      await this.markUsed(id);
      this.deps.log?.(`road data: now using ${id} (${want.version})`);
      return true;
    })().finally(() => this.indexInFlight.delete(id));
    this.indexInFlight.set(id, p);
    return p;
  }

  /** Areas (counties) of a region that have road data, for picking a home county. */
  areas(region: string = HOME_REGION): string[] {
    const index = this.held.get(region)?.index;
    return index ? Object.keys(index.counties).filter((c) => index.counties[c].length > 0).sort() : [];
  }

  /** @deprecated Ireland's counties (before v0.21). */
  counties(): string[] {
    return this.areas(HOME_REGION);
  }

  /** An area's tiles. `area` is "County Kilkenny" (Ireland) or "gb/Kent". */
  countyTiles(area: string): string[] {
    const { region, name } = splitHome(area);
    return this.held.get(region)?.index.counties[name] ?? [];
  }

  isLoaded(tileId: string) {
    return this.done.has(tileId);
  }

  loadedCount() {
    return this.loaded.size;
  }

  /** Forgets what's in memory (after the tile cache was cleared). */
  forget() {
    this.loaded.clear();
    this.done.clear();
  }

  private forgetRegion(id: string) {
    for (const k of [...this.loaded]) if (id === HOME_REGION ? !k.includes(':') : k.startsWith(`${id}:`)) this.loaded.delete(k);
    this.done.clear();
  }

  async statsJson(region: string = HOME_REGION): Promise<any | null> {
    return this.regionJson(region, 'stats.json');
  }

  /** One of a region's own files (stats.json, scenic.json): null if missing or offline. */
  async regionJson(region: string, file: string): Promise<any | null> {
    const r = await this.regionFile(region, file);
    return r?.ok ? r.data : null;
  }

  /** Same, telling "not in this region's data" (missing) apart from no connection. */
  async regionFile(region: string, file: string): Promise<FetchResult | null> {
    const base = this.base(region);
    if (!base) return null;
    return this.deps.fetchJson(`${base}${file}`);
  }

  /** Every name a tile has on the phone (one per region in use that has it). */
  cachedKeys(tile: string): string[] {
    const out: string[] = [];
    for (const [id, h] of this.held) if (h.set.has(tile)) out.push(tileKey(id, tile));
    return out;
  }

  /** The regions that could have this tile (by the squares they cover). */
  private candidates(tile: string): string[] {
    const regions = this.manifest?.regions ?? {};
    const cell = cellOfTile(tile);
    const out: string[] = [];
    for (const [id, r] of Object.entries(regions)) {
      if (!r?.path) continue;
      if (!r.cells) {
        // From before v0.19 (no squares): Ireland's covers everything we had.
        if (id === HOME_REGION) out.push(id);
        continue;
      }
      if (cell && r.cells.includes(cell)) out.push(id);
    }
    // No manifest yet but an index from before: that region.
    if (!this.manifest) for (const id of this.held.keys()) out.push(id);
    return out;
  }

  /**
   * Makes sure these tiles are loaded: from the phone's cache, else
   * downloaded, from every region that has them. Tiles no region lists
   * (sea) count as loaded and empty. Returns how many couldn't be had (no
   * connection).
   */
  async ensure(tileIds: Iterable<string>, opts: { pinned?: boolean; onProgress?: (f: number) => void } = {}): Promise<number> {
    const want = Array.from(new Set(tileIds)).filter((t) => !this.done.has(t));
    if (want.length === 0) return 0;
    if (!this.manifest && this.held.size === 0) return want.length; // no road data yet (first launch offline)
    let failed = 0;
    const jobs: { region: string; tile: string; key: string }[] = [];
    const pending = new Map<string, number>(); // tile -> keys still to load
    const bad = new Set<string>();
    const tried = new Map<string, boolean>(); // regions asked for in this call (one try each)
    for (const tile of want) {
      let n = 0;
      for (const region of this.candidates(tile)) {
        if (!this.held.has(region)) {
          if (!tried.has(region)) tried.set(region, await this.useRegion(region));
          if (!tried.get(region)) {
            bad.add(tile);
            continue;
          }
        }
        if (!this.held.get(region)!.set.has(tile)) continue;
        const key = tileKey(region, tile);
        if (this.loaded.has(key)) continue;
        jobs.push({ region, tile, key });
        n++;
      }
      if (n === 0 && !bad.has(tile)) this.done.add(tile);
      else pending.set(tile, n);
    }
    // Cache first (only tiles of the version in use).
    const cached = await this.deps.getTiles(jobs.map((j) => j.key));
    const byKey = new Map(cached.map((c) => [c.tileId, c]));
    const segs: RoadSegment[] = [];
    const repin: { tileId: string; segments: RoadSegment[]; version: string }[] = [];
    const toFetch: typeof jobs = [];
    for (const j of jobs) {
      const c = byKey.get(j.key);
      const version = this.held.get(j.region)!.index.version;
      if (c && c.version === version) {
        this.loaded.add(j.key);
        segs.push(...c.segments);
        if (opts.pinned) repin.push({ tileId: j.key, segments: c.segments, version });
      } else toFetch.push(j);
    }
    if (segs.length) this.deps.onSegments(segs);
    for (const v of new Set(repin.map((r) => r.version))) {
      await this.deps.putTiles(repin.filter((r) => r.version === v).map(({ tileId, segments }) => ({ tileId, segments })), true, v);
    }
    // Then the network, 8 at a time.
    for (let i = 0; i < toFetch.length; i += 8) {
      const batch = await Promise.all(toFetch.slice(i, i + 8).map((j) => this.fetchOne(j.region, j.tile, j.key, !!opts.pinned)));
      batch.forEach((r, k) => {
        if (r === 'fail') bad.add(toFetch[i + k].tile);
      });
      opts.onProgress?.(Math.min(1, (i + 8) / toFetch.length));
    }
    for (const tile of pending.keys()) {
      if (bad.has(tile)) failed++;
      else this.done.add(tile);
    }
    return failed;
  }

  private fetchOne(region: string, tile: string, key: string, pinned: boolean): Promise<'ok' | 'fail'> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const p = (async (): Promise<'ok' | 'fail'> => {
      const base = this.base(region);
      const held = this.held.get(region);
      const version = held?.index.version;
      if (!base || !version) return 'fail';
      const r = await this.deps.fetchJson(`${base}${tile}.json`);
      if (!r.ok) {
        if (r.missing) this.loaded.add(key); // listed but gone: treat as empty
        return r.missing ? 'ok' : 'fail';
      }
      if (this.held.get(region)?.index.version !== version) return 'fail'; // the version changed meanwhile
      const num = this.regionInfo(region)?.num ?? 0;
      const segs = decodeTile(r.data, num * AREA_BLOCK);
      this.loaded.add(key);
      if (segs.length) {
        this.deps.onSegments(segs);
        await this.deps.putTiles([{ tileId: key, segments: segs }], pinned, version);
      }
      return 'ok';
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }
}

/**
 * A home area as saved: Ireland's counties by name ("County Kilkenny", as
 * before v0.21), other regions' as "gb/Kent".
 */
export function splitHome(saved: string): { region: string; name: string } {
  const m = /^([a-z]{2})\/(.+)$/.exec(saved);
  return m ? { region: m[1], name: m[2] } : { region: HOME_REGION, name: saved };
}
export const joinHome = (region: string, name: string) => (region === HOME_REGION ? name : `${region}/${name}`);

/** fetch() wrapped for RoadData: only a 404 means "no such file". Gives up after 30 s. */
export async function fetchJson(url: string): Promise<FetchResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: abort.signal });
    if (res.status === 404) return { ok: false, missing: true };
    if (!res.ok) return { ok: false, missing: false };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, missing: false };
  } finally {
    clearTimeout(timer);
  }
}
