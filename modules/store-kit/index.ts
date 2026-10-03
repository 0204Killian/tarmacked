// JS side of the store module (modules/store-kit/ios): tarmacked Premium,
// a one-time purchase through Apple. Missing (an old build, or a phone
// without the App Store) = unavailable, never a crash.
import * as Expo from 'expo';

export type StoreProduct = { id: string; title: string; price: string };
export type PurchaseResult = 'purchased' | 'cancelled' | 'pending' | 'unavailable' | 'failed';

type Native = {
  product(id: string): Promise<StoreProduct | null>;
  purchase(id: string): Promise<PurchaseResult>;
  owned(id: string): Promise<boolean>;
  restore(id: string): Promise<boolean>;
};

declare const require: (m: string) => any;
function load(): Native | null {
  const tries: (() => Native | null)[] = [
    () => Expo.requireOptionalNativeModule?.<Native>('TarmackedStore') ?? null,
    () => require('expo-modules-core').requireOptionalNativeModule?.('TarmackedStore') ?? null,
    () => (globalThis as any).expo?.modules?.TarmackedStore ?? null,
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

/** The product with its local price, or null (offline, or not set up in App Store Connect yet). */
export async function product(id: string): Promise<StoreProduct | null> {
  if (!native) return null;
  try {
    return await native.product(id);
  } catch {
    return null;
  }
}

export async function purchase(id: string): Promise<PurchaseResult> {
  if (!native) return 'unavailable';
  try {
    return await native.purchase(id);
  } catch {
    return 'failed';
  }
}

/** Whether this phone's Apple ID has bought it (null = couldn't tell). */
export async function owned(id: string): Promise<boolean | null> {
  if (!native) return null;
  try {
    return await native.owned(id);
  } catch {
    return null;
  }
}

export async function restore(id: string): Promise<boolean | null> {
  if (!native) return null;
  try {
    return await native.restore(id);
  } catch {
    return null;
  }
}
