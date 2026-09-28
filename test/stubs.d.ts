declare namespace JSX { interface IntrinsicElements { [k: string]: any } interface Element {} interface ElementChildrenAttribute { children: {} } }
declare module 'react' {
  export type ReactNode = any;
  export class Component<P, S> { props: P; state: S; constructor(p: P); setState(s: Partial<S>): void; }
  export function useState<T>(v: T | (() => T)): [T, (v: T | ((p: T) => T)) => void];
  export function useEffect(f: () => void | (() => void), deps?: any[]): void;
  export function useRef<T>(v: T): { current: T };
  export function useMemo<T>(f: () => T, deps: any[]): T;
  export function useCallback<T extends (...a: any[]) => any>(f: T, deps: any[]): T;
}
declare module 'react-native' {
  export const StyleSheet: { create<T>(s: T): T };
  export const Text: any, View: any, Pressable: any, ScrollView: any, ActivityIndicator: any;
  export const Dimensions: { get(w: 'window'): { width: number; height: number } };
}
declare module 'react-native-maps' {
  export type Region = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };
  export type MapType = 'standard' | 'satellite' | 'hybrid';
  export type MapPressEvent = { nativeEvent: { coordinate: { latitude: number; longitude: number } } };
  export default class MapView { animateToRegion(r: Region, ms?: number): void; animateCamera(c: any, o?: any): void; fitToCoordinates(c: any[], o?: any): void; }
  export const Polyline: any, LocalTile: any, UrlTile: any, PROVIDER_DEFAULT: any;
}
declare module 'expo-location' {
  export type LocationObject = { coords: { latitude: number; longitude: number; accuracy: number | null }; timestamp: number };
  export type LocationSubscription = { remove(): void };
  export const Accuracy: { BestForNavigation: number; High: number; Balanced: number }; export const ActivityType: { AutomotiveNavigation: number };
  export function requestForegroundPermissionsAsync(): Promise<{ status: string }>;
  export function requestBackgroundPermissionsAsync(): Promise<{ status: string }>;
  export function getCurrentPositionAsync(o: any): Promise<LocationObject>;
  export function getLastKnownPositionAsync(): Promise<LocationObject | null>;
  export function startLocationUpdatesAsync(n: string, o: any): Promise<void>;
  export function stopLocationUpdatesAsync(n: string): Promise<void>;
  export function watchPositionAsync(o: any, cb: (l: LocationObject) => void): Promise<LocationSubscription>;
}
declare module 'expo-task-manager' { export function defineTask(n: string, f: (a: { data: unknown; error: any }) => void): void; }
declare module 'expo-sharing' { export function isAvailableAsync(): Promise<boolean>; export function shareAsync(u: string, o?: any): Promise<void>; }
declare module 'expo-document-picker' { export function getDocumentAsync(o: any): Promise<{ canceled: boolean; assets?: { uri: string }[] }>; }
declare module 'expo-file-system' {
  export class Directory { constructor(...parts: (string | Directory | File)[]); readonly uri: string; readonly exists: boolean; create(o?: { intermediates?: boolean; idempotent?: boolean }): void; delete(): void; }
  export class File { constructor(...parts: (string | Directory | File)[]); readonly uri: string; readonly exists: boolean; create(): void; delete(): void; write(c: string | Uint8Array): void; text(): Promise<string>; }
  export const Paths: { cache: Directory; document: Directory };
}
declare module '@react-native-async-storage/async-storage' { const A: { getItem(k: string): Promise<string | null> }; export default A; }
declare module 'expo-sqlite' {
  export interface SQLiteRunResult { changes: number; lastInsertRowId: number }
  export interface SQLiteStatement { executeAsync(p: any[]): Promise<any>; finalizeAsync(): Promise<void> }
  export interface SQLiteDatabase {
    execAsync(s: string): Promise<void>; runAsync(s: string, p?: any[]): Promise<SQLiteRunResult>;
    getFirstAsync<T>(s: string, p?: any[]): Promise<T | null>; getAllAsync<T>(s: string, p?: any[]): Promise<T[]>;
    prepareAsync(s: string): Promise<SQLiteStatement>; withTransactionAsync(f: () => Promise<void>): Promise<void>;
  }
  export function openDatabaseAsync(n: string): Promise<SQLiteDatabase>;
}
declare module '@shopify/react-native-skia' {
  export interface SkImage { encodeToBytes(): Uint8Array }
  export interface SkCanvas { clear(c: any): void; drawPath(p: SkPath, paint: SkPaint): void }
  export interface SkSurface { getCanvas(): SkCanvas; flush(): void; makeImageSnapshot(): SkImage }
  export interface SkPath { moveTo(x: number, y: number): SkPath; lineTo(x: number, y: number): SkPath }
  export interface SkPaint { setAntiAlias(b: boolean): void; setStyle(s: any): void; setStrokeCap(c: any): void; setStrokeJoin(j: any): void; setColor(c: any): void; setStrokeWidth(w: number): void }
  export const Skia: { Surface: { Make(w: number, h: number): SkSurface | null; MakeOffscreen(w: number, h: number): SkSurface | null }; Path: { Make(): SkPath }; Paint(): SkPaint; Color(c: string): any };
  export enum PaintStyle { Fill, Stroke } export enum StrokeCap { Butt, Round, Square } export enum StrokeJoin { Bevel, Miter, Round }
}
declare module 'expo-battery' {
  export enum BatteryState { UNKNOWN = 0, UNPLUGGED = 1, CHARGING = 2, FULL = 3 }
  export function getBatteryStateAsync(): Promise<BatteryState>;
  export function addBatteryStateListener(cb: (e: { batteryState: BatteryState }) => void): { remove(): void };
}
