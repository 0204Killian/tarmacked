// Everything that has to work while the app is closed or in the background:
// recording GPS points, noticing you've parked, waking up when you drive
// off (automatic drive detection), and the notifications that ask you
// about it.
//
// iOS can run this code with no screen at all (e.g. relaunching the app
// in the background when you leave the wake-up fence), so it keeps its
// state in the database, never in React.
//
// How a drive is followed:
//  - Every GPS point goes straight into the database, so nothing is lost
//    if iOS closes the app mid-drive.
//  - Each time you move, a notification is (re)scheduled for 5 minutes
//    later: "Still driving?" or, for an auto-detected drive, "Save this
//    drive?". If you keep moving it keeps getting pushed back, so it only
//    appears once you've stopped. No code has to run for it to appear.
//  - A small wake-up fence follows you. iOS pauses GPS by itself once
//    you're parked; driving off again crosses the fence, which wakes the
//    app. If you were parked 15+ minutes, the old drive has ended
//    (trimmed back to where you stopped) and, with auto-detect on, a new
//    one starts.

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import * as store from './storage';
import * as Motion from '../modules/motion-activity';
import { Watch, newWatch, updateWatch, hasEnded, PROMPT_AFTER_MS, MOVE_RADIUS_M } from './driveWatch';
import { distanceMeters } from './geo';

export const LOCATION_TASK = 'tarmacked-background-location';
export const GEOFENCE_TASK = 'tarmacked-geofence';
const FENCE_ID = 'tarmacked-wake';
const FENCE_RADIUS_M = 150;
const FENCE_REFRESH_M = 100;
export const PROMPT_ID = 'drive-prompt';
export const CATEGORY_AUTO = 'auto-drive';
export const CATEGORY_MANUAL = 'manual-drive';
// An auto-detected "drive" shorter than this wasn't a drive (a walk to the
// shop, GPS wander) and is dropped without asking.
const MIN_AUTO_DRIVE_M = 500;

export type Mode = 'high' | 'balanced' | 'saver';

// Savings come from logging less often and letting the phone batch
// updates; accuracy stays high in every mode so points aren't thrown away
// by the wild-GPS filter.
export function locationOptions(mode: Mode) {
  if (mode === 'high') return { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 10 };
  if (mode === 'balanced')
    return { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 20, deferredUpdatesInterval: 15000, deferredUpdatesDistance: 200 };
  return { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 35, deferredUpdatesInterval: 60000, deferredUpdatesDistance: 800 };
}

// --- change events for the open app ---

export type BgEvent = { type: 'points' | 'started' | 'ended'; driveId: number; status?: store.DriveStatus };
const listeners = new Set<(e: BgEvent) => void>();
export function onChange(fn: (e: BgEvent) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const emit = (e: BgEvent) => listeners.forEach((fn) => fn(e));

export function log(line: string) {
  store.appendLog(line).catch(() => undefined);
}

// --- state (kept in the database so a background relaunch can pick it up) ---

// Read fresh each time (a background relaunch and the open app must never
// disagree about which drive is recording).
async function loadWatch(): Promise<Watch | null> {
  const raw = await store.getMeta('watch');
  try {
    return raw ? (JSON.parse(raw) as Watch) : null;
  } catch {
    return null;
  }
}
async function saveWatch(w: Watch | null) {
  await store.setMeta('watch', w ? JSON.stringify(w) : '');
}
export async function currentWatch(): Promise<Watch | null> {
  return loadWatch();
}

// One thing at a time: GPS batches, fence events and app actions can
// arrive together.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => undefined);
  return run;
}

export async function autoDetectEnabled() {
  return (await store.getMeta('autodetect')) === '1';
}

async function currentMode(): Promise<Mode> {
  const m = await store.getMeta('accuracy_mode');
  return m === 'balanced' || m === 'saver' ? m : m === 'auto' ? 'balanced' : 'high';
}

// --- location updates ---

export async function startUpdates(mode: Mode) {
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    ...locationOptions(mode),
    activityType: Location.ActivityType.AutomotiveNavigation,
    // iOS pauses GPS by itself once you've been parked a while (saves
    // battery if a drive is never stopped); the wake-up fence resumes it.
    pausesUpdatesAutomatically: true,
    showsBackgroundLocationIndicator: true,
    foregroundService: { notificationTitle: 'tarmacked is tracking', notificationBody: 'Recording this drive' },
  });
  await store.setMeta('active_mode', mode);
  log(`GPS on (${mode})`);
}

