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

// speed (m/s) comes with live GPS fixes but isn't stored.
export type StoredPoint = { latitude: number; longitude: number; timestamp: number; accuracy?: number | null; speed?: number | null };
export type Shape = [number, number][];
export type TileEntry = { tileId: string; segments: RoadSegment[] };
export type CachedTile = TileEntry & { version: string | null };

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
  // v0.15: drive status (recording / pending confirmation / done), auto-detected
  // drives, one row per GPS point (duplicates removed), and a saved log.
  if (!have.has('status')) await db.execAsync("ALTER TABLE drives ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
  if (!have.has('auto')) await db.execAsync('ALTER TABLE drives ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
  const idx = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'points_unique'");
  if (idx.length === 0) {
    await db.execAsync(`
      DELETE FROM points WHERE rowid NOT IN (SELECT MIN(rowid) FROM points GROUP BY drive_id, t);
      CREATE UNIQUE INDEX IF NOT EXISTS points_unique ON points(drive_id, t);
    `);
  }
  // v0.15.2: points_unique (drive_id, t) already serves every lookup by
  // drive, so the older drive_id-only index just slowed down each GPS write.
  await db.execAsync('DROP INDEX IF EXISTS points_by_drive');
  await db.execAsync('CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, line TEXT NOT NULL)');
  // v0.15.2: times each drive went over a chunk (up and back down = 2).
  const rcols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(drive_roads)');
  if (!rcols.some((c) => c.name === 'n')) await db.execAsync('ALTER TABLE drive_roads ADD COLUMN n INTEGER NOT NULL DEFAULT 1');
  // v0.17: which version of the road data each cached tile came from
  // (tiles from before have none, and are re-downloaded when online).
  const tcols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(tiles)');
  if (!tcols.some((c) => c.name === 'version')) await db.execAsync('ALTER TABLE tiles ADD COLUMN version TEXT');
  return db;
}

// Runs a statement for many rows inside one transaction. Rows are run
// synchronously where expo-sqlite allows it: one native call per row
// instead of one awaited promise per row — many times faster for the
// tens of thousands of rows a re-check writes.
async function bulk(db: SQLite.SQLiteDatabase, sql: string, rows: (string | number | null)[][]) {
  if (rows.length === 0) return;
  const stmt = await db.prepareAsync(sql);
  try {
    if (typeof stmt.executeSync === 'function') {
      for (let i = 0; i < rows.length; i++) {
        stmt.executeSync(rows[i]);
        if (i % 2000 === 1999) await new Promise<void>((r) => setTimeout(r, 0)); // let the UI breathe
      }
    } else {
      for (const r of rows) await stmt.executeAsync(r);
    }
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
        'INSERT OR IGNORE INTO points (drive_id, lat, lon, t) VALUES (?, ?, ?, ?)',
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
  const counts = await db.getFirstAsync<{ drives: number; points: number }>(
    'SELECT (SELECT COUNT(*) FROM drives) AS drives, (SELECT COUNT(*) FROM points) AS points'
  );
  return {
    onboarded: onboarded === 'true',
    homeCounty,
    driven: driven.map((r) => ({ id: r.id, shape: r.shape ? (JSON.parse(r.shape) as Shape) : null, county: r.county })),
    excluded: excluded.map((r) => ({ id: r.id, county: r.county, lengthM: r.length_m })),
    unmatched: unmatched.map((r) => ({ latitude: r.lat, longitude: r.lon, timestamp: r.t })),
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

export type DrivenRow = { id: string; shape: Shape | null; firstAt: number; county: number | null };

// Un-marking by hand (v0.16): removes these pieces and returns them as they
// were, so the edit can be undone exactly (same shape, same first-driven time).
export async function removeDrivenPieces(ids: string[]): Promise<DrivenRow[]> {
  if (ids.length === 0) return [];
  return write(async (db) => {
    const out: DrivenRow[] = [];
    for (const id of ids) {
      const r = await db.getFirstAsync<{ id: string; shape: string | null; first_at: number; county: number | null }>(
        'SELECT id, shape, first_at, county FROM driven WHERE id = ?',
        [id]
      );
      if (!r) continue;
      out.push({ id: r.id, shape: r.shape ? (JSON.parse(r.shape) as Shape) : null, firstAt: r.first_at, county: r.county });
      await db.runAsync('DELETE FROM driven WHERE id = ?', [id]);
    }
    return out;
  });
}

// Undo of an un-mark: the pieces go back exactly as they were.
export async function restoreDriven(rows: DrivenRow[]) {
  if (rows.length === 0) return;
  await write(async (db) => {
    await bulk(
      db,
      'INSERT OR REPLACE INTO driven (id, shape, first_at, county) VALUES (?, ?, ?, ?)',
      rows.map((r) => [r.id, r.shape ? JSON.stringify(r.shape) : null, r.firstAt, r.county])
    );
  });
}

// The time a road was un-marked by hand, or null if it isn't.
export async function getUnmarked(id: string): Promise<number | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ at: number }>('SELECT at FROM unmarked WHERE id = ?', [id]);
  return r ? r.at : null;
}

// Sets (or with null, clears) a road's un-marked time — for undo.
export async function setUnmarked(id: string, at: number | null) {
  await write((db) =>
    at === null
      ? db.runAsync('DELETE FROM unmarked WHERE id = ?', [id])
      : db.runAsync('INSERT OR REPLACE INTO unmarked (id, at) VALUES (?, ?)', [id, at])
  );
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

// A new drive, recording. auto = started by automatic drive detection.
export async function startDrive(startedAt: number, auto = false): Promise<number> {
  const res = await write((db) =>
    db.runAsync("INSERT INTO drives (started_at, status, auto) VALUES (?, 'recording', ?)", [startedAt, auto ? 1 : 0])
  );
  return res.lastInsertRowId;
}

export type DriveStatus = 'recording' | 'pending' | 'done';

export async function setDriveStatus(driveId: number, status: DriveStatus, endedAt?: number) {
  await write((db) =>
    endedAt !== undefined
      ? db.runAsync('UPDATE drives SET status = ?, ended_at = ? WHERE id = ?', [status, endedAt, driveId])
      : db.runAsync('UPDATE drives SET status = ? WHERE id = ?', [status, driveId])
  );
}

// The drive currently recording, if any (e.g. after the app was closed mid-drive).
export async function getRecordingDrive(): Promise<{ id: number; startedAt: number; auto: boolean; lastT: number | null } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: number; started_at: number; auto: number; last_t: number | null }>(
    "SELECT d.id, d.started_at, d.auto, (SELECT MAX(t) FROM points p WHERE p.drive_id = d.id) AS last_t " +
      "FROM drives d WHERE d.status = 'recording' ORDER BY d.started_at DESC LIMIT 1"
  );
  return row ? { id: row.id, startedAt: row.started_at, auto: row.auto === 1, lastT: row.last_t } : null;
}

// Points recorded after time t (the live drive reads new points this way).
export async function loadPointsSince(driveId: number, t: number): Promise<StoredPoint[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ lat: number; lon: number; t: number; acc: number | null }>(
    'SELECT lat, lon, t, acc FROM points WHERE drive_id = ? AND t > ? ORDER BY t',
    [driveId, t]
  );
  return rows.map((r) => ({ latitude: r.lat, longitude: r.lon, timestamp: r.t, accuracy: r.acc }));
}

