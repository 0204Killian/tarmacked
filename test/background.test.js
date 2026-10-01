// Scenario tests for src/background.ts with fake iOS services (location,
// geofence, notifications, motion) and an in-memory store.
// Run: tsc --target es2020 --module commonjs --outDir /tmp/bgt src/background.ts src/driveWatch.ts src/geo.ts modules/motion-activity/index.ts test/stubs.d.ts; node test/background.test.js /tmp/bgt
const path = require('path');
const Module = require('module');
const OUT = path.resolve(process.argv[2] || '/tmp/bgt');

// ---- fake clock ----
let now = Date.parse('2026-10-01T08:00:00Z');
Date.now = () => now;

// ---- fakes ----
const tasks = {};
const fake = {
  location: {
    updates: false, fences: null, lastKnown: null, bgPerm: 'granted', starts: 0,
    Accuracy: { BestForNavigation: 6, High: 4, Balanced: 3 }, ActivityType: { AutomotiveNavigation: 2 },
    GeofencingEventType: { Enter: 1, Exit: 2 },
    lastOpts: null,
    async startLocationUpdatesAsync(_t, o) { fake.location.updates = true; fake.location.starts++; fake.location.lastOpts = o; },
    async stopLocationUpdatesAsync() { fake.location.updates = false; },
    async hasStartedLocationUpdatesAsync() { return fake.location.updates; },
    async getBackgroundPermissionsAsync() { return { status: fake.location.bgPerm, canAskAgain: true }; },
    async startGeofencingAsync(_t, regions) { fake.location.fences = regions; },
    async stopGeofencingAsync() { fake.location.fences = null; },
    async hasStartedGeofencingAsync() { return !!fake.location.fences; },
    async getLastKnownPositionAsync() { return fake.location.lastKnown ? { coords: { latitude: fake.location.lastKnown[0], longitude: fake.location.lastKnown[1] } } : null; },
    async getCurrentPositionAsync() { return fake.location.lastKnown ? { coords: { latitude: fake.location.lastKnown[0], longitude: fake.location.lastKnown[1] } } : null; },
  },
  tm: { defineTask(name, fn) { tasks[name] = fn; } },
  notif: {
    scheduled: new Map(), log: [],
    SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
    setNotificationHandler() {}, async setNotificationCategoryAsync() {},
    async scheduleNotificationAsync(r) { fake.notif.scheduled.set(r.identifier, { ...r, at: now + r.trigger.seconds * 1000 }); fake.notif.log.push(r.content.title); },
    async cancelScheduledNotificationAsync(id) { fake.notif.scheduled.delete(id); },
    async dismissNotificationAsync() {},
  },
  motion: { acts: [], async queryActivities() { return fake.motion.acts; }, isAvailable: () => true, authorizationStatus: () => 'authorized' },
};
// In-memory store with the functions background.ts uses.
const db = { meta: {}, drives: new Map(), points: new Map(), log: [], nextId: 1 };
const store = {
  async getMeta(k) { return db.meta[k] ?? null; },
  async setMeta(k, v) { db.meta[k] = v; },
  async appendLog(l) { db.log.push(l); },
  async startDrive(at, auto) { const id = db.nextId++; db.drives.set(id, { id, startedAt: at, auto, status: 'recording' }); db.points.set(id, []); return id; },
  async addPoints(id, pts) { const list = db.points.get(id); for (const p of pts) if (!list.some((q) => q.timestamp === p.timestamp)) list.push(p); },
  async trimDrive(id, t) { db.points.set(id, db.points.get(id).filter((p) => p.timestamp <= t)); },
  async setDriveStatus(id, status, endedAt) { const d = db.drives.get(id); if (d) { d.status = status; if (endedAt !== undefined) d.endedAt = endedAt; } },
  async setDriveDistance(id, m) { const d = db.drives.get(id); if (d) d.distanceM = m; },
  async deleteDrive(id) { db.drives.delete(id); db.points.delete(id); },
  async getRecordingDrive() { const d = [...db.drives.values()].find((x) => x.status === 'recording'); return d ? { id: d.id, startedAt: d.startedAt, auto: d.auto, lastT: null } : null; },
  async queueMatch(id) { const q = JSON.parse(db.meta.match_queue || '[]'); if (!q.includes(id)) q.push(id); db.meta.match_queue = JSON.stringify(q); },
  async trimDriveStart(id, t) { db.points.set(id, db.points.get(id).filter((p) => p.timestamp >= t)); },
  async deleteStalePending(ms) { let n = 0; for (const d of [...db.drives.values()]) if (d.status === 'pending' && d.startedAt < now - ms) { db.drives.delete(d.id); n++; } return n; },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'expo-location') return fake.location;
  if (req === 'expo-task-manager') return fake.tm;
  if (req === 'expo-notifications') return fake.notif;
  if (req === './storage') return store;
  if (req.endsWith('modules/motion-activity')) return fake.motion;
  return origLoad.apply(this, arguments);
};
const bg = require(path.join(OUT, 'src/background.js'));
const events = [];
bg.onChange((e) => events.push(e));
const queued = () => JSON.parse(db.meta.match_queue || '[]');

