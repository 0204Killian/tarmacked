import { Component, ReactNode, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView, ActivityIndicator, AppState, Linking, Animated, Easing, Image, Switch, Platform, Alert, ActionSheetIOS, Keyboard } from 'react-native';
import MapView, { Polyline, UrlTile, Marker, PROVIDER_DEFAULT, MapPressEvent, MapType, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { File, Directory, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as MailComposer from 'expo-mail-composer';
import * as DocumentPicker from 'expo-document-picker';
import * as store from './src/storage';
import * as bg from './src/background';
import * as Motion from './modules/motion-activity';
import * as NavKit from './modules/nav-kit';
import { RoadNetwork, RoadSegment, baseChunkId } from './src/roadMatcher';
import { DriveMatcher, Point, PieceIndex, isPatchy } from './src/coverage';
import { recheckDrives, driveDistanceMeters } from './src/recheck';
import { HEAT_STEPS, heatStep, stepColor, rankRoads, RoadRank } from './src/heat';
import { Coord, lineLengthMeters, distanceMeters, headingBetween, haversine, tileIdForPoint, neighbourTileIds, simplifyLine } from './src/geo';
import { RoadData, fetchJson } from './src/roadData';
import { migrateEdits, OldEdit } from './src/editMigrate';
import { Recap, driveGains } from './src/recap';
import { RecapCard } from './src/RecapCard';
import { Navigator, NavUpdate, routeAhead } from './src/nav';
import { RoadGraph, PlannedRoute, RouteMode, Avoid, sameRoute } from './src/router';
import { RouteData, Region as NavRegion, regionsFor } from './src/routeData';
import { Place, fold } from './src/places';
import { SearchPanel, RouteChooser, NavBanner, NavFooter, SpeedLimit } from './src/navUi';
import { TILE_HOST } from './src/tiles';
import { formatBytes, shortCounty, pad2, formatWhen, formatDuration, km } from './src/format';
import { Chain, buildChains } from './src/chains';
import { SettingsCard, SettingsHeader, SettingsRow, settingStyles } from './src/settingsUi';

// Road data comes from tiles.tarmacked.com (see src/tiles.ts and
// scripts/pipeline). It's checked for a newer version at most this often.
const ROAD_DATA_CHECK_MS = 6 * 60 * 60 * 1000;
// Shown in Settings → Help. Keep in step with app.json.
const APP_VERSION = '0.20.7';
// How far ahead of your position the route line is cut (under your dot).
const NAV_TRIM_LEAD_M = 8;
const SUPPORT_EMAIL = 'support@tarmacked.com';



// Edit mode only draws roads once zoomed in this far (a few km across).
const EDIT_MAX_LAT_DELTA = 0.06;
// A pause longer than this inside one old recording = two separate drives.
const DRIVE_SPLIT_GAP_MS = 15 * 60 * 1000;
const NOTE_MS = 7000;
// Bumped whenever the road-matching rules change, so saved drives are
// replayed once under the new rules. 2 = v0.14.1 (route-aware matching),
// 3 = v0.14.2 (roads marked since trails were saved must be re-earned),
// 4 = v0.15.1 (roundabouts drawn in several pieces),
// 5 = v0.15.2 (roads once put back by hand are re-checked too: slip stubs;
// heatmap counts every pass within a drive).
const MATCHER_REV = 5;
const LOG_LINES = 60;

// Real road totals for every county and the whole Republic, made by the
// road-data pipeline alongside the tiles (stats.json). Cached for offline use.
type CountyStats = { counties: string[]; totalMeters: number[]; nationalMeters: number };
type Panel = null | 'stats' | 'drives' | 'dev';

// 'osm' = OpenStreetMap tiles drawn over a plain Apple map (the default).
type MapChoice = 'osm' | MapType;
const MAP_TYPES: MapChoice[] = ['osm', 'standard', 'satellite', 'hybrid'];
const MAP_LABELS: Record<MapChoice, string> = { osm: 'OSM', standard: 'Apple', satellite: 'Satellite', hybrid: 'Hybrid' } as Record<MapChoice, string>;
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// GPS accuracy modes. Savings come from logging less often and letting
// the phone batch updates; accuracy stays high in every mode so points
// aren't thrown away by the wild-GPS filter.
type AccuracyMode = 'high' | 'balanced' | 'saver' | 'auto';
const ACCURACY_MODES: { key: AccuracyMode; label: string; info: string }[] = [
  { key: 'high', label: 'High', info: 'Recommended. A point every ~10 m. Most accurate, most battery.' },
  { key: 'balanced', label: 'Balanced', info: 'A point every ~20 m, delivered in batches. Less battery.' },
  { key: 'saver', label: 'Saver', info: 'A point every ~35 m, big batches. Least battery; short roads may be missed.' },
  { key: 'auto', label: 'Auto', info: 'High while charging, Balanced on battery.' },
];
const isCharging = (s: Battery.BatteryState) => s === Battery.BatteryState.CHARGING || s === Battery.BatteryState.FULL;
type StatsTab = 'overview' | 'counties' | 'roads' | 'data';
type AutoPerm = { key: 'motion' | 'location' | 'notifications'; state: 'ok' | 'ask' | 'settings' | 'phoneOff' | 'unavailable' | 'missing' };
const PERM_TEXT: Record<AutoPerm['key'], { name: string; why: string; fix: string }> = {
  motion: {
    name: 'Motion & Fitness',
    why: 'To tell driving from walking.',
    fix: 'Turned off. In Settings, turn on Motion & Fitness for tarmacked.',
  },
  location: {
    name: 'Location: Always',
    why: "To notice you've set off while the app is closed.",
    fix: 'In Settings → Location, choose Always (and keep Precise Location on).',
  },
  notifications: {
    name: 'Notifications',
    why: 'To ask before saving a drive.',
    fix: 'Turned off. In Settings → Notifications, turn on Allow Notifications.',
  },
};
const STATS_TABS: { key: StatsTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'counties', label: 'Counties' },
  { key: 'roads', label: 'Roads' },
  { key: 'data', label: 'Your data' },
];
const FALLBACK_REGION = { latitude: 53.1, longitude: -7.7, latitudeDelta: 4, longitudeDelta: 4 };
const haversineM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => haversine([a.lat, a.lon], [b.lat, b.lon]);
const toLatLng = (c: Coord[]) => c.map(([latitude, longitude]) => ({ latitude, longitude }));


// Keep the native splash up until the loading screen (which looks the
// same) is ready to take over, so there's no flash between them.
SplashScreen.preventAutoHideAsync().catch(() => undefined);
// Never leave the splash up if something goes wrong before the loading screen shows.
setTimeout(() => SplashScreen.hideAsync().catch(() => undefined), 8000);
const LOADING_MIN_MS = 600;

// When iOS starts the app in the background (leaving the wake-up fence,
// GPS for a drive), the screen isn't on and nobody is looking: the heavy
// start-up work (all road data, re-checks) waits until the app is opened.
// The background tasks in src/background.ts don't need any of it.
function whenOpened(): Promise<void> {
  if (AppState.currentState !== 'background') return Promise.resolve();
  return new Promise((resolve) => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        sub.remove();
        resolve();
      }
    });
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

// If anything goes wrong while drawing the screen, show the error instead
// of a blank screen, so it can be reported.
class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    SplashScreen.hideAsync().catch(() => undefined);
    return { error };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={styles.onboardContainer}>
        <Text style={styles.onboardTitle}>Something went wrong</Text>
        <Text style={styles.onboardText}>Screenshot this and send it on:</Text>
        <ScrollView style={styles.countyList}>
          <Text style={styles.logText}>{`${error.message}\n\n${error.stack ?? ''}`}</Text>
        </ScrollView>
      </View>
    );
  }
}

export default function Root() {
  return (
    <CrashScreen>
      <App />
    </CrashScreen>
  );
}