// Drops points after endT (the parked tail of a drive that wasn't stopped).
export async function trimDrive(driveId: number, endT: number) {
  await write((db) => db.runAsync('DELETE FROM points WHERE drive_id = ? AND t > ?', [driveId, endT]));
}

// Drops points before t (the walk to the car before an on-foot start).
export async function trimDriveStart(driveId: number, t: number) {
  await write((db) => db.runAsync('DELETE FROM points WHERE drive_id = ? AND t < ?', [driveId, t]));
}

export async function getDrive(driveId: number): Promise<{ id: number; startedAt: number; status: DriveStatus; auto: boolean; leftOut: boolean } | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ id: number; started_at: number; status: DriveStatus; auto: number; left_out: number }>(
    'SELECT id, started_at, status, auto, left_out FROM drives WHERE id = ?',
    [driveId]
  );
  return r ? { id: r.id, startedAt: r.started_at, status: r.status, auto: r.auto === 1, leftOut: r.left_out === 1 } : null;
}

// --- drives waiting to be matched (v0.15.2) ---
// A finished drive whose roads haven't been worked out yet (it ended with
// the app closed, or an auto drive you just saved). The open app matches
// just these drives onto the map — no need to replay your whole history.

async function readQueue(db: SQLite.SQLiteDatabase): Promise<number[]> {
  const row = await db.getFirstAsync<{ value: string | null }>("SELECT value FROM meta WHERE key = 'match_queue'");
  try {
    const v = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

export async function queueMatch(driveId: number) {
  await write(async (db) => {
    const q = await readQueue(db);
    if (!q.includes(driveId)) q.push(driveId);
    await db.runAsync("INSERT OR REPLACE INTO meta (key, value) VALUES ('match_queue', ?)", [JSON.stringify(q)]);
  });
}

export async function loadMatchQueue(): Promise<number[]> {
  return readQueue(await getDb());
}

export async function dequeueMatch(ids: number[]) {
  if (ids.length === 0) return;
  await write(async (db) => {
    const q = (await readQueue(db)).filter((x) => !ids.includes(x));
    await db.runAsync("INSERT OR REPLACE INTO meta (key, value) VALUES ('match_queue', ?)", [JSON.stringify(q)]);
  });
}

// Auto-detected drives never confirmed within maxAgeMs are deleted.
export async function deleteStalePending(maxAgeMs: number): Promise<number> {
  const db = await getDb();
  const old = await db.getAllAsync<{ id: number }>("SELECT id FROM drives WHERE status = 'pending' AND started_at < ?", [
    Date.now() - maxAgeMs,
  ]);
  for (const d of old) await deleteDrive(d.id);
  return old.length;
}

// --- saved log (for checking what happened in the background) ---

const LOG_KEEP = 500;

export async function appendLog(line: string) {
  await write(async (db) => {
    await db.runAsync('INSERT INTO log (t, line) VALUES (?, ?)', [Date.now(), line]);
    await db.runAsync('DELETE FROM log WHERE id <= (SELECT MAX(id) FROM log) - ?', [LOG_KEEP]);
  });
}

export async function loadLog(limit = LOG_KEEP): Promise<{ t: number; line: string }[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ t: number; line: string }>('SELECT t, line FROM log ORDER BY id DESC LIMIT ?', [limit]);
  return rows.reverse();
}

export async function addPoints(driveId: number, points: StoredPoint[]) {
  if (points.length === 0) return;
  await write(async (db) => {
    await bulk(
      db,
      'INSERT OR IGNORE INTO points (drive_id, lat, lon, t, acc) VALUES (?, ?, ?, ?, ?)',
      points.map((p) => [driveId, p.latitude, p.longitude, p.timestamp, p.accuracy ?? null])
    );
  });
}

export type DriveRecord = { id: number; startedAt: number; leftOut: boolean; status: DriveStatus; auto: boolean; points: StoredPoint[] };

// Every saved drive with its points, oldest first. Only loaded on demand
// (re-checking drives, showing the raw trail) since it keeps growing.
export async function loadDrives(): Promise<DriveRecord[]> {
  const db = await getDb();
  const drives = await db.getAllAsync<{ id: number; started_at: number; left_out: number; status: DriveStatus; auto: number }>(
    'SELECT id, started_at, left_out, status, auto FROM drives ORDER BY started_at'
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
  return drives.map((d) => ({
    id: d.id,
    startedAt: d.started_at,
    leftOut: d.left_out === 1,
    status: d.status,
    auto: d.auto === 1,
    points: byDrive.get(d.id) || [],
  }));
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
  status: DriveStatus;
  auto: boolean;
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
    status: DriveStatus;
    auto: number;
    n: number;
    last_t: number | null;
  }>(
    'SELECT d.id, d.started_at, d.ended_at, d.distance_m, d.new_m, d.ignored_n, d.left_out, d.status, d.auto, COUNT(p.drive_id) AS n, MAX(p.t) AS last_t ' +
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
    status: r.status,
    auto: r.auto === 1,
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

export async function setDriveDistance(driveId: number, distanceM: number) {
  await write((db) => db.runAsync('UPDATE drives SET distance_m = ? WHERE id = ?', [distanceM, driveId]));
}

export async function setDriveLeftOut(driveId: number, leftOut: boolean) {
  await write((db) => db.runAsync('UPDATE drives SET left_out = ? WHERE id = ?', [leftOut ? 1 : 0, driveId]));
}

// --- roads each drive covered (heatmap) ---

// passes: chunk -> times this drive went over it.
export async function setDriveRoads(driveId: number, passes: Map<string, number>) {
  await write(async (db) => {
    await db.runAsync('DELETE FROM drive_roads WHERE drive_id = ?', [driveId]);
    await bulk(db, 'INSERT OR IGNORE INTO drive_roads (drive_id, chunk_id, n) VALUES (?, ?, ?)', Array.from(passes, ([c, n]) => [driveId, c, n]));
  });
}

export async function replaceAllDriveRoads(all: Map<number, Map<string, number>>) {
  await write(async (db) => {
    await db.runAsync('DELETE FROM drive_roads');
    const rows: (string | number)[][] = [];
    all.forEach((passes, driveId) => passes.forEach((n, c) => rows.push([driveId, c, n])));
    await bulk(db, 'INSERT OR IGNORE INTO drive_roads (drive_id, chunk_id, n) VALUES (?, ?, ?)', rows);
  });
}

export async function loadDriveRoads(driveId: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ chunk_id: string }>('SELECT chunk_id FROM drive_roads WHERE drive_id = ?', [driveId]);
  return rows.map((r) => r.chunk_id);
}

// How many times each chunk was driven, over all saved drives (not left out).
export async function loadRoadCounts(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ chunk_id: string; n: number }>(
    "SELECT r.chunk_id, SUM(r.n) AS n FROM drive_roads r JOIN drives d ON d.id = r.drive_id WHERE d.left_out = 0 AND d.status = 'done' GROUP BY r.chunk_id"
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

// --- tile cache (disposable) ---

export async function putTiles(entries: TileEntry[], pinned: boolean, version: string | null = null) {
  if (entries.length === 0) return;
  const now = Date.now();
  await write(async (db) => {
    await bulk(
      db,
      'INSERT INTO tiles (tile_id, segments, pinned, last_used_at, version) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(tile_id) DO UPDATE SET segments = excluded.segments, pinned = MAX(tiles.pinned, excluded.pinned), ' +
        'last_used_at = excluded.last_used_at, version = excluded.version',
      entries.map((e) => [e.tileId, JSON.stringify(e.segments), pinned ? 1 : 0, now, version])
    );
  });
}

// Cached tiles by ID (any version; the caller checks).
export async function getTiles(ids: string[]): Promise<CachedTile[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const out: CachedTile[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = await db.getAllAsync<{ tile_id: string; segments: string; version: string | null }>(
      `SELECT tile_id, segments, version FROM tiles WHERE tile_id IN (${part.map(() => '?').join(',')})`,
      part
    );
    for (const r of rows) out.push({ tileId: r.tile_id, segments: JSON.parse(r.segments), version: r.version });
  }
  return out;
}

// Every cached tile. Only used when there's no road-data index yet (first
// launch of 0.17 with no signal), and to find old road shapes before a
// new version of the road data replaces them.
export async function getAllTiles(): Promise<CachedTile[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ tile_id: string; segments: string; version: string | null }>('SELECT tile_id, segments, version FROM tiles');
  return rows.map((r) => ({ tileId: r.tile_id, segments: JSON.parse(r.segments), version: r.version }));
}

// How much road data is stored on the phone.
export async function tileCacheInfo(): Promise<{ tiles: number; bytes: number; pinned: number }> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ n: number; b: number | null; p: number | null }>(
    'SELECT COUNT(*) AS n, SUM(LENGTH(segments)) AS b, SUM(pinned) AS p FROM tiles'
  );
  return { tiles: r?.n ?? 0, bytes: r?.b ?? 0, pinned: r?.p ?? 0 };
}