async function stopUpdates() {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    // wasn't running
  }
}

async function updatesRunning() {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    return false;
  }
}

// --- wake-up fence ---

async function setFence(at: [number, number]): Promise<boolean> {
  try {
    const bg = await Location.getBackgroundPermissionsAsync();
    if (bg.status !== 'granted') return false;
    await Location.startGeofencingAsync(GEOFENCE_TASK, [
      { identifier: FENCE_ID, latitude: at[0], longitude: at[1], radius: FENCE_RADIUS_M, notifyOnEnter: false, notifyOnExit: true },
    ]);
    return true;
  } catch (e) {
    log(`fence failed: ${(e as Error).message}`);
    return false;
  }
}

export async function clearFence() {
  try {
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) await Location.stopGeofencingAsync(GEOFENCE_TASK);
  } catch {
    // none set
  }
}

// Puts the fence where you are now (after turning auto-detect on).
export async function fenceHere() {
  try {
    const pos = await Location.getLastKnownPositionAsync();
    if (pos) await setFence([pos.coords.latitude, pos.coords.longitude]);
  } catch {
    // no position yet: set on the next drive
  }
}

// --- notifications ---

let categoriesReady = false;
export async function setupNotifications() {
  if (categoriesReady) return;
  categoriesReady = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
    });
    await Notifications.setNotificationCategoryAsync(CATEGORY_AUTO, [
      { identifier: 'save', buttonTitle: 'Save', options: { opensAppToForeground: true } },
      { identifier: 'delete', buttonTitle: 'Delete', options: { opensAppToForeground: true, isDestructive: true } },
    ]);
    await Notifications.setNotificationCategoryAsync(CATEGORY_MANUAL, [
      { identifier: 'end', buttonTitle: 'End drive', options: { opensAppToForeground: true } },
      { identifier: 'keep', buttonTitle: 'Keep going', options: { opensAppToForeground: false } },
    ]);
  } catch (e) {
    log(`notification setup failed: ${(e as Error).message}`);
  }
}

async function cancelPrompt() {
  try {
    await Notifications.cancelScheduledNotificationAsync(PROMPT_ID);
    await Notifications.dismissNotificationAsync(PROMPT_ID);
  } catch {
    // nothing scheduled
  }
}

// Scheduled for PROMPT_AFTER_MS after the last movement; pushed back every
// time you move.
async function schedulePrompt(w: Watch) {
  await cancelPrompt();
  const km = (w.distanceM / 1000).toFixed(1);
  const askToSave = w.auto && !w.confirmed;
  if (askToSave && w.distanceM < MIN_AUTO_DRIVE_M) return;
  const seconds = Math.max(5, Math.round((w.lastMoveAt + PROMPT_AFTER_MS - Date.now()) / 1000));
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: PROMPT_ID,
      content: askToSave
        ? {
            title: 'Save this drive?',
            body: `Looks like you drove ${km} km. Save adds its roads to your map; Delete if you weren't driving.`,
            categoryIdentifier: CATEGORY_AUTO,
            data: { driveId: w.driveId, kind: 'auto' },
          }
        : {
            title: 'Still driving?',
            body: `You haven't moved for 5 minutes. End the drive now, or it ends by itself after 15 minutes parked.`,
            categoryIdentifier: CATEGORY_MANUAL,
            data: { driveId: w.driveId, kind: 'manual' },
          },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds, repeats: false },
    });
  } catch (e) {
    log(`couldn't schedule prompt: ${(e as Error).message}`);
  }
}

// --- drives ---

async function beginDrive(auto: boolean, at: number, where: [number, number] | null): Promise<Watch> {
  const driveId = await store.startDrive(at, auto);
  const w = newWatch(driveId, auto, at, where);
  await saveWatch(w);
  log(`drive ${driveId} started (${auto ? 'auto-detected' : 'Start pressed'})`);
  emit({ type: 'started', driveId });
  return w;
}

