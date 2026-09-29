// All persistent data lives here, in a real SQLite database on the phone.
//
// Why a database instead of the old AsyncStorage blobs: every change is now
// a small row write (one driven chunk, one batch of points) instead of
// rewriting an entire multi-MB block every few seconds, and changes are
// written in transactions — a crash mid-write can't half-corrupt anything.
//
// What's permanent vs disposable:
//  - driven roads, excluded roads, unmatched points, drives + points: your
//    history. Permanent, and included in backups.
//  - tiles: downloaded road data. Just a cache — it can always be
//    re-downloaded, so stale areas get cleared out automatically.
//  - driven roads store their own shape, so they keep drawing even when
//    the tile cache for that area has been cleared.
//  - unmarked: roads you un-marked by hand, and when — so re-checking your
//    drives doesn't put them back (unless you drive them again later).
//  - driven_removed: roads a re-check took away, kept so it can be undone.

import * as SQLite from 'expo-sqlite';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RoadSegment } from './roadMatcher';

export type StoredPoint = { latitude: number; longitude: number; timestamp: number; accuracy?: number | null };
export type Shape = [number, number][];
export type TileEntry = { tileId: string; segments: RoadSegment[] };

// Tiles not used for this long get cleared (unless pinned, e.g. home county).
const TILE_MAX_IDLE_MS = 120 * 24 * 60 * 60 * 1000; // ~4 months

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

