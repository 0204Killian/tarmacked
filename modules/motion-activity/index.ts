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
  requestPermission?(): Promise<string>;
  queryActivities(fromMs: number, toMs: number): Promise<MotionActivity[]>;
};

// Finds the native module. Tried three ways, so a difference between Expo
// versions in where the helper lives can't silently hide it.
declare const require: (m: string) => any;
function load(): { mod: Native | null; via: string } {
  const tries: [string, () => Native | null][] = [
    ['expo', () => Expo.requireOptionalNativeModule?.<Native>('MotionActivity') ?? null],
    ['expo-modules-core', () => require('expo-modules-core').requireOptionalNativeModule?.('MotionActivity') ?? null],
    ['global', () => (globalThis as any).expo?.modules?.MotionActivity ?? null],
  ];
  for (const [via, get] of tries) {
    try {
      const mod = get();
      if (mod) return { mod, via };
    } catch {
      // try the next way
    }
  }
  return { mod: null, via: 'none' };
}
const loaded = load();
const native = loaded.mod;

// For the diagnostics line in Settings and the log.
export function diagnostics(): string {
  return `Motion module: ${native ? `loaded (${loaded.via})` : 'missing'} · permission: ${authorizationStatus()}`;
}

// False when this build doesn't include the native module at all.
export function isLoaded(): boolean {
  return !!native;
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
// Shows the Motion & Fitness prompt and waits (up to a minute) for your
// answer before reporting the status.
export async function requestPermission(): Promise<string> {
  if (!native) return 'unavailable';
  try {
    if (native.requestPermission) return await native.requestPermission();
    await queryActivities(Date.now() - 60_000, Date.now());
  } catch {
    // denied: the status below says so
  }
  for (let i = 0; i < 240 && authorizationStatus() === 'notDetermined'; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return authorizationStatus();
}
