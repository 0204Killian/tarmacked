// JS side of the NavKit native module (modules/nav-kit/ios): Apple place
// search, driving directions and spoken prompts. Missing (an old build) =
// unavailable, never a crash.
import * as Expo from 'expo';
import type { Coord } from '../../src/geo';
import type { NavRoute } from '../../src/nav';

export type Place = { name: string; subtitle: string; lat: number; lon: number };
export type Route = NavRoute;

type Native = {
  search(query: string, near: number[]): Promise<Place[]>;
  directions(from: number[], to: number[], alternatives: boolean): Promise<Route[]>;
  placeName(lat: number, lon: number): Promise<string>;
  speak(text: string): Promise<void>;
  stopSpeaking(): Promise<void>;
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

export async function search(query: string, near: Coord | null): Promise<Place[]> {
  if (!native || !query.trim()) return [];
  return native.search(query.trim(), near ? [near[0], near[1]] : []);
}

export async function directions(from: Coord, to: Coord, alternatives: boolean): Promise<Route[]> {
  if (!native) throw new Error('Directions need the latest app build');
  return native.directions([from[0], from[1]], [to[0], to[1]], alternatives);
}

export async function placeName(at: Coord): Promise<string> {
  if (!native) return '';
  try {
    return await native.placeName(at[0], at[1]);
  } catch {
    return '';
  }
}

export function speak(text: string) {
  native?.speak(text).catch(() => undefined);
}

export function stopSpeaking() {
  native?.stopSpeaking().catch(() => undefined);
}