function App() {
  // null = still loading; false = needs onboarding; true = ready
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [onboardingCounties, setOnboardingCounties] = useState<string[] | null>(null);
  const [onboardingError, setOnboardingError] = useState('');
  const [onboardTry, setOnboardTry] = useState(0);
  const [downloadingCounty, setDownloadingCounty] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState({ done: 0, total: 0 });
  const [homeCounty, setHomeCounty] = useState<string | null>(null);

  const [tracking, setTracking] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editAction, setEditAction] = useState<'exclude' | 'undrive'>('exclude');
  const [following, setFollowing] = useState(true);
  const [panel, setPanel] = useState<Panel>(null);
  const [mapTypeIndex, setMapTypeIndex] = useState(0);
  const [region, setRegion] = useState(FALLBACK_REGION);
  const [visibleRegion, setVisibleRegion] = useState<Region>(FALLBACK_REGION);
  const mapRef = useRef<MapView | null>(null);

  // Driven / excluded roads. The refs are the source of truth (read inside
  // timers and async work); the state copies make the screen update.
  const drivenRef = useRef<Set<string>>(new Set());
  const excludedRef = useRef<Set<string>>(new Set());
  const [drivenIds, setDrivenIds] = useState<Set<string>>(new Set());
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  // Stored with each driven road so it draws and counts even when the road
  // data for that area isn't downloaded.
  const drivenShapesRef = useRef<Map<string, Coord[]>>(new Map());
  const drivenCountyRef = useRef<Map<string, number>>(new Map());
  const lengthRef = useRef<Map<string, number>>(new Map());
  const excludedInfoRef = useRef<Map<string, { c: number | null; l: number | null }>>(new Map());
  const unmarkedRef = useRef<Map<string, number>>(new Map());
  // Partly-driven road pieces: covered stretches that add up across drives.
  const partialsRef = useRef<Map<string, [number, number][]>>(new Map());

  // Downloaded road data.
  const netRef = useRef(new RoadNetwork());
  // Which areas are loaded, and the road-data version (src/roadData.ts).
  const roadDataRef = useRef<RoadData | null>(null);
  const onSegmentsRef = useRef<(segs: RoadSegment[]) => void>(() => undefined);
  const logRef = useRef<(line: string) => void>(() => undefined);
  const snapshotEditsRef = useRef<() => Promise<void>>(async () => undefined);
  if (!roadDataRef.current) {
    roadDataRef.current = new RoadData({
      fetchJson,
      getMeta: store.getMeta,
      setMeta: store.setMeta,
      getTiles: store.getTiles,
      putTiles: store.putTiles,
      clearTiles: store.clearTiles,
      beforeClear: () => snapshotEditsRef.current(),
      onSegments: (segs) => onSegmentsRef.current(segs),
      log: (line) => logRef.current(line),
    });
  }
  const roadData = roadDataRef.current;
  const lastRoadCheckRef = useRef(0);
  const [netRev, setNetRev] = useState(0);

  const [countyStats, setCountyStats] = useState<CountyStats | null>(null);
  const [currentCounty, setCurrentCounty] = useState<number | null>(null);

  // The drive in progress.
  const matcherRef = useRef<DriveMatcher | null>(null);
  const currentDriveIdRef = useRef<number | null>(null);
  const driveStartRef = useRef(0);
  const driveDistanceRef = useRef(0);
  const driveNewMRef = useRef(0);
  const lastLivePointRef = useRef<Point | null>(null);
  const [liveIds, setLiveIds] = useState<string[]>([]);
  const [liveTrail, setLiveTrail] = useState<Point[]>([]);
  const [accuracyMode, setAccuracyMode] = useState<AccuracyMode>('high');
  const activeModeRef = useRef<bg.Mode>('high');
  const batterySub = useRef<{ remove(): void } | null>(null);

  // Heatmap: how many drives covered each chunk.
  const [roadCounts, setRoadCounts] = useState<Map<string, number>>(new Map());
  const [heatOn, setHeatOn] = useState(false);
  // A most-driven stretch picked from Stats → Roads, highlighted on the map.
  const [highlight, setHighlight] = useState<{ name: string; count: number; chunks: string[] } | null>(null);
  const [statsTab, setStatsTab] = useState<StatsTab>('overview');

  // Automatic drive detection.
  const [autoDetect, setAutoDetect] = useState(false);
  const [offerAuto, setOfferAuto] = useState(false); // the "Never miss a drive" screen
  const [autoPerms, setAutoPerms] = useState<AutoPerm[]>([]);
  const [autoWanted, setAutoWanted] = useState(false); // you turned it on (it may still need permissions)
  const [autoBusy, setAutoBusy] = useState(false);

  // Drives list / drive shown on the map.
  const [drives, setDrives] = useState<store.DriveSummary[] | null>(null);
  const [selectedDrive, setSelectedDrive] = useState<{ id: number; points: Point[]; roads: string[] } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  // Dev / housekeeping.
  const [unmatchedCount, setUnmatchedCount] = useState(0);
  const [rawStats, setRawStats] = useState({ drives: 0, points: 0 });
  const [rawSessions, setRawSessions] = useState<Point[][] | null>(null);
  const [recheckProgress, setRecheckProgress] = useState<number | null>(null);

  // Edit roads: this session's edits, newest last, for Undo (v0.16).
  type Edit =
    | { kind: 'unmark'; id: string; prevUnmarked: number | null; rows: Promise<store.DrivenRow[]> }
    | { kind: 'exclude'; id: string };
  const [editHistory, setEditHistory] = useState<Edit[]>([]);

  const [simulateTaps, setSimulateTaps] = useState(false);
  // Developer section of Settings: hidden until the version is tapped 7 times.
  const [devMenu, setDevMenu] = useState(false);
  const versionTapsRef = useRef<number[]>([]);
  // The card after a drive (v0.17).
  const [recap, setRecap] = useState<Recap | null>(null);
  const driveFreshRef = useRef<string[]>([]);
  const [storageInfo, setStorageInfo] = useState<{ tiles: number; bytes: number; pinned: number } | null>(null);
  const [confirming, setConfirming] = useState<null | 'uninstall'>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNoteText] = useState('');

  // Sat-nav (v0.18): our own routes (src/router.ts).
  type NavStage = 'off' | 'search' | 'choose' | 'driving';
  type Dest = { name: string; at: Coord };
  const [navStage, setNavStage] = useState<NavStage>('off');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState('');
  const [dest, setDest] = useState<Dest | null>(null);
  const [routeOptions, setRouteOptions] = useState<PlannedRoute[]>([]);
  const [chosenRoute, setChosenRoute] = useState(0);
  const [routesLoading, setRoutesLoading] = useState('');
  const [routeError, setRouteError] = useState('');
  const [navRoute, setNavRoute] = useState<PlannedRoute | null>(null);
  const [navUpdate, setNavUpdate] = useState<NavUpdate | null>(null);
  const [rerouting, setRerouting] = useState(false);
  const [muted, setMuted] = useState(false);
  const navRef = useRef<Navigator | null>(null);
  const navDestRef = useRef<Dest | null>(null);
  const navModeRef = useRef<RouteMode>('fastest');
  const navLastFixRef = useRef<Point | null>(null);
  const rerouteAtRef = useRef(0);
  const routeRequestRef = useRef(0); // ignores answers to older route requests
  const mutedRef = useRef(false);
  const routeDataRef = useRef<RouteData | null>(null);
  // Avoid options (v0.19): defaults in Settings → Navigation, changeable per trip.
  const [avoidDefaults, setAvoidDefaults] = useState<Avoid>({});
  const [tripAvoid, setTripAvoid] = useState<Avoid>({});
  const navAvoidRef = useRef<Avoid>({});
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [log, setLog] = useState<string[]>([]);

  // Map drawing.
  const [dataLoaded, setDataLoaded] = useState(false);
  const [loadingGone, setLoadingGone] = useState(false);
  const [bootStep, setBootStep] = useState('Starting…');

  const setNote = useCallback((text: string) => {
    setNoteText(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    if (text) noteTimer.current = setTimeout(() => setNoteText(''), NOTE_MS);
  }, []);
  // Also saved, so what happened in the background can be checked later.
  const addLog = useCallback((line: string) => {
    const d = new Date();
    setLog((prev) => [...prev.slice(-(LOG_LINES - 1)), `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${line}`]);
    store.appendLog(line).catch(() => undefined);
  }, []);

  // ---------- Driven-road bookkeeping ----------

  const rememberDriven = (id: string, shape: Coord[] | null, county: number | null) => {
    if (shape) {
      drivenShapesRef.current.set(id, shape);
      lengthRef.current.set(id, lineLengthMeters(shape));
    }
    if (county !== null) drivenCountyRef.current.set(id, county);
  };

  const forgetDriven = (id: string) => {
    drivenShapesRef.current.delete(id);
    drivenCountyRef.current.delete(id);
    lengthRef.current.delete(id);
  };

  // Marks road pieces as driven. A piece already covered by a driven one
  // adds nothing; smaller pieces a new one covers (e.g. a start/stop
  // stretch, later driven in full) are replaced by it.
  // Returns the new pieces and the metres of road they add.
  const markDriven = (ids: string[]): { fresh: string[]; newM: number } => {
    const net = netRef.current;
    const bases = new Set(ids.map(baseChunkId));
    const index = new PieceIndex(Array.from(drivenRef.current).filter((d) => bases.has(baseChunkId(d))));
    const fresh: string[] = [];
    const replaced: string[] = [];
    let newM = 0;
    for (const id of ids) {
      if (excludedRef.current.has(baseChunkId(id)) || index.coveredBy(id)) continue;
      for (const old of index.within(id)) {
        index.delete(old);
        replaced.push(old);
        newM -= lengthRef.current.get(old) ?? net.length(old);
      }
      index.add(id);
      fresh.push(id);
    }
    if (fresh.length === 0) return { fresh, newM: 0 };
    for (const old of replaced) {
      drivenRef.current.delete(old);
      forgetDriven(old);
    }
    const stillFresh = fresh.filter((id) => !replaced.includes(id));
    const rows = stillFresh.map((id) => {
      const shape = drivenShapesRef.current.get(id) ?? net.shapeOf(id);
      const county = drivenCountyRef.current.get(id) ?? net.countyOf(id);
      rememberDriven(id, shape, county);
      drivenRef.current.add(id);
      newM += lengthRef.current.get(id) ?? net.length(id);
      return { id, shape, county };
    });
    setDrivenIds(new Set(drivenRef.current));
    store
      .applyRecheck(rows, replaced, false)
      .catch((e) => setNote(`Couldn't save driven roads: ${(e as Error).message}`));
    return { fresh: stillFresh, newM: Math.max(0, newM) };
  };

  // When road data arrives, fill in shape/county/length for driven or
  // excluded roads we didn't know them for (e.g. older history).
  const backfillFromSegments = (segs: RoadSegment[]) => {
    const drivenFill: { id: string; shape: Coord[]; county: number | null }[] = [];
    const excludedFill: { id: string; county: number | null; lengthM: number }[] = [];
    for (const seg of segs) {
      if (drivenRef.current.has(seg.id)) {
        const needShape = !drivenShapesRef.current.has(seg.id);
        const needCounty = seg.c !== undefined && !drivenCountyRef.current.has(seg.id);
        if (needShape || needCounty) {
          const shape = drivenShapesRef.current.get(seg.id) ?? seg.coords;
          rememberDriven(seg.id, shape, seg.c ?? null);
          drivenFill.push({ id: seg.id, shape, county: seg.c ?? null });
        }
      }
      const ex = excludedInfoRef.current.get(seg.id);
      if (ex && (ex.c === null || ex.l === null)) {
        const next = { c: ex.c ?? seg.c ?? null, l: ex.l ?? lineLengthMeters(seg.coords) };
        excludedInfoRef.current.set(seg.id, next);
        excludedFill.push({ id: seg.id, county: next.c, lengthM: next.l });
      }
    }
    if (drivenFill.length > 0) store.addDriven(drivenFill).catch(() => undefined);
    if (excludedFill.length > 0) store.fillExcludedInfo(excludedFill).catch(() => undefined);
    return drivenFill.length;
  };

  const addRoadData = (segs: RoadSegment[]) => {
    if (segs.length === 0) return;
    netRef.current.add(segs);
    const filled = backfillFromSegments(segs);
    setNetRev((r) => r + 1);
    if (filled > 0) setDrivenIds(new Set(drivenRef.current)); // stats may change
  };

  // ---------- Road data tiles ----------

  onSegmentsRef.current = addRoadData;
  logRef.current = addLog;

  // Loads road data for these areas: from the phone, else downloaded.
  // Returns how many areas couldn't be had (no signal).
  const ensureTiles = (tileIds: Iterable<string>, onProgress?: (f: number) => void) => roadData.ensure(tileIds, { onProgress });

  // Road data for the area on screen (edit mode, or after moving the map).
  const ensureVisible = (minLat: number, minLon: number, maxLat: number, maxLon: number) => {
    const tiles: string[] = [];
    for (let la = minLat; la <= maxLat + 0.05; la += 0.05)
      for (let lo = minLon; lo <= maxLon + 0.05; lo += 0.05) tiles.push(tileIdForPoint(Math.min(la, maxLat), Math.min(lo, maxLon)));
    if (tiles.length <= 30) roadData.ensure(tiles).catch(() => undefined);
  };

  const downloadHomeCounty = async (county: string) => {
    setDownloadingCounty(county);
    setOnboardingError('');
    try {
      const tileIds = roadData.countyTiles(county);
      setDownloadProgress({ done: 0, total: tileIds.length });
      const failed = await roadData.ensure(tileIds, {
        pinned: true, // home county is never auto-cleared
        onProgress: (f) => setDownloadProgress({ done: Math.round(f * tileIds.length), total: tileIds.length }),
      });
      if (failed > 0) throw new Error(`${failed} area(s) didn't download`);
      await store.setMeta('home_county', county);
      await store.setMeta('onboarded', 'true');
      setHomeCounty(county);
      setOnboarded(true);
      return true;
    } catch (e) {
      setOnboardingError(`Download failed: ${(e as Error).message}. Check your connection and try again.`);
      return false;
    } finally {
      setDownloadingCounty(null);
    }
  };

  // Before a new version of the road data replaces the old: note where each
  // map edit is, so it can be moved onto the new road pieces.
  snapshotEditsRef.current = async () => {
    const ids = [...Array.from(excludedRef.current).map((id) => ({ id, kind: 'x' })), ...Array.from(unmarkedRef.current.keys()).map((id) => ({ id, kind: 'u' }))];
    if (ids.length === 0) return;
    let old: RoadNetwork = netRef.current;
    if (ids.some(({ id }) => !old.shapeOf(id))) {
      old = new RoadNetwork();
      old.add(netRef.current.segs.size ? Array.from(netRef.current.segs.values()) : []);
      old.add((await store.getAllTiles()).flatMap((t) => t.segments));
    }
    const edits = ids.map(({ id, kind }) => ({ id, kind, shape: old.shapeOf(id) ?? drivenShapesRef.current.get(id) ?? [] }));
    // Merged with any earlier migration that hasn't finished yet.
    let earlier: any[] = [];
    try {
      earlier = JSON.parse((await store.getMeta('edit_migration')) || '[]');
    } catch {
      earlier = [];
    }
    const seen = new Set(edits.map((e) => `${e.kind}|${e.id}`));
    await store.setMeta('edit_migration', JSON.stringify([...edits, ...earlier.filter((e) => !seen.has(`${e.kind}|${e.id}`))]));
  };

  // Moves map edits onto the new road pieces (needs signal for the areas
  // they're in; otherwise it waits and tries again later).
  const migrateEditsNow = async (): Promise<boolean> => {
    let edits: (OldEdit & { kind: 'x' | 'u' })[] = [];
    try {
      edits = JSON.parse((await store.getMeta('edit_migration')) || '[]');
    } catch {
      edits = [];
    }
    if (edits.length === 0) return true;
    const tiles = new Set<string>();
    for (const e of edits) for (const c of e.shape.length ? [e.shape[0], e.shape[e.shape.length - 1]] : []) neighbourTileIds(c[0], c[1]).forEach((t) => tiles.add(t));
    if ((await roadData.ensure(tiles)) > 0) {
      addLog(`moving ${edits.length} map edit(s) waits for road data`);
      return false;
    }
    const where = migrateEdits(edits, netRef.current);
    let moved = 0;
    let dropped = 0;
    for (const e of edits) {
      const to = where.get(e.id) ?? [e.id];
      if (to.length === 1 && to[0] === e.id) continue;
      if (to.length === 0) dropped++;
      else moved++;
      if (e.kind === 'x') {
        if (!excludedRef.current.has(e.id)) continue;
        excludedRef.current.delete(e.id);
        excludedInfoRef.current.delete(e.id);
        await store.setExcluded(e.id, false);
        for (const n of to) {
          const c = netRef.current.countyOf(n);
          const l = netRef.current.length(n);
          excludedRef.current.add(n);
          excludedInfoRef.current.set(n, { c, l });
          await store.setExcluded(n, true, c, l);
        }
      } else {
        const at = unmarkedRef.current.get(e.id);
        if (at === undefined) continue;
        unmarkedRef.current.delete(e.id);
        await store.setUnmarked(e.id, null);
        for (const n of to) {
          unmarkedRef.current.set(n, at);
          await store.setUnmarked(n, at);
        }
      }
    }
    await store.setMeta('edit_migration', '');
    setExcludedIds(new Set(excludedRef.current));
    addLog(`map edits: ${edits.length} checked, ${moved} moved to new road pieces, ${dropped} on roads that are gone`);
    return true;
  };

  // Checks for newer road data (not mid-drive: the road pieces would change
  // under the drive being matched). A new version reloads the road data,
  // moves map edits across and re-checks every drive against it.
  const syncRoadData = async (force = false): Promise<'new' | 'same' | 'offline' | 'busy'> => {
    if (!force && Date.now() - lastRoadCheckRef.current < ROAD_DATA_CHECK_MS) return 'same';
    if ((await bg.currentWatch()) || recheckRunning.current) return 'busy';
    const hadIndex = !!roadData.index;
    const change = await roadData.refresh();
    if (!roadData.index) return 'offline';
    lastRoadCheckRef.current = Date.now();
    roadData.statsJson().then(async (fresh) => {
      if (!fresh || !Array.isArray(fresh.counties) || !Array.isArray(fresh.totalMeters)) return;
      setCountyStats(fresh);
      await store.setMeta('county_stats', JSON.stringify(fresh));
    });
    if (!change) return hadIndex ? 'same' : 'new';
    addLog(`road data ${change.from || 'from before 0.17'} → ${change.to}`);
    netRef.current.clear();
    roadData.forget();
    setNetRev((r) => r + 1);
    const home = await store.getMeta('home_county');
    if (home) await roadData.ensure(roadData.countyTiles(home), { pinned: true });
    await migrateEditsNow();
    await store.setMeta('recheck_pending', '1');
    return 'new';
  };

  const skipOnboarding = async () => {
    await store.setMeta('onboarded', 'true');
    setOnboarded(true);
  };

  // ---------- Loading ----------

  useEffect(() => {
    (async () => {
      await whenOpened();
      try {
        setBootStep('Opening your data…');
        const migrated = await store.migrateIfNeeded();
        if (migrated) setNote(migrated);
        // Once: tidy away the empty auto drives that Stop used to leave
        // behind (0.20.0 and older started a new one straight after Stop).
        if ((await store.getMeta('empty_auto_cleanup')) !== '1') {
          for (const d of await store.listDrives()) {
            if (d.auto && d.status !== 'recording' && (d.distanceM ?? 0) < 50 && d.pointCount < 30 && !(d.newM ?? 0)) await store.deleteDrive(d.id);
          }
          await store.setMeta('empty_auto_cleanup', '1');
        }
      } catch (e) {
        setNote(`Couldn't move your data to the new storage yet (${(e as Error).message}). Nothing was deleted — it retries next launch.`);
      }
      try {
        setBootStep('Clearing old road data…');
        await store.evictStaleTiles();
        const hasIndex = await roadData.loadCached();
        setBootStep('Loading your roads…');
        const data = await store.loadAll();
        setBootStep('Setting up the map…');
        for (const d of data.driven) {
          drivenRef.current.add(d.id);
          rememberDriven(d.id, d.shape, d.county);
        }
        for (const e of data.excluded) {
          excludedRef.current.add(e.id);
          excludedInfoRef.current.set(e.id, { c: e.county, l: e.lengthM });
        }
        unmarkedRef.current = await store.loadUnmarked();
        partialsRef.current = await store.loadPartials();
        setRoadCounts(await store.loadRoadCounts());
        const savedMode = (await store.getMeta('accuracy_mode')) as AccuracyMode | null;
        if (savedMode && ACCURACY_MODES.some((m) => m.key === savedMode)) setAccuracyMode(savedMode);
        setDevMenu((await store.getMeta('dev_menu')) === '1');
        mutedRef.current = (await store.getMeta('nav_muted')) === '1';
        setMuted(mutedRef.current);
        try {
          setAvoidDefaults(JSON.parse((await store.getMeta('nav_avoid')) || '{}'));
        } catch {
          // none saved
        }
        const savedMap = await store.getMeta('map_type');
        if (savedMap && MAP_TYPES.includes(savedMap as MapChoice)) setMapTypeIndex(MAP_TYPES.indexOf(savedMap as MapChoice));
        if (hasIndex) {
          // Home county from the phone; everywhere else loads as it's needed.
          if (data.homeCounty) await roadData.ensure(roadData.countyTiles(data.homeCounty), { pinned: true });
        } else {
          // Road data from before 0.17 (no signal yet to fetch the new
          // data): use what's on the phone until then.
          addRoadData((await store.getAllTiles()).flatMap((t) => t.segments));
        }
        setDrivenIds(new Set(drivenRef.current));
        setExcludedIds(new Set(excludedRef.current));
        setUnmatchedCount(data.unmatched.length);
        setRawStats({ drives: data.driveCount, points: data.pointCount });
        if (data.homeCounty) setHomeCounty(data.homeCounty);
        setOnboarded(data.onboarded);
        setDataLoaded(true);
      } catch (e) {
        setBootStep(`Couldn't load saved data: ${(e as Error).message}`);
        setNote(`Couldn't load saved data: ${(e as Error).message}`);
        setOnboarded(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // County totals: the cached copy straight away; a fresh one comes with
  // each road-data check (syncRoadData).
  useEffect(() => {
    (async () => {
      try {
        const cached = await store.getMeta('county_stats');
        if (cached) setCountyStats(JSON.parse(cached));
      } catch {
        // no cached copy yet
      }
    })();
  }, []);

  useEffect(() => {
    if (onboarded !== false || onboardingCounties !== null) return;
    (async () => {
      await syncRoadData(true);
      const counties = roadData.counties();
      if (counties.length > 0) setOnboardingCounties(counties);
      else setOnboardingError("Couldn't download the road data. Check your connection and try again.");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded, onboardingCounties, onboardTry]);

  // Location permissions and a first fix to centre the map.
  useEffect(() => {
    if (onboarded !== true) return;
    (async () => {
      try {
        const fg = await withTimeout(Location.requestForegroundPermissionsAsync(), 8000, 'foreground permission');
        addLog(`location permission: ${fg.status}`);
      } catch (e) {
        addLog(`location permission failed: ${(e as Error).message}`);
      }
      try {
        const current = await withTimeout(Location.getCurrentPositionAsync({}), 8000, 'get current position');
        const here = { latitude: current.coords.latitude, longitude: current.coords.longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 };
        setRegion(here);
        setVisibleRegion(here);
        mapRef.current?.animateToRegion(here, 300);
        roadData.ensure(neighbourTileIds(here.latitude, here.longitude)).catch(() => undefined);
      } catch (e) {
        addLog(`no position yet: ${(e as Error).message}`);
      }
    })();
  }, [onboarded, addLog]);

  // ---------- Re-checking drives ----------

  const recheckRunning = useRef(false);

  /**
   * Replays every saved drive through the matching rules and updates which
   * roads count as driven (adding and removing). Downloads road data for
   * everywhere you've driven first; if that isn't possible (no signal) it
   * does nothing and tries again later. Removed roads can be put back.
   */
  const runRecheck = async (reason: 'upgrade' | 'manual' | 'deleted'): Promise<boolean> => {
    if (recheckRunning.current) return false;
    // Not while a drive is recording: the re-check rewrites the partly-driven
    // stretches and per-drive roads the live drive is adding to. It runs
    // once the drive ends instead.
    if (await bg.currentWatch()) {
      await store.setMeta('recheck_pending', '1');
      addLog(`re-check (${reason}) waits for the drive to end`);
      return false;
    }
    recheckRunning.current = true;
    setRecheckProgress(0);
    try {
      const queuedBefore = await store.loadMatchQueue();
      const allDrives = await store.loadDrives();
      // Trails of deleted drives still waiting for their roads to be removed.
      let forgotten: Point[][] = [];
      try {
        forgotten = JSON.parse((await store.getMeta('forgotten_trails')) || '[]');
      } catch {
        forgotten = [];
      }
      // Left-out drives earn nothing; their trails are only used to find
      // the roads to re-check (like a deleted drive's).
      // Auto-detected drives you haven't saved (pending, or still
      // recording) don't count yet; a drive you started yourself counts
      // while it records.
      const counts = (d: store.DriveRecord) => d.status === 'done' || (d.status === 'recording' && !d.auto);
      const counted = allDrives.filter((d) => counts(d) && !d.leftOut);
      const leftOutTrails = allDrives.filter((d) => counts(d) && d.leftOut).map((d) => d.points);
      const tiles = new Set<string>();
      const visited = new Set<string>();
      for (const points of [...allDrives.map((d) => d.points), ...forgotten]) {
        for (const p of points) {
          const own = tileIdForPoint(p.latitude, p.longitude);
          if (visited.has(own)) continue;
          visited.add(own);
          neighbourTileIds(p.latitude, p.longitude).forEach((t) => tiles.add(t));
        }
      }
      // Also the road data for driven roads we have no county for yet.
      drivenRef.current.forEach((id) => {
        if (drivenCountyRef.current.has(id)) return;
        const shape = drivenShapesRef.current.get(id);
        if (shape) tiles.add(tileIdForPoint(shape[0][0], shape[0][1]));
      });
      const failed = await ensureTiles(tiles, (f) => setRecheckProgress(f * 0.3));
      if (failed > 0) {
        await store.setMeta('recheck_pending', '1');
        setNote(`Couldn't download road data for ${failed} area(s) — I'll re-check your drives next time you have signal.`);
        return false;
      }
      const current = new Map<string, Coord[] | null>();
      drivenRef.current.forEach((id) => current.set(id, drivenShapesRef.current.get(id) ?? null));
      // GPS trails have been saved since the earliest drive (or trail of a
      // deleted one); roads marked before that, or carried over from the
      // old storage, are the only ones kept without a drive to back them.
      const trailStarts = [...allDrives.map((d) => d.startedAt), ...forgotten.filter((t) => t.length).map((t) => t[0].timestamp)];
      const migratedAt = Number((await store.getMeta('migrated_from_asyncstorage')) || 0);
      const trailsSince = Math.max(trailStarts.length ? Math.min(...trailStarts) : Infinity, migratedAt + 1);
      const result = await recheckDrives(
        netRef.current,
        counted,
        current,
        excludedRef.current,
        unmarkedRef.current,
        (f) => setRecheckProgress(0.3 + f * 0.7),
        [...forgotten, ...leftOutTrails],
        { firstAt: await store.loadDrivenFirstAt(), trailsSince }
      );
      const net = netRef.current;
      const addRows = result.add.map((id) => ({ id, shape: net.shapeOf(id), county: net.countyOf(id) }));
      await store.applyRecheck(addRows, result.remove, reason !== 'deleted');
      await store.setMeta('forgotten_trails', '[]');
      await store.setDriveStats(result.stats);
      await store.replaceUnmatched(result.unmatched);
      await store.replacePartials(result.partials);
      await store.replaceAllDriveRoads(result.driveRoads);
      setRoadCounts(await store.loadRoadCounts());
      // Keep the same Map object (a live matcher may hold it), new contents.
      partialsRef.current.clear();
      result.partials.forEach((v, k) => partialsRef.current.set(k, v));
      await store.setMeta('recheck_pending', '');
      // A full replay covers every saved drive under the current rules.
      await store.setMeta('matcher_rev', String(MATCHER_REV));
      await store.dequeueMatch(queuedBefore);
      for (const r of addRows) {
        drivenRef.current.add(r.id);
        rememberDriven(r.id, r.shape, r.county);
      }
      for (const id of result.remove) {
        drivenRef.current.delete(id);
        forgetDriven(id);
      }
      setDrivenIds(new Set(drivenRef.current));
      setUnmatchedCount(result.unmatched.length);
      setRawStats({ drives: allDrives.length, points: allDrives.reduce((n, d) => n + d.points.length, 0) });
      if (drives !== null) setDrives(await store.listDrives());
      const changed = result.add.length + result.remove.length;
      if (reason !== 'deleted' || changed > 0) {
        setNote(
          `Re-checked ${allDrives.length} drive(s): ${result.add.length} road pieces added, ${result.remove.length} removed.` +
            ''
        );
      }
      addLog(`re-check (${reason}): +${result.add.length} −${result.remove.length}`);
      return true;
    } catch (e) {
      setNote(`Re-check failed: ${(e as Error).message}. Nothing was changed.`);
      return false;
    } finally {
      recheckRunning.current = false;
      setRecheckProgress(null);
    }
  };

  /**
   * Matches drives that finished without the app matching them live (ended
   * with the app closed, or auto drives you've just saved) onto the map —
   * just those drives, on top of what's already there. Much quicker than
   * replaying your whole history, which only happens now when roads may
   * need REMOVING (a drive deleted or left out) or the rules change.
   */
  const matchQueued = async (): Promise<boolean> => {
    if (recheckRunning.current) return false;
    const queue = await store.loadMatchQueue();
    if (queue.length === 0) return true;
    recheckRunning.current = true;
    const doneIds: number[] = [];
    try {
      const drives: { d: NonNullable<Awaited<ReturnType<typeof store.getDrive>>>; points: Point[] }[] = [];
      for (const id of queue) {
        const d = await store.getDrive(id);
        if (!d || d.status !== 'done' || d.leftOut) {
          doneIds.push(id); // deleted, left out, or not saved: nothing to add
          continue;
        }
        drives.push({ d, points: await store.loadDrivePoints(id) });
      }
      const tiles = new Set<string>();
      for (const { points } of drives) for (const p of points) neighbourTileIds(p.latitude, p.longitude).forEach((t) => tiles.add(t));
      if ((await ensureTiles(tiles)) > 0) {
        addLog(`matching ${drives.length} drive(s) waits for road data`);
        return false;
      }
      drives.sort((a, b) => a.d.startedAt - b.d.startedAt);
      for (const { d, points } of drives) {
        const m = new DriveMatcher(netRef.current, excludedRef.current, partialsRef.current);
        const unmatched: Point[] = [];
        const completed: string[] = [];
        for (let i = 0; i < points.length; i += 200) {
          const r = m.feed(points.slice(i, i + 200));
          completed.push(...r.completed);
          unmatched.push(...r.unmatched);
          await tick();
        }
        completed.push(...m.finish());
        // Start/stop credit after the completed sections (as when matched live);
        // and, as in the re-check, a road you un-marked after this drive stays un-marked.
        const ids = [...completed, ...m.stubs].filter((id) => {
          const at = unmarkedRef.current.get(id) ?? unmarkedRef.current.get(baseChunkId(id));
          return at === undefined || at < d.startedAt;
        });
        const { fresh, newM } = markDriven(ids);
        savePartialsFrom(m);
        if (unmatched.length) {
          store.addUnmatched(unmatched).catch(() => undefined);
          setUnmatchedCount((n) => n + unmatched.length);
        }
        const last = points[points.length - 1];
        await store.setDriveStats([{ id: d.id, endedAt: last ? last.timestamp : null, distanceM: driveDistanceMeters(points), newM, ignoredN: m.gps.ignored }]);
        const passes = m.roadPasses();
        await store.setDriveRoads(d.id, passes);
        doneIds.push(d.id);
        // Just finished (an auto-detected drive you saved): the recap card.
        if (drives.length === 1 && last && Date.now() - last.timestamp < 30 * 60_000)
          showRecap({ driveId: d.id, startedAt: d.startedAt, endedAt: last.timestamp, distanceM: driveDistanceMeters(points), newM, fresh, roads: Array.from(passes.keys()) });
        addLog(`drive ${d.id} matched: ${km(newM)} km new`);
      }
      if (drives.length) {
        setRoadCounts(await store.loadRoadCounts());
        setNote(drives.length === 1 ? `Drive added to your map.` : `${drives.length} drives added to your map.`);
      }
      return true;
    } catch (e) {
      addLog(`matching saved drives failed: ${(e as Error).message}`);
      return false;
    } finally {
      await store.dequeueMatch(doneIds).catch(() => undefined);
      recheckRunning.current = false;
    }
  };

  // Work that waits for the app to be open and no drive recording: a
  // deferred full re-check first (it covers queued drives too), else
  // matching just the queued drives.
  const runPendingWork = async () => {
    if (await bg.currentWatch()) return;
    await syncRoadData().catch(() => 'offline');
    await migrateEditsNow().catch(() => false);
    if ((await store.getMeta('recheck_pending')) === '1') await runRecheck('manual');
    else await matchQueued();
    store.listDrives().then(setDrives).catch(() => undefined);
  };
  const pendingWorkRef = useRef(runPendingWork);
  pendingWorkRef.current = runPendingWork;

  // First launch of v0.13: split old recordings into drives and re-check
  // everything with the new rule. Also retries a re-check that couldn't run.
  useEffect(() => {
    if (!dataLoaded || onboarded !== true) return;
    (async () => {
      // A drive that ended while the app was closed is closed off first.
      await bg.setupNotifications();
      try {
        await bg.settle();
      } catch (e) {
        addLog(`settle failed: ${(e as Error).message}`);
      }
      // Newer road data? (Moves map edits across and asks for a re-check.)
      try {
        await syncRoadData(true);
      } catch (e) {
        addLog(`road data check failed: ${(e as Error).message}`);
      }
      const upgraded = await store.getMeta('v013_upgrade');
      const upgraded14 = await store.getMeta('v014_upgrade');
      const pending = await store.getMeta('recheck_pending');
      if (!upgraded) {
        const { split, dropped } = await store.splitDrivesOnGaps(DRIVE_SPLIT_GAP_MS);
        addLog(`drives tidied: ${split} split, ${dropped} empty removed`);
        await store.setMeta('v013_split', '1');
        if (await runRecheck('upgrade')) {
          await store.setMeta('v013_upgrade', String(Date.now()));
          await store.setMeta('v014_upgrade', String(Date.now()));
        }
      } else if (!upgraded14) {
        // v0.14: start/stop credit, wild-GPS filter and heatmap counts
        // are worked out for every saved drive.
        if (await runRecheck('upgrade')) {
          await store.setMeta('v014_upgrade', String(Date.now()));
          await store.setMeta('matcher_rev', String(MATCHER_REV));
        }
      } else if (Number((await store.getMeta('matcher_rev')) || '1') < MATCHER_REV) {
        // The road matcher changed (v0.14.1: slip roads, roundabouts):
        // replay every saved drive once so the whole map follows the new rules.
        if (await runRecheck('upgrade')) await store.setMeta('matcher_rev', String(MATCHER_REV));
      } else if (pending === '1') {
        await runRecheck('manual');
      }
      // Drives that ended with the app closed: added to the map.
      await matchQueued();
      // Still recording (the app was closed mid-drive): pick it back up.
      // (Not a walk-to-the-car trial: that only shows once it's a drive.)
      const rec = await store.getRecordingDrive();
      const recW = await bg.currentWatch();
      if (rec && recW && !recW.trial) {
        beginLive(rec.id, rec.startedAt, rec.auto);
        addLog(`drive ${rec.id} resumed`);
      }
      // Opened by tapping a notification button while the app was closed.
      try {
        const last = await Notifications.getLastNotificationResponseAsync();
        if (last) {
          const key = `${last.notification.request.identifier}|${last.notification.date}|${last.actionIdentifier}`;
          if ((await store.getMeta('last_response')) !== key) {
            await store.setMeta('last_response', key);
            await responseRef.current(last.actionIdentifier, last.notification.request.content.data);
          }
        }
      } catch {
        // none
      }
      if (!(await store.getMeta('autodetect_offered'))) setOfferAuto(true);
      setAutoDetect(await bg.autoDetectEnabled());
      if ((await bg.autoDetectEnabled()) && !(await store.getMeta('autodetect_wanted'))) await store.setMeta('autodetect_wanted', '1');
      refreshPermsRef.current().catch(() => undefined);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataLoaded, onboarded]);

  // Notification buttons tapped while the app is running.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      const key = `${r.notification.request.identifier}|${r.notification.date}|${r.actionIdentifier}`;
      store.setMeta('last_response', key).catch(() => undefined);
      responseRef.current(r.actionIdentifier, r.notification.request.content.data);
    });
    return () => sub.remove();
  }, []);

  // Coming back to the app: close off a drive that ended while away, catch
  // up on points, and re-check anything that needs it.
  useEffect(() => {
    if (!dataLoaded || onboarded !== true) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      (async () => {
        try {
          refreshPermsRef.current().catch(() => undefined);
          await bg.settle();
          pollRef.current();
          if (currentDriveIdRef.current === null) {
            const rec = await store.getRecordingDrive();
            const w = await bg.currentWatch();
            if (rec && w && !w.trial) beginLive(rec.id, rec.startedAt, rec.auto);
          }
          await pendingWorkRef.current();
        } catch (e) {
          addLog(`resume failed: ${(e as Error).message}`);
        }
      })();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataLoaded, onboarded]);

  // ---------- Tracking ----------

  const processPoints = (newPoints: Point[]) => {
    if (newPoints.length === 0) return;
    if (navRef.current) navFeedRef.current(newPoints);
    // Fetch road data around you before you need it.
    const wanted = new Set<string>();
    for (const p of newPoints) neighbourTileIds(p.latitude, p.longitude).forEach((t) => wanted.add(t));
    roadData.ensure(wanted).catch(() => undefined);

    const matcher = matcherRef.current;
    // Distance only counts points that pass the wild-GPS filter.
    let good = newPoints;
    if (matcher) {
      const result = matcher.feed(newPoints);
      good = result.accepted;
      const { fresh, newM } = markDriven(result.completed);
      if (fresh.length > 0) {
        driveNewMRef.current += newM;
        driveFreshRef.current.push(...fresh);
        setLiveIds((prev) => [...prev, ...fresh]);
      }
      if (result.unmatched.length > 0) {
        setUnmatchedCount((n) => n + result.unmatched.length);
        store.addUnmatched(result.unmatched).catch(() => undefined);
      }
      savePartialsFrom(matcher);
      const last = matcher.lastChunkId ? netRef.current.segs.get(matcher.lastChunkId) : undefined;
      if (last?.c !== undefined) setCurrentCounty(last.c);
    }

    for (const p of good) {
      const prev = lastLivePointRef.current;
      if (prev && p.timestamp - prev.timestamp <= 60_000) driveDistanceRef.current += distanceMeters(prev, p);
      lastLivePointRef.current = p;
    }
    setRawStats((prev) => ({ ...prev, points: prev.points + newPoints.length }));
    setLiveTrail((prev) => [...prev, ...newPoints]);
    store.touchTiles(Array.from(new Set(newPoints.map((p) => tileIdForPoint(p.latitude, p.longitude))))).catch(() => undefined);
  };

  // Saves the partly-driven stretches this drive changed.
  const savePartialsFrom = (matcher: DriveMatcher) => {
    if (matcher.touched.size === 0) return;
    const entries: [string, [number, number][] | null][] = Array.from(matcher.touched).map((id) => [
      id,
      partialsRef.current.get(id) ?? null,
    ]);
    matcher.touched.clear();
    store.savePartials(entries).catch(() => undefined);
  };

  const processRef = useRef(processPoints);
  processRef.current = processPoints;

  // The live drive reads its new points from the database, where the
  // background task saves every point (so nothing is lost if iOS closes
  // the app mid-drive).
  const lastPolledRef = useRef(0);
  const pointCountRef = useRef(0);
  const pollBusyRef = useRef(false);
  const pollOnce = async () => {
    const driveId = currentDriveIdRef.current;
    if (driveId === null || pollBusyRef.current) return;
    pollBusyRef.current = true;
    try {
      const pts = await store.loadPointsSince(driveId, lastPolledRef.current);
      if (pts.length > 0) {
        lastPolledRef.current = pts[pts.length - 1].timestamp;
        pointCountRef.current += pts.length;
        processRef.current(pts);
      }
    } catch (e) {
      addLog(`couldn't read GPS points: ${(e as Error).message}`);
    } finally {
      pollBusyRef.current = false;
    }
  };
  const pollRef = useRef(pollOnce);
  pollRef.current = pollOnce;

  useEffect(() => {
    if (!tracking) return;
    const h = setInterval(() => pollRef.current(), 2000);
    return () => clearInterval(h);
  }, [tracking]);

  // An auto-detected drive recording: shown on the map, but its roads only
  // count once you save it.
  const [liveAuto, setLiveAuto] = useState(false);
  const liveAutoRef = useRef(false);

  // Shows a drive as the live one (just started, or resumed after the app
  // was closed): its points so far are read in on the first poll.
  const beginLive = (driveId: number, startedAt: number, auto: boolean) => {
    currentDriveIdRef.current = driveId;
    matcherRef.current = auto ? null : new DriveMatcher(netRef.current, excludedRef.current, partialsRef.current);
    liveAutoRef.current = auto;
    setLiveAuto(auto);
    driveStartRef.current = startedAt;
    driveDistanceRef.current = 0;
    driveNewMRef.current = 0;
    driveFreshRef.current = [];
    lastLivePointRef.current = null;
    lastPolledRef.current = startedAt - 1;
    pointCountRef.current = 0;
    setLiveIds([]);
    setLiveTrail([]);
    setTracking(true);
    pollRef.current();
  };

  const endLiveUi = () => {
    if (batterySub.current) {
      batterySub.current.remove();
      batterySub.current = null;
    }
    matcherRef.current = null;
    currentDriveIdRef.current = null;
    liveAutoRef.current = false;
    setLiveAuto(false);
    setTracking(false);
    setLiveIds([]);
    setLiveTrail([]);
    store.listDrives().then(setDrives).catch(() => undefined);
  };

  // The recap card: the drive's roads (new ones green), and what it added.
  const showRecap = (r: { driveId: number; startedAt: number; endedAt: number; distanceM: number; newM: number; fresh: string[]; roads: string[] }) => {
    if (r.distanceM < 300) return; // moved the car, not a drive
    const net = netRef.current;
    const shape = (id: string) => drivenShapesRef.current.get(id) ?? net.shapeOf(id) ?? null;
    const freshSet = new Set(r.fresh);
    const newShapes = r.fresh.map(shape).filter((c): c is Coord[] => !!c);
    const oldShapes = r.roads.filter((id) => !freshSet.has(id)).map(shape).filter((c): c is Coord[] => !!c);
    const pieces = r.fresh.map((id) => ({ lengthM: lengthRef.current.get(id) ?? net.length(id), county: drivenCountyRef.current.get(id) ?? net.countyOf(id) }));
    // Pieces can replace shorter bits driven before: scale to the real new metres.
    const sum = pieces.reduce((a, p) => a + p.lengthM, 0);
    const k = sum > 0 ? Math.max(0, Math.min(1, r.newM / sum)) : 0;
    const gains = driveGains(pieces.map((p) => ({ ...p, lengthM: p.lengthM * k })), countyStats);
    setRecap({ driveId: r.driveId, startedAt: r.startedAt, endedAt: r.endedAt, distanceM: r.distanceM, newM: r.newM, newShapes, oldShapes, ...gains });
  };

  // Finishes matching a drive matched live (Stop pressed, or it ended by
  // itself while the app was open), and saves its figures.
  const finishLiveMatching = () => {
    const matcher = matcherRef.current;
    const driveId = currentDriveIdRef.current;
    if (!matcher || driveId === null) return;
    const done = matcher.finish();
    // Start/stop credit comes after the completed sections, so a section
    // finished this drive replaces any stretch of it.
    const { fresh: lastFresh, newM } = markDriven([...done, ...matcher.stubs]);
    driveNewMRef.current += newM;
    driveFreshRef.current.push(...lastFresh);
    savePartialsFrom(matcher);
    const ignored = matcher.gps.ignored;
    const driveRoads = matcher.roadPasses();
    matcherRef.current = null;
    if (pointCountRef.current < 2) {
      store.deleteDrive(driveId).catch(() => undefined); // nothing recorded
      setRawStats((prev) => ({ ...prev, drives: Math.max(0, prev.drives - 1) }));
      return;
    }
    store
      .setDriveStats([{ id: driveId, endedAt: Date.now(), distanceM: driveDistanceRef.current, newM: driveNewMRef.current, ignoredN: ignored }])
      .catch(() => undefined);
    store
      .setDriveRoads(driveId, driveRoads)
      .then(() => store.loadRoadCounts())
      .then(setRoadCounts)
      .catch(() => undefined);
    const patchy = isPatchy(ignored, pointCountRef.current);
    setNote(
      `Drive saved: ${km(driveDistanceRef.current)} km, ${km(driveNewMRef.current)} km of new road.` +
        (patchy ? ' ⚠ Patchy GPS on this drive — check it in Drives.' : '')
    );
    showRecap({
      driveId,
      startedAt: driveStartRef.current,
      endedAt: Date.now(),
      distanceM: driveDistanceRef.current,
      newM: driveNewMRef.current,
      fresh: driveFreshRef.current,
      roads: Array.from(driveRoads.keys()),
    });
  };

  // GPS mode for a new drive; in Auto, follows charging while it records.
  const chooseMode = async (): Promise<bg.Mode> => {
    if (accuracyMode !== 'auto') return accuracyMode;
    try {
      const mode: bg.Mode = isCharging(await Battery.getBatteryStateAsync()) ? 'high' : 'balanced';
      batterySub.current = Battery.addBatteryStateListener(({ batteryState }) => {
        const next: bg.Mode = isCharging(batteryState) ? 'high' : 'balanced';
        if (next !== activeModeRef.current) {
          activeModeRef.current = next;
          bg.startUpdates(next).catch(() => undefined);
        }
      });
      return mode;
    } catch (e) {
      addLog(`battery state unavailable: ${(e as Error).message}`);
      return 'balanced';
    }
  };

  // Start and Stop ignore taps while the last one is still being handled.
  const busyRef = useRef(false);

  // Start pressed. (Not passed straight to onPress: that would hand it the press event.)
  const start = () => startRecording(null);
  // forceMode: the sat-nav records in High (no batching, so prompts are on time).
  const startRecording = async (forceMode: bg.Mode | null) => {
    if (busyRef.current || tracking) return;
    busyRef.current = true;
    try {
      setSelectedDrive(null);
      setHighlight(null);
      setPanel(null);
      setFollowing(true);
      const mode = forceMode ?? (await chooseMode());
      activeModeRef.current = mode;
      try {
        const bgPerm = await Location.getBackgroundPermissionsAsync();
        if (bgPerm.status !== 'granted' && bgPerm.canAskAgain) await withTimeout(Location.requestBackgroundPermissionsAsync(), 8000, 'background permission');
      } catch {
        // records while the app is open at least
      }
      try {
        // For "Still driving?" if you forget to press Stop.
        const n = await Notifications.getPermissionsAsync();
        if (n.status === 'undetermined' && n.canAskAgain) await withTimeout(Notifications.requestPermissionsAsync(), 8000, 'notification permission');
      } catch {
        // prompts just won't show
      }
      let w;
      try {
        w = await withTimeout(bg.startManualDrive(mode), 10000, 'start tracking');
      } catch (e) {
        addLog(`couldn't start tracking: ${(e as Error).message}`);
        setNote(`Couldn't start GPS: ${(e as Error).message}`);
        await bg.discardDrive().catch(() => undefined);
        return;
      }
      setRawStats((prev) => ({ ...prev, drives: prev.drives + 1 }));
      beginLive(w.driveId, Date.now() - 1000, w.auto);
    } finally {
      busyRef.current = false;
    }
  };

  const stop = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await pollRef.current(); // the last points
      if (liveAutoRef.current) {
        // Stop on an auto-detected drive = yes, this was a drive.
        // Auto-detect then stays off until you've parked (no new drive
        // starting the moment you press Stop while still moving).
        await bg.confirmDrive();
        const r = await bg.endDrive('Stop pressed', { trim: true, matched: false }); // queues it for matching
        endLiveUi();
        if (r?.status === 'dropped') {
          setNote('Too short to save. Auto-detect is off until you park.');
          return;
        }
        setNote('Drive saved. Auto-detect is off until you park.');
        await runPendingWork();
        return;
      }
      finishLiveMatching();
      await bg.endDrive('Stop pressed', { trim: false, matched: true });
      endLiveUi();
      runPendingWork().catch(() => undefined); // a re-check that waited for the drive
    } finally {
      busyRef.current = false;
    }
  };

  // Like a sat-nav: while a drive is recording and the map is following
  // you, the screen stays on (the power button still locks it). Panning
  // away from your position lets it sleep normally again.
  useEffect(() => {
    const keepOn = tracking && following && !editMode;
    if (keepOn) activateKeepAwakeAsync('following').catch(() => undefined);
    else Promise.resolve(deactivateKeepAwake('following')).catch(() => undefined);
    return () => {
      Promise.resolve(deactivateKeepAwake('following')).catch(() => undefined);
    };
  }, [tracking, following, editMode]);

  // Things the background code did while the app was open.
  const bgEventRef = useRef((e: bg.BgEvent) => {});
  bgEventRef.current = (e: bg.BgEvent) => {
    // Started in the background (app not opened yet): the road data isn't
    // loaded, so a live view would match nothing. The drive is picked up
    // when the app is opened; until then the background task records it.
    if (!dataLoaded || onboarded !== true) return;
    if (e.type === 'started' && currentDriveIdRef.current === null) {
      store
        .getRecordingDrive()
        .then((rec) => rec && rec.id === e.driveId && beginLive(rec.id, rec.startedAt, rec.auto))
        .catch(() => undefined);
    } else if (e.type === 'ended' && currentDriveIdRef.current === e.driveId && !busyRef.current) {
      // Ended by itself (parked 15+ minutes, or GPS came back after a long stop).
      // Matched live here, so it doesn't need matching again from the queue.
      const live = !liveAutoRef.current;
      if (live) finishLiveMatching();
      endLiveUi();
      (live ? store.dequeueMatch([e.driveId]) : Promise.resolve())
        .then(() => pendingWorkRef.current())
        .catch(() => undefined);
    } else if (e.type === 'points' && currentDriveIdRef.current === e.driveId) {
      pollRef.current();
    }
  };
  useEffect(() => bg.onChange((e) => bgEventRef.current(e)), []);

  // Answers to the drive notifications (Save / Delete / End drive).
  const handleResponse = async (action: string, data: Record<string, unknown> | undefined) => {
    const driveId = Number(data?.driveId);
    if (!Number.isFinite(driveId)) return;
    const w = await bg.currentWatch();
    const live = !!w && w.driveId === driveId;
    try {
      if (action === 'save') {
        if (live) {
          await bg.confirmDrive();
          setNote('Saved. Still recording this drive — it ends when you park.');
        } else {
          await store.setDriveStatus(driveId, 'done');
          await store.queueMatch(driveId);
          setNote('Drive saved — adding its roads to your map…');
          await matchQueued();
        }
      } else if (action === 'delete') {
        if (live) {
          await bg.discardDrive();
          if (currentDriveIdRef.current === driveId) endLiveUi();
        } else await store.deleteDrive(driveId);
        setNote('Drive deleted.');
      } else if (action === 'end') {
        if (live && currentDriveIdRef.current === driveId) await stop();
        else if (live) await bg.endDrive('End drive tapped', { trim: true, matched: false });
      } else if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) {
        setPanel('drives');
      }
    } catch (e) {
      setNote(`Couldn't do that: ${(e as Error).message}`);
    }
    store.listDrives().then(setDrives).catch(() => undefined);
  };
  const responseRef = useRef(handleResponse);
  responseRef.current = handleResponse;

  const onMapPress = (e: MapPressEvent) => {
    if (!tracking || editMode || !simulateTaps) return;
    const { latitude, longitude } = e.nativeEvent.coordinate;
    bg.onPoints([{ latitude, longitude, timestamp: Date.now() }]).catch(() => undefined);
  };

  // ---------- Sat-nav (v0.18) ----------
  // Routes are our own (src/router.ts): the main roads from graph.json plus
  // the detailed road tiles near the start and the end. Following a route,
  // prompts and going off route are src/nav.ts. Positions come from the
  // recording drive, so navigating always records (in High, so prompts are
  // on time).

  const navDir = () => {
    const d = new Directory(Paths.document, 'nav');
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    return d;
  };
  if (!routeDataRef.current) {
    routeDataRef.current = new RouteData({
      fetchText: async (url) => {
        try {
          const res = await fetch(url);
          if (res.status === 404) return { ok: false, missing: true };
          if (!res.ok) return { ok: false, missing: false };
          return { ok: true, text: await res.text() };
        } catch {
          return { ok: false, missing: false };
        }
      },
      readFile: async (name) => {
        const f = new File(navDir(), name);
        return f.exists ? await f.text() : null;
      },
      writeFile: async (name, text) => {
        new File(navDir(), name).write(text);
      },
      deleteFiles: async (keep) => {
        for (const item of navDir().list()) if (item instanceof File && !keep.includes(item.name)) item.delete();
      },
      log: (line) => addLog(line),
    });
  }
  const routeData = routeDataRef.current;

  // The road-data regions a trip needs (more than one = a cross-border trip):
  // the ones its points are in, and any between them.
  const navRegions = (points: Coord[] = []): NavRegion[] =>
    regionsFor(
      Object.entries(roadData.manifest?.regions ?? {}).map(([id, r]) => ({ id, version: r.version, base: `${TILE_HOST}${r.path}`, bbox: (r as { bbox?: number[] }).bbox ?? null, cells: (r as { cells?: string[] }).cells ?? null })),
      points,
    );

  const say = (text: string) => {
    if (!mutedRef.current) NavKit.speak(text);
  };

  // Where you are, and which way you're going if that's known.
  const hereNow = async (): Promise<{ at: Coord; heading: number | null } | null> => {
    const p = lastLivePointRef.current;
    if (p && Date.now() - p.timestamp < 60_000) {
      const prev = navLastFixRef.current;
      const heading = prev && prev !== p && distanceMeters(prev, p) > 8 ? headingBetween(prev, p) : null;
      return { at: [p.latitude, p.longitude], heading };
    }
    try {
      const pos =
        (await Location.getLastKnownPositionAsync({ maxAge: 60_000 })) ??
        (await withTimeout(Location.getCurrentPositionAsync({}), 8000, 'get current position'));
      const h = pos.coords.heading;
      const moving = (pos.coords.speed ?? 0) > 2;
      return { at: [pos.coords.latitude, pos.coords.longitude], heading: h != null && h >= 0 && moving ? h : null };
    } catch {
      return null;
    }
  };

  // The detailed roads within ~5 km of these points go into the route graph
  // (downloaded first if they aren't on the phone).
  const addDetailAround = async (graph: RoadGraph, points: Coord[], regions: NavRegion[]) => {
    const want = new Set<string>();
    for (const p of points) {
      for (let la = p[0] - 0.045; la <= p[0] + 0.0451; la += 0.025) {
        for (let lo = p[1] - 0.075; lo <= p[1] + 0.0751; lo += 0.025) want.add(tileIdForPoint(la, lo));
      }
    }
    // Ireland's from the phone's road data; other countries' downloaded for the route.
    await roadData.ensure(want);
    const segs: RoadSegment[] = [];
    for (const seg of netRef.current.segs.values()) if (want.has(tileIdForPoint(seg.coords[0][0], seg.coords[0][1]))) segs.push(seg);
    for (const r of regions) {
      if (r.id === 'ie' || !r.bbox) continue;
      const b = r.bbox;
      const inside = [...want].filter((t) => {
        const [, a, c] = t.split('_').map(Number);
        return (a + 1) * 0.05 >= b[0] && a * 0.05 <= b[2] && (c + 1) * 0.05 >= b[1] && c * 0.05 <= b[3];
      });
      if (inside.length) segs.push(...(await routeData.foreignTiles(r, inside)));
    }
    graph.addDetail(segs);
  };

  // Road pieces you've driven, for the "new roads" route and its new-road total.
  const drivenChecker = () => {
    const base = new Set<string>();
    for (const id of drivenRef.current) base.add(baseChunkId(id));
    return (way: number, piece: number) => base.has(`way/${way}#${piece}`);
  };

  const planRoutes = async (
    from: { at: Coord; heading: number | null },
    to: Coord,
    modes: RouteMode[],
    req: number,
    avoid: Avoid,
    onStage: (what: string) => void = () => undefined,
  ): Promise<{ routes: PlannedRoute[]; hasGraph: boolean } | null> => {
    onStage('Getting road data…');
    const regions = navRegions([from.at, to]);
    const data = await routeData.load(regions);
    await addDetailAround(data.graph, [from.at, to], regions);
    if (req !== routeRequestRef.current) return null;
    onStage('Working out routes…');
    await tick();
    const isDriven = drivenChecker();
    const routes: PlannedRoute[] = [];
    for (const mode of modes) {
      const t0 = Date.now();
      const r = data.graph.route({ lat: from.at[0], lon: from.at[1], heading: from.heading }, { lat: to[0], lon: to[1] }, mode, isDriven, avoid);
      addLog(`sat-nav: ${mode} route ${r ? `${km(r.distance)} km` : 'not found'} in ${Date.now() - t0} ms`);
      if (r && !routes.some((o) => sameRoute(o, r))) routes.push(r);
      await tick();
      if (req !== routeRequestRef.current) return null;
    }
    return { routes, hasGraph: data.withGraph.length > 0 };
  };

  const openSearch = () => {
    setPanel(null);
    setSearchQuery('');
    setSearchResults([]);
    setSearchNote('');
    setNavStage('search');
    hereNow()
      .then((h) => routeData.load(navRegions(h ? [h.at] : [])))
      .catch(() => undefined); // ready for the first letters
  };

  // Towns and villages as you type (on the phone); Apple's search for
  // addresses, Eircodes and businesses after a short pause (online).
  useEffect(() => {
    if (navStage !== 'search') return;
    const q = searchQuery.trim();
    setSearchNote('');
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    let live = true;
    let local: Place[] = [];
    const herePromise = hereNow();
    (async () => {
      const here = await herePromise;
      const data = await routeData.load(navRegions(here ? [here.at] : []));
      if (!live) return;
      local = data.places.search(q, here?.at ?? null, 6);
      setSearchResults((prev) => (prev.some((p) => p.source === 'online') ? prev : local));
    })().catch(() => undefined);
    if (!NavKit.canSearch() || q.length < 3) {
      return () => {
        live = false;
      };
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const here = await herePromise;
        const found = await NavKit.search(q, here?.at ?? null);
        if (!live) return;
        const online: Place[] = found.map((f) => ({ ...f, source: 'online' as const }));
        // A town of ours with the same name as an Apple result nearby: keep ours.
        const dup = (o: Place) => local.some((l) => fold(l.name) === fold(o.name) && haversineM(l, o) < 3000);
        const exact = local.filter((l) => fold(l.name).startsWith(fold(q)));
        const rest = local.filter((l) => !exact.includes(l));
        setSearchResults([...exact.slice(0, 3), ...online.filter((o) => !dup(o)), ...exact.slice(3), ...rest].slice(0, 15));
      } catch {
        if (live) setSearchNote("Couldn't search online (no connection?). Towns and villages still work.");
      } finally {
        if (live) setSearching(false);
      }
    }, 450);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, navStage]);

  const chooseDestination = async (d: Dest, avoid: Avoid = avoidDefaults) => {
    Keyboard.dismiss();
    setTripAvoid(avoid);
    const req = ++routeRequestRef.current;
    setDest(d);
    setNavStage('choose');
    setPanel(null);
    setRouteOptions([]);
    setChosenRoute(0);
    setRouteError('');
    setRoutesLoading('Finding you…');
    try {
      const from = await hereNow();
      if (!from) throw new Error('No GPS position yet. Try again in a moment.');
      const res = await planRoutes(from, d.at, ['fastest', 'new'], req, avoid, (what) => req === routeRequestRef.current && setRoutesLoading(what));
      if (!res) return;
      if (res.routes.length === 0) {
        throw new Error(
          res.hasGraph
            ? "Couldn't find a driving route to there."
            : "Couldn't find a route. Long trips need the newest road data: try Settings → Road data → Check for updates.",
        );
      }
      setRouteOptions(res.routes);
      setChosenRoute(0);
      setFollowing(false);
      const pts = res.routes.flatMap((r) => r.coords.filter((_, i) => i % 10 === 0));
      mapRef.current?.fitToCoordinates(toLatLng([...pts, d.at, from.at]), { edgePadding: { top: 120, right: 50, bottom: 340, left: 50 }, animated: true });
    } catch (e) {
      if (req === routeRequestRef.current) setRouteError((e as Error).message);
    } finally {
      if (req === routeRequestRef.current) setRoutesLoading('');
    }
  };

  const cancelRoutes = () => {
    routeRequestRef.current++;
    setNavStage('off');
    setDest(null);
    setRouteOptions([]);
    setRouteError('');
    setRoutesLoading('');
  };

  // Long-press the map: route to that spot.
  const onMapLongPress = (e: MapPressEvent) => {
    if (editMode || navStage === 'driving') return;
    const { latitude, longitude } = e.nativeEvent.coordinate;
    const at: Coord = [latitude, longitude];
    chooseDestination({ name: 'Dropped pin', at }).catch(() => undefined);
    const rename = (name: string) => setDest((d) => (d && d.at[0] === at[0] && d.at[1] === at[1] && name ? { ...d, name } : d));
    NavKit.placeName(at)
      .then(async (name) => {
        if (name) return rename(name);
        const near = (await routeData.load(navRegions([at]))).places.nearest(at);
        if (near) rename(near.km < 1 ? near.name : `Near ${near.name}`);
      })
      .catch(() => undefined);
  };

  const spokenName = (d: Dest) => (d.name === 'Dropped pin' ? '' : d.name.split(',')[0]);

  // Once, before the first trip: directions and limits are a guide.
  const startNavigation = async () => {
    if (!routeOptions[chosenRoute] || !dest) return;
    if ((await store.getMeta('nav_notice')) !== '1') {
      Alert.alert(
        'Before you go',
        'Directions and speed limits come from OpenStreetMap and can be wrong or out of date. Always follow the road signs and the rules of the road.',
        [
          { text: 'How to fix the map', onPress: () => Linking.openURL('https://tarmacked.com/map-data').catch(() => undefined) },
          { text: 'Got it', onPress: () => { store.setMeta('nav_notice', '1').catch(() => undefined); beginNavigation().catch(() => undefined); } },
        ],
        { cancelable: false }
      );
      return;
    }
    await beginNavigation();
  };

  const beginNavigation = async () => {
    const route = routeOptions[chosenRoute];
    if (!route || !dest) return;
    const nav = new Navigator(route, spokenName(dest));
    navRef.current = nav;
    navDestRef.current = dest;
    navModeRef.current = route.mode;
    navAvoidRef.current = route.avoid;
    navLastFixRef.current = null;
    rerouteAtRef.current = 0;
    setNavRoute(route);
    setNavUpdate(null);
    setNavStage('driving');
    setPanel(null);
    setFollowing(true);
    say(nav.start() + (route.uses.tollM > 0 ? ' This route has tolls.' : '') + (route.uses.ferryM > 0 ? ' This route takes a ferry.' : ''));
    addLog(`sat-nav to ${dest.name}: ${route.mode}, ${km(route.distance)} km`);
    if (!tracking) await startRecording('high');
    else if (liveAutoRef.current) await bg.confirmDrive(); // navigating = definitely driving: keep it
    if (tracking && activeModeRef.current !== 'high') {
      activeModeRef.current = 'high';
      bg.startUpdates('high').catch(() => undefined);
    }
  };

  const endNavigation = () => {
    navRef.current = null;
    navDestRef.current = null;
    routeRequestRef.current++;
    NavKit.stopSpeaking();
    setNavRoute(null);
    setNavUpdate(null);
    setNavStage('off');
    setDest(null);
    setRouteOptions([]);
    setRerouting(false);
  };

  // Off the route: a new one from here, the same kind (at most every 10 s).
  const reroute = async (from: Coord, heading: number | null) => {
    const d = navDestRef.current;
    if (!d || Date.now() - rerouteAtRef.current < 10_000) return;
    rerouteAtRef.current = Date.now();
    setRerouting(true);
    try {
      const res = await planRoutes({ at: from, heading }, d.at, [navModeRef.current], routeRequestRef.current, navAvoidRef.current);
      if (!navRef.current || navDestRef.current !== d || !res || res.routes.length === 0) return;
      navRef.current = new Navigator(res.routes[0], spokenName(d));
      setNavRoute(res.routes[0]);
      say('New route.');
      addLog('sat-nav: new route');
    } catch (e) {
      addLog(`sat-nav: couldn't get a new route (${(e as Error).message})`);
    } finally {
      setRerouting(false);
    }
  };

  // Each batch of GPS points from the recording drive.
  const navFeed = (pts: Point[]) => {
    const nav = navRef.current;
    if (!nav) return;
    const p = pts[pts.length - 1];
    if (p.accuracy != null && p.accuracy > 50) return;
    const prev = navLastFixRef.current;
    const dt = prev ? (p.timestamp - prev.timestamp) / 1000 : 0;
    const moved = prev ? distanceMeters(prev, p) : 0;
    const speed = prev && dt >= 1 && dt < 30 ? moved / dt : null;
    const heading = prev && moved > 8 ? headingBetween(prev, p) : null;
    navLastFixRef.current = p;
    const u = nav.update([p.latitude, p.longitude], speed, p.accuracy ?? null);
    setNavUpdate(u);
    if (u.say) say(u.say);
    if (u.offRoute) reroute([p.latitude, p.longitude], heading).catch(() => undefined);
    if (u.arrived) {
      addLog('sat-nav: arrived');
      setTimeout(() => {
        if (navRef.current === nav) endNavigation();
      }, 8000);
    }
  };
  const navFeedRef = useRef(navFeed);
  navFeedRef.current = navFeed;

  // Avoid options: the trip's (re-plans the routes) and the defaults (Settings).
  const toggleTripAvoid = (k: keyof Avoid) => {
    if (!dest) return;
    chooseDestination(dest, { ...tripAvoid, [k]: !tripAvoid[k] }).catch(() => undefined);
  };
  const toggleAvoidDefault = (k: keyof Avoid) => {
    const next = { ...avoidDefaults, [k]: !avoidDefaults[k] };
    setAvoidDefaults(next);
    store.setMeta('nav_avoid', JSON.stringify(next)).catch(() => undefined);
  };

  const toggleMute = () => {
    const m = !mutedRef.current;
    mutedRef.current = m;
    setMuted(m);
    if (m) NavKit.stopSpeaking();
    store.setMeta('nav_muted', m ? '1' : '0').catch(() => undefined);
  };

  // The route still ahead (what's been driven drops off), and the speed
  // limit where you are on it.
  // Cut exactly where you are (a few metres ahead, under your dot), every
  // 5 m: the line behind you disappears as you drive over it.
  const navAlongStep = navUpdate ? Math.floor((navUpdate.along + NAV_TRIM_LEAD_M) / 5) : 0;
  const navAhead = useMemo(() => {
    const nav = navRef.current;
    if (!navRoute || !nav || nav.route !== navRoute) return navRoute?.coords ?? [];
    return routeAhead(navRoute.coords, nav.cum, navAlongStep * 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRoute, navAlongStep]);
  const navSpeedLimit = useMemo(() => {
    const nav = navRef.current;
    if (!navRoute || !nav || nav.route !== navRoute || !navUpdate) return 0;
    let i = 0;
    while (i < nav.cum.length - 2 && nav.cum[i + 1] < navUpdate.along) i++;
    return navRoute.speeds[i] ?? 0;
  }, [navRoute, navUpdate]);

  // ---------- Editing ----------

  // Private / gone: toggles. Shared by tapping and Undo.
  const toggleExcluded = (id: string) => {
    const nowExcluded = !excludedRef.current.has(id);
    const seg = netRef.current.segs.get(id);
    const info = { c: seg?.c ?? null, l: seg ? lineLengthMeters(seg.coords) : null };
    if (nowExcluded) {
      excludedRef.current.add(id);
      excludedInfoRef.current.set(id, info);
    } else {
      excludedRef.current.delete(id);
      excludedInfoRef.current.delete(id);
    }
    setExcludedIds(new Set(excludedRef.current));
    store.setExcluded(id, nowExcluded, info.c, info.l).catch((e) => setNote(`Couldn't save that change: ${(e as Error).message}`));
  };

  const handleEditTap = (id: string) => {
    if (editAction === 'undrive') {
      // The tapped road piece, and any sections of it.
      const gone = Array.from(drivenRef.current).filter((d) => baseChunkId(d) === id);
      if (gone.length === 0) return;
      for (const d of gone) {
        drivenRef.current.delete(d);
        forgetDriven(d);
      }
      const prevUnmarked = unmarkedRef.current.get(id) ?? null;
      unmarkedRef.current.set(id, Date.now());
      setDrivenIds(new Set(drivenRef.current));
      // Removed in one go, keeping the rows as they were for Undo.
      const rows = store.removeDrivenPieces(gone);
      rows.catch((e) => setNote(`Couldn't save that change: ${(e as Error).message}`));
      store.markUnmarked(id).catch(() => undefined);
      setEditHistory((h) => [...h, { kind: 'unmark', id, prevUnmarked, rows: rows.catch(() => [] as store.DrivenRow[]) }]);
      return;
    }
    toggleExcluded(id);
    setEditHistory((h) => [...h, { kind: 'exclude', id }]);
  };

  // Undo: steps back one edit of this edit-mode session.
  const undoEdit = async () => {
    const last = editHistory[editHistory.length - 1];
    if (!last) return;
    setEditHistory((h) => h.slice(0, -1));
    if (last.kind === 'exclude') {
      toggleExcluded(last.id);
      return;
    }
    try {
      const rows = await last.rows;
      await store.restoreDriven(rows);
      await store.setUnmarked(last.id, last.prevUnmarked);
      if (last.prevUnmarked === null) unmarkedRef.current.delete(last.id);
      else unmarkedRef.current.set(last.id, last.prevUnmarked);
      for (const r of rows) {
        drivenRef.current.add(r.id);
        rememberDriven(r.id, r.shape ?? netRef.current.shapeOf(r.id), r.county);
      }
      setDrivenIds(new Set(drivenRef.current));
    } catch (e) {
      setNote(`Couldn't undo that: ${(e as Error).message}`);
    }
  };

  // Each visit to edit mode starts a fresh undo list.
  useEffect(() => {
    setEditHistory([]);
  }, [editMode]);


  // ---------- Map helpers ----------

  const recentre = async () => {
    setFollowing(true);
    try {
      const pos =
        (await Location.getLastKnownPositionAsync()) ??
        (await withTimeout(Location.getCurrentPositionAsync({}), 8000, 'get current position'));
      mapRef.current?.animateCamera({ center: { latitude: pos.coords.latitude, longitude: pos.coords.longitude } }, { duration: 400 });
    } catch {
      // no fix right now — following snaps to you on the next update anyway
    }
  };

  // ---------- Drives ----------

  const openDrives = async () => {
    setPanel((p) => (p === 'drives' ? null : 'drives'));
    try {
      setDrives(await store.listDrives());
    } catch (e) {
      setNote(`Couldn't load drives: ${(e as Error).message}`);
    }
  };

  const showDrive = async (id: number) => {
    setDeleteConfirmId(null);
    if (selectedDrive?.id === id) {
      setSelectedDrive(null);
      return;
    }
    try {
      const points = await store.loadDrivePoints(id);
      const roads = await store.loadDriveRoads(id);
      setSelectedDrive({ id, points, roads });
      setHighlight(null);
      if (points.length > 1) {
        setFollowing(false);
        mapRef.current?.fitToCoordinates(
          points.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
          { edgePadding: { top: 120, right: 40, bottom: 320, left: 40 }, animated: true }
        );
      }
    } catch (e) {
      setNote(`Couldn't load that drive: ${(e as Error).message}`);
    }
  };

  const deleteDrive = async (id: number) => {
    if (deleteConfirmId !== id) {
      setDeleteConfirmId(id);
      return;
    }
    setDeleteConfirmId(null);
    if (selectedDrive?.id === id) setSelectedDrive(null);
    try {
      // Remember its trail until the re-check has removed the roads it earned.
      const gone = await store.loadDrivePoints(id);
      let forgotten: Point[][] = [];
      try {
        forgotten = JSON.parse((await store.getMeta('forgotten_trails')) || '[]');
      } catch {
        forgotten = [];
      }
      await store.setMeta('forgotten_trails', JSON.stringify([...forgotten, gone]));
      await store.deleteDrive(id);
      setDrives(await store.listDrives());
      const ok = await runRecheck('deleted');
      if (!ok) setNote('Drive deleted. Its roads are re-checked as soon as possible (after a drive in progress, or once road data can be downloaded).');
    } catch (e) {
      setNote(`Couldn't delete that drive: ${(e as Error).message}`);
    }
  };

  // Leave a patchy drive out (it earns no roads) or put it back in.
  const chooseAccuracy = (mode: AccuracyMode) => {
    setAccuracyMode(mode);
    store.setMeta('accuracy_mode', mode).catch(() => undefined);
  };

  // ---------- Automatic drive detection ----------

  // What auto-detect needs, and for each missing one what fixes it:
  // 'ask' = the iOS prompt can still be shown in the app; 'settings' = it
  // was turned off, flip it on tarmacked's page in Settings; 'phoneOff' =
  // Fitness Tracking is off for the whole phone.
  const checkAutoPermissions = async (): Promise<AutoPerm[]> => {
    const out: AutoPerm[] = [];
    if (!Motion.isLoaded()) out.push({ key: 'motion', state: 'missing' });
    else if (!Motion.isAvailable()) out.push({ key: 'motion', state: 'unavailable' });
    else {
      const st = Motion.authorizationStatus();
      out.push({ key: 'motion', state: st === 'authorized' ? 'ok' : st === 'notDetermined' ? 'ask' : st === 'restricted' ? 'phoneOff' : 'settings' });
    }
    try {
      const b = await Location.getBackgroundPermissionsAsync();
      out.push({ key: 'location', state: b.status === 'granted' ? 'ok' : b.canAskAgain ? 'ask' : 'settings' });
    } catch {
      out.push({ key: 'location', state: 'settings' });
    }
    try {
      const n = await Notifications.getPermissionsAsync();
      out.push({ key: 'notifications', state: n.status === 'granted' ? 'ok' : n.canAskAgain ? 'ask' : 'settings' });
    } catch {
      out.push({ key: 'notifications', state: 'settings' });
    }
    return out;
  };

  // Shows the iOS prompt for one permission.
  const askPermission = async (key: AutoPerm['key']) => {
    try {
      if (key === 'motion') {
        const st = await Motion.requestPermission();
        addLog(`motion permission: ${st} (${Motion.diagnostics()})`);
      }
      else if (key === 'location') {
        const fg = await Location.getForegroundPermissionsAsync();
        if (fg.status !== 'granted') await Location.requestForegroundPermissionsAsync();
        await Location.requestBackgroundPermissionsAsync();
      } else await Notifications.requestPermissionsAsync();
    } catch (e) {
      addLog(`${key} permission: ${(e as Error).message}`);
    }
  };

  // Re-reads the permissions; if you asked for auto-detect and everything
  // is now allowed (e.g. back from Settings), it switches on.
  const refreshAutoPermissions = async () => {
    const perms = await checkAutoPermissions();
    setAutoPerms(perms);
    const wanted = (await store.getMeta('autodetect_wanted')) === '1';
    setAutoWanted(wanted);
    const allOk = perms.every((p) => p.state === 'ok');
    if (wanted && allOk && !(await bg.autoDetectEnabled())) {
      await store.setMeta('autodetect', '1');
      setAutoDetect(true);
      if (!(await bg.currentWatch())) await bg.fenceHere();
      addLog('auto-detect on');
      setNote("Auto-detect is on. Drives you forget to start are recorded, and you're asked before they're saved.");
    }
    return perms;
  };
  const refreshPermsRef = useRef(refreshAutoPermissions);
  refreshPermsRef.current = refreshAutoPermissions;

  // Turning auto-detect on: shows each iOS prompt that can still be shown,
  // then switches on if everything's allowed. Anything still missing is
  // listed in Settings with a button to fix it.
  const enableAutoDetect = async () => {
    if (autoBusy) return;
    setAutoBusy(true);
    try {
      await store.setMeta('autodetect_wanted', '1');
      for (const p of await checkAutoPermissions()) if (p.state === 'ask') await askPermission(p.key);
      const perms = await refreshAutoPermissions();
      if (!perms.every((p) => p.state === 'ok')) {
        setPanel('dev');
        setNote('Auto-detect needs a permission or two — see Settings (⚙) to finish turning it on.');
      }
    } finally {
      await store.setMeta('autodetect_offered', '1').catch(() => undefined);
      setOfferAuto(false);
      setAutoBusy(false);
    }
  };

  const disableAutoDetect = async () => {
    await store.setMeta('autodetect_wanted', '0');
    setAutoWanted(false);
    await store.setMeta('autodetect', '0');
    setAutoDetect(false);
    if (!(await bg.currentWatch())) await bg.clearFence();
    addLog('auto-detect off');
  };

  const declineAutoDetect = () => {
    store.setMeta('autodetect_offered', '1').catch(() => undefined);
    setOfferAuto(false);
  };

  // Settings panel: show what's missing, if anything.
  useEffect(() => {
    if (panel !== 'dev') return;
    refreshAutoPermissions().catch(() => undefined);
    store.tileCacheInfo().then(setStorageInfo).catch(() => undefined);
    store
      .loadLog(LOG_LINES)
      .then((rows) => setLog(rows.map((r) => { const d = new Date(r.t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${r.line}`; })))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  const exportLog = async () => {
    try {
      const rows = await store.loadLog();
      const file = new File(Paths.cache, `tarmacked-log-${new Date().toISOString().slice(0, 10)}.txt`);
      if (file.exists) file.delete();
      file.create();
      file.write(rows.map((r) => `${new Date(r.t).toISOString()} ${r.line}`).join('\n'));
      await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', UTI: 'public.plain-text', dialogTitle: 'tarmacked log' });
    } catch (e) {
      setNote(`Couldn't export the log: ${(e as Error).message}`);
    }
  };

  // Settings → Help → Send a problem report: the app's log (no locations)
  // and a few facts about the phone and data, in a file to email us.
  const sendProblemReport = async () => {
    try {
      const rows = await store.loadLog();
      const info = await store.tileCacheInfo();
      const head = [
        `tarmacked ${APP_VERSION} · iOS ${Platform.Version}`,
        `road data ${roadData.version ?? 'none'} · ${info.tiles} areas cached · home county ${homeCounty ?? 'none'}`,
        `drives ${rawStats.drives} · road pieces driven ${drivenIds.size} · edits ${excludedIds.size + unmarkedRef.current.size}`,
        `auto-detect ${autoDetect ? 'on' : 'off'} · GPS ${accuracyMode}`,
        '',
        'What happened (write it here when you send this):',
        '',
        '--- log ---',
      ];
      // Log lines never hold coordinates, but drop anything that looks like one to be safe.
      const lines = rows.map((r) => `${new Date(r.t).toISOString()} ${r.line.replace(/-?\d{1,3}\.\d{4,}/g, '…')}`);
      const file = new File(Paths.cache, `tarmacked-report-${new Date().toISOString().slice(0, 10)}.txt`);
      if (file.exists) file.delete();
      file.create();
      file.write([...head, ...lines].join('\n'));
      // An email to us, ready to go, with the report attached. No mail
      // account set up in Apple Mail (Gmail app users etc.): the share sheet.
      if (await MailComposer.isAvailableAsync().catch(() => false)) {
        await MailComposer.composeAsync({
          recipients: [SUPPORT_EMAIL],
          subject: `tarmacked ${APP_VERSION} problem report`,
          body: 'What happened, and roughly when and where:\n\n',
          attachments: [file.uri],
        });
        return;
      }
      setNote(`Send the report to ${SUPPORT_EMAIL}`);
      await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', UTI: 'public.plain-text', dialogTitle: `Send to ${SUPPORT_EMAIL}` });
    } catch (e) {
      setNote(`Couldn't make the report: ${(e as Error).message}`);
    }
  };

  const tapVersion = () => {
    const now = Date.now();
    versionTapsRef.current = [...versionTapsRef.current.filter((t) => now - t < 3000), now];
    if (versionTapsRef.current.length >= 7 && !devMenu) {
      versionTapsRef.current = [];
      setDevMenu(true);
      store.setMeta('dev_menu', '1').catch(() => undefined);
      setNote('Developer tools are at the bottom of Settings.');
    }
  };

  // Pending auto-detected drives, from the Drives list.
  const savePending = async (id: number) => {
    await store.setDriveStatus(id, 'done');
    await store.queueMatch(id);
    setDrives(await store.listDrives());
    setNote('Drive saved — adding its roads to your map…');
    await matchQueued();
    setDrives(await store.listDrives());
  };
  const deletePending = async (id: number) => {
    if (selectedDrive?.id === id) setSelectedDrive(null);
    await store.deleteDrive(id);
    setDrives(await store.listDrives());
    setNote('Drive deleted.');
  };

  const toggleLeftOut = async (d: store.DriveSummary) => {
    try {
      await store.setDriveLeftOut(d.id, !d.leftOut);
      setDrives(await store.listDrives());
      const ok = await runRecheck('manual');
      if (!ok) setNote(`Drive ${d.leftOut ? 'included' : 'left out'} — roads update as soon as possible (after a drive in progress, or once road data can be downloaded).`);
    } catch (e) {
      setNote(`Couldn't change that drive: ${(e as Error).message}`);
    }
  };

  // ---------- Stats: roads ----------

  // Jumps to a road's most-driven bit, with the heatmap on so the colours
  // match the list.
  const showRoad = (r: RoadRank) => {
    const shapes = r.hotChunks.map((id) => netRef.current.shapeOf(id)).filter((c): c is Coord[] => !!c);
    if (shapes.length === 0) return;
    setHighlight({ name: r.name, count: r.count, chunks: r.hotChunks });
    setSelectedDrive(null);
    setHeatOn(true);
    setPanel(null);
    setFollowing(false);
    // Zoom to the longest joined-up stretch at that count.
    const chains = buildChains(r.hotChunks, (id) => netRef.current.shapeOf(id) ?? undefined);
    const longest = chains.reduce((a, b) => (lineLengthMeters(b.coords) > lineLengthMeters(a.coords) ? b : a), chains[0]);
    mapRef.current?.fitToCoordinates(toLatLng(longest.coords), {
      edgePadding: { top: 160, right: 60, bottom: 220, left: 60 },
      animated: true,
    });
  };

  // ---------- Dev tools ----------

  const toggleRawTrail = async () => {
    if (rawSessions) {
      setRawSessions(null);
      return;
    }
    try {
      setRawSessions((await store.loadDrives()).map((d) => d.points));
    } catch (e) {
      setNote(`Couldn't load the saved trail: ${(e as Error).message}`);
    }
  };



  // "Update road data": checks for a newer version now.
  const refreshRoadData = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const r = await syncRoadData(true);
      if (r === 'busy') setNote('Road data can be updated once this drive ends.');
      else if (r === 'offline') setNote("Couldn't reach the road data. Check your connection.");
      else if (r === 'same') setNote(`Road data is up to date (${roadData.version}).`);
      else {
        setNote(`Road data updated to ${roadData.version}. Re-checking your drives…`);
        await runPendingWork();
      }
    } finally {
      setRefreshing(false);
    }
  };

  // ---------- Settings choices (native sheets and prompts) ----------
  const pickSheet = (title: string, message: string | undefined, labels: string[], current: number, onPick: (i: number) => void) => {
    const options = [...labels.map((l, i) => (i === current ? `${l} ✓` : l)), 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      { title, message, options, cancelButtonIndex: options.length - 1, userInterfaceStyle: 'dark' },
      (i: number) => {
        if (i < labels.length) onPick(i);
      },
    );
  };

  const chooseAccuracySheet = () =>
    pickSheet(
      'GPS accuracy',
      ACCURACY_MODES.map((m) => `${m.label}: ${m.info}`).join('\n') + (tracking ? '\n\nApplies from your next drive.' : ''),
      ACCURACY_MODES.map((m) => m.label),
      ACCURACY_MODES.findIndex((m) => m.key === accuracyMode),
      (i) => chooseAccuracy(ACCURACY_MODES[i].key),
    );

  const chooseMapSheet = () =>
    pickSheet('Map style', undefined, MAP_TYPES.map((t) => MAP_LABELS[t]), mapTypeIndex, (i) => {
      setMapTypeIndex(i);
      store.setMeta('map_type', MAP_TYPES[i]).catch(() => undefined);
    });

  const roadDataSheet = () =>
    pickSheet(
      'Road data',
      `From OpenStreetMap${roadData.version ? `, version ${roadData.version}` : ''}. It updates by itself.\n\nFreeing up storage keeps your home county. Other areas download again when you're there.`,
      ['Check for updates', 'Free up storage'],
      -1,
      (i) => {
        if (i === 0) refreshRoadData();
        else freeUpStorage().catch((e) => setNote(`Couldn't free up storage: ${(e as Error).message}`));
      },
    );

  const confirmRecheck = () =>
    Alert.alert('Recalculate your map?', 'Goes through every saved drive again and redraws your map from them. It can take a minute.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Recalculate',
        onPress: () => {
          setPanel(null);
          runRecheck('manual');
        },
      },
    ]);

  const confirmDeleteAll = () =>
    Alert.alert(
      'Delete all your data?',
      "Every drive, road and edit on this phone is deleted. This can't be undone, so back up first (Stats → Your data) if you might want them.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete everything', style: 'destructive', onPress: deleteAllData },
      ],
    );

  const confirmThen = (what: 'uninstall', action: () => void) => {
    if (confirming !== what) {
      setConfirming(what);
      setTimeout(() => setConfirming((c) => (c === what ? null : c)), 4000);
      return;
    }
    setConfirming(null);
    action();
  };

  // "Free up storage": road data for everywhere but the home county.
  // It downloads again when you drive there.
  const freeUpStorage = async () => {
    const before = await store.tileCacheInfo();
    await store.clearUnpinnedTiles();
    netRef.current.clear();
    roadData.forget();
    setNetRev((r) => r + 1);
    if (homeCounty) await roadData.ensure(roadData.countyTiles(homeCounty), { pinned: true });
    const after = await store.tileCacheInfo();
    setStorageInfo(after);
    setNote(`Freed ${formatBytes(before.bytes - after.bytes)}. Road data for other areas downloads again when you're there.`);
  };

  // Developer: forget every downloaded area (they download again as needed).
  const clearRoadData = () => {
    netRef.current.clear();
    roadData.forget();
    setNetRev((r) => r + 1);
    store.clearTiles().then(() => store.tileCacheInfo().then(setStorageInfo)).catch(() => undefined);
  };

  const deleteAllData = () => {
    resetMap();
    setLog([]);
    store
      .deleteAllData()
      .then(() => setNote('All your drives, roads and edits are deleted from this phone.'))
      .catch((e) => setNote(`Delete failed: ${(e as Error).message}`));
  };

  const resetMap = () => {
    drivenRef.current = new Set();
    excludedRef.current = new Set();
    drivenShapesRef.current = new Map();
    drivenCountyRef.current = new Map();
    lengthRef.current = new Map();
    excludedInfoRef.current = new Map();
    unmarkedRef.current = new Map();
    partialsRef.current = new Map();
    setRoadCounts(new Map());
    setHighlight(null);
    setDrivenIds(new Set());
    setExcludedIds(new Set());
    setUnmatchedCount(0);
    setRawSessions(null);
    setRawStats({ drives: 0, points: 0 });
    setSelectedDrive(null);
    setDrives([]);
    setPanel(null);
  };

  // ---------- Backup & restore ----------

  const exportBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    try {
      const data = await store.exportBackup();
      const file = new File(Paths.cache, `tarmacked-backup-${new Date().toISOString().slice(0, 10)}.json`);
      if (file.exists) file.delete();
      file.create();
      file.write(JSON.stringify(data));
      if (!(await Sharing.isAvailableAsync())) throw new Error('sharing is not available on this device');
      await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Save your tarmacked backup' });
      setNote(`Backup created: ${data.driven.length} road pieces, ${data.drives.length} drives.`);
    } catch (e) {
      setNote(`Backup failed: ${(e as Error).message}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const restoreBackup = async () => {
    if (backupBusy || tracking) return;
    setBackupBusy(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true });
      if (picked.canceled || !picked.assets?.length) return;
      const text = await new File(picked.assets[0].uri).text();
      const result = await store.importBackup(JSON.parse(text));
      const data = await store.loadAll();
      for (const d of data.driven) {
        drivenRef.current.add(d.id);
        rememberDriven(d.id, drivenShapesRef.current.get(d.id) ?? d.shape, d.county);
      }
      for (const e of data.excluded) {
        excludedRef.current.add(e.id);
        excludedInfoRef.current.set(e.id, { c: e.county, l: e.lengthM });
      }
      unmarkedRef.current = await store.loadUnmarked();
      backfillFromSegments(Array.from(netRef.current.segs.values()));
      setDrivenIds(new Set(drivenRef.current));
      setExcludedIds(new Set(excludedRef.current));
      setUnmatchedCount(data.unmatched.length);
      setRawStats({ drives: data.driveCount, points: data.pointCount });
      if (data.homeCounty) setHomeCounty(data.homeCounty);
      setPanel(null);
      setNote(`Restored: ${result.driven} road pieces merged in, ${result.drivesAdded} new drives. Nothing on the phone was removed.`);
      if (result.drivesAdded > 0) runRecheck('manual'); // fills in heatmap counts for the restored drives
    } catch (e) {
      setNote(`Restore failed: ${(e as Error).message}`);
    } finally {
      setBackupBusy(false);
    }
  };

  // ---------- Stats ----------

  // Per-county and national figures. Totals come from county-stats.json;
  // driven km uses each driven road's stored shape and county. Excluded
  // roads come off both sides.
  const countyFigures = useMemo(() => {
    const n = countyStats?.counties.length ?? 0;
    const driven = new Array(n).fill(0);
    const excluded = new Array(n).fill(0);
    drivenIds.forEach((id) => {
      const base = baseChunkId(id);
      if (excludedIds.has(base)) return;
      if (base !== id && drivenIds.has(base)) return; // whole piece already counted
      const c = drivenCountyRef.current.get(id);
      if (c === undefined || c >= n) return;
      driven[c] += lengthRef.current.get(id) ?? 0;
    });
    excludedIds.forEach((id) => {
      const info = excludedInfoRef.current.get(id);
      if (info && info.c !== null && info.c < n && info.l !== null) excluded[info.c] += info.l;
    });
    const rows = (countyStats?.counties ?? []).map((name, i) => {
      const total = Math.max(0, countyStats!.totalMeters[i] - excluded[i]);
      return { code: i, name, driven: driven[i], total, percent: total > 0 ? (driven[i] / total) * 100 : 0 };
    });
    const nationalDriven = driven.reduce((a: number, b: number) => a + b, 0);
    const nationalTotal = Math.max(0, (countyStats?.nationalMeters ?? 0) - excluded.reduce((a: number, b: number) => a + b, 0));
    const unassigned = Array.from(drivenIds).filter((id) => !drivenCountyRef.current.has(id)).length;
    return { rows, nationalDriven, nationalTotal, nationalPercent: nationalTotal > 0 ? (nationalDriven / nationalTotal) * 100 : 0, unassigned };
  }, [countyStats, drivenIds, excludedIds]);

  // Counties tab: most complete first (then most driven, then A to Z).
  const countiesByCompletion = useMemo(
    () => [...countyFigures.rows].sort((a, b) => b.percent - a.percent || b.driven - a.driven || a.name.localeCompare(b.name)),
    [countyFigures]
  );

  // Tapping the county in the bottom bar: its stats.
  const openCountyStats = () => {
    setStatsTab('counties');
    setPanel('stats');
    store.listDrives().then(setDrives).catch(() => undefined);
  };

  const focusRow =
    currentCounty !== null ? countyFigures.rows[currentCounty] : countyFigures.rows.find((r) => r.name === homeCounty) ?? null;

  // ---------- Map drawing ----------

  const bounds = useMemo(() => {
    const padLat = visibleRegion.latitudeDelta * 0.6;
    const padLon = visibleRegion.longitudeDelta * 0.6;
    return {
      minLat: visibleRegion.latitude - padLat,
      maxLat: visibleRegion.latitude + padLat,
      minLon: visibleRegion.longitude - padLon,
      maxLon: visibleRegion.longitude + padLon,
    };
  }, [visibleRegion]);
  const inView = (c: Chain) => c.maxLat >= bounds.minLat && c.minLat <= bounds.maxLat && c.maxLon >= bounds.minLon && c.minLon <= bounds.maxLon;

  // Driven roads joined into long continuous lines (far fewer map objects
  // than one per 100m piece), then simplified to the detail the current
  // zoom can actually show.
  const drivenChains = useMemo(
    () =>
      buildChains(
        Array.from(drivenIds).filter((id) => !excludedIds.has(baseChunkId(id))),
        (id) => drivenShapesRef.current.get(id)
      ),
    [drivenIds, excludedIds]
  );
  // Tolerance steps in powers of two so panning doesn't re-simplify.
  const simplifyLevel = Math.max(0, Math.round(Math.log2(visibleRegion.latitudeDelta / 0.005)));
  const simplifiedChains = useMemo(() => {
    if (simplifyLevel === 0) return drivenChains;
    const tolerance = (0.005 * 2 ** simplifyLevel) / 700; // ~1 screen pixel, in degrees
    return drivenChains.map((c) => ({ ...c, coords: simplifyLine(c.coords, tolerance) }));
  }, [drivenChains, simplifyLevel]);
  const visibleChains = useMemo(() => simplifiedChains.filter(inView), [simplifiedChains, bounds]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoomedOut = visibleRegion.latitudeDelta > 0.3;

  // Heatmap: driven roads grouped into colour steps by how many drives
  // covered them, each step joined into lines like the plain green.
  const maxCount = useMemo(() => {
    let m = 1;
    roadCounts.forEach((n) => {
      if (n > m) m = n;
    });
    return m;
  }, [roadCounts]);
  const heatChains = useMemo(() => {
    if (!heatOn) return [] as Chain[][];
    const steps: string[][] = Array.from({ length: HEAT_STEPS }, () => []);
    drivenIds.forEach((id) => {
      if (excludedIds.has(baseChunkId(id))) return;
      steps[heatStep(roadCounts.get(baseChunkId(id)) ?? 1, maxCount)].push(id);
    });
    return steps.map((ids) => buildChains(ids, (id) => drivenShapesRef.current.get(id)));
  }, [heatOn, drivenIds, excludedIds, roadCounts, maxCount]);
  const visibleHeat = useMemo(() => {
    const tolerance = simplifyLevel === 0 ? 0 : (0.005 * 2 ** simplifyLevel) / 700;
    return heatChains.map((chains) =>
      chains.filter(inView).map((c) => (tolerance ? { ...c, coords: simplifyLine(c.coords, tolerance) } : c))
    );
  }, [heatChains, simplifyLevel, bounds]); // eslint-disable-line react-hooks/exhaustive-deps

  // The selected drive's roads (orange), and a most-driven stretch picked
  // from Stats → Roads.
  const shapeForDraw = (id: string) => drivenShapesRef.current.get(id) ?? netRef.current.shapeOf(id) ?? undefined;
  const selectedChains = useMemo(
    () => (selectedDrive ? buildChains(selectedDrive.roads, shapeForDraw) : []),
    [selectedDrive, netRev] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const highlightChains = useMemo(
    () => (highlight ? buildChains(highlight.chunks, shapeForDraw) : []),
    [highlight, netRev] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---------- Stats figures ----------

  // Road names for the rankings come from the road data, so the areas of
  // every road you've driven are loaded when Stats opens (mostly from the
  // phone; nothing at all is downloaded offline).
  useEffect(() => {
    if (panel !== 'stats') return;
    const tiles = new Set<string>();
    roadCounts.forEach((_, id) => {
      const shape = drivenShapesRef.current.get(id) ?? drivenShapesRef.current.get(baseChunkId(id));
      if (shape) tiles.add(tileIdForPoint(shape[0][0], shape[0][1]));
    });
    roadData.ensure(tiles).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, roadCounts]);

  const roadRanking = useMemo(
    () => (panel === 'stats' && statsTab === 'roads' ? rankRoads(netRef.current, roadCounts) : []),
    [panel, statsTab, roadCounts, netRev]
  );
  const overview = useMemo(() => {
    const list = (drives ?? []).filter((d) => !d.leftOut && d.status === 'done');
    const now = new Date();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let week = 0, month = 0, all = 0, dist = 0, time = 0;
    let longest: store.DriveSummary | null = null;
    let mostNew: store.DriveSummary | null = null;
    for (const d of list) {
      const n = d.newM ?? 0;
      all += n;
      if (d.startedAt >= weekStart) week += n;
      if (d.startedAt >= monthStart) month += n;
      dist += d.distanceM ?? 0;
      if (d.endedAt) time += d.endedAt - d.startedAt;
      if ((d.distanceM ?? 0) > (longest?.distanceM ?? 0)) longest = d;
      if (n > (mostNew?.newM ?? 0)) mostNew = d;
    }
    return { count: list.length, week, month, all, dist, time, longest, mostNew };
  }, [drives]);
  const topRoad = useMemo(
    () => (panel === 'stats' && statsTab === 'overview' ? rankRoads(netRef.current, roadCounts, 1)[0] ?? null : null),
    [panel, statsTab, roadCounts, netRev]
  );

  // Roads completed during the drive in progress, drawn live on top.
  const liveChains = useMemo(() => buildChains(liveIds, (id) => drivenShapesRef.current.get(id)), [liveIds]);

  const editZoomedIn = visibleRegion.latitudeDelta <= EDIT_MAX_LAT_DELTA;
  // Road pieces with anything driven on them (whole or in sections), for edit mode.
  const drivenBases = useMemo(() => new Set(Array.from(drivenIds).map(baseChunkId)), [drivenIds]);
  const visibleEditSegments = useMemo(() => {
    if (!editMode || !editZoomedIn) return [] as RoadSegment[];
    return netRef.current.inBox(bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, editZoomedIn, bounds, netRev]);

  // Edit mode: the roads on screen.
  useEffect(() => {
    if (!editMode || !editZoomedIn) return;
    ensureVisible(bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, editZoomedIn, bounds]);

  // Every dark outline is drawn first and every green line after, so no
  // outline ever sits on top of green where two lines meet. Apple Maps
  // stacks lines in the order they're added (it ignores zIndex), so the
  // whole set is re-added whenever it changes to keep that order.
  const drawRevs = useRef({ n: 0, map: new WeakMap<Chain[], number>() });
  // A new number only when this set of lines actually changes.
  const revOf = (chains: Chain[]) => {
    const revs = drawRevs.current;
    let rev = revs.map.get(chains);
    if (rev === undefined) {
      rev = ++revs.n;
      revs.map.set(chains, rev);
    }
    return rev;
  };
  type Layer = { chains: Chain[]; color: string };
  // `after`: revision of the lines drawn underneath. Lines drawn on top
  // include it in their keys, so they're re-added (back on top) whenever
  // the lines under them are.
  const drawLayers = (prefix: string, layers: Layer[], thin: boolean, after = '', outline = '#0d3818', width = 4) => {
    const tag = (c: Chain[]) => `${revOf(c)}${after}`;
    const outlines = thin
      ? []
      : layers.flatMap((l, li) =>
          l.chains.map((c, i) => (
            <Polyline
              key={`${prefix}o${li}.${i}-${tag(l.chains)}`}
              coordinates={toLatLng(c.coords)}
              strokeColor={outline}
              strokeWidth={width + 3}
              lineCap="round"
              lineJoin="round"
            />
          ))
        );
    const cores = layers.flatMap((l, li) =>
      l.chains.map((c, i) => (
        <Polyline
          key={`${prefix}c${li}.${i}-${tag(l.chains)}`}
          coordinates={toLatLng(c.coords)}
          strokeColor={l.color}
          strokeWidth={thin ? width - 1 : width}
          lineCap="round"
          lineJoin="round"
        />
      ))
    );
    return [...outlines, ...cores];
  };
  const baseLayers: Layer[] = heatOn
    ? visibleHeat.map((chains, i) => ({ chains, color: stepColor(i) }))
    : [{ chains: visibleChains, color: '#39d353' }];
  // Everything drawn on top is re-added when the base lines or map type change.
  const baseRev = `m${mapTypeIndex}b${editMode ? 'e' : baseLayers.map((l) => revOf(l.chains)).join('.')}`;

  // ---------- Onboarding ----------

  // The loading screen stays over whatever is underneath until the data
  // is in (at least LOADING_MIN_MS), then fades away.
  const bootReady = onboarded === false || (onboarded === true && dataLoaded);
  const loadingOverlay = loadingGone ? null : (
    <LoadingScreen step={bootStep} ready={bootReady} onGone={() => setLoadingGone(true)} />
  );

  if (onboarded === null) {
    return <View style={styles.onboardContainer}>{loadingOverlay}</View>;
  }

  if (onboarded === false) {
    return (
      <View style={styles.onboardContainer}>
        <Text style={styles.onboardTitle}>tarmacked</Text>
        {downloadingCounty ? (
          <>
            <Text style={styles.onboardText}>Downloading {downloadingCounty}…</Text>
            <ActivityIndicator color="#39d353" size="large" style={{ marginVertical: 16 }} />
            <Text style={styles.onboardText}>
              {downloadProgress.done} / {downloadProgress.total} areas
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.onboardText}>
              Pick your home county to download it now — everywhere else downloads automatically as you drive there.
            </Text>
            {onboardingError ? <Text style={styles.onboardError}>{onboardingError}</Text> : null}
            {onboardingError && onboardingCounties === null ? (
              <Pressable
                style={styles.skipLink}
                onPress={() => {
                  setOnboardingError('');
                  setOnboardTry((n) => n + 1);
                }}
              >
                <Text style={styles.linkText}>Try again</Text>
              </Pressable>
            ) : null}
            {onboardingCounties === null && !onboardingError && (
              <ActivityIndicator color="#39d353" size="large" style={{ marginVertical: 16 }} />
            )}
            <ScrollView style={styles.countyList}>
              {(onboardingCounties || []).map((c) => (
                <Pressable key={c} style={styles.countyRow} onPress={() => downloadHomeCounty(c)}>
                  <Text style={styles.countyRowText}>{c}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={styles.skipLink} onPress={skipOnboarding}>
              <Text style={styles.linkText}>Skip for now</Text>
            </Pressable>
          </>
        )}
        {loadingOverlay}
      </View>
    );
  }

  // ---------- Main screen ----------

  const elapsed = tracking ? Date.now() - driveStartRef.current : 0;
  const togglePanel = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  // Map: the style and the heatmap, in one place.
  const openMapSheet = () => {
    const styleIdx = mapTypeIndex;
    const labels = [...MAP_TYPES.map((t, i) => `${MAP_LABELS[t]} map${i === styleIdx ? ' ✓' : ''}`), 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions({ title: 'Map style', options: labels, cancelButtonIndex: labels.length - 1, userInterfaceStyle: 'dark' }, (i: number) => {
      if (i >= 0 && i < MAP_TYPES.length) {
        setMapTypeIndex(i);
        store.setMeta('map_type', MAP_TYPES[i]).catch(() => undefined);
      }
    });
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_DEFAULT}
        // Under OSM tiles: satellite, which has no labels of its own (Apple's
        // place names otherwise showed through, doubled with OSM's).
        mapType={MAP_TYPES[mapTypeIndex] === 'osm' ? 'satellite' : (MAP_TYPES[mapTypeIndex] as MapType)}
        showsPointsOfInterest={MAP_TYPES[mapTypeIndex] !== 'osm'}
        initialRegion={region}
        showsUserLocation
        followsUserLocation={following && !editMode}
        onPanDrag={() => following && setFollowing(false)}
        onPress={onMapPress}
        onLongPress={onMapLongPress}
        onRegionChangeComplete={(r: Region) => setVisibleRegion(r)}
      >
        {MAP_TYPES[mapTypeIndex] === 'osm' && (
          <UrlTile
            key="osm"
            urlTemplate={OSM_TILE_URL}
            maximumZ={19}
            shouldReplaceMapContent
            tileCachePath={`${Paths.cache.uri}osm-tiles`}
            tileCacheMaxAge={7 * 24 * 60 * 60}
          />
        )}
        {editMode &&
          visibleEditSegments.map((seg) => {
            const isExcluded = excludedIds.has(seg.id);
            const isDriven = drivenBases.has(seg.id);
            return (
              <Polyline
                key={seg.id}
                coordinates={toLatLng(seg.coords)}
                strokeColor={isExcluded ? '#a03030' : isDriven ? '#39d353' : '#555'}
                strokeWidth={isExcluded || isDriven ? 5 : 3}
                lineCap="round"
                lineJoin="round"
                lineDashPattern={isExcluded ? [6, 4] : undefined}
                tappable
                onPress={() => handleEditTap(seg.id)}
              />
            );
          })}

        {!editMode && drawLayers('d', baseLayers, zoomedOut, `m${mapTypeIndex}`)}

        {tracking && drawLayers('live', [{ chains: liveChains, color: '#39d353' }], false, baseRev)}

        {tracking && liveTrail.length > 1 && (
          <Polyline
            coordinates={liveTrail.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))}
            strokeColor="#3a8dff"
            strokeWidth={3}
            lineCap="round"
            lineJoin="round"
            zIndex={6}
          />
        )}

        {/* Selected drive: its roads in orange, on top of everything else. */}
        {selectedDrive && selectedChains.length > 0 && drawLayers('sel', [{ chains: selectedChains, color: '#ff9f1a' }], false, baseRev, '#5a3000')}
        {/* Drives from before v0.14's re-check have no road list yet: show the GPS trail. */}
        {selectedDrive && selectedChains.length === 0 && selectedDrive.points.length > 1 && (
          <Polyline
            key={`seltrail-${baseRev}`}
            coordinates={selectedDrive.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))}
            strokeColor="#ff9f1a"
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
            zIndex={7}
          />
        )}

        {/* Most-driven stretch picked from Stats → Roads. */}
        {highlight && drawLayers('hl', [{ chains: highlightChains, color: '#ffffff' }], false, baseRev, '#d0206a', 5)}

        {/* Sat-nav: routes to choose from (the chosen one in blue), or the road ahead. */}
        {navStage === 'choose' &&
          routeOptions.map((r, i) =>
            i === chosenRoute ? null : (
              <Polyline
                key={`alt-${i}-${baseRev}`}
                coordinates={toLatLng(r.coords)}
                strokeColor="#7f8b96"
                strokeWidth={5}
                lineCap="round"
                lineJoin="round"
                zIndex={8}
                tappable
                onPress={() => setChosenRoute(i)}
              />
            )
          )}
        {navStage === 'choose' && routeOptions[chosenRoute] && (
          <Polyline
            key={`route-${chosenRoute}-${baseRev}`}
            coordinates={toLatLng(routeOptions[chosenRoute].coords)}
            strokeColor="#3a8dff"
            strokeWidth={7}
            lineCap="round"
            lineJoin="round"
            zIndex={9}
          />
        )}
        {navStage === 'driving' && navAhead.length > 1 && (
          <Polyline
            key={`nav-${baseRev}`}
            coordinates={toLatLng(navAhead)}
            strokeColor="#3a8dff"
            strokeWidth={8}
            lineCap="round"
            lineJoin="round"
            zIndex={9}
          />
        )}
        {(navStage === 'choose' || navStage === 'driving') && dest && (
          <Marker coordinate={{ latitude: dest.at[0], longitude: dest.at[1] }} title={dest.name} pinColor="#e5332a" />
        )}

        {rawSessions &&
          rawSessions.map((session, i) =>
            session.length > 1 ? (
              <Polyline
                key={`raw-${i}`}
                coordinates={session.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))}
                strokeColor="#3a8dff"
                strokeWidth={2}
                zIndex={8}
              />
            ) : null
          )}
      </MapView>

      {/* Top bar (the sat-nav banner or search takes its place) */}
      {navStage === 'driving' && <NavBanner update={navUpdate} rerouting={rerouting} />}
      {navStage === 'search' && (
        <SearchPanel
          query={searchQuery}
          onQuery={setSearchQuery}
          results={searchResults}
          searching={searching}
          note={searchNote}
          onPick={(p) => chooseDestination({ name: p.name || p.subtitle || 'Destination', at: [p.lat, p.lon] }).catch(() => undefined)}
          onClose={() => {
            Keyboard.dismiss();
            setNavStage('off');
          }}
        />
      )}
      {(navStage === 'off' || navStage === 'choose') && (
        <View style={styles.topBar}>
          <View style={styles.topPill}>
            <Pressable
              style={[styles.topItem, panel === 'stats' && styles.topItemActive]}
              onPress={() => {
                togglePanel('stats');
                store.listDrives().then(setDrives).catch(() => undefined);
              }}
            >
              <Text style={styles.topText}>Stats</Text>
            </Pressable>
            <View style={styles.topDivider} />
            <Pressable style={[styles.topItem, panel === 'drives' && styles.topItemActive]} onPress={openDrives}>
              <Text style={styles.topText}>Drives</Text>
            </Pressable>
            <View style={styles.topDivider} />
            <Pressable style={[styles.topItem, styles.topIcon, panel === 'dev' && styles.topItemActive]} onPress={() => togglePanel('dev')}>
              <Text style={[styles.topText, styles.topGlyph]}>⚙</Text>
            </Pressable>
          </View>
          {/* Map display: heatmap on/off, and the map style. */}
          <View style={styles.topPill}>
            <Pressable
              style={[styles.topItem, styles.topIcon, heatOn && styles.topItemHeat]}
              onPress={() => setHeatOn((v) => !v)}
              accessibilityLabel={heatOn ? 'Hide heatmap' : 'Show heatmap'}
            >
              <View style={styles.heatIcon}>
                {[0, Math.floor(HEAT_STEPS / 2), HEAT_STEPS - 1].map((k, n) => (
                  <View key={k} style={[styles.heatIconBar, { height: 7 + n * 4, backgroundColor: heatOn ? '#fff' : stepColor(k) }]} />
                ))}
              </View>
            </Pressable>
            <View style={styles.topDivider} />
            <Pressable style={styles.topItem} onPress={openMapSheet}>
              <Text style={styles.topText}>Map</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Heatmap legend, and the picked most-driven stretch */}
      {(heatOn || highlight) && !panel && !editMode && navStage === 'off' && (
        <View style={styles.heatBar}>
          {heatOn && (
            <View style={styles.legendRow}>
              <Text style={styles.legendText}>1×</Text>
              {Array.from({ length: HEAT_STEPS }, (_, i) => (
                <View key={i} style={[styles.legendStep, { backgroundColor: stepColor(i) }]} />
              ))}
              <Text style={styles.legendText}>{maxCount}×</Text>
            </View>
          )}
          {highlight && (
            <Pressable style={styles.legendRow} onPress={() => setHighlight(null)}>
              <Text style={styles.highlightText} numberOfLines={1}>
                {highlight.name} · {highlight.count}× — most driven bit
              </Text>
              <Text style={styles.legendText}>  ✕</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Messages */}
      {recheckProgress !== null ? (
        <View style={styles.toast}>
          <Text style={styles.toastText}>Re-checking your drives… {Math.round(recheckProgress * 100)}%</Text>
        </View>
      ) : note ? (
        <Pressable style={styles.toast} onPress={() => setNote('')}>
          <Text style={styles.toastText}>{note}</Text>
        </Pressable>
      ) : null}

      {/* Stats */}
      {panel === 'stats' && (
        <View style={styles.panel}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={{ gap: 6 }}>
            {STATS_TABS.map((t) => (
              <Pressable key={t.key} style={[styles.tabPill, statsTab === t.key && styles.tabPillActive]} onPress={() => setStatsTab(t.key)}>
                <Text style={styles.chipText}>{t.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <ScrollView>
            {statsTab === 'overview' &&
              (countyStats ? (
                <>
                  <Text style={styles.bigStat}>{countyFigures.nationalPercent.toFixed(3)}%</Text>
                  <Text style={styles.small}>
                    of Ireland's roads · {km(countyFigures.nationalDriven)} / {km(countyFigures.nationalTotal, 0)} km
                  </Text>
                  <Text style={styles.sectionTitle}>New road</Text>
                  <View style={styles.statGrid}>
                    <StatTile label="This week" value={`+${km(overview.week)} km`} />
                    <StatTile label="This month" value={`+${km(overview.month)} km`} />
                    <StatTile label="All time" value={`${km(overview.all)} km`} />
                  </View>
                  <Text style={styles.sectionTitle}>Drives</Text>
                  <View style={styles.statGrid}>
                    <StatTile label="Drives" value={String(overview.count)} />
                    <StatTile label="Distance" value={`${km(overview.dist, 0)} km`} />
                    <StatTile label="Time" value={formatDuration(overview.time)} />
                  </View>
                  <Text style={styles.sectionTitle}>Records</Text>
                  {overview.longest && (
                    <Text style={styles.recordLine}>
                      Longest drive: {km(overview.longest.distanceM ?? 0)} km · {formatWhen(overview.longest.startedAt)}
                    </Text>
                  )}
                  {overview.mostNew && (
                    <Text style={styles.recordLine}>
                      Most new road: +{km(overview.mostNew.newM ?? 0)} km · {formatWhen(overview.mostNew.startedAt)}
                    </Text>
                  )}
                  {topRoad && (
                    <Pressable onPress={() => showRoad(topRoad)}>
                      <Text style={styles.recordLine}>
                        Most driven road: {topRoad.name} · {topRoad.count}× <Text style={styles.linkText}>show</Text>
                      </Text>
                    </Pressable>
                  )}
                  {!overview.longest && !topRoad && <Text style={styles.small}>Records appear after your first drive.</Text>}
                </>
              ) : (
                <Text style={styles.small}>Road totals haven't loaded yet — connect to the internet once and they're saved for offline use.</Text>
              ))}

            {statsTab === 'counties' &&
              (countyStats ? (
                <>
                  <Text style={styles.statsHeadline}>
                    Ireland {countyFigures.nationalPercent.toFixed(3)}% · {km(countyFigures.nationalDriven)} /{' '}
                    {km(countyFigures.nationalTotal, 0)} km
                  </Text>
                  {countiesByCompletion.map((r) => (
                    <View key={r.name} style={[styles.countyStatRow, r.code === focusRow?.code && styles.countyStatRowCurrent]}>
                      <Text style={[styles.countyStatName, r.driven > 0 && styles.countyStatNameDriven]}>{shortCounty(r.name)}</Text>
                      <Text style={styles.countyStatValue}>
                        {r.percent.toFixed(2)}% · {km(r.driven)} / {km(r.total, 0)} km
                      </Text>
                    </View>
                  ))}
                  {countyFigures.unassigned > 0 && (
                    <Text style={styles.small}>
                      {countyFigures.unassigned} road pieces aren't counted yet — their county fills in once the road data for
                      that area downloads.
                    </Text>
                  )}
                </>
              ) : (
                <Text style={styles.small}>Road totals haven't loaded yet — connect to the internet once and they're saved for offline use.</Text>
              ))}

            {statsTab === 'roads' && (
              <>
                <Text style={styles.small}>
                  Your most driven roads — the number is how many drives covered the busiest bit. Tap one to see it on the map
                  (colours match the heatmap).
                </Text>
                {roadRanking.length === 0 ? (
                  <Text style={styles.small}>Nothing yet — this fills in as you drive.</Text>
                ) : (
                  roadRanking.map((r, i) => (
                    <Pressable key={r.key} style={styles.roadRow} onPress={() => showRoad(r)}>
                      <Text style={styles.roadRank}>{i + 1}</Text>
                      <View style={[styles.roadSwatch, { backgroundColor: stepColor(heatStep(r.count, maxCount)) }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.roadName} numberOfLines={1}>
                          {r.name}
                        </Text>
                        <Text style={styles.driveInfo}>
                          {r.county !== null && countyStats ? `${shortCounty(countyStats.counties[r.county] ?? '')} · ` : ''}
                          {km(r.hotM, 2)} km at that
                        </Text>
                      </View>
                      <Text style={styles.roadCount}>{r.count}×</Text>
                    </Pressable>
                  ))
                )}
              </>
            )}

            {statsTab === 'data' && (
              <>
                <Text style={styles.small}>
                  Saved on this phone. Back up to keep a copy somewhere safe (Files, iCloud Drive, email). Restoring merges a backup
                  in — it never removes anything already on the phone.
                </Text>
                <View style={styles.row}>
                  <Pressable style={[styles.button, styles.buttonBlue]} onPress={exportBackup} disabled={backupBusy}>
                    <Text style={styles.buttonText}>{backupBusy ? 'Working…' : 'Back up'}</Text>
                  </Pressable>
                  <Pressable style={[styles.button, styles.buttonGrey]} onPress={restoreBackup} disabled={backupBusy || tracking}>
                    <Text style={styles.buttonText}>Restore</Text>
                  </Pressable>
                </View>
              </>
            )}
          </ScrollView>
        </View>
      )}

      {/* Drives */}
      {panel === 'drives' && (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Drives</Text>
          {drives === null ? (
            <ActivityIndicator color="#39d353" />
          ) : drives.length === 0 ? (
            <Text style={styles.small}>No drives yet — tap Start when you set off.</Text>
          ) : (
            <ScrollView>
              {drives.map((d) => {
                const selected = selectedDrive?.id === d.id;
                const patchy = isPatchy(d.ignoredN, d.pointCount);
                const pending = d.status === 'pending';
                const recording = d.status === 'recording';
                const daysLeft = Math.max(1, Math.ceil((d.startedAt + 7 * 86_400_000 - Date.now()) / 86_400_000));
                return (
                  <Pressable key={d.id} style={[styles.driveRow, selected && styles.driveRowSelected]} onPress={() => showDrive(d.id)}>
                    <View style={{ flex: 1, opacity: d.leftOut ? 0.55 : 1 }}>
                      <Text style={styles.driveWhen}>
                        {formatWhen(d.startedAt)}
                        {recording && <Text style={styles.recordingTag}>{'  ● recording'}</Text>}
                        {d.auto && !recording && <Text style={styles.driveInfo}>{'  auto'}</Text>}
                        {patchy && <Text style={styles.patchyTag}>{'  ⚠ patchy GPS'}</Text>}
                        {d.leftOut && <Text style={styles.driveInfo}>{'  left out'}</Text>}
                      </Text>
                      {pending && (
                        <Text style={styles.pendingTag}>Not saved yet · deletes in {daysLeft} day{daysLeft === 1 ? '' : 's'}</Text>
                      )}
                      <Text style={styles.driveInfo}>
                        {d.endedAt ? `${formatDuration(d.endedAt - d.startedAt)} · ` : ''}
                        {d.distanceM !== null ? `${km(d.distanceM)} km` : `${d.pointCount} points`}
                        {d.newM !== null && d.newM > 0 ? ` · +${km(d.newM)} km new` : ''}
                      </Text>
                    </View>
                    {pending && (
                      <View style={styles.pendingButtons}>
                        <Pressable style={[styles.smallButton, styles.smallButtonGreen]} onPress={() => savePending(d.id)} disabled={recheckProgress !== null}>
                          <Text style={styles.chipText}>Save</Text>
                        </Pressable>
                        <Pressable style={styles.smallButton} onPress={() => deletePending(d.id)}>
                          <Text style={styles.chipText}>Delete</Text>
                        </Pressable>
                      </View>
                    )}
                    {selected && !pending && !recording && (patchy || d.leftOut) && (
                      <Pressable
                        style={[styles.smallButton, { marginRight: 6 }]}
                        onPress={() => toggleLeftOut(d)}
                        disabled={tracking || recheckProgress !== null}
                      >
                        <Text style={styles.chipText}>{d.leftOut ? 'Include' : 'Leave out'}</Text>
                      </Pressable>
                    )}
                    {selected && !pending && !recording && (
                      <Pressable
                        style={[styles.smallButton, deleteConfirmId === d.id && styles.smallButtonDanger]}
                        onPress={() => deleteDrive(d.id)}
                      >
                        <Text style={styles.chipText}>{deleteConfirmId === d.id ? 'Tap to confirm' : 'Delete'}</Text>
                      </Pressable>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          {selectedDrive && (
            <Text style={styles.small}>
              Its roads are shown in orange on the map. Tap it again to hide.
              {drives?.find((d) => d.id === selectedDrive.id && isPatchy(d.ignoredN, d.pointCount))
                ? ' Patchy GPS: some points were ignored. Its roads still count unless you leave it out.'
                : ''}
            </Text>
          )}
        </View>
      )}

      {/* Dev tools */}
      {panel === 'dev' && (
        <View style={styles.panel}>
          <ScrollView>
            <Text style={[settingStyles.header, { marginTop: 0 }]}>Settings</Text>
            <SettingsCard>
              <SettingsRow
                first
                title="Auto-detect drives"
                right={
                  <Switch
                    value={autoDetect || autoWanted}
                    disabled={autoBusy}
                    onValueChange={(on: boolean) => (on ? enableAutoDetect() : disableAutoDetect())}
                    trackColor={{ true: '#2f6f3a', false: '#333' }}
                  />
                }
              />
              <SettingsRow
                title="GPS accuracy"
                value={ACCURACY_MODES.find((m) => m.key === accuracyMode)?.label}
                onPress={chooseAccuracySheet}
              />
              <SettingsRow title="Map style" value={MAP_LABELS[MAP_TYPES[mapTypeIndex]]} onPress={chooseMapSheet} />
            </SettingsCard>
            {(autoWanted || autoDetect) && autoPerms.some((p) => p.state !== 'ok') && (
              <View style={styles.missingBox}>
                <Text style={styles.missingText}>{autoDetect ? 'Auto-detect is missing a permission:' : 'To finish turning on auto-detect:'}</Text>
                {autoPerms
                  .filter((p) => p.state !== 'ok')
                  .map((p) => (
                    <View key={p.key} style={styles.permRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.permName}>{PERM_TEXT[p.key].name}</Text>
                        <Text style={styles.permHow}>
                          {p.state === 'ask'
                            ? PERM_TEXT[p.key].why
                            : p.state === 'phoneOff'
                              ? 'Fitness Tracking is off for the whole phone: Settings → Privacy & Security → Motion & Fitness → Fitness Tracking.'
                              : p.state === 'missing'
                                ? "This version of the app was built without its motion part. Update the app to fix it."
                                : p.state === 'unavailable'
                                ? "This phone can't tell driving from walking, so auto-detect can't work here."
                                : PERM_TEXT[p.key].fix}
                        </Text>
                      </View>
                      {p.state === 'ask' && (
                        <Pressable
                          style={[styles.smallButton, styles.smallButtonGreen]}
                          onPress={async () => {
                            await askPermission(p.key);
                            await refreshAutoPermissions();
                          }}
                        >
                          <Text style={styles.chipText}>Allow</Text>
                        </Pressable>
                      )}
                      {(p.state === 'settings' || p.state === 'phoneOff') && (
                        <Pressable style={styles.smallButton} onPress={() => Linking.openSettings()}>
                          <Text style={styles.chipText}>Open Settings</Text>
                        </Pressable>
                      )}
                    </View>
                  ))}
              </View>
            )}

            <SettingsHeader title="Your map" />
            <SettingsCard>
              <SettingsRow
                first
                title="Fix my map"
                disabled={tracking}
                onPress={() => {
                  setFollowing(false);
                  setEditMode(true);
                  setPanel(null);
                }}
              />
              <SettingsRow title="Recalculate from my drives" disabled={tracking || recheckProgress !== null} onPress={confirmRecheck} />
              <SettingsRow
                title="Road data"
                value={refreshing ? 'Checking…' : [roadData.version ?? 'none', storageInfo ? formatBytes(storageInfo.bytes) : '…'].join(' · ')}
                disabled={tracking || refreshing}
                onPress={roadDataSheet}
              />
            </SettingsCard>

            <SettingsHeader title="Navigation" />
            <SettingsCard>
              {(
                [
                  ['tolls', 'Avoid tolls'],
                  ['motorways', 'Avoid motorways'],
                  ['unpaved', 'Avoid unpaved roads'],
                  ['ferries', 'Avoid ferries'],
                ] as [keyof Avoid, string][]
              ).map(([k, title], i) => (
                <SettingsRow
                  key={k}
                  first={i === 0}
                  title={title}
                  right={<Switch value={!!avoidDefaults[k]} onValueChange={() => toggleAvoidDefault(k)} trackColor={{ true: '#2f6f3a', false: '#333' }} />}
                />
              ))}
            </SettingsCard>
            <Text style={settingStyles.foot}>Used only when there's another way. You can change them for one trip on the route screen.</Text>

            <SettingsHeader title="Help" />
            <SettingsCard>
              <SettingsRow first title="Send a problem report" onPress={sendProblemReport} />
              <SettingsRow title="Help & privacy" onPress={() => Linking.openURL('https://tarmacked.com/support').catch(() => undefined)} />
            </SettingsCard>
            <Pressable onPress={tapVersion}>
              <Text style={settingStyles.foot}>
                Version {APP_VERSION}
                {'\n'}Map data © OpenStreetMap contributors, available under the Open Database License.
              </Text>
            </Pressable>

            <View style={{ marginTop: 28 }}>
              <SettingsCard>
                <SettingsRow first title="Delete all my data" danger disabled={tracking} onPress={confirmDeleteAll} />
              </SettingsCard>
            </View>

            {devMenu && (
              <>
                <Text style={styles.sectionTitle}>Developer</Text>
                <View style={styles.row}>
                  <Pressable style={[styles.button, styles.buttonGrey, rawSessions && styles.buttonOn]} onPress={toggleRawTrail}>
                    <Text style={styles.buttonText}>{rawSessions ? 'Hide' : 'Show'} raw GPS</Text>
                  </Pressable>
                  <Pressable style={[styles.button, styles.buttonGrey, simulateTaps && styles.buttonOn]} onPress={() => setSimulateTaps((v) => !v)}>
                    <Text style={styles.buttonText}>Tap-to-simulate: {simulateTaps ? 'on' : 'off'}</Text>
                  </Pressable>
                </View>
                <View style={styles.row}>
                  <Pressable
                    style={[styles.button, styles.buttonRed, confirming === 'uninstall' && styles.buttonRedConfirm]}
                    onPress={() => confirmThen('uninstall', clearRoadData)}
                    disabled={tracking}
                  >
                    <Text style={styles.buttonText}>{confirming === 'uninstall' ? 'Tap again' : 'Clear all road data'}</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.button, styles.buttonGrey]}
                    onPress={() => {
                      setDevMenu(false);
                      store.setMeta('dev_menu', '').catch(() => undefined);
                    }}
                  >
                    <Text style={styles.buttonText}>Hide developer</Text>
                  </Pressable>
                </View>
                <Text style={styles.diagText}>{Motion.diagnostics()}</Text>
                <Text style={styles.small}>
                  Home county: {homeCounty || 'none'} · road pieces loaded: {netRef.current.size} · areas: {roadData.loadedCount()}
                  {'\n'}Road data: {roadData.version ?? 'none'} · cached tiles: {storageInfo?.tiles ?? '…'} ({storageInfo?.pinned ?? 0} home)
                  {'\n'}Driven: {drivenIds.size} · excluded: {excludedIds.size} · off-road GPS points: {unmatchedCount}
                  {'\n'}Saved drives: {rawStats.drives} ({rawStats.points} points)
                </Text>
                <View style={[styles.row, { alignItems: 'center', marginTop: 12 }]}>
                  <Text style={[styles.panelTitle, { marginBottom: 0, flex: 1 }]}>Log</Text>
                  <Pressable style={styles.smallButton} onPress={exportLog}>
                    <Text style={styles.chipText}>Export log</Text>
                  </Pressable>
                </View>
                <Text style={styles.logText}>{log.length ? log.join('\n') : '—'}</Text>
              </>
            )}
          </ScrollView>
        </View>
      )}

      {navStage === 'driving' && <SpeedLimit kmh={navSpeedLimit} />}

      {/* Map buttons on the right, above the bottom card: find a place, and back to you. */}
      {!editMode && (navStage === 'off' || navStage === 'driving') && (
        <View style={[styles.sideButtons, navStage === 'driving' && styles.sideButtonsDriving]} pointerEvents="box-none">
          {navStage === 'off' && (
            <Pressable style={styles.roundButton} onPress={openSearch}>
              <Text style={styles.roundSearch}>⌕</Text>
            </Pressable>
          )}
          {!following && (
            <Pressable style={styles.roundButton} onPress={recentre}>
              <Text style={styles.recentreText}>◎</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Bottom bar */}
      {editMode ? (
        <View style={styles.bottomBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.barLine}>
              {!editZoomedIn
                ? 'Zoom in to edit roads'
                : editAction === 'exclude'
                  ? 'Tap a road: private / gone'
                  : 'Tap a green road to un-mark it'}
            </Text>
            <View style={[styles.row, { justifyContent: 'flex-start', marginTop: 6 }]}>
              <Pressable style={[styles.smallButton, editAction === 'exclude' && styles.chipActive]} onPress={() => setEditAction('exclude')}>
                <Text style={styles.chipText}>Private / gone</Text>
              </Pressable>
              <Pressable style={[styles.smallButton, editAction === 'undrive' && styles.chipActive]} onPress={() => setEditAction('undrive')}>
                <Text style={styles.chipText}>Un-mark</Text>
              </Pressable>
            </View>
          </View>
          <View style={{ gap: 6 }}>
            <Pressable
              style={[styles.smallButton, editHistory.length === 0 && { opacity: 0.4 }]}
              onPress={undoEdit}
              disabled={editHistory.length === 0}
            >
              <Text style={styles.chipText}>↶ Undo{editHistory.length > 1 ? ` (${editHistory.length})` : ''}</Text>
            </Pressable>
            <Pressable style={[styles.mainButton, styles.buttonBlue]} onPress={() => setEditMode(false)}>
              <Text style={styles.buttonText}>Done</Text>
            </Pressable>
          </View>
        </View>
      ) : navStage === 'choose' && dest ? (
        <RouteChooser
          destName={dest.name}
          options={routeOptions}
          chosen={chosenRoute}
          loading={routesLoading}
          error={routeError}
          onChoose={setChosenRoute}
          onGo={() => startNavigation().catch(() => undefined)}
          onCancel={cancelRoutes}
          avoid={tripAvoid}
          onAvoid={toggleTripAvoid}
        />
      ) : navStage === 'driving' ? (
        <NavFooter update={navUpdate} muted={muted} onMute={toggleMute} onEnd={endNavigation} newM={tracking ? driveNewMRef.current : 0} />
      ) : (
        <View style={styles.bottomBar}>
          <View style={{ flex: 1 }}>
            {countyStats ? (
              <Pressable onPress={openCountyStats} hitSlop={8}>
                <Text style={styles.barLine}>
                  {focusRow ? `${shortCounty(focusRow.name)} ${focusRow.percent.toFixed(2)}%` : 'Ireland'}
                  <Text style={styles.barDim}>{`  ·  Ireland ${countyFigures.nationalPercent.toFixed(3)}%`}</Text>
                </Text>
              </Pressable>
            ) : (
              <Text style={styles.barDim}>Connect once to load road totals</Text>
            )}
            {tracking &&
              (liveAuto ? (
                <Text style={styles.barLive}>
                  ● Auto-detected · {formatDuration(elapsed)} · {km(driveDistanceRef.current)} km · Stop to save
                </Text>
              ) : (
                <Text style={styles.barLive}>
                  ● {formatDuration(elapsed)} · {km(driveDistanceRef.current)} km · +{km(driveNewMRef.current)} km new
                </Text>
              ))}
          </View>
          <Pressable
            style={[styles.mainButton, tracking && styles.mainButtonStop, !tracking && recheckProgress !== null && styles.mainButtonBusy]}
            onPress={tracking ? stop : start}
            disabled={!tracking && recheckProgress !== null}
          >
            <Text style={styles.buttonText}>{tracking ? 'Stop' : 'Start'}</Text>
            <Text style={styles.modeLabel}>
              {tracking
                ? activeModeRef.current === 'high' ? 'High' : activeModeRef.current === 'balanced' ? 'Balanced' : 'Saver'
                : ACCURACY_MODES.find((m) => m.key === accuracyMode)?.label}
            </Text>
          </Pressable>
        </View>
      )}

      {MAP_TYPES[mapTypeIndex] === 'osm' && (
        <View style={styles.osmCredit} pointerEvents="none">
          <Text style={styles.osmCreditText}>© OpenStreetMap contributors</Text>
        </View>
      )}

      {recap && <RecapCard recap={recap} onClose={() => setRecap(null)} />}

      {offerAuto && loadingGone && !tracking && (
        <View style={styles.offerBackdrop}>
          <View style={styles.offerCard}>
            <Text style={styles.offerTitle}>Never miss a drive</Text>
            <Text style={styles.offerText}>
              tarmacked can notice when you're driving and record it, even if you forget to press Start. It always asks before
              saving a drive, and ends drives you forget to stop.
            </Text>
            <Text style={styles.offerPerm}>
              <Text style={styles.offerPermName}>Motion & Fitness</Text> to tell driving from walking
            </Text>
            <Text style={styles.offerPerm}>
              <Text style={styles.offerPermName}>Location: Always</Text> to notice you've set off while the app is closed
            </Text>
            <Text style={styles.offerPerm}>
              <Text style={styles.offerPermName}>Notifications</Text> to ask before saving a drive
            </Text>
            <Text style={styles.small}>You can change this any time in Settings (⚙).</Text>
            <View style={[styles.row, { marginTop: 16 }]}>
              <Pressable style={[styles.button, styles.buttonGrey]} onPress={declineAutoDetect} disabled={autoBusy}>
                <Text style={styles.buttonText}>Not now</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.buttonGreen]} onPress={enableAutoDetect} disabled={autoBusy}>
                <Text style={styles.buttonText}>{autoBusy ? 'Setting up…' : 'Turn on'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      {loadingOverlay}
    </View>
  );
}

// Shown from launch until your data is loaded. The mark sits exactly where
// the native splash screen shows it, so the hand-over is invisible.
function LoadingScreen({ step, ready, onGone }: { step: string; ready: boolean; onGone: () => void }) {
  const fade = useRef(new Animated.Value(1)).current;
  const line = useRef(new Animated.Value(0)).current;
  const shownAt = useRef(Date.now());
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(line, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.cubic), useNativeDriver: false }),
        Animated.timing(line, { toValue: 0, duration: 0, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [line]);
  useEffect(() => {
    if (!ready) return;
    const wait = Math.max(0, LOADING_MIN_MS - (Date.now() - shownAt.current));
    const h = setTimeout(() => {
      Animated.timing(fade, { toValue: 0, duration: 350, useNativeDriver: true }).start(() => onGone());
    }, wait);
    return () => clearTimeout(h);
  }, [ready, fade, onGone]);
  return (
    <Animated.View
      style={[styles.loading, { opacity: fade }]}
      pointerEvents={ready ? 'none' : 'auto'}
      onLayout={() => SplashScreen.hideAsync().catch(() => undefined)}
    >
      <Image source={require('./assets/splash-icon.png')} style={styles.loadingMark} />
      <View style={styles.loadingBelow}>
        <Text style={styles.loadingWord}>tarmacked</Text>
        <View style={styles.loadingTrack}>
          <Animated.View style={[styles.loadingLine, { width: line.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
        </View>
        <Text style={styles.loadingStatus}>{step}</Text>
      </View>
    </Animated.View>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },

  // Loading screen: the mark is centred at the native splash's size
  // (imageWidth in app.json), everything else hangs below it.
  loading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#0f1311', alignItems: 'center', justifyContent: 'center' },
  loadingMark: { width: 120, height: 120 },
  loadingBelow: { position: 'absolute', top: '50%', marginTop: 84, left: 0, right: 0, alignItems: 'center' },
  loadingWord: { color: '#e8ede9', fontSize: 30, fontWeight: '900', letterSpacing: -0.8 },
  loadingTrack: { width: 140, height: 4, borderRadius: 2, backgroundColor: '#26302b', marginTop: 16, overflow: 'hidden' },
  loadingLine: { height: 4, borderRadius: 2, backgroundColor: '#39d353' },
  loadingStatus: { color: '#93a098', fontSize: 13, marginTop: 14 },

  // "Never miss a drive"
  offerBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 },
  offerCard: { backgroundColor: '#161c19', borderRadius: 16, padding: 22, borderWidth: 1, borderColor: '#26302b' },
  offerTitle: { color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 10 },
  offerText: { color: '#cfd8d2', fontSize: 15, lineHeight: 21, marginBottom: 14 },
  offerPerm: { color: '#93a098', fontSize: 14, lineHeight: 20, marginBottom: 6 },
  offerPermName: { color: '#39d353', fontWeight: '700' },

  missingBox: { backgroundColor: 'rgba(232,176,64,0.12)', borderRadius: 10, padding: 12, marginTop: 10, gap: 10 },
  permRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  diagText: { color: '#6f7b74', fontSize: 11, marginTop: 8, fontFamily: 'Courier' },
  permName: { color: '#fff', fontSize: 14, fontWeight: '700' },
  permHow: { color: '#cfd8d2', fontSize: 12, lineHeight: 17, marginTop: 2 },
  missingText: { color: '#e8c070', fontSize: 13, lineHeight: 18 },
  recordingTag: { color: '#ff7a7a', fontSize: 12, fontWeight: '700' },
  pendingTag: { color: '#e8c070', fontSize: 12, marginTop: 2 },
  pendingButtons: { flexDirection: 'row', gap: 6 },
  smallButtonGreen: { backgroundColor: '#2f6f3a' },
  buttonGreen: { backgroundColor: '#2a6f2a' },
  map: { flex: 1 },
  onboardContainer: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', padding: 24 },
  onboardTitle: { color: '#fff', fontSize: 32, fontWeight: '700', marginBottom: 20 },
  onboardText: { color: '#aaa', fontSize: 14, textAlign: 'center', marginBottom: 12 },
  onboardError: { color: '#e0a030', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  countyList: { maxHeight: 320, alignSelf: 'stretch', marginTop: 8 },
  countyRow: { paddingVertical: 12, paddingHorizontal: 16, backgroundColor: '#1c1c1c', borderRadius: 8, marginBottom: 6 },
  countyRowText: { color: '#fff', fontSize: 15, textAlign: 'center' },
  skipLink: { marginTop: 16 },
  linkText: { color: '#6aa9ff', fontSize: 14 },

  topBar: { position: 'absolute', top: 56, left: 12, right: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  topPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(20,24,22,0.92)',
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  topItem: { paddingVertical: 9, paddingHorizontal: 15 },
  topIcon: { paddingHorizontal: 13 },
  topItemActive: { backgroundColor: '#2f6f3a' },
  topItemHeat: { backgroundColor: '#a3471a' },
  topDivider: { width: StyleSheet.hairlineWidth, height: 18, backgroundColor: 'rgba(255,255,255,0.25)' },
  topText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  topGlyph: { fontSize: 15 },
  sideButtons: { position: 'absolute', right: 16, bottom: 104, gap: 10, alignItems: 'center' },
  sideButtonsDriving: { bottom: 116 },
  roundButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(20,24,22,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  roundSearch: { color: '#fff', fontSize: 26, fontWeight: '600', marginTop: -2 },
  heatIcon: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 17 },
  heatIconBar: { width: 4, borderRadius: 1.5 },
  chipActive: { backgroundColor: '#2f6f3a' },

  heatBar: {
    position: 'absolute',
    top: 104,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(17,17,17,0.88)',
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 12,
    gap: 4,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center' },
  legendStep: { flex: 1, height: 6 },
  legendText: { color: '#ccc', fontSize: 11, fontWeight: '600', marginHorizontal: 4 },
  highlightText: { flex: 1, color: '#fff', fontSize: 13, fontWeight: '600' },

  tabBar: { flexGrow: 0, marginBottom: 12 },
  tabPill: { backgroundColor: '#2a2a2a', borderRadius: 16, paddingVertical: 7, paddingHorizontal: 14 },
  tabPillActive: { backgroundColor: '#2f6f3a' },
  bigStat: { color: '#39d353', fontSize: 30, fontWeight: '800' },
  sectionTitle: { color: '#fff', fontSize: 14, fontWeight: '700', marginTop: 16, marginBottom: 6 },
  statGrid: { flexDirection: 'row', gap: 8 },
  statTile: { flex: 1, backgroundColor: '#1f1f1f', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 8 },
  statValue: { color: '#fff', fontSize: 15, fontWeight: '700' },
  statLabel: { color: '#8a8a8a', fontSize: 11, marginTop: 2 },
  recordLine: { color: '#ddd', fontSize: 13, paddingVertical: 4 },
  roadRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 8 },
  roadRank: { color: '#777', fontSize: 12, width: 18, textAlign: 'right' },
  roadSwatch: { width: 10, height: 26, borderRadius: 3 },
  roadName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  roadCount: { color: '#fff', fontSize: 15, fontWeight: '700' },
  patchyTag: { color: '#e8b040', fontSize: 12, fontWeight: '600' },
  modeLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 10, textAlign: 'center', marginTop: 1 },
  osmCredit: { position: 'absolute', bottom: 12, left: 16, backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: 4, paddingHorizontal: 5 },
  osmCreditText: { color: '#333', fontSize: 10 },
  chipText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  toast: {
    position: 'absolute',
    bottom: 116,
    left: 12,
    right: 72,
    backgroundColor: 'rgba(17,17,17,0.92)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  toastText: { color: '#e8c070', fontSize: 13 },

  panel: {
    position: 'absolute',
    top: 104,
    left: 12,
    right: 12,
    maxHeight: '58%',
    backgroundColor: 'rgba(17,17,17,0.96)',
    borderRadius: 14,
    padding: 16,
  },
  panelTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 10 },
  small: { color: '#8a8a8a', fontSize: 12, marginTop: 8, lineHeight: 17 },
  statsHeadline: { color: '#39d353', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  countyStatRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, paddingHorizontal: 6, borderRadius: 6 },
  countyStatRowCurrent: { backgroundColor: 'rgba(57,211,83,0.15)' },
  countyStatName: { color: '#888', fontSize: 13 },
  countyStatNameDriven: { color: '#fff', fontWeight: '600' },
  countyStatValue: { color: '#aaa', fontSize: 12 },
  driveRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 8, borderRadius: 8 },
  driveRowSelected: { backgroundColor: 'rgba(255,159,26,0.15)' },
  driveWhen: { color: '#fff', fontSize: 14, fontWeight: '600' },
  driveInfo: { color: '#9a9a9a', fontSize: 12, marginTop: 2 },
  logText: { color: '#7fd67f', fontSize: 10, fontFamily: 'Courier' },

  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 },
  button: { flexGrow: 1, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  buttonBlue: { backgroundColor: '#2a4f8a' },
  buttonPurple: { backgroundColor: '#5a3a8a' },
  buttonGrey: { backgroundColor: '#333' },
  buttonOn: { backgroundColor: '#3a6fb0' },
  buttonRed: { backgroundColor: '#5a2a2a' },
  buttonRedConfirm: { backgroundColor: '#a03030' },
  smallButton: { backgroundColor: '#333', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12 },
  smallButtonDanger: { backgroundColor: '#a03030' },

  recentreText: { color: '#6aa9ff', fontSize: 22, fontWeight: '700' },

  bottomBar: {
    position: 'absolute',
    bottom: 34,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(20,24,22,0.92)',
    borderRadius: 16,
    paddingVertical: 8,
    paddingLeft: 16,
    paddingRight: 8,
  },
  barLine: { color: '#fff', fontSize: 15, fontWeight: '600' },
  barDim: { color: '#9a9a9a', fontSize: 13, fontWeight: '400' },
  barLive: { color: '#ff7a7a', fontSize: 13, marginTop: 4 },
  mainButton: { backgroundColor: '#2a6f2a', paddingVertical: 10, paddingHorizontal: 22, borderRadius: 11 },
  mainButtonStop: { backgroundColor: '#8a2a2a' },
  mainButtonBusy: { opacity: 0.4 },
});
