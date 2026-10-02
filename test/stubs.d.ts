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
  export const StyleSheet: { create<T>(s: T): T; hairlineWidth: number };
  export const Text: any, View: any, Pressable: any, ScrollView: any, ActivityIndicator: any, Image: any, Switch: any, TextInput: any;
  export const Keyboard: { dismiss(): void };
  export const Platform: { OS: 'ios' | 'android'; Version: string | number };
  export const AppState: { currentState: string; addEventListener(t: 'change', cb: (s: 'active' | 'background' | 'inactive') => void): { remove(): void } };
  export const Linking: { openSettings(): Promise<void>; openURL(u: string): Promise<void>; getInitialURL(): Promise<string | null>; addEventListener(t: 'url', cb: (e: { url: string }) => void): { remove(): void } };
  export const Animated: any;
  export const Easing: any;
  export const Dimensions: { get(w: 'window'): { width: number; height: number } };
}
declare module 'react-native-maps' {
  export type Region = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };
  export type MapType = 'standard' | 'satellite' | 'hybrid';
  export type MapPressEvent = { nativeEvent: { coordinate: { latitude: number; longitude: number } } };
  export default class MapView { animateToRegion(r: Region, ms?: number): void; animateCamera(c: any, o?: any): void; fitToCoordinates(c: any[], o?: any): void; }
  export const Polyline: any, LocalTile: any, UrlTile: any, PROVIDER_DEFAULT: any, Marker: any;
  export type LongPressEvent = { nativeEvent: { coordinate: { latitude: number; longitude: number } } };
}
declare module 'expo-location' {
  export type LocationObject = { coords: { latitude: number; longitude: number; accuracy: number | null; speed?: number | null }; timestamp: number };
  export type PermissionResponse = { status: 'granted' | 'denied' | 'undetermined'; canAskAgain: boolean };
  export function getForegroundPermissionsAsync(): Promise<PermissionResponse>;
  export function getBackgroundPermissionsAsync(): Promise<PermissionResponse>;
  export function hasStartedLocationUpdatesAsync(n: string): Promise<boolean>;
  export enum GeofencingEventType { Enter = 1, Exit = 2 }
  export type LocationRegion = { identifier?: string; latitude: number; longitude: number; radius: number; notifyOnEnter?: boolean; notifyOnExit?: boolean };
  export function startGeofencingAsync(n: string, regions: LocationRegion[]): Promise<void>;
  export function stopGeofencingAsync(n: string): Promise<void>;
  export function hasStartedGeofencingAsync(n: string): Promise<boolean>;
  export type LocationSubscription = { remove(): void };
  export const Accuracy: { BestForNavigation: number; High: number; Balanced: number }; export const ActivityType: { AutomotiveNavigation: number };
  export function requestForegroundPermissionsAsync(): Promise<PermissionResponse>;
  export function requestBackgroundPermissionsAsync(): Promise<PermissionResponse>;
  export function getCurrentPositionAsync(o: any): Promise<LocationObject>;
  export function getLastKnownPositionAsync(o?: { maxAge?: number; requiredAccuracy?: number }): Promise<LocationObject | null>;
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
  export interface SQLiteStatement { executeAsync(p: any[]): Promise<any>; executeSync(p: any[]): any; finalizeAsync(): Promise<void> }
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
declare module 'expo-notifications' {
  export const DEFAULT_ACTION_IDENTIFIER: string;
  export enum SchedulableTriggerInputTypes { TIME_INTERVAL = 'timeInterval' }
  export type NotificationContentInput = { title?: string; body?: string; data?: Record<string, unknown>; categoryIdentifier?: string };
  export type NotificationResponse = { actionIdentifier: string; notification: { date: number; request: { identifier: string; content: { data: Record<string, unknown> } } } };
  export function setNotificationHandler(h: { handleNotification: () => Promise<{ shouldShowBanner: boolean; shouldShowList: boolean; shouldPlaySound: boolean; shouldSetBadge: boolean }> }): void;
  export function setNotificationCategoryAsync(id: string, actions: { identifier: string; buttonTitle: string; options?: { opensAppToForeground?: boolean; isDestructive?: boolean } }[]): Promise<unknown>;
  export function scheduleNotificationAsync(r: { identifier?: string; content: NotificationContentInput; trigger: { type: SchedulableTriggerInputTypes; seconds: number; repeats?: boolean } | null }): Promise<string>;
  export function cancelScheduledNotificationAsync(id: string): Promise<void>;
  export function dismissNotificationAsync(id: string): Promise<void>;
  export function getPermissionsAsync(): Promise<{ status: 'granted' | 'denied' | 'undetermined'; canAskAgain: boolean }>;
  export function requestPermissionsAsync(): Promise<{ status: 'granted' | 'denied' | 'undetermined'; canAskAgain: boolean }>;
  export function getLastNotificationResponseAsync(): Promise<NotificationResponse | null>;
  export function addNotificationResponseReceivedListener(cb: (r: NotificationResponse) => void): { remove(): void };
}
declare module 'expo-splash-screen' {
  export function preventAutoHideAsync(): Promise<boolean>;
  export function hideAsync(): Promise<void>;
  export function setOptions(o: { duration?: number; fade?: boolean }): void;
}
declare module 'expo' {
  export const requireOptionalNativeModule: (<T>(name: string) => T | null) | undefined;
}
declare function require(p: string): any;
declare module 'expo-keep-awake' {
  export function activateKeepAwakeAsync(tag?: string): Promise<void>;
  export function deactivateKeepAwake(tag?: string): Promise<void>;
}
declare module 'react-native-svg' {
  const Svg: any;
  export default Svg;
  export const Path: any, Rect: any;
}
declare module 'react-native-view-shot' {
  export function captureRef(ref: any, o?: { format?: 'png' | 'jpg'; quality?: number; result?: 'tmpfile' | 'base64' }): Promise<string>;
}
