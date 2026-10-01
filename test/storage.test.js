// Storage tests on a real SQLite database (Node's built-in node:sqlite
// standing in for expo-sqlite): schema upgrade from an older install, the
// match queue, backups keeping drive status, and bulk writes.
// Run: tsc ... src/storage.ts test/stubs.d.ts; node test/storage.test.js <out dir>
const path = require('path');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');
const OUT = path.resolve(process.argv[2] || '/tmp/tarmacked-tests');

let raw = new DatabaseSync(':memory:');
const syncCalls = { n: 0 };
const toArgs = (p) => (p || []).map((v) => (v === undefined ? null : v));
const fakeDb = {
  async execAsync(sql) { raw.exec(sql); },
  async runAsync(sql, p) { const r = raw.prepare(sql).run(...toArgs(p)); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
  async getFirstAsync(sql, p) { return raw.prepare(sql).get(...toArgs(p)) ?? null; },
  async getAllAsync(sql, p) { return raw.prepare(sql).all(...toArgs(p)); },
  async prepareAsync(sql) {
    const st = raw.prepare(sql);
    return {
      async executeAsync(p) { st.run(...toArgs(p)); },
      executeSync(p) { syncCalls.n++; st.run(...toArgs(p)); },
      async finalizeAsync() {},
    };
  },
  async withTransactionAsync(fn) {
    raw.exec('BEGIN');
    try { await fn(); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; }
  },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'expo-sqlite') return { openDatabaseAsync: async () => fakeDb };
  if (req === '@react-native-async-storage/async-storage') return { default: { getItem: async () => null }, getItem: async () => null };
  return origLoad.apply(this, arguments);
};