// Ends the drive at its last movement. Auto drives you haven't confirmed
// become "pending" (not counted until you save them).
// matched: the open app already matched its roads live, so no re-check is needed.
async function finishDrive(w: Watch, reason: string, opts: { trim: boolean; matched: boolean }): Promise<store.DriveStatus | 'dropped'> {
  await cancelPrompt();
  let status: store.DriveStatus | 'dropped';
  if (w.auto && !w.confirmed && w.distanceM < MIN_AUTO_DRIVE_M) {
    await store.deleteDrive(w.driveId);
    status = 'dropped';
  } else {
    if (opts.trim) await store.trimDrive(w.driveId, w.lastMoveAt);
    status = w.auto && !w.confirmed ? 'pending' : 'done';
    await store.setDriveStatus(w.driveId, status, opts.trim ? w.lastMoveAt : w.lastT);
    if (!opts.matched) await store.setDriveDistance(w.driveId, w.distanceM);
    if (status === 'done' && !opts.matched) await store.setMeta('recheck_pending', '1');
  }
  await saveWatch(null);
  if (await autoDetectEnabled()) {
    if (w.anchor[0] !== 0) await setFence(w.anchor);
  } else {
    await clearFence();
  }
  log(`drive ${w.driveId} ended (${reason}): ${status}, ${(w.distanceM / 1000).toFixed(1)} km`);
  emit({ type: 'ended', driveId: w.driveId, status: status === 'dropped' ? undefined : status });
  return status;
}

// Start pressed: a new drive (or the one already recording).
export function startManualDrive(mode: Mode): Promise<Watch> {
  return serial(async () => {
    const existing = await loadWatch();
    if (existing) return existing;
    const now = Date.now();
    let where: [number, number] | null = null;
    try {
      const pos = await Location.getLastKnownPositionAsync();
      if (pos) where = [pos.coords.latitude, pos.coords.longitude];
    } catch {
      // first point will set it
    }
    const w = await beginDrive(false, now, where);
    await startUpdates(mode);
    await schedulePrompt(w);
    return w;
  });
}

// Stop pressed (or "End drive" tapped).
export function endDrive(reason: string, opts: { trim: boolean; matched: boolean }) {
  return serial(async () => {
    const w = await loadWatch();
    if (!w) return null;
    await stopUpdates();
    return { driveId: w.driveId, status: await finishDrive(w, reason, opts) };
  });
}

// "Save" on an auto drive still recording: keep it; it'll ask "Still driving?" from now on.
export function confirmDrive() {
  return serial(async () => {
    const w = await loadWatch();
    if (!w) return;
    w.confirmed = true;
    await saveWatch(w);
    await schedulePrompt(w);
  });
}

// "Delete" on an auto drive still recording: throw it away.
export function discardDrive() {
  return serial(async () => {
    const w = await loadWatch();
    if (!w) return;
    await stopUpdates();
    await cancelPrompt();
    await store.deleteDrive(w.driveId);
    await saveWatch(null);
    if (await autoDetectEnabled()) {
      if (w.last) await setFence(w.last);
    } else await clearFence();
    log(`drive ${w.driveId} deleted while recording`);
    emit({ type: 'ended', driveId: w.driveId });
  });
}

// Called on launch and whenever the app comes back: ends a drive parked
// 15+ minutes, restarts GPS for one still going, clears old pending drives.
export function settle(): Promise<'none' | 'recording' | 'ended'> {
  return serial(async () => {
    const dropped = await store.deleteStalePending(7 * 24 * 60 * 60_000);
    if (dropped > 0) log(`${dropped} unconfirmed auto drive(s) deleted after 7 days`);
    const w = await loadWatch();
    if (!w) {
      // A drive left "recording" with no watch (older version, or state lost).
      const rec = await store.getRecordingDrive();
      if (rec) {
        await store.setDriveStatus(rec.id, rec.auto ? 'pending' : 'done', rec.lastT ?? rec.startedAt);
        if (!rec.auto) await store.setMeta('recheck_pending', '1');
        log(`drive ${rec.id} was left recording: closed`);
        return 'ended';
      }
      return 'none';
    }
    if (hasEnded(w, Date.now())) {
      await stopUpdates();
      await finishDrive(w, 'parked 15+ min', { trim: true, matched: false });
      return 'ended';
    }
    if (!(await updatesRunning())) {
      try {
        await startUpdates(await currentMode());
        log(`drive ${w.driveId}: GPS resumed`);
      } catch (e) {
        log(`couldn't resume GPS: ${(e as Error).message}`);
      }
    }
    return 'recording';
  });
}

