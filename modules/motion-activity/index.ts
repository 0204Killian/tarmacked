// JS side of the MotionActivity native module (modules/motion-activity/ios).
// Missing (e.g. an old build) = treated as unavailable, never a crash.
import * as Expo from 'expo';

export type MotionActivity = {
  start: number; // ms since 1970
  automotive: boolean;
  walking: boolean;
  running: boolean;
  cycling: boolean;
  stationary: boolean;
  unknown: boolean;
  confidence: 0 | 1 | 2; // low, medium, high
};

type Native = {
  isAvailable(): boolean;
  authorizationStatus(): string;
  queryActivities(fromMs: number, toMs: number): Promise<MotionActivity[]>;
};

let native: Native | null = null;
try {
  native = Expo.requireOptionalNativeModule<Native>('MotionActivity');
} catch {
  native = null;
}

export function isAvailable(): boolean {
  try {
    return !!native && native.isAvailable();
  } catch {
    return false;
  }
}

export function authorizationStatus(): string {
  try {
    return native ? native.authorizationStatus() : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function queryActivities(fromMs: number, toMs: number): Promise<MotionActivity[]> {
  if (!native) return [];
  return native.queryActivities(fromMs, toMs);
}

// Asks for Motion & Fitness permission (iOS prompts on the first query).
export async function requestPermission(): Promise<string> {
  try {
    await queryActivities(Date.now() - 60_000, Date.now());
  } catch {
    // denied: the status below says so
  }
  return authorizationStatus();
}