const results = [];
function check(name, ok, info = '') { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`); }

(async () => {
  // An install from before v0.13: the old points index, no status columns.
  raw.exec(`
    CREATE TABLE drives (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL UNIQUE);
    CREATE TABLE points (drive_id INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, t INTEGER NOT NULL);
    CREATE INDEX points_by_drive ON points(drive_id);
    INSERT INTO drives (started_at) VALUES (1000);
    INSERT INTO points VALUES (1, 52.5, -7.5, 1000), (1, 52.5, -7.5, 1000), (1, 52.6, -7.5, 2000);
  `);
  const store = require(path.join(OUT, 'src/storage.js'));
  await store.getMeta('x'); // opens + upgrades
  const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'points'").all().map((r) => r.name);
  check('upgrade: duplicate points removed, unique index added, old index dropped', idx.includes('points_unique') && !idx.includes('points_by_drive') && raw.prepare('SELECT COUNT(*) n FROM points').get().n === 2, idx.join());
  const d1 = await store.getDrive(1);
  check('upgrade: old drives count as saved', d1 && d1.status === 'done' && !d1.auto);

  // Match queue
  await store.queueMatch(5);
  await store.queueMatch(7);
  await store.queueMatch(5);
  check('match queue: no duplicates', (await store.loadMatchQueue()).join() === '5,7');
  await store.dequeueMatch([5]);
  check('match queue: dequeue', (await store.loadMatchQueue()).join() === '7');
  await store.dequeueMatch([7]);

  // trimDriveStart
  const id2 = await store.startDrive(10_000, true);
  await store.addPoints(id2, [1, 2, 3, 4].map((k) => ({ latitude: 52, longitude: -7, timestamp: 10_000 + k * 1000, accuracy: 5, speed: 9 })));
  await store.trimDriveStart(id2, 12_500);
  check('trimDriveStart drops the walk before the drive', (await store.loadDrivePoints(id2)).map((p) => p.timestamp).join() === '13000,14000');

  // Backup keeps status: a pending auto drive stays pending; a recording auto drive comes back pending.
  await store.setDriveStatus(id2, 'pending');
  const id3 = await store.startDrive(20_000, true); // still recording
  await store.addPoints(id3, [{ latitude: 52, longitude: -7, timestamp: 20_500 }]);
  const id4 = await store.startDrive(30_000, false); // manual, recording
  await store.addPoints(id4, [{ latitude: 52, longitude: -7, timestamp: 30_500 }]);
  const backup = JSON.parse(JSON.stringify(await store.exportBackup()));
  // Restore into a fresh phone.
  raw = new DatabaseSync(':memory:');
  delete require.cache[require.resolve(path.join(OUT, 'src/storage.js'))];
  const fresh = require(path.join(OUT, 'src/storage.js'));
  const res = await fresh.importBackup(backup);
  const byStart = new Map((await fresh.listDrives()).map((d) => [d.startedAt, d]));
  check('backup: restored drive count', res.drivesAdded === 4, JSON.stringify(res));
  check('backup: old saved drive stays saved', byStart.get(1000).status === 'done' && !byStart.get(1000).auto);
  check('backup: unsaved auto drive stays pending (not counted)', byStart.get(10_000).status === 'pending' && byStart.get(10_000).auto);
  check('backup: auto drive still recording comes back pending', byStart.get(20_000).status === 'pending');
  check('backup: your own drive still recording comes back saved', byStart.get(30_000).status === 'done' && !byStart.get(30_000).auto);
  // A pre-0.15.2 backup (no status) restores as before: everything saved.
  raw = new DatabaseSync(':memory:');
  delete require.cache[require.resolve(path.join(OUT, 'src/storage.js'))];
  const old = require(path.join(OUT, 'src/storage.js'));
  const oldBackup = { ...backup, drives: backup.drives.map(({ status, auto, ...d }) => d) };
  await old.importBackup(oldBackup);
  check('backup: older backups (no status) still restore, as saved drives', (await old.listDrives()).every((d) => d.status === 'done'));

  // Heatmap: passes per drive add up; unsaved drives don't count.
  const ds = await old.listDrives();
  const saved = ds.filter((d) => d.status === 'done');
  await old.setDriveRoads(saved[0].id, new Map([['way/x#0', 2]]));
  await old.setDriveRoads(saved[1].id, new Map([['way/x#0', 1]]));
  const counts = await old.loadRoadCounts();
  check('heatmap: up-and-back (2) plus another drive (1) = 3', counts.get('way/x#0') === 3, JSON.stringify([...counts]));

  // Undo for un-marking (v0.16): pieces come back exactly, un-mark cleared.
  await old.applyRecheck([{ id: 'way/u#0~0-40', shape: [[1, 2], [1.1, 2]], county: 3 }, { id: 'way/u#0~40-90', shape: null, county: 3 }], [], false);
  const firstBefore = (await old.loadDrivenFirstAt()).get('way/u#0~0-40');
  const removed = await old.removeDrivenPieces(['way/u#0~0-40', 'way/u#0~40-90', 'way/nope#0']);
  await old.markUnmarked('way/u#0');
  const goneOk = removed.length === 2 && !(await old.loadDrivenFirstAt()).has('way/u#0~0-40');
  await old.restoreDriven(removed);
  await old.setUnmarked('way/u#0', null);
  const back = await old.loadDrivenFirstAt();
  check('undo un-mark: pieces back with their shape and first-driven time, un-mark cleared',
    goneOk && back.get('way/u#0~0-40') === firstBefore && back.has('way/u#0~40-90') && (await old.getUnmarked('way/u#0')) === null &&
    JSON.stringify(removed[0].shape) === '[[1,2],[1.1,2]]');
  await old.setUnmarked('way/u#0', 1234);
  check('undo restores an older un-mark time', (await old.getUnmarked('way/u#0')) === 1234);

  // Bulk writes go through the synchronous path, all-or-nothing.
  syncCalls.n = 0;
  const many = new Map([[1, new Map(Array.from({ length: 5000 }, (_, i) => [`way/${i}#0`, 1]))]]);
  await old.replaceAllDriveRoads(many);
  check('bulk: 5000 rows written synchronously', syncCalls.n === 5000 && raw.prepare('SELECT COUNT(*) n FROM drive_roads').get().n === 5000);
  let threw = false;
  try {
    await old.applyRecheck([{ id: 'a', shape: null, county: null }], [], false);
    await old.importBackup({ format: 'tarmacked-backup', version: 1, driven: [{ id: 'b', s: null, t: 1, c: null }, { id: null, s: null, t: 1, c: null }] });
  } catch {
    threw = true;
  }
  const hasB = raw.prepare("SELECT COUNT(*) n FROM driven WHERE id = 'b'").get().n;
  check('bulk: a failing row rolls back the whole write', threw && hasB === 0);

  console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
})();