// "Free up storage": everything except the home county.
export async function clearUnpinnedTiles(): Promise<number> {
  const res = await write((db) => db.runAsync('DELETE FROM tiles WHERE pinned = 0'));
  return res.changes;
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

// One region's cached tiles (v0.21: other regions' are filed as "gb:t_..."),
// or all of them.
export async function clearTiles(region?: string) {
  if (!region) await write((db) => db.runAsync('DELETE FROM tiles'));
  else if (region === 'ie') await write((db) => db.runAsync("DELETE FROM tiles WHERE tile_id NOT LIKE '%:%'"));
  else await write((db) => db.runAsync('DELETE FROM tiles WHERE tile_id LIKE ?', [`${region}:%`]));
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

// "Delete all my data": everything personal on the phone — drives, roads,
// edits, the log and leftovers. Settings (home county, GPS mode, map style)
// and the downloaded road data stay.
export async function deleteAllData() {
  await resetProgress();
  await write(async (db) => {
    await db.runAsync('DELETE FROM log');
    await db.runAsync(
      "DELETE FROM meta WHERE key IN ('match_queue', 'forgotten_trails', 'recheck_pending', 'edit_migration', 'last_response')"
    );
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
  const drives = await db.getAllAsync<{ id: number; started_at: number; left_out: number; status: DriveStatus; auto: number }>(
    'SELECT id, started_at, left_out, status, auto FROM drives ORDER BY id'
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
    // status/auto (v0.15.2): so an auto drive you never saved doesn't come
    // back as a counted drive. Older backups have neither = saved drives.
    drives: drives.map((d) => ({
      startedAt: d.started_at,
      leftOut: d.left_out === 1 || undefined,
      status: d.status === 'done' ? undefined : d.status,
      auto: d.auto === 1 || undefined,
      points: pointsByDrive.get(d.id) || [],
    })),
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
      // A drive still recording when backed up is closed off: kept if you
      // started it, waiting for Save if it was auto-detected.
      const status = drive.status === 'pending' || (drive.status === 'recording' && drive.auto) ? 'pending' : 'done';
      const res = await db.runAsync('INSERT OR IGNORE INTO drives (started_at, left_out, status, auto) VALUES (?, ?, ?, ?)', [
        drive.startedAt,
        drive.leftOut ? 1 : 0,
        status,
        drive.auto ? 1 : 0,
      ]);
      if (res.changes === 0) continue;
      const driveId = res.lastInsertRowId;
      await bulk(
        db,
        'INSERT OR IGNORE INTO points (drive_id, lat, lon, t, acc) VALUES (?, ?, ?, ?, ?)',
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