// ---- helpers ----
const M_LAT = 111320, M_LON = 111320 * Math.cos((53 * Math.PI) / 180);
const at = (x, y) => [53 + y / M_LAT, -7.3 + x / M_LON]; // metres east/north of a fixed point
async function gps(x, y, speed = null) {
  const [la, lo] = at(x, y);
  fake.location.lastKnown = [la, lo];
  await tasks[bg.LOCATION_TASK]({ data: { locations: [{ coords: { latitude: la, longitude: lo, accuracy: 5, speed }, timestamp: now }] } });
}
// Drive east at `speed` m/s for `metres`, a point every 2 s.
async function driveEast(fromX, metres, speed = 20) {
  let x = fromX;
  while (x < fromX + metres) { now += 2000; x += speed * 2; await gps(x, 0, speed); }
  return x;
}
let jseed = 7;
const jrand = () => ((jseed = (jseed * 16807) % 2147483647) / 2147483647);
async function park(x, minutes) {
  for (let s = 0; s < minutes * 60; s += 30) { now += 30000; await gps(x + (jrand() - 0.5) * 8, (jrand() - 0.5) * 8); }
}
async function fenceExit() { await tasks[bg.GEOFENCE_TASK]({ data: { eventType: 2 } }); }
function reset() {
  db.meta = {}; db.drives.clear(); db.points.clear(); db.log = []; db.nextId = 1;
  fake.location.updates = false; fake.location.fences = null; fake.location.starts = 0; fake.location.bgPerm = 'granted'; fake.location.lastOpts = null; fake.notif.scheduled.clear(); fake.notif.log = []; fake.motion.acts = []; events.length = 0;
}
const results = [];
function check(name, ok, info = '') { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`); }
const onlyDrive = () => [...db.drives.values()][0];

(async () => {
  // 1. Manual drive, forgotten: GPS points are saved as they arrive; "Still
  //    driving?" is due 5 min after the last movement; after 15 min parked the
  //    drive ends, trimmed back to where you stopped.
  reset();
  await bg.startManualDrive('high');
  const startX = await driveEast(0, 3000);
  const stopAt = now;
  const prompt = fake.notif.scheduled.get(bg.PROMPT_ID);
  check('manual: points saved to the database as they arrive', db.points.get(1).length > 50, `${db.points.get(1).length} points`);
  check('manual: "Still driving?" due 5 min after the last movement', prompt && prompt.content.title === 'Still driving?' && Math.abs(prompt.at - (stopAt + 5 * 60000)) < 35000);
  await park(startX, 10);
  check('manual: still recording 10 min after parking', onlyDrive().status === 'recording' && fake.location.updates, `status ${onlyDrive().status} updates ${fake.location.updates} log: ${db.log.join(' / ')}`);
  now += 6 * 60000;
  const r = await bg.settle();
  const d = onlyDrive();
  const lastPt = db.points.get(1).slice(-1)[0];
  check('manual: ended once parked 15+ min, trimmed back to the stop', r === 'ended' && d.status === 'done' && Math.abs(d.endedAt - stopAt) < 3000 && lastPt.timestamp <= stopAt && !fake.location.updates, `status ${d.status}, end ${(d.endedAt - stopAt) / 1000}s from stop`);
  check('manual: forgotten drive queued for matching (no full re-check)', queued().join() === '1' && !db.meta.recheck_pending);

  // 2. Stopping at lights/traffic for 8 minutes doesn't end the drive.
  reset();
  await bg.startManualDrive('high');
  let x = await driveEast(0, 2000);
  await park(x, 8);
  x = await driveEast(x, 2000);
  check('manual: 8-minute stop then carrying on = one drive', db.drives.size === 1 && onlyDrive().status === 'recording');

  // 3. Auto-detect: leaving the fence in a car starts an auto drive; parking
  //    asks "Save this drive?"; unanswered, it ends as pending (not counted).
  reset();
  db.meta.autodetect = '1';
  fake.location.lastKnown = at(0, 0);
  fake.motion.acts = [{ start: now - 60000, automotive: true, walking: false, running: false, cycling: false, stationary: false, unknown: false, confidence: 2 }];
  await fenceExit();
  check('auto: leaving the fence in a car starts recording', db.drives.size === 1 && onlyDrive().auto && fake.location.updates, `drives ${db.drives.size} updates ${fake.location.updates} log: ${db.log.join(' / ')}`);
  x = await driveEast(0, 8000);
  const autoStop = now;
  const p3 = fake.notif.scheduled.get(bg.PROMPT_ID);
  check('auto: "Save this drive?" due 5 min after parking, with the distance', p3 && p3.content.title === 'Save this drive?' && /[78]\.\d km/.test(p3.content.body) && Math.abs(p3.at - (autoStop + 5 * 60000)) < 35000, p3 && p3.content.body);
  await park(x, 16);
  await bg.settle();
  check('auto: unanswered, ends as pending (not counted), distance saved', onlyDrive().status === 'pending' && onlyDrive().distanceM > 7900 && !db.meta.recheck_pending && queued().length === 0);
  check('auto: wake-up fence left where you parked', fake.location.fences && Math.abs(fake.location.fences[0].longitude - at(x, 0)[1]) < 0.001);

  // 4. Walking out of the fence: a quiet trial that's thrown away when you
  //    never reach car speed (a walk to the shop).
  reset();
  db.meta.autodetect = '1';
  fake.location.lastKnown = at(200, 0);
  const walking = [{ start: now - 60000, automotive: false, walking: true, running: false, cycling: false, stationary: false, unknown: false, confidence: 2 }];
  fake.motion.acts = walking;
  await fenceExit();
  check('auto: walking out of the fence starts a quiet trial (GPS on, nothing shown)', db.drives.size === 1 && fake.location.updates && events.length === 0, `drives ${db.drives.size} updates ${fake.location.updates} events ${events.length}`);
  let wx = 200;
  for (let i = 0; i < 150 && db.drives.size; i++) { now += 2000; wx += 2.8; await gps(wx, 0, 1.4); } // walk until the trial gives up (4 min)
  check('auto: walk never reaches car speed: dropped, GPS off, no prompt', db.drives.size === 0 && !fake.location.updates && !fake.notif.log.length && !(await bg.currentWatch()), `drives ${db.drives.size} log ${db.log.join(' / ')}`);
  check('auto: after a dropped walk, the fence is around where you are', fake.location.fences && Math.abs(fake.location.fences[0].longitude - at(wx, 0)[1]) < 0.0005);

  // 4b. Walking to the car (motion still says walking when the fence is
  //     crossed), then driving off: becomes a drive, minus the walk.
  reset();
  db.meta.autodetect = '1';
  fake.location.lastKnown = at(0, 0);
  fake.motion.acts = walking;
  await fenceExit();
  wx = 0;
  for (let i = 0; i < 40; i++) { now += 2000; wx += 2.8; await gps(wx, 0, 1.4); } // 80 s walk
  const walkEnd = now;
  x = await driveEast(wx, 3000);
  const d4b = onlyDrive();
  const pts4b = db.points.get(d4b.id);
  check('auto: on-foot start then car speed = an auto drive', d4b.auto && d4b.status === 'recording' && events.some((e) => e.type === 'started') && !(await bg.currentWatch()).trial);
  check('auto: the walk to the car is trimmed off', pts4b[0].timestamp >= walkEnd - 20000 && pts4b.length > 60, `first point ${(pts4b[0].timestamp - walkEnd) / 1000}s from the walk's end, ${pts4b.length} points`);
  const p4b = fake.notif.scheduled.get(bg.PROMPT_ID);
  check('auto: on-foot start still asks "Save this drive?" with the drive distance only', p4b && p4b.content.title === 'Save this drive?' && /[23]\.\d km/.test(p4b.content.body), p4b && p4b.content.body);

  // 4c. Trial with no GPS at all (stood still): dropped on the next settle.
  reset();
  db.meta.autodetect = '1';
  fake.location.lastKnown = at(0, 0);
  fake.motion.acts = walking;
  await fenceExit();
  now += 5 * 60000;
  await bg.settle();
  check('auto: a trial that hears nothing is dropped on settle', db.drives.size === 0 && !fake.location.updates);

  // 5. A "drive" that goes nowhere (motion unsure, GPS wander) is dropped quietly.
  reset();
  db.meta.autodetect = '1';
  fake.location.lastKnown = at(0, 0);
  fake.motion.acts = [];
  await fenceExit();
  await driveEast(0, 200, 5);
  await park(200, 16);
  await bg.settle();
  check('auto: under 500 m is dropped without asking', db.drives.size === 0 && !fake.notif.log.includes('Save this drive?'), `drives ${db.drives.size} notif ${fake.notif.log} log ${db.log.join(' / ')}`);

  // 6. Save tapped while an auto drive is still going: kept, asks "Still driving?" from then on.
  reset();
  db.meta.autodetect = '1';
  fake.location.lastKnown = at(0, 0);
  fake.motion.acts = [{ start: now - 60000, automotive: true, walking: false, running: false, cycling: false, stationary: false, unknown: false, confidence: 2 }];
  await fenceExit();
  x = await driveEast(0, 3000);
  await bg.confirmDrive();
  x = await driveEast(x, 1000);
  check('auto: after Save, the prompt becomes "Still driving?"', fake.notif.scheduled.get(bg.PROMPT_ID).content.title === 'Still driving?');
  await park(x, 16);
  await bg.settle();
  check('auto: a saved auto drive ends as done and is queued for matching', onlyDrive().status === 'done' && queued().join() === String(onlyDrive().id));

  // 7. Delete tapped while recording: gone, GPS off.
  reset();
  db.meta.autodetect = '1';
  fake.location.lastKnown = at(0, 0);
  fake.motion.acts = [{ start: now - 60000, automotive: true, walking: false, running: false, cycling: false, stationary: false, unknown: false, confidence: 2 }];
  await fenceExit();
  await driveEast(0, 2000);
  await bg.discardDrive();
  check('auto: Delete while recording removes it and stops GPS', db.drives.size === 0 && !fake.location.updates && !(await bg.currentWatch()));

  // 8. iOS paused GPS while parked; driving off 40 min later crosses the fence:
  //    the old drive ended at the stop, and (auto-detect on) a new one starts.
  reset();
  db.meta.autodetect = '1';
  await bg.startManualDrive('high');
  x = await driveEast(0, 3000);
  const stop8 = now;
  fake.location.updates = false; // iOS paused updates
  now += 40 * 60000;
  fake.motion.acts = [{ start: now - 60000, automotive: true, walking: false, running: false, cycling: false, stationary: false, unknown: false, confidence: 2 }];
  await fenceExit();
  const d1 = db.drives.get(1), d2 = db.drives.get(2);
  check('fence after a long stop: old drive ended at the stop, new auto drive started', d1 && d1.status === 'done' && Math.abs(d1.endedAt - stop8) < 3000 && d2 && d2.auto && d2.status === 'recording' && fake.location.updates);

  // 9. Fence crossed during a short stop (GPS paused at lights): same drive, GPS back on.
  reset();
  await bg.startManualDrive('high');
  x = await driveEast(0, 3000);
  fake.location.updates = false;
  now += 3 * 60000;
  await fenceExit();
  check('fence during a short stop: same drive, GPS resumed', db.drives.size === 1 && onlyDrive().status === 'recording' && fake.location.updates);

  // 10. Unconfirmed auto drives are deleted after 7 days.
  reset();
  db.drives.set(9, { id: 9, startedAt: now - 8 * 86400000, auto: true, status: 'pending' });
  db.drives.set(10, { id: 10, startedAt: now - 2 * 86400000, auto: true, status: 'pending' });
  await bg.settle();
  check('pending drives deleted after 7 days, not before', !db.drives.has(9) && db.drives.has(10));

  // 11. GPS points that arrive after a 20-minute gap (resumed after a pause): old
  //     drive ends back then; without auto-detect GPS just turns off.
  reset();
  await bg.startManualDrive('high');
  x = await driveEast(0, 2000);
  now += 20 * 60000;
  await gps(x + 500, 0);
  check('points after a 20 min gap: old drive ended, GPS off (auto-detect off)', onlyDrive().status === 'done' && !fake.location.updates && db.drives.size === 1);

  // 12. Same, with auto-detect on and GPS showing you driving off: new auto drive
  //     from the first point away from where you parked.
  reset();
  db.meta.autodetect = '1';
  await bg.startManualDrive('high');
  x = await driveEast(0, 2000);
  now += 20 * 60000;
  await gps(x + 300, 0);
  const d12 = db.drives.get(2);
  check('points after a 20 min gap, moving off (auto-detect on): new auto drive', db.drives.get(1).status === 'done' && d12 && d12.auto && d12.status === 'recording' && db.points.get(2).length === 1, `drives ${[...db.drives.values()].map((d) => `${d.id}:${d.status}:${d.auto}`)} pts2 ${db.points.get(2) && db.points.get(2).length} log ${db.log.join(' / ')}`);

  // 13. Self-healing fence: auto-detect on, nothing recording, no fence
  //     (lost) — settle puts one back where you are.
  reset();
  db.meta.autodetect = '1';
  fake.location.lastKnown = at(0, 0);
  await bg.settle();
  check('fence missing: settle sets one where you are', fake.location.fences && Math.abs(fake.location.fences[0].latitude - at(0, 0)[0]) < 1e-6);
  // ...and if you're already outside it (moved without it firing), it's moved.
  fake.location.lastKnown = at(1000, 0);
  await bg.settle();
  check('outside the fence: settle moves it to you', Math.abs(fake.location.fences[0].longitude - at(1000, 0)[1]) < 1e-6);
  const before = JSON.stringify(fake.location.fences);
  fake.location.lastKnown = at(1020, 0);
  await bg.settle();
  check('inside the fence: left alone', JSON.stringify(fake.location.fences) === before);
  db.meta.autodetect = '0';
  fake.location.fences = null;
  await bg.settle();
  check('auto-detect off: no fence set', !fake.location.fences);

  // 14. GPS auto-pause only when the fence can resume it ("Always" location).
  reset();
  fake.location.bgPerm = 'denied';
  await bg.startManualDrive('high');
  check('"While Using" only: GPS never auto-paused', fake.location.lastOpts && fake.location.lastOpts.pausesUpdatesAutomatically === false);
  reset();
  await bg.startManualDrive('high');
  check('"Always": GPS auto-pause on', fake.location.lastOpts && fake.location.lastOpts.pausesUpdatesAutomatically === true);

  console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
})();