async function openDb() {
  const db = await SQLite.openDatabaseAsync('tarmacked.db');
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT);
    CREATE TABLE IF NOT EXISTS driven (id TEXT PRIMARY KEY NOT NULL, shape TEXT, first_at INTEGER NOT NULL, county INTEGER);
    CREATE TABLE IF NOT EXISTS excluded_roads (id TEXT PRIMARY KEY NOT NULL, county INTEGER, length_m REAL);
    CREATE TABLE IF NOT EXISTS unmatched (lat REAL NOT NULL, lon REAL NOT NULL, t INTEGER NOT NULL, UNIQUE(lat, lon, t));
    CREATE TABLE IF NOT EXISTS drives (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS points (drive_id INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, t INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS points_by_drive ON points(drive_id);
    CREATE TABLE IF NOT EXISTS tiles (
      tile_id TEXT PRIMARY KEY NOT NULL,
      segments TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unmarked (id TEXT PRIMARY KEY NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS partial_coverage (chunk_id TEXT PRIMARY KEY NOT NULL, stretches TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drive_roads (drive_id INTEGER NOT NULL, chunk_id TEXT NOT NULL, PRIMARY KEY (drive_id, chunk_id));
    CREATE INDEX IF NOT EXISTS drive_roads_by_chunk ON drive_roads(chunk_id);
    CREATE TABLE IF NOT EXISTS driven_removed (
      id TEXT PRIMARY KEY NOT NULL, shape TEXT, first_at INTEGER, county INTEGER, removed_at INTEGER NOT NULL
    );
  `);
  // v0.13: per-drive summary columns.
  const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(drives)');
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('ended_at')) await db.execAsync('ALTER TABLE drives ADD COLUMN ended_at INTEGER');
  if (!have.has('distance_m')) await db.execAsync('ALTER TABLE drives ADD COLUMN distance_m REAL');
  if (!have.has('new_m')) await db.execAsync('ALTER TABLE drives ADD COLUMN new_m REAL');
  // v0.14: wild-GPS count, "leave out", and GPS accuracy per point.
  if (!have.has('ignored_n')) await db.execAsync('ALTER TABLE drives ADD COLUMN ignored_n INTEGER');
  if (!have.has('left_out')) await db.execAsync('ALTER TABLE drives ADD COLUMN left_out INTEGER NOT NULL DEFAULT 0');
  const pcols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(points)');
  if (!pcols.some((c) => c.name === 'acc')) await db.execAsync('ALTER TABLE points ADD COLUMN acc REAL');
  return db;
}

// Runs a statement for many rows inside one transaction.
async function bulk(db: SQLite.SQLiteDatabase, sql: string, rows: (string | number | null)[][]) {
  if (rows.length === 0) return;
  const stmt = await db.prepareAsync(sql);
  try {
    for (const r of rows) await stmt.executeAsync(r);
  } finally {
    await stmt.finalizeAsync();
  }
}

// Every write goes through this queue and runs as its own transaction.
// Several saves often fire at the same moment (driven roads, points,
// unmatched points), and SQLite can't open a second transaction on one
// connection while another is still in progress — so they run one after
// another instead. Reads don't need this.
let writeChain: Promise<unknown> = Promise.resolve();
function write<T>(fn: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    const db = await getDb();
    let result!: T;
    await db.withTransactionAsync(async () => {
      result = await fn(db);
    });
    return result;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

// Adds a driven chunk, or fills in its shape/county if we didn't have them.
// Never overwrites an existing value or the original first-driven time.
const DRIVEN_UPSERT =
  'INSERT INTO driven (id, shape, first_at, county) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ' +
  'shape = COALESCE(driven.shape, excluded.shape), county = COALESCE(driven.county, excluded.county)';

// --- meta ---

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string | null }>('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : null;
}

export async function setMeta(key: string, value: string) {
  await write((db) => db.runAsync('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [
    key,
    value,
    value,
  ]));
}

// --- one-time migration from the old AsyncStorage format ---

const OLD_KEYS = {
  driven: 'tarmacked:driven:local',
  excluded: 'tarmacked:excluded:local',
  unmatched: 'tarmacked:unmatched:local',
  tiles: 'tarmacked:dynamicTiles',
  onboarded: 'tarmacked:onboarded',
  homeCounty: 'tarmacked:homeCounty',
  rawTrail: 'tarmacked:rawTrail',
};

/**
 * Copies everything from the old storage into the database, once. The old
 * data is deliberately left in place as a safety copy — nothing is
 * deleted. Everything is written in one transaction (all or nothing), and
 * every insert is merge-safe, so if it fails partway it simply retries on
 * the next launch without duplicating anything.
 * Returns a short summary if a migration ran, or null if already done.
 */
export async function migrateIfNeeded(): Promise<string | null> {
  if (await getMeta('migrated_from_asyncstorage')) return null;

  const [drivenRaw, excludedRaw, unmatchedRaw, tilesRaw, onboardedRaw, homeRaw, trailRaw] = await Promise.all([
    AsyncStorage.getItem(OLD_KEYS.driven),
    AsyncStorage.getItem(OLD_KEYS.excluded),
    AsyncStorage.getItem(OLD_KEYS.unmatched),
    AsyncStorage.getItem(OLD_KEYS.tiles),
    AsyncStorage.getItem(OLD_KEYS.onboarded),
    AsyncStorage.getItem(OLD_KEYS.homeCounty),
    AsyncStorage.getItem(OLD_KEYS.rawTrail),
  ]);

  const drivenIds: string[] = drivenRaw ? JSON.parse(drivenRaw) : [];
  const excludedIds: string[] = excludedRaw ? JSON.parse(excludedRaw) : [];
  const unmatched: StoredPoint[] = unmatchedRaw ? JSON.parse(unmatchedRaw) : [];
  const tiles: TileEntry[] = tilesRaw ? JSON.parse(tilesRaw) : [];
  const sessions: StoredPoint[][] = trailRaw ? JSON.parse(trailRaw) : [];

  // Old driven roads only stored ids — take their shapes from the cached
  // road data where available, so they keep drawing without it later.
  const shapeById = new Map<string, Shape>();
  const countyById = new Map<string, number>();
  for (const t of tiles) {
    for (const seg of t.segments) {
      shapeById.set(seg.id, seg.coords);
      if (seg.c !== undefined) countyById.set(seg.id, seg.c);
    }
  }

  const now = Date.now();
  let drivesMoved = 0;
  let pointsMoved = 0;

  await write(async (db) => {
    await bulk(
      db,
      DRIVEN_UPSERT,
      drivenIds.map((id) => {
        const shape = shapeById.get(id);
        return [id, shape ? JSON.stringify(shape) : null, now, countyById.get(id) ?? null];
      })
    );
    await bulk(db, 'INSERT OR IGNORE INTO excluded_roads (id) VALUES (?)', excludedIds.map((id) => [id]));
    await bulk(
      db,
      'INSERT OR IGNORE INTO unmatched (lat, lon, t) VALUES (?, ?, ?)',
      unmatched.map((p) => [p.latitude, p.longitude, p.timestamp])
    );
    for (const session of sessions) {
      if (!session || session.length === 0) continue;
      const res = await db.runAsync('INSERT OR IGNORE INTO drives (started_at) VALUES (?)', [session[0].timestamp]);
      if (res.changes === 0) continue; // already migrated on an earlier attempt
      const driveId = res.lastInsertRowId;
      await bulk(
        db,
        'INSERT INTO points (drive_id, lat, lon, t) VALUES (?, ?, ?, ?)',
        session.map((p) => [driveId, p.latitude, p.longitude, p.timestamp])
      );
      drivesMoved++;
      pointsMoved += session.length;
    }
    await bulk(
      db,
      'INSERT OR IGNORE INTO tiles (tile_id, segments, pinned, last_used_at) VALUES (?, ?, 0, ?)',
      tiles.map((t) => [t.tileId, JSON.stringify(t.segments), now])
    );
    if (onboardedRaw === 'true') {
      await db.runAsync("INSERT OR IGNORE INTO meta (key, value) VALUES ('onboarded', 'true')");
    }
    if (homeRaw) {
      await db.runAsync("INSERT OR IGNORE INTO meta (key, value) VALUES ('home_county', ?)", [homeRaw]);
    }
    await db.runAsync("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_from_asyncstorage', ?)", [
      String(now),
    ]);
  });

  return (
    `Moved to new storage: ${drivenIds.length} driven road chunks, ${excludedIds.length} excluded, ` +
    `${drivesMoved} drives (${pointsMoved} points). Old copy kept as a backup.`
  );
}

// --- loading ---

export type LoadedState = {
  onboarded: boolean;
  homeCounty: string | null;
  driven: { id: string; shape: Shape | null; county: number | null }[];
  excluded: { id: string; county: number | null; lengthM: number | null }[];
  unmatched: StoredPoint[];
  tiles: TileEntry[];
  driveCount: number;
  pointCount: number;
};

export async function loadAll(): Promise<LoadedState> {
  const db = await getDb();
  const [onboarded, homeCounty] = await Promise.all([getMeta('onboarded'), getMeta('home_county')]);
  const driven = await db.getAllAsync<{ id: string; shape: string | null; county: number | null }>(
    'SELECT id, shape, county FROM driven'
  );
  const excluded = await db.getAllAsync<{ id: string; county: number | null; length_m: number | null }>(
    'SELECT id, county, length_m FROM excluded_roads'
  );
  const unmatched = await db.getAllAsync<{ lat: number; lon: number; t: number }>(
    'SELECT lat, lon, t FROM unmatched ORDER BY t'
  );
  const tiles = await db.getAllAsync<{ tile_id: string; segments: string }>('SELECT tile_id, segments FROM tiles');
  const counts = await db.getFirstAsync<{ drives: number; points: number }>(
    'SELECT (SELECT COUNT(*) FROM drives) AS drives, (SELECT COUNT(*) FROM points) AS points'
  );
  return {
    onboarded: onboarded === 'true',
    homeCounty,
    driven: driven.map((r) => ({ id: r.id, shape: r.shape ? (JSON.parse(r.shape) as Shape) : null, county: r.county })),
    excluded: excluded.map((r) => ({ id: r.id, county: r.county, lengthM: r.length_m })),
    unmatched: unmatched.map((r) => ({ latitude: r.lat, longitude: r.lon, timestamp: r.t })),
    tiles: tiles.map((r) => ({ tileId: r.tile_id, segments: JSON.parse(r.segments) as RoadSegment[] })),
    driveCount: counts?.drives ?? 0,
    pointCount: counts?.points ?? 0,
  };
}

// --- driven / excluded / unmatched ---

export async function addDriven(rows: { id: string; shape: Shape | null; county: number | null }[]) {
  if (rows.length === 0) return;
  const now = Date.now();
  await write(async (db) => {
    await bulk(
      db,
      DRIVEN_UPSERT,
      rows.map((r) => [r.id, r.shape ? JSON.stringify(r.shape) : null, now, r.county])
    );
  });
}

// Fills in the county for excluded roads recorded before we knew it.
export async function fillExcludedInfo(rows: { id: string; county: number | null; lengthM: number }[]) {
  if (rows.length === 0) return;
  await write(async (db) => {
    await bulk(
      db,
      'UPDATE excluded_roads SET county = COALESCE(county, ?), length_m = COALESCE(length_m, ?) WHERE id = ?',
      rows.map((r) => [r.county, r.lengthM, r.id])
    );
  });
}

export async function removeDriven(id: string) {
  await write((db) => db.runAsync('DELETE FROM driven WHERE id = ?', [id]));
}

export async function setExcluded(id: string, excluded: boolean, county: number | null = null, lengthM: number | null = null) {
  await write((db) =>
    excluded
      ? db.runAsync('INSERT OR REPLACE INTO excluded_roads (id, county, length_m) VALUES (?, ?, ?)', [id, county, lengthM])
      : db.runAsync('DELETE FROM excluded_roads WHERE id = ?', [id])
  );
}

export async function addUnmatched(points: StoredPoint[]) {
  if (points.length === 0) return;
  await write(async (db) => {
    await bulk(
      db,
      'INSERT OR IGNORE INTO unmatched (lat, lon, t) VALUES (?, ?, ?)',
      points.map((p) => [p.latitude, p.longitude, p.timestamp])
    );
  });
}

export async function replaceUnmatched(points: StoredPoint[]) {
  await write(async (db) => {
    await db.runAsync('DELETE FROM unmatched');
    await bulk(
      db,
      'INSERT OR IGNORE INTO unmatched (lat, lon, t) VALUES (?, ?, ?)',
      points.map((p) => [p.latitude, p.longitude, p.timestamp])
    );
  });
}

// --- drives / raw trail ---

export async function startDrive(startedAt: number): Promise<number> {
  const res = await write((db) => db.runAsync('INSERT INTO drives (started_at) VALUES (?)', [startedAt]));
  return res.lastInsertRowId;
}

export async function addPoints(driveId: number, points: StoredPoint[]) {
  if (points.length === 0) return;
  await write(async (db) => {
    await bulk(
      db,
      'INSERT INTO points (drive_id, lat, lon, t, acc) VALUES (?, ?, ?, ?, ?)',
      points.map((p) => [driveId, p.latitude, p.longitude, p.timestamp, p.accuracy ?? null])
    );
  });
}

export type DriveRecord = { id: number; startedAt: number; leftOut: boolean; points: StoredPoint[] };

// Every saved drive with its points, oldest first. Only loaded on demand
// (re-checking drives, showing the raw trail) since it keeps growing.
export async function loadDrives(): Promise<DriveRecord[]> {
  const db = await getDb();
  const drives = await db.getAllAsync<{ id: number; started_at: number; left_out: number }>(
    'SELECT id, started_at, left_out FROM drives ORDER BY started_at'
  );
  const rows = await db.getAllAsync<{ drive_id: number; lat: number; lon: number; t: number; acc: number | null }>(
    'SELECT drive_id, lat, lon, t, acc FROM points ORDER BY drive_id, t, rowid'
  );
  const byDrive = new Map<number, StoredPoint[]>();
  for (const r of rows) {
    const p = { latitude: r.lat, longitude: r.lon, timestamp: r.t, accuracy: r.acc };
    const list = byDrive.get(r.drive_id);
    if (list) list.push(p);
    else byDrive.set(r.drive_id, [p]);
  }
  return drives.map((d) => ({ id: d.id, startedAt: d.started_at, leftOut: d.left_out === 1, points: byDrive.get(d.id) || [] }));
}

export async function loadDrivePoints(driveId: number): Promise<StoredPoint[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ lat: number; lon: number; t: number; acc: number | null }>(
    'SELECT lat, lon, t, acc FROM points WHERE drive_id = ? ORDER BY t, rowid',
    [driveId]
  );
  return rows.map((r) => ({ latitude: r.lat, longitude: r.lon, timestamp: r.t, accuracy: r.acc }));
}

export type DriveSummary = {
  id: number;
  startedAt: number;
  endedAt: number | null;
  distanceM: number | null;
  newM: number | null;
  pointCount: number;
  ignoredN: number | null;
  leftOut: boolean;
};

// For the Drives list, newest first.
export async function listDrives(): Promise<DriveSummary[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    started_at: number;
    ended_at: number | null;
    distance_m: number | null;
    new_m: number | null;
    ignored_n: number | null;
    left_out: number;
    n: number;
    last_t: number | null;
  }>(
    'SELECT d.id, d.started_at, d.ended_at, d.distance_m, d.new_m, d.ignored_n, d.left_out, COUNT(p.drive_id) AS n, MAX(p.t) AS last_t ' +
      'FROM drives d LEFT JOIN points p ON p.drive_id = d.id GROUP BY d.id ORDER BY d.started_at DESC'
  );
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? r.last_t,
    distanceM: r.distance_m,
    newM: r.new_m,
    pointCount: r.n,
    ignoredN: r.ignored_n,
    leftOut: r.left_out === 1,
  }));
}

export async function setDriveStats(
  rows: { id: number; endedAt: number | null; distanceM: number; newM: number; ignoredN: number }[]
) {
  if (rows.length === 0) return;
  await write(async (db) => {
    await bulk(
      db,
      'UPDATE drives SET ended_at = COALESCE(?, ended_at), distance_m = ?, new_m = ?, ignored_n = ? WHERE id = ?',
      rows.map((r) => [r.endedAt, r.distanceM, r.newM, r.ignoredN, r.id])
    );
  });
}

export async function setDriveLeftOut(driveId: number, leftOut: boolean) {
  await write((db) => db.runAsync('UPDATE drives SET left_out = ? WHERE id = ?', [leftOut ? 1 : 0, driveId]));
}

// --- roads each drive covered (heatmap) ---

export async function setDriveRoads(driveId: number, chunkIds: string[]) {
  await write(async (db) => {
    await db.runAsync('DELETE FROM drive_roads WHERE drive_id = ?', [driveId]);
    await bulk(db, 'INSERT OR IGNORE INTO drive_roads (drive_id, chunk_id) VALUES (?, ?)', chunkIds.map((c) => [driveId, c]));
  });
}

export async function replaceAllDriveRoads(all: Map<number, string[]>) {
  await write(async (db) => {
    await db.runAsync('DELETE FROM drive_roads');
    const rows: (string | number)[][] = [];
    all.forEach((ids, driveId) => ids.forEach((c) => rows.push([driveId, c])));
    await bulk(db, 'INSERT OR IGNORE INTO drive_roads (drive_id, chunk_id) VALUES (?, ?)', rows);
  });
}

export async function loadDriveRoads(driveId: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ chunk_id: string }>('SELECT chunk_id FROM drive_roads WHERE drive_id = ?', [driveId]);
  return rows.map((r) => r.chunk_id);
}

// How many drives (not left out) covered each chunk.
export async function loadRoadCounts(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ chunk_id: string; n: number }>(
    'SELECT r.chunk_id, COUNT(*) AS n FROM drive_roads r JOIN drives d ON d.id = r.drive_id WHERE d.left_out = 0 GROUP BY r.chunk_id'
  );
  return new Map(rows.map((r) => [r.chunk_id, r.n]));
}

export async function deleteDrive(driveId: number) {
  await write(async (db) => {
    await db.runAsync('DELETE FROM drive_roads WHERE drive_id = ?', [driveId]);
    await db.runAsync('DELETE FROM points WHERE drive_id = ?', [driveId]);
    await db.runAsync('DELETE FROM drives WHERE id = ?', [driveId]);
  });
}

/**
 * Tidies the saved drives, once: a recording with a long pause in it (the
 * tracker left on between two trips) is split into separate drives, and
 * empty recordings are dropped. No points are deleted except those in
 * recordings with fewer than 2 points.
 */
export async function splitDrivesOnGaps(gapMs: number): Promise<{ split: number; dropped: number }> {
  const db = await getDb();
  const drives = await db.getAllAsync<{ id: number }>('SELECT id FROM drives');
  let split = 0;
  let dropped = 0;
  await write(async (db) => {
    for (const d of drives) {
      const ts = await db.getAllAsync<{ t: number }>('SELECT t FROM points WHERE drive_id = ? ORDER BY t', [d.id]);
      if (ts.length < 2) {
        await db.runAsync('DELETE FROM points WHERE drive_id = ?', [d.id]);
        await db.runAsync('DELETE FROM drives WHERE id = ?', [d.id]);
        dropped++;
        continue;
      }
      const starts: number[] = [];
      for (let i = 1; i < ts.length; i++) if (ts[i].t - ts[i - 1].t > gapMs) starts.push(ts[i].t);
      // Latest piece first, so each move only takes that piece's points.
      for (const start of starts.reverse()) {
        let startedAt = start;
        let res = await db.runAsync('INSERT OR IGNORE INTO drives (started_at) VALUES (?)', [startedAt]);
        while (res.changes === 0) {
          startedAt += 1; // started_at must be unique
          res = await db.runAsync('INSERT OR IGNORE INTO drives (started_at) VALUES (?)', [startedAt]);
        }
        await db.runAsync('UPDATE points SET drive_id = ? WHERE drive_id = ? AND t >= ?', [res.lastInsertRowId, d.id, start]);
        split++;
      }
    }
  });
  // Pieces that only got 1 point are dropped too.
  const tiny = await db.getAllAsync<{ id: number }>(
    'SELECT d.id FROM drives d LEFT JOIN points p ON p.drive_id = d.id GROUP BY d.id HAVING COUNT(p.drive_id) < 2'
  );
  if (tiny.length > 0) {
    await write(async (db) => {
      for (const d of tiny) {
        await db.runAsync('DELETE FROM points WHERE drive_id = ?', [d.id]);
        await db.runAsync('DELETE FROM drives WHERE id = ?', [d.id]);
      }
    });
    dropped += tiny.length;
  }
  return { split, dropped };
}

// --- partly-driven chunks (coverage that adds up across drives) ---

export type Stretches = [number, number][];

export async function loadPartials(): Promise<Map<string, Stretches>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ chunk_id: string; stretches: string }>('SELECT chunk_id, stretches FROM partial_coverage');
  return new Map(rows.map((r) => [r.chunk_id, JSON.parse(r.stretches) as Stretches]));
}

// null = no longer needed (the chunk is now fully driven).
export async function savePartials(entries: [string, Stretches | null][]) {
  if (entries.length === 0) return;
  await write(async (db) => {
    for (const [id, stretches] of entries) {
      if (stretches) {
        await db.runAsync('INSERT OR REPLACE INTO partial_coverage (chunk_id, stretches) VALUES (?, ?)', [id, JSON.stringify(stretches)]);
      } else {
        await db.runAsync('DELETE FROM partial_coverage WHERE chunk_id = ?', [id]);
      }
    }
  });
}

export async function replacePartials(all: Map<string, Stretches>) {
  await write(async (db) => {
    await db.runAsync('DELETE FROM partial_coverage');
    await bulk(
      db,
      'INSERT INTO partial_coverage (chunk_id, stretches) VALUES (?, ?)',
      Array.from(all.entries()).map(([id, st]) => [id, JSON.stringify(st)])
    );
  });
}

// --- hand edits and re-check results ---

export async function markUnmarked(id: string) {
  await write((db) => db.runAsync('INSERT OR REPLACE INTO unmarked (id, at) VALUES (?, ?)', [id, Date.now()]));
}

export async function loadUnmarked(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; at: number }>('SELECT id, at FROM unmarked');
  return new Map(rows.map((r) => [r.id, r.at]));
}

/**
 * Applies the result of re-checking drives: adds newly confirmed roads and
 * removes ones that no longer pass. Removed roads are kept in
 * driven_removed so the change can be undone (not when the removal is
 * because you deleted the drive they came from).
 */
export async function applyRecheck(
  add: { id: string; shape: Shape | null; county: number | null }[],
  remove: string[],
  keepForUndo = true
) {
  const now = Date.now();
  await write(async (db) => {
    if (keepForUndo) {
      await bulk(
        db,
        'INSERT OR REPLACE INTO driven_removed (id, shape, first_at, county, removed_at) ' +
          'SELECT id, shape, first_at, county, ? FROM driven WHERE id = ?',
        remove.map((id) => [now, id])
      );
    }
    await bulk(db, 'DELETE FROM driven WHERE id = ?', remove.map((id) => [id]));
    await bulk(db, DRIVEN_UPSERT, add.map((r) => [r.id, r.shape ? JSON.stringify(r.shape) : null, now, r.county]));
  });
}

// When each driven road was first marked.
export async function loadDrivenFirstAt(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; first_at: number }>('SELECT id, first_at FROM driven');
  return new Map(rows.map((r) => [r.id, r.first_at]));
}

// Roads you put back by hand after a re-check: re-checks leave them alone.
export async function loadPinned(): Promise<Set<string>> {
  const db = await getDb();
  await db.execAsync('CREATE TABLE IF NOT EXISTS pinned_roads (id TEXT PRIMARY KEY NOT NULL)');
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM pinned_roads');
  return new Set(rows.map((r) => r.id));
}

export async function countRemoved(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM driven_removed');
  return row?.n ?? 0;
}

// Puts back everything re-checks have removed.
export async function restoreRemoved(): Promise<number> {
  const n = await countRemoved();
  if (n === 0) return 0;
  await write(async (db) => {
    await db.runAsync(
      'INSERT OR IGNORE INTO driven (id, shape, first_at, county) SELECT id, shape, first_at, county FROM driven_removed'
    );
    await db.execAsync('CREATE TABLE IF NOT EXISTS pinned_roads (id TEXT PRIMARY KEY NOT NULL)');
    await db.runAsync('INSERT OR IGNORE INTO pinned_roads (id) SELECT id FROM driven_removed');
    await db.runAsync('DELETE FROM driven_removed');
    // Anything restored shouldn't be taken away again by the next re-check.
    await db.runAsync('DELETE FROM unmarked WHERE id IN (SELECT id FROM driven)');
  });
  return n;
}

// --- tile cache (disposable) ---

export async function putTiles(entries: TileEntry[], pinned: boolean) {
  if (entries.length === 0) return;
  const now = Date.now();
  await write(async (db) => {
    await bulk(
      db,
      'INSERT INTO tiles (tile_id, segments, pinned, last_used_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(tile_id) DO UPDATE SET segments = excluded.segments, pinned = MAX(tiles.pinned, excluded.pinned), last_used_at = excluded.last_used_at',
      entries.map((e) => [e.tileId, JSON.stringify(e.segments), pinned ? 1 : 0, now])
    );
  });
}

// Marks tiles as recently used (you've been near them), so they aren't
// cleared out as stale.
export async function touchTiles(tileIds: string[]) {
  if (tileIds.length === 0) return;
  const now = Date.now();
  await write(async (db) => {
    await bulk(db, 'UPDATE tiles SET last_used_at = ? WHERE tile_id = ?', tileIds.map((id) => [now, id]));
  });
}

export async function evictStaleTiles(): Promise<number> {
  const res = await write((db) =>
    db.runAsync('DELETE FROM tiles WHERE pinned = 0 AND last_used_at < ?', [Date.now() - TILE_MAX_IDLE_MS])
  );
  return res.changes;
}

export async function clearTiles() {
  await write((db) => db.runAsync('DELETE FROM tiles'));
}

// --- reset (dev tool) ---

export async function resetProgress() {
  await write(async (db) => {
    await db.runAsync('DELETE FROM driven');
    await db.runAsync('DELETE FROM excluded_roads');
    await db.runAsync('DELETE FROM unmatched');
    await db.runAsync('DELETE FROM points');
    await db.runAsync('DELETE FROM drives');
    await db.runAsync('DELETE FROM unmarked');
    await db.runAsync('DELETE FROM driven_removed');
    await db.runAsync('DELETE FROM partial_coverage');
    await db.runAsync('DELETE FROM drive_roads');
    await db.execAsync('CREATE TABLE IF NOT EXISTS pinned_roads (id TEXT PRIMARY KEY NOT NULL)');
    await db.runAsync('DELETE FROM pinned_roads');
  });
}

// --- backup / restore ---

const BACKUP_FORMAT = 'tarmacked-backup';
const BACKUP_VERSION = 1;

// Your history only — road data isn't included since it can always be
// re-downloaded, which keeps the backup file small.
export async function exportBackup() {
  const db = await getDb();
  const homeCounty = await getMeta('home_county');
  const driven = await db.getAllAsync<{ id: string; shape: string | null; first_at: number; county: number | null }>(
    'SELECT id, shape, first_at, county FROM driven'
  );
  const excluded = await db.getAllAsync<{ id: string; county: number | null; length_m: number | null }>(
    'SELECT id, county, length_m FROM excluded_roads'
  );
  const unmatched = await db.getAllAsync<{ lat: number; lon: number; t: number }>('SELECT lat, lon, t FROM unmatched');
  const drives = await db.getAllAsync<{ id: number; started_at: number; left_out: number }>(
    'SELECT id, started_at, left_out FROM drives ORDER BY id'
  );
  const unmarked = await db.getAllAsync<{ id: string; at: number }>('SELECT id, at FROM unmarked');
  const points = await db.getAllAsync<{ drive_id: number; lat: number; lon: number; t: number; acc: number | null }>(
    'SELECT drive_id, lat, lon, t, acc FROM points ORDER BY drive_id, rowid'
  );
  // [lat, lon, t] or [lat, lon, t, accuracy] (v0.14+; older app versions ignore the 4th).
  const pointsByDrive = new Map<number, number[][]>();
  for (const p of points) {
    const row = p.acc == null ? [p.lat, p.lon, p.t] : [p.lat, p.lon, p.t, p.acc];
    const list = pointsByDrive.get(p.drive_id);
    if (list) list.push(row);
    else pointsByDrive.set(p.drive_id, [row]);
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    homeCounty,
    driven: driven.map((r) => ({ id: r.id, s: r.shape ? JSON.parse(r.shape) : null, t: r.first_at, c: r.county })),
    excluded: excluded.map((r) => ({ id: r.id, c: r.county, l: r.length_m })),
    unmatched: unmatched.map((r) => [r.lat, r.lon, r.t]),
    drives: drives.map((d) => ({ startedAt: d.started_at, leftOut: d.left_out === 1 || undefined, points: pointsByDrive.get(d.id) || [] })),
    unmarked: unmarked.map((u) => [u.id, u.at]),
  };
}

/**
 * Restores a backup by MERGING it into what's on the phone — nothing on
 * the phone is deleted or overwritten, so restoring an old backup can
 * never lose newer progress. Drives already present are skipped.
 */
export async function importBackup(data: any) {
  if (!data || data.format !== BACKUP_FORMAT) throw new Error("That file isn't a tarmacked backup.");
  if (data.version !== BACKUP_VERSION) throw new Error(`Unsupported backup version (${data.version}).`);
  let drivesAdded = 0;
  await write(async (db) => {
    await bulk(
      db,
      'INSERT INTO driven (id, shape, first_at, county) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ' +
        'shape = COALESCE(driven.shape, excluded.shape), county = COALESCE(driven.county, excluded.county), ' +
        'first_at = MIN(driven.first_at, excluded.first_at)',
      (data.driven || []).map((d: any) => [d.id, d.s ? JSON.stringify(d.s) : null, d.t ?? Date.now(), d.c ?? null])
    );
    await bulk(
      db,
      'INSERT OR IGNORE INTO excluded_roads (id, county, length_m) VALUES (?, ?, ?)',
      (data.excluded || []).map((e: any) => (typeof e === 'string' ? [e, null, null] : [e.id, e.c ?? null, e.l ?? null]))
    );
    await bulk(db, 'INSERT OR IGNORE INTO unmatched (lat, lon, t) VALUES (?, ?, ?)', data.unmatched || []);
    for (const drive of data.drives || []) {
      if (!drive.points || drive.points.length === 0) continue;
      const res = await db.runAsync('INSERT OR IGNORE INTO drives (started_at, left_out) VALUES (?, ?)', [
        drive.startedAt,
        drive.leftOut ? 1 : 0,
      ]);
      if (res.changes === 0) continue;
      const driveId = res.lastInsertRowId;
      await bulk(
        db,
        'INSERT INTO points (drive_id, lat, lon, t, acc) VALUES (?, ?, ?, ?, ?)',
        drive.points.map((p: number[]) => [driveId, p[0], p[1], p[2], p[3] ?? null])
      );
      drivesAdded++;
    }
    await bulk(db, 'INSERT OR IGNORE INTO unmarked (id, at) VALUES (?, ?)', data.unmarked || []);
    if (data.homeCounty) {
      await db.runAsync("INSERT OR IGNORE INTO meta (key, value) VALUES ('home_county', ?)", [data.homeCounty]);
    }
  });
  return { driven: (data.driven || []).length, drivesAdded };
}
