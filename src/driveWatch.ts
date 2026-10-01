// Watches a drive in progress for "you've stopped driving". Pure logic
// (no React, storage or native calls) so it can be tested on its own.

import { distanceMeters } from './geo';

export type WatchPoint = { latitude: number; longitude: number; timestamp: number; speed?: number | null; accuracy?: number | null };

// A position counts as "moving" once it's this far from where you last were
// still. GPS wanders a few tens of metres while parked.
export const MOVE_RADIUS_M = 60;
// Ask "still driving?" / "save this drive?" this long after the last movement.
export const PROMPT_AFTER_MS = 5 * 60_000;
// A drive with no movement for this long has ended (trimmed back to the
// last movement). Driving off again before then carries on the same drive.
export const AUTO_END_AFTER_MS = 15 * 60_000;
// Auto-detected drives never confirmed are deleted after this long.
export const PENDING_KEEP_MS = 7 * 24 * 60 * 60_000;

export type Watch = {
  driveId: number;
  auto: boolean; // started by automatic detection
  confirmed: boolean; // an auto drive you already said to keep
  anchor: [number, number]; // where you last were still (lat, lon)
  lastMoveAt: number; // time of the last real movement
  lastT: number; // time of the latest point
  last: [number, number] | null; // latest point
  distanceM: number; // driven so far (rough, for notifications)
  fence: [number, number] | null; // centre of the wake-up fence
  promptFor: number; // lastMoveAt the prompt notification was scheduled for
  // Set while we're not sure it's a drive yet: you left the fence on foot
  // (walking to the car looks like walking). GPS runs, but nothing is shown
  // or asked until you're moving at car speed; if that doesn't happen by
  // `until`, the "drive" is quietly thrown away.
  trial?: { until: number; ref: { lat: number; lon: number; t: number } | null; fast: number };
};

// --- on-foot trial ---
// How long to wait for car speed after leaving the fence on foot.
export const TRIAL_MS = 4 * 60_000;
// Car speed: faster than anyone walks or runs, and most cycling.
export const DRIVING_SPEED_MS = 8; // ~29 km/h
const TRIAL_SPAN_MS = 10_000; // speed measured over at least this long (GPS jitter)

// Folds new points into a trial. 'driving' = car speed seen (the trial is
// over and this is a drive); 'over' = time's up without it; 'waiting'.
// Returns the time the drive should start from when it's 'driving'.
export function trialStep(w: Watch, points: WatchPoint[], now: number): { state: 'driving' | 'waiting' | 'over'; from?: number } {
  const tr = w.trial;
  if (!tr) return { state: 'driving' };
  for (const p of points) {
    if (p.accuracy != null && p.accuracy > 30) continue;
    // The phone's own speed reading (Doppler, good to ~1 m/s): two in a row.
    if (p.speed != null && p.speed >= DRIVING_SPEED_MS) {
      tr.fast++;
      if (tr.fast >= 2) return { state: 'driving', from: (tr.ref?.t ?? p.timestamp) - 15_000 };
    } else if (p.speed != null) tr.fast = 0;
    // Or distance over time between fixes at least 10 s apart.
    if (!tr.ref) tr.ref = { lat: p.latitude, lon: p.longitude, t: p.timestamp };
    else if (p.timestamp - tr.ref.t >= TRIAL_SPAN_MS) {
      const v = distanceMeters({ latitude: tr.ref.lat, longitude: tr.ref.lon }, p) / ((p.timestamp - tr.ref.t) / 1000);
      if (v >= DRIVING_SPEED_MS) return { state: 'driving', from: tr.ref.t - 15_000 };
      tr.ref = { lat: p.latitude, lon: p.longitude, t: p.timestamp };
    }
  }
  return { state: now >= tr.until ? 'over' : 'waiting' };
}

export function newWatch(driveId: number, auto: boolean, at: number, where: [number, number] | null): Watch {
  return {
    driveId,
    auto,
    confirmed: false,
    anchor: where ?? [0, 0],
    lastMoveAt: at,
    lastT: at,
    last: where,
    distanceM: 0,
    fence: null,
    promptFor: 0,
  };
}

const MAX_STEP_MS = 60_000;

// Folds new points into the watch. Returns true if you moved.
export function updateWatch(w: Watch, points: WatchPoint[]): boolean {
  let moved = false;
  for (const p of points) {
    if (p.timestamp <= w.lastT && w.last) continue;
    const here: [number, number] = [p.latitude, p.longitude];
    if (w.last && p.timestamp - w.lastT <= MAX_STEP_MS) {
      w.distanceM += distanceMeters({ latitude: w.last[0], longitude: w.last[1] }, p);
    }
    const fromAnchor =
      w.anchor[0] === 0 && w.anchor[1] === 0
        ? Infinity
        : distanceMeters({ latitude: w.anchor[0], longitude: w.anchor[1] }, p);
    if (fromAnchor > MOVE_RADIUS_M) {
      w.anchor = here;
      w.lastMoveAt = p.timestamp;
      moved = true;
    }
    w.last = here;
    w.lastT = p.timestamp;
  }
  return moved;
}

// Has the drive ended (no movement for AUTO_END_AFTER_MS)?
export function hasEnded(w: Watch, now: number): boolean {
  return now - w.lastMoveAt >= AUTO_END_AFTER_MS;
}
