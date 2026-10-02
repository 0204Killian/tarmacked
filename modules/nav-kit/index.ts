// JS side of the NavKit native module (modules/nav-kit/ios): spoken
// prompts on the phone, for tarmacked's own sat-nav (0.18). Missing (an old
// build) = unavailable, never a crash.
import * as Expo from 'expo';

type Native = {
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

export function speak(text: string) {
  native?.speak(text).catch(() => undefined);
}

export function stopSpeaking() {
  native?.stopSpeaking().catch(() => undefined);
}
