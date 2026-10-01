// JS side of the SpotifyRemote native module (modules/spotify-remote/ios):
// what's playing in the Spotify app, and play / pause / skip. Missing (an
// old build) = unavailable, never a crash.
import * as Expo from 'expo';

export const CLIENT_ID = 'e5d4943652cf490a99fa7091d93797db';
export const REDIRECT = 'tarmacked://spotify-callback';

export type SpotifyState = {
  connected: boolean;
  track?: string;
  artist?: string;
  album?: string;
  paused?: boolean;
  imageId?: string;
  image?: string; // data: URI of the artwork
  error?: string;
};

type Native = {
  configure(clientID: string, redirect: string): Promise<boolean>;
  authorize(): Promise<boolean>;
  handleURL(url: string): Promise<string>;
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  signOut(): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  addListener?(event: string, cb: (e: Partial<SpotifyState>) => void): { remove(): void };
};

declare const require: (m: string) => any;
function load(): Native | null {
  const tries: (() => Native | null)[] = [
    () => Expo.requireOptionalNativeModule?.<Native>('SpotifyRemote') ?? null,
    () => require('expo-modules-core').requireOptionalNativeModule?.('SpotifyRemote') ?? null,
    () => (globalThis as any).expo?.modules?.SpotifyRemote ?? null,
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

// Sets up the link; true if there's a saved sign-in to reconnect with.
export async function configure(): Promise<boolean> {
  if (!native) return false;
  return native.configure(CLIENT_ID, REDIRECT);
}

export function onState(cb: (e: Partial<SpotifyState>) => void): () => void {
  const sub = native?.addListener?.('onState', cb);
  return () => sub?.remove();
}

export const isCallback = (url: string | null | undefined) => !!url && url.startsWith(REDIRECT);

export async function authorize() {
  return native ? native.authorize() : false;
}
export async function handleURL(url: string) {
  return native ? native.handleURL(url) : '';
}
export async function connect() {
  return native ? native.connect() : false;
}
export async function disconnect() {
  await native?.disconnect();
}
export async function signOut() {
  await native?.signOut();
}
export const play = () => native?.play().catch(() => undefined);
export const pause = () => native?.pause().catch(() => undefined);
export const next = () => native?.next().catch(() => undefined);
export const previous = () => native?.previous().catch(() => undefined);
