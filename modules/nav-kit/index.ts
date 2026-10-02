// JS side of the NavKit native module (modules/nav-kit/ios), for tarmacked's
// own sat-nav (v0.18): spoken prompts on the phone, and Apple's place search
// and place names (online). Missing (an old build) = unavailable, never a crash.
import * as Expo from 'expo';
import type { Coord } from '../../src/geo';

export type FoundPlace = { name: string; subtitle: string; lat: number; lon: number };

type Native = {
  speak(text: string): Promise<void>;
  stopSpeaking(): Promise<void>;
  search?(query: string, lat: number, lon: number): Promise<FoundPlace[]>;
  placeName?(lat: number, lon: number): Promise<string>;
};

declare const require: (m: string) => any;
function load(): Native | null {
  const tries: (() => Native | null)[] = [
    () => Expo.requireOptionalNativeModule?.<Native>('NavKit') ?? null,
    () => require('expo-modules-core').requireOptionalNativeModule?.('NavKit') ?? null,
    () => (globalThis as any).expo?.modules?.NavKit ?? null,
  ];
  for (const get of tries) {
    try {
      const m = get();
      if (m) return m;
    } catch {
      // next
    }
  }
  return null;
}
const native = load();

export const available = () => !!native;
export const canSearch = () => !!native?.search;

export function speak(text: string) {
  native?.speak(text).catch(() => undefined);
}

export function stopSpeaking() {
  native?.stopSpeaking().catch(() => undefined);
}

/** Apple's search: places, addresses, businesses. Throws when offline. */
export async function search(query: string, near: Coord | null): Promise<FoundPlace[]> {
  if (!native?.search || !query.trim()) return [];
  const res = await native.search(query.trim(), near ? near[0] : 0, near ? near[1] : 0);
  return Array.isArray(res) ? res.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)) : [];
}

/** "12 Main Street, Kilkenny" for a spot, or '' (offline / nothing there). */
export async function placeName(at: Coord): Promise<string> {
  if (!native?.placeName) return '';
  try {
    return await native.placeName(at[0], at[1]);
  } catch {
    return '';
  }
}