// New GPS points, from the background task (or the in-app fallback).
export function onPoints(newPoints: store.StoredPoint[]) {
  let points = newPoints;
  return serial(async () => {
    if (points.length === 0) return;
    let w = await loadWatch();
    if (!w) {
      log(`${points.length} GPS point(s) arrived with no drive recording`);
      await stopUpdates();
      return;
    }
    // Parked 15+ minutes: the drive ended back when you stopped. Only if
    // these points show you driving off again (and auto-detect is on) does
    // a new drive start; GPS wandering while parked just turns GPS off.
    if (points[0].timestamp - w.lastMoveAt >= 15 * 60_000) {
      const anchor = w.anchor;
      const away = points.find((p) => distanceMeters({ latitude: anchor[0], longitude: anchor[1] }, p) > MOVE_RADIUS_M);
      await finishDrive(w, 'parked 15+ min', { trim: true, matched: false });
      if (!away || !(await autoDetectEnabled())) {
        await stopUpdates();
        return;
      }
      w = await beginDrive(true, away.timestamp, [away.latitude, away.longitude]);
      points = points.filter((p) => p.timestamp >= away.timestamp);
    }
    await store.addPoints(w.driveId, points);
    const moved = updateWatch(w, points);
    if (moved && w.lastMoveAt - w.promptFor > 30_000) {
      w.promptFor = w.lastMoveAt;
      await schedulePrompt(w);
    }
    if (w.last && (!w.fence || distanceMeters({ latitude: w.fence[0], longitude: w.fence[1] }, { latitude: w.last[0], longitude: w.last[1] }) > FENCE_REFRESH_M)) {
      if (await setFence(w.last)) w.fence = w.last;
    }
    await saveWatch(w);
    emit({ type: 'points', driveId: w.driveId });
  });
}

// Left the wake-up fence.
function onFenceExit() {
  return serial(async () => {
    const now = Date.now();
    const w = await loadWatch();
    if (w && !hasEnded(w, now)) {
      // Still in a drive: iOS may have paused GPS at a long stop.
      if (!(await updatesRunning())) await startUpdates(await currentMode());
      return;
    }
    if (w) {
      await stopUpdates();
      await finishDrive(w, 'parked 15+ min', { trim: true, matched: false });
    }
    if (!(await autoDetectEnabled())) return;
    // Walking, running or cycling away isn't a drive. Anything else (in a
    // vehicle, or not sure yet) starts recording; a "drive" that turns out
    // to go nowhere is dropped without asking.
    let acts: Motion.MotionActivity[] = [];
    try {
      acts = await Motion.queryActivities(now - 3 * 60_000, now);
    } catch (e) {
      log(`motion data unavailable: ${(e as Error).message}`);
    }
    const recent = acts.filter((a) => a.confidence >= 1);
    const latest = recent[recent.length - 1];
    const onFoot = !!latest && !latest.automotive && (latest.walking || latest.running || latest.cycling);
    let where: [number, number] | null = null;
    try {
      const pos = await Location.getLastKnownPositionAsync();
      if (pos) where = [pos.coords.latitude, pos.coords.longitude];
    } catch {
      // unknown
    }
    if (onFoot) {
      if (where) await setFence(where);
      log('left the fence on foot: not a drive');
      return;
    }
    const drive = await beginDrive(true, now, where);
    try {
      await startUpdates(await currentMode());
    } catch (e) {
      log(`couldn't start GPS for an auto drive: ${(e as Error).message}`);
      await store.deleteDrive(drive.driveId);
      await saveWatch(null);
    }
  });
}

// --- background tasks (must be defined when the app's code first loads) ---

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    log(`location task error: ${error.message ?? error}`);
    return;
  }
  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
  if (!locations || locations.length === 0) return;
  await onPoints(
    locations.map((l) => ({ latitude: l.coords.latitude, longitude: l.coords.longitude, timestamp: l.timestamp, accuracy: l.coords.accuracy ?? null }))
  );
});

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error) {
    log(`fence task error: ${error.message ?? error}`);
    return;
  }
  const { eventType } = (data ?? {}) as { eventType?: Location.GeofencingEventType };
  if (eventType === Location.GeofencingEventType.Exit) await onFenceExit();
});
