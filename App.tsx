import { useState, useEffect, useRef, useMemo } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import MapView, { Polyline, PROVIDER_DEFAULT, MapPressEvent, MapType, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  findNearestSegment,
  findNearestSegmentAligned,
  totalLengthMeters,
  segmentLengthMeters,
  RoadSegment,
} from './src/roadMatcher';
import countyTotalsRaw from './assets/roads/county-totals.json';

const countyTotals = countyTotalsRaw as { county: string; totalMeters: number }[];

const DRIVEN_KEY = 'tarmacked:driven:local';
const EXCLUDED_KEY = 'tarmacked:excluded:local';
const UNMATCHED_KEY = 'tarmacked:unmatched:local';
const DYNAMIC_TILES_KEY = 'tarmacked:dynamicTiles';
const ONBOARDED_KEY = 'tarmacked:onboarded';
const HOME_COUNTY_KEY = 'tarmacked:homeCounty';
const RAW_TRAIL_KEY = 'tarmacked:rawTrail';

const LOCATION_TASK_NAME = 'tarmacked-background-location';

// Every road tile is fetched live from the public repo over GitHub's raw
// file CDN. Must match TILE_DEGREES and tileIdForPoint() in
// scripts/tile-county.js exactly.
const TILES_BASE_URL = 'https://raw.githubusercontent.com/0204Killian/tarmacked/main/tiles/';
const TILE_DEGREES = 0.05;

// Edit mode only draws roads once zoomed in this far (roughly a few km
// across) — drawing a whole county's worth of tappable lines at once is
// what made it unusable.
const EDIT_MAX_LAT_DELTA = 0.06;

// --- Corner/bend fixes ---
// Same-road gap fill: if consecutive matches land on chunks 3 and 6 of the
// same road, chunks 4 and 5 must have been driven too.
const GAP_FILL_MAX_CHUNKS = 8; // ~800m — beyond that, don't assume
const GAP_FILL_MAX_MS = 60_000;
// Bridging: extra check points along the line between two consecutive GPS
// points, so short chunks at junctions/bends still get hit.
const BRIDGE_STEP_M = 15;
const BRIDGE_MAX_M = 250; // bigger gaps (tunnel, signal loss) aren't bridged
const BRIDGE_MAX_MS = 30_000;
// Junction linking: when consecutive matches jump between different roads,
// search connected chunks for the link between them. Roads that meet share
// an exact point — often partway along a chunk, not at its end, so every
// point of every chunk is indexed, not just the ends.
const CONNECT_MAX_CHUNKS = 3;

// Heading check: ignore roads crossing your direction of travel at more
// than this angle — stops overpasses/underpasses being marked as driven.
const HEADING_MAX_ANGLE_DEG = 55;
const HEADING_MIN_MOVE_M = 8; // below this, direction is too noisy to trust
const HEADING_STALE_MS = 10_000;

function vertexKey(c: [number, number]) {
  return `${c[0]},${c[1]}`;
}

// Compass-style bearing (0 = north, 90 = east) from a to b.
function headingBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const dx = (b.longitude - a.longitude) * 111_320 * Math.cos((a.latitude * Math.PI) / 180);
  const dy = (b.latitude - a.latitude) * 111_320;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

function haversineMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Chunk ids look like "way/123#4" — the road, and position along it.
function parseChunkId(id: string): { way: string; idx: number } | null {
  const hash = id.lastIndexOf('#');
  if (hash < 0) return null;
  const idx = parseInt(id.slice(hash + 1), 10);
  if (Number.isNaN(idx)) return null;
  return { way: id.slice(0, hash), idx };
}

function tileIdForPoint(lat: number, lon: number): string {
  const latIdx = Math.floor(lat / TILE_DEGREES);
  const lonIdx = Math.floor(lon / TILE_DEGREES);
  return `t_${latIdx}_${lonIdx}`;
}

// The point's own tile plus its 8 neighbours — a road chunk can start in
// one tile and run ~100m into the next, so neighbours cover edge cases.
function neighbourTileIds(lat: number, lon: number): string[] {
  const latIdx = Math.floor(lat / TILE_DEGREES);
  const lonIdx = Math.floor(lon / TILE_DEGREES);
  const ids: string[] = [];
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      ids.push(`t_${latIdx + dLat}_${lonIdx + dLon}`);
    }
  }
  return ids;
}

// Groups segments by the tile their first point falls in — the same rule
// tile-county.js uses to decide which file a chunk goes into.
function buildTileIndex(segments: RoadSegment[]): Map<string, RoadSegment[]> {
  const index = new Map<string, RoadSegment[]>();
  for (const seg of segments) {
    const [lat, lon] = seg.coords[0];
    const tid = tileIdForPoint(lat, lon);
    const bucket = index.get(tid);
    if (bucket) bucket.push(seg);
    else index.set(tid, [seg]);
  }
  return index;
}

type Point = { latitude: number; longitude: number; timestamp: number };
// Carried between batches so bridging and gap-fill work across the 2s
// poll boundaries, not just within one batch.
type MatchContext = {
  lastPoint: Point | null;
  lastMatch: { id: string; way: string; idx: number; t: number } | null;
  lastHeading: { deg: number; t: number } | null;
};
type DynamicTileEntry = { tileId: string; segments: RoadSegment[] };

let recordedPoints: Point[] = [];

TaskManager.defineTask(LOCATION_TASK_NAME, ({ data, error }) => {
  if (error) {
    console.error(error);
    return;
  }
  if (data) {
    const { locations } = data as { locations: Location.LocationObject[] };
    for (const loc of locations) {
      recordedPoints.push({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        timestamp: loc.timestamp,
      });
    }
  }
});

const FALLBACK_REGION = {
  latitude: 53.1,
  longitude: -7.7,
  latitudeDelta: 4,
  longitudeDelta: 4,
};

const MAP_TYPES: MapType[] = ['standard', 'satellite', 'hybrid'];

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function saveDynamicTiles(entries: DynamicTileEntry[]) {
  const raw = await AsyncStorage.getItem(DYNAMIC_TILES_KEY);
  const existing: DynamicTileEntry[] = raw ? JSON.parse(raw) : [];
  const incomingIds = new Set(entries.map((e) => e.tileId));
  const kept = existing.filter((e) => !incomingIds.has(e.tileId));
  await AsyncStorage.setItem(DYNAMIC_TILES_KEY, JSON.stringify([...kept, ...entries]));
}

export default function App() {
  // null = still checking storage; false = needs onboarding; true = ready
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [onboardingCounties, setOnboardingCounties] = useState<string[] | null>(null);
  const [onboardingError, setOnboardingError] = useState('');
  const [downloadingCounty, setDownloadingCounty] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState({ done: 0, total: 0 });
  const [homeCounty, setHomeCounty] = useState<string | null>(null);

  const [tracking, setTracking] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // Map follows your position until you drag it; the recentre button
  // switches it back on.
  const [following, setFollowing] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const mapRef = useRef<MapView | null>(null);
  // What a tap on a road does in edit mode.
  const [editAction, setEditAction] = useState<'exclude' | 'undrive'>('exclude');
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [resetConfirming, setResetConfirming] = useState(false);
  const [clearTilesConfirming, setClearTilesConfirming] = useState(false);
  const [showRawTrail, setShowRawTrail] = useState(false);
  const [mapTypeIndex, setMapTypeIndex] = useState(0);
  const [region, setRegion] = useState(FALLBACK_REGION);
  const [visibleRegion, setVisibleRegion] = useState<Region>(FALLBACK_REGION);
  const [pointCount, setPointCount] = useState(0);
  const [drivenIds, setDrivenIds] = useState<Set<string>>(new Set());
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [unmatchedPoints, setUnmatchedPoints] = useState<Point[]>([]);
  // Every recorded point (matched or not), grouped per drive so separate
  // drives don't get joined by a straight line. Foundation for drawing
  // the real driven trail later, and for judging matching accuracy now.
  const [rawSessions, setRawSessions] = useState<Point[][]>([]);
  const [dynamicSegments, setDynamicSegments] = useState<RoadSegment[]>([]);
  const [note, setNote] = useState('');
  const [debug, setDebug] = useState('starting…');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const foregroundSub = useRef<Location.LocationSubscription | null>(null);
  const loadedRef = useRef(false);
  const processedIndexRef = useRef(0);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTilesTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownTilesRef = useRef<Set<string>>(new Set());
  const matchCtxRef = useRef<MatchContext>({ lastPoint: null, lastMatch: null, lastHeading: null });

  useEffect(() => {
    (async () => {
      try {
        const [savedOnboarded, savedHomeCounty, savedDriven, savedExcluded, savedUnmatched, savedTiles, savedTrail] =
          await Promise.all([
            AsyncStorage.getItem(ONBOARDED_KEY),
            AsyncStorage.getItem(HOME_COUNTY_KEY),
            AsyncStorage.getItem(DRIVEN_KEY),
            AsyncStorage.getItem(EXCLUDED_KEY),
            AsyncStorage.getItem(UNMATCHED_KEY),
            AsyncStorage.getItem(DYNAMIC_TILES_KEY),
            AsyncStorage.getItem(RAW_TRAIL_KEY),
          ]);
        if (savedDriven) setDrivenIds(new Set(JSON.parse(savedDriven)));
        if (savedExcluded) setExcludedIds(new Set(JSON.parse(savedExcluded)));
        if (savedUnmatched) setUnmatchedPoints(JSON.parse(savedUnmatched));
        if (savedTrail) setRawSessions(JSON.parse(savedTrail));
        if (savedTiles) {
          const parsed = JSON.parse(savedTiles) as DynamicTileEntry[];
          setDynamicSegments(parsed.flatMap((t) => t.segments));
          parsed.forEach((t) => knownTilesRef.current.add(t.tileId));
        }
        if (savedHomeCounty) setHomeCounty(savedHomeCounty);
        setOnboarded(savedOnboarded === 'true');
      } catch (e) {
        console.warn('failed to load saved state', e);
        setOnboarded(false);
      } finally {
        loadedRef.current = true;
      }
    })();
  }, []);

  useEffect(() => {
    if (onboarded !== false || onboardingCounties !== null) return;
    (async () => {
      try {
        const res = await fetch(`${TILES_BASE_URL}county-index.json`);
        if (!res.ok) throw new Error(`index responded ${res.status}`);
        const index = await res.json();
        setOnboardingCounties(Object.keys(index).sort());
      } catch (e) {
        setOnboardingError(`Couldn't reach GitHub to list counties (${(e as Error).message}). Check your connection and try again.`);
      }
    })();
  }, [onboarded, onboardingCounties]);

  useEffect(() => {
    if (!loadedRef.current) return;
    AsyncStorage.setItem(DRIVEN_KEY, JSON.stringify(Array.from(drivenIds))).catch((e) =>
      console.warn('failed to save driven roads', e)
    );
  }, [drivenIds]);

  useEffect(() => {
    if (!loadedRef.current) return;
    AsyncStorage.setItem(EXCLUDED_KEY, JSON.stringify(Array.from(excludedIds))).catch((e) =>
      console.warn('failed to save excluded roads', e)
    );
  }, [excludedIds]);

  useEffect(() => {
    if (!loadedRef.current) return;
    AsyncStorage.setItem(UNMATCHED_KEY, JSON.stringify(unmatchedPoints)).catch((e) =>
      console.warn('failed to save unmatched points', e)
    );
  }, [unmatchedPoints]);

  useEffect(() => {
    if (!loadedRef.current) return;
    AsyncStorage.setItem(RAW_TRAIL_KEY, JSON.stringify(rawSessions)).catch((e) =>
      console.warn('failed to save raw trail', e)
    );
  }, [rawSessions]);

  useEffect(() => {
    if (onboarded !== true) return;
    (async () => {
      setDebug('requesting foreground permission…');
      try {
        const fg = await withTimeout(Location.requestForegroundPermissionsAsync(), 8000, 'foreground permission');
        setDebug(`foreground: ${fg.status}`);
      } catch (e) {
        setDebug(`foreground: FAILED — ${(e as Error).message}`);
      }

      setDebug((d) => d + '\nrequesting background permission…');
      try {
        const bg = await withTimeout(Location.requestBackgroundPermissionsAsync(), 8000, 'background permission');
        setDebug((d) => d + `\nbackground: ${bg.status}`);
      } catch (e) {
        setDebug((d) => d + `\nbackground: FAILED — ${(e as Error).message}`);
      }

      setDebug((d) => d + '\ngetting current position…');
      try {
        const current = await withTimeout(Location.getCurrentPositionAsync({}), 8000, 'get current position');
        const here = {
          latitude: current.coords.latitude,
          longitude: current.coords.longitude,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        };
        setRegion(here);
        setVisibleRegion(here);
        setDebug((d) => d + `\nposition: ${current.coords.latitude.toFixed(4)}, ${current.coords.longitude.toFixed(4)}`);
      } catch (e) {
        setDebug((d) => d + `\nposition: FAILED — ${(e as Error).message} (using fallback map region)`);
      }
    })();
  }, [onboarded]);

  // Only rebuilt when the set of downloaded roads changes, not every render.
  const tileIndex = useMemo(() => buildTileIndex(dynamicSegments), [dynamicSegments]);
  const segmentsById = useMemo(() => new Map(dynamicSegments.map((seg) => [seg.id, seg])), [dynamicSegments]);
  // Point -> chunk ids containing it. Roads that meet share an exact point
  // (the same OSM node), wherever along a chunk it falls.
  const vertexIndex = useMemo(() => {
    const idx = new Map<string, string[]>();
    for (const seg of dynamicSegments) {
      for (const c of seg.coords) {
        const k = vertexKey(c);
        const list = idx.get(k);
        if (!list) idx.set(k, [seg.id]);
        else if (list[list.length - 1] !== seg.id) list.push(seg.id);
      }
    }
    return idx;
  }, [dynamicSegments]);

  // Shortest chain of connected chunks between two matches; returns the
  // chunks strictly in between, or null if they aren't linked within
  // CONNECT_MAX_CHUNKS.
  const connectChunks = (fromId: string, toId: string): string[] | null => {
    let frontier: { id: string; path: string[] }[] = [{ id: fromId, path: [] }];
    const seen = new Set<string>([fromId]);
    for (let depth = 0; depth <= CONNECT_MAX_CHUNKS; depth++) {
      const next: { id: string; path: string[] }[] = [];
      for (const node of frontier) {
        const seg = segmentsById.get(node.id);
        if (!seg) continue;
        for (const c of seg.coords) {
          for (const nid of vertexIndex.get(vertexKey(c)) || []) {
            if (seen.has(nid)) continue;
            if (nid === toId) return node.path;
            if (excludedIds.has(nid)) continue;
            seen.add(nid);
            next.push({ id: nid, path: [...node.path, nid] });
          }
        }
      }
      frontier = next;
    }
    return null;
  };

  // Matching now only checks roads in the point's own tile and its
  // neighbours, instead of every road downloaded so far.
  const candidatesFor = (p: Point): RoadSegment[] => {
    const out: RoadSegment[] = [];
    for (const tid of neighbourTileIds(p.latitude, p.longitude)) {
      const bucket = tileIndex.get(tid);
      if (!bucket) continue;
      for (const seg of bucket) {
        if (!excludedIds.has(seg.id)) out.push(seg);
      }
    }
    return out;
  };

  const downloadHomeCounty = async (county: string) => {
    setDownloadingCounty(county);
    setOnboardingError('');
    try {
      const indexRes = await fetch(`${TILES_BASE_URL}county-index.json`);
      const index = await indexRes.json();
      const tileIds: string[] = index[county] || [];
      setDownloadProgress({ done: 0, total: tileIds.length });

      const allNew: RoadSegment[] = [];
      const entries: DynamicTileEntry[] = [];
      const batchSize = 8;
      for (let i = 0; i < tileIds.length; i += batchSize) {
        const batch = tileIds.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map(async (tid) => {
            try {
              const res = await fetch(`${TILES_BASE_URL}${tid}.json`);
              if (!res.ok) return { tileId: tid, segments: [] as RoadSegment[] };
              const data = await res.json();
              return { tileId: tid, segments: (data.segments || []) as RoadSegment[] };
            } catch {
              return { tileId: tid, segments: [] as RoadSegment[] };
            }
          })
        );
        for (const r of results) {
          if (r.segments.length > 0) {
            allNew.push(...r.segments);
            entries.push(r);
          }
          knownTilesRef.current.add(r.tileId);
        }
        setDownloadProgress({ done: Math.min(i + batchSize, tileIds.length), total: tileIds.length });
      }

      setDynamicSegments((prev) => [...prev, ...allNew]);
      await saveDynamicTiles(entries);
      await AsyncStorage.setItem(HOME_COUNTY_KEY, county);
      await AsyncStorage.setItem(ONBOARDED_KEY, 'true');
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

  const skipOnboarding = async () => {
    await AsyncStorage.setItem(ONBOARDED_KEY, 'true');
    setOnboarded(true);
  };

  const tryFetchTile = async (tileId: string) => {
    if (knownTilesRef.current.has(tileId)) return;
    // Mark as in-flight straight away so a burst of points in the same
    // tile doesn't fire off duplicate requests.
    knownTilesRef.current.add(tileId);
    try {
      const res = await fetch(`${TILES_BASE_URL}${tileId}.json`);
      if (!res.ok) return; // not tiled — leave it marked so we don't keep asking
      const data = await res.json();
      const newSegments: RoadSegment[] = data.segments || [];
      if (newSegments.length === 0) return;

      setDebug((d) => d + `\nacquired new tile: ${tileId} (${newSegments.length} segments)`);
      setDynamicSegments((prev) => [...prev, ...newSegments]);
      saveDynamicTiles([{ tileId, segments: newSegments }]).catch((e) => console.warn('failed to persist tile', e));
    } catch {
      // Network failure (e.g. no signal) — unmark so a later attempt retries.
      knownTilesRef.current.delete(tileId);
    }
  };

  // Shared by the live poll and the final drain on Stop. Side effects
  // happen here, outside the state updaters, so nothing runs twice.
  // Matches an ordered run of points. Besides each real point it:
  //  - bridges: checks extra points every 15m along the line from the
  //    previous point, so short chunks at bends/junctions get hit
  //  - gap-fills: if two matches land on the same road a few chunks apart,
  //    marks the chunks in between as driven too
  // Pure apart from ctx, so it can be re-run over the saved trail any time.
  const matchSequence = (points: Point[], ctx: MatchContext) => {
    const matched = new Set<string>();
    const unmatched: Point[] = [];

    const register = (id: string, t: number) => {
      matched.add(id);
      const parsed = parseChunkId(id);
      if (!parsed) return;
      const last = ctx.lastMatch;
      if (last && last.id !== id && t - last.t <= GAP_FILL_MAX_MS) {
        if (last.way === parsed.way) {
          const gap = Math.abs(parsed.idx - last.idx);
          if (gap > 1 && gap <= GAP_FILL_MAX_CHUNKS) {
            const lo = Math.min(parsed.idx, last.idx);
            const hi = Math.max(parsed.idx, last.idx);
            for (let k = lo + 1; k < hi; k++) {
              const fillId = `${parsed.way}#${k}`;
              if (!excludedIds.has(fillId)) matched.add(fillId);
            }
          }
        } else {
          const link = connectChunks(last.id, id);
          if (link) link.forEach((lid) => matched.add(lid));
        }
      }
      ctx.lastMatch = { id, way: parsed.way, idx: parsed.idx, t };
    };

    for (const p of points) {
      const prev = ctx.lastPoint;

      // Direction of travel for this point: from the previous point if
      // we've moved far enough to trust it, else the last good heading if
      // it's recent, else none (no heading check).
      let heading: number | null = null;
      if (prev && haversineMeters(prev, p) >= HEADING_MIN_MOVE_M) {
        heading = headingBetween(prev, p);
        ctx.lastHeading = { deg: heading, t: p.timestamp };
      } else if (ctx.lastHeading && p.timestamp - ctx.lastHeading.t <= HEADING_STALE_MS) {
        heading = ctx.lastHeading.deg;
      }

      if (prev && p.timestamp - prev.timestamp <= BRIDGE_MAX_MS) {
        const dist = haversineMeters(prev, p);
        if (dist > BRIDGE_STEP_M && dist <= BRIDGE_MAX_M) {
          for (let s = 1; s * BRIDGE_STEP_M < dist; s++) {
            const f = (s * BRIDGE_STEP_M) / dist;
            const q = {
              latitude: prev.latitude + (p.latitude - prev.latitude) * f,
              longitude: prev.longitude + (p.longitude - prev.longitude) * f,
              timestamp: prev.timestamp + (p.timestamp - prev.timestamp) * f,
            };
            const qm = findNearestSegmentAligned(q, candidatesFor(q), heading, HEADING_MAX_ANGLE_DEG);
            // Bridge points are only helpers — a miss here isn't saved as unmatched.
            if (qm.id) register(qm.id, q.timestamp);
          }
        }
      }
      const m = findNearestSegmentAligned(p, candidatesFor(p), heading, HEADING_MAX_ANGLE_DEG);
      if (m.id) register(m.id, p.timestamp);
      // Only genuinely off-road points count as unmatched — not ones that
      // were on a road that just failed the direction check.
      else if (!m.nearbyRejected) unmatched.push(p);
      ctx.lastPoint = p;
    }

    return { matched, unmatched };
  };

  const processPoints = (newPoints: Point[]) => {
    if (newPoints.length === 0) return;
    const result = matchSequence(newPoints, matchCtxRef.current);
    const matched = Array.from(result.matched);
    const newlyUnmatched = result.unmatched;
    newlyUnmatched.forEach((p) => tryFetchTile(tileIdForPoint(p.latitude, p.longitude)));
    if (matched.length > 0) {
      setDrivenIds((prev) => {
        const next = new Set(prev);
        matched.forEach((id) => next.add(id));
        return next;
      });
    }
    if (newlyUnmatched.length > 0) {
      setUnmatchedPoints((prev) => [...prev, ...newlyUnmatched]);
    }
    setRawSessions((prev) => {
      if (prev.length === 0) return [newPoints];
      const copy = prev.slice();
      copy[copy.length - 1] = [...copy[copy.length - 1], ...newPoints];
      return copy;
    });
  };

  useEffect(() => {
    if (tracking) {
      pollRef.current = setInterval(() => {
        const newPoints = recordedPoints.slice(processedIndexRef.current);
        processedIndexRef.current = recordedPoints.length;
        processPoints(newPoints);
        setPointCount(recordedPoints.length);
      }, 2000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [tracking, excludedIds, tileIndex]);

  const start = async () => {
    recordedPoints = [];
    processedIndexRef.current = 0;
    matchCtxRef.current = { lastPoint: null, lastMatch: null, lastHeading: null };
    setPointCount(0);
    setNote('');
    setRawSessions((prev) => [...prev, []]);
    try {
      await withTimeout(
        Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: Location.Accuracy.BestForNavigation,
          // Denser logging: at 100km/h this is a point every ~40-55m
          // instead of ~140m, so short chunks at bends don't get skipped.
          timeInterval: 2000,
          distanceInterval: 10,
          activityType: Location.ActivityType.AutomotiveNavigation,
          pausesUpdatesAutomatically: false,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'tarmacked is tracking',
            notificationBody: 'Recording this drive',
          },
        }),
        8000,
        'start background tracking'
      );
    } catch (e) {
      setNote(`Foreground-only — ${(e as Error).message}. Tap the map to simulate driving.`);
      try {
        foregroundSub.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 10 },
          (loc) => {
            recordedPoints.push({
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
              timestamp: loc.timestamp,
            });
          }
        );
      } catch {
        setNote('No GPS available — tap the map to simulate driving');
      }
    }
    setTracking(true);
  };

  const stop = async () => {
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    } catch {
      // Wasn't running as a background task — nothing to stop there.
    }
    if (foregroundSub.current) {
      foregroundSub.current.remove();
      foregroundSub.current = null;
    }
    const newPoints = recordedPoints.slice(processedIndexRef.current);
    processedIndexRef.current = recordedPoints.length;
    processPoints(newPoints);
    setTracking(false);
  };

  const onMapPress = (e: MapPressEvent) => {
    if (!tracking || editMode) return;
    const { latitude, longitude } = e.nativeEvent.coordinate;
    recordedPoints.push({ latitude, longitude, timestamp: Date.now() });
  };

  const handleEditTap = (id: string) => {
    if (editAction === 'undrive') {
      if (!drivenIds.has(id)) return;
      setDrivenIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }
    toggleExcluded(id);
  };

  const toggleExcluded = (id: string) => {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const cycleMapType = () => setMapTypeIndex((i) => (i + 1) % MAP_TYPES.length);

  const rematch = () => {
    unmatchedPoints.forEach((p) => tryFetchTile(tileIdForPoint(p.latitude, p.longitude)));

    const matched: string[] = [];
    const stillUnmatched: Point[] = [];
    for (const p of unmatchedPoints) {
      const id = findNearestSegment(p, candidatesFor(p));
      if (id) matched.push(id);
      else stillUnmatched.push(p);
    }
    if (matched.length > 0) {
      setDrivenIds((prev) => {
        const next = new Set(prev);
        matched.forEach((id) => next.add(id));
        return next;
      });
    }
    setUnmatchedPoints(stillUnmatched);
    setNote(`Rematch: recovered ${matched.length} of ${unmatchedPoints.length} saved points`);
  };

  // Replays every saved drive through the current matching logic. Only
  // ever adds driven roads, never removes any.
  const rerunFullTrail = () => {
    const allMatched = new Set<string>();
    let unmatchedCount = 0;
    for (const session of rawSessions) {
      const result = matchSequence(session, { lastPoint: null, lastMatch: null, lastHeading: null });
      result.matched.forEach((id) => allMatched.add(id));
      unmatchedCount += result.unmatched.length;
      result.unmatched.forEach((p) => tryFetchTile(tileIdForPoint(p.latitude, p.longitude)));
    }
    setDrivenIds((prev) => {
      const next = new Set(prev);
      allMatched.forEach((id) => next.add(id));
      return next;
    });
    setDevToolsOpen(false);
    setNote(
      `Re-ran ${rawSessions.length} drive(s): ${allMatched.size} road chunks matched` +
        (unmatchedCount > 0 ? `, ${unmatchedCount} points still off-road or in areas not downloaded yet` : '')
    );
  };

  const recentre = async () => {
    setFollowing(true);
    try {
      const pos =
        (await Location.getLastKnownPositionAsync()) ??
        (await withTimeout(Location.getCurrentPositionAsync({}), 8000, 'get current position'));
      mapRef.current?.animateCamera(
        { center: { latitude: pos.coords.latitude, longitude: pos.coords.longitude } },
        { duration: 400 }
      );
    } catch {
      // No fix available right now — following will snap to you on the next location update anyway.
    }
  };

  // Swaps the phone's cached road data for fresh data — needed after the
  // tiles are regenerated (e.g. to pick up one-way directions). Driven
  // roads are kept: chunk ids don't change.
  const refreshRoadData = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setDevToolsOpen(false);
    setDynamicSegments([]);
    knownTilesRef.current.clear();
    try {
      await AsyncStorage.removeItem(DYNAMIC_TILES_KEY);
      if (homeCounty) {
        setNote(`Refreshing road data for ${homeCounty}…`);
        const ok = await downloadHomeCounty(homeCounty);
        setNote(
          ok
            ? `Road data refreshed. Other areas re-download automatically as you drive.`
            : `Refresh failed — check your connection and try again.`
        );
      } else {
        setNote('Road data cleared. Areas will re-download automatically as you drive.');
      }
    } finally {
      setRefreshing(false);
    }
  };

  const handleResetPress = () => {
    if (!resetConfirming) {
      setResetConfirming(true);
      resetTimeoutRef.current = setTimeout(() => setResetConfirming(false), 4000);
      return;
    }
    if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    setDrivenIds(new Set());
    setExcludedIds(new Set());
    setUnmatchedPoints([]);
    setRawSessions([]);
    setResetConfirming(false);
    setDevToolsOpen(false);
  };

  const handleClearTilesPress = () => {
    if (!clearTilesConfirming) {
      setClearTilesConfirming(true);
      clearTilesTimeoutRef.current = setTimeout(() => setClearTilesConfirming(false), 4000);
      return;
    }
    if (clearTilesTimeoutRef.current) clearTimeout(clearTilesTimeoutRef.current);
    setDynamicSegments([]);
    knownTilesRef.current.clear();
    AsyncStorage.removeItem(DYNAMIC_TILES_KEY).catch((e) => console.warn('failed to clear tile cache', e));
    setClearTilesConfirming(false);
    setDevToolsOpen(false);
  };

  // --- Stats, memoised so they aren't recomputed on every 2s poll ---
  const totalLength = useMemo(
    () => totalLengthMeters(dynamicSegments.filter((seg) => !excludedIds.has(seg.id))),
    [dynamicSegments, excludedIds]
  );
  const drivenLength = useMemo(() => {
    let sum = 0;
    drivenIds.forEach((id) => {
      if (excludedIds.has(id)) return;
      const seg = segmentsById.get(id);
      if (seg) sum += segmentLengthMeters(seg);
    });
    return sum;
  }, [drivenIds, excludedIds, segmentsById]);
  const percentDriven = totalLength > 0 ? (drivenLength / totalLength) * 100 : 0;

  const otherCountiesTotal = countyTotals.reduce((sum, c) => sum + c.totalMeters, 0);
  const nationalTotal = totalLength + otherCountiesTotal;
  const nationalPercent = nationalTotal > 0 ? (drivenLength / nationalTotal) * 100 : 0;

  // --- Viewport culling: only draw what's actually on screen ---
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

  const editZoomedIn = visibleRegion.latitudeDelta <= EDIT_MAX_LAT_DELTA;

  const visibleEditSegments = useMemo(() => {
    if (!editMode || !editZoomedIn) return [] as RoadSegment[];
    const out: RoadSegment[] = [];
    const minLatIdx = Math.floor(bounds.minLat / TILE_DEGREES);
    const maxLatIdx = Math.floor(bounds.maxLat / TILE_DEGREES);
    const minLonIdx = Math.floor(bounds.minLon / TILE_DEGREES);
    const maxLonIdx = Math.floor(bounds.maxLon / TILE_DEGREES);
    for (let la = minLatIdx - 1; la <= maxLatIdx; la++) {
      for (let lo = minLonIdx - 1; lo <= maxLonIdx; lo++) {
        const bucket = tileIndex.get(`t_${la}_${lo}`);
        if (!bucket) continue;
        for (const seg of bucket) {
          const inView = seg.coords.some(
            ([lat, lon]) => lat >= bounds.minLat && lat <= bounds.maxLat && lon >= bounds.minLon && lon <= bounds.maxLon
          );
          if (inView) out.push(seg);
        }
      }
    }
    return out;
  }, [editMode, editZoomedIn, bounds, tileIndex]);

  const visibleDrivenSegments = useMemo(() => {
    const out: RoadSegment[] = [];
    drivenIds.forEach((id) => {
      if (excludedIds.has(id)) return;
      const seg = segmentsById.get(id);
      if (!seg) return;
      const [lat, lon] = seg.coords[0];
      if (lat >= bounds.minLat && lat <= bounds.maxLat && lon >= bounds.minLon && lon <= bounds.maxLon) {
        out.push(seg);
      }
    });
    return out;
  }, [drivenIds, excludedIds, segmentsById, bounds]);

  const rawPointTotal = rawSessions.reduce((sum, s) => sum + s.length, 0);

  // --- Onboarding screens ---
  if (onboarded === null) {
    return (
      <View style={styles.onboardContainer}>
        <ActivityIndicator color="#39d353" size="large" />
      </View>
    );
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
              {downloadProgress.done} / {downloadProgress.total} tiles
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.onboardText}>Pick your home county to download it now — everywhere else downloads automatically as you drive there.</Text>
            {onboardingError ? <Text style={styles.onboardError}>{onboardingError}</Text> : null}
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
              <Text style={styles.skipLinkText}>Skip for now</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  // --- Main app ---
  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_DEFAULT}
        mapType={MAP_TYPES[mapTypeIndex]}
        initialRegion={region}
        showsUserLocation
        followsUserLocation={following && !editMode}
        onPanDrag={() => {
          if (following) setFollowing(false);
        }}
        onPress={onMapPress}
        onRegionChangeComplete={(r) => setVisibleRegion(r)}
      >
        {editMode &&
          visibleEditSegments.map((seg) => {
            const isExcluded = excludedIds.has(seg.id);
            const isDriven = drivenIds.has(seg.id);
            return (
              <Polyline
                key={seg.id}
                coordinates={seg.coords.map(([lat, lon]) => ({ latitude: lat, longitude: lon }))}
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

        {!editMode &&
          visibleDrivenSegments.flatMap((seg) => {
            const coords = seg.coords.map(([lat, lon]) => ({ latitude: lat, longitude: lon }));
            return [
              <Polyline
                key={`${seg.id}-outline`}
                coordinates={coords}
                strokeColor="#0d3818"
                strokeWidth={7}
                lineCap="round"
                lineJoin="round"
                zIndex={1}
              />,
              <Polyline
                key={seg.id}
                coordinates={coords}
                strokeColor="#39d353"
                strokeWidth={4}
                lineCap="round"
                lineJoin="round"
                zIndex={2}
              />,
            ];
          })}

        {showRawTrail &&
          rawSessions.map((session, i) =>
            session.length > 1 ? (
              <Polyline
                key={`raw-${i}`}
                coordinates={session.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))}
                strokeColor="#3a8dff"
                strokeWidth={2}
                lineCap="round"
                lineJoin="round"
                zIndex={3}
              />
            ) : null
          )}
      </MapView>

      {!following && (
        <Pressable style={styles.recentreButton} onPress={recentre}>
          <Text style={styles.recentreText}>◎</Text>
        </Pressable>
      )}

      <View style={styles.topRightButtons}>
        <Pressable style={styles.smallButton} onPress={cycleMapType}>
          <Text style={styles.smallButtonText}>{MAP_TYPES[mapTypeIndex]}</Text>
        </Pressable>
      </View>

      <View style={styles.topLeftButtons}>
        <Pressable
          style={styles.smallButton}
          onPress={() => {
            setStatsOpen(false);
            setDevToolsOpen((v) => !v);
          }}
        >
          <Text style={styles.smallButtonText}>⚙ Dev</Text>
        </Pressable>
        <Pressable
          style={styles.smallButton}
          onPress={() => {
            setDevToolsOpen(false);
            setStatsOpen((v) => !v);
          }}
        >
          <Text style={styles.smallButtonText}>Stats</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.debugBox}>
        <Text style={styles.debugText}>{debug}</Text>
      </ScrollView>

      {devToolsOpen && (
        <View style={[styles.panel, styles.panelBelow]}>
          <Text style={styles.panelTitle}>Developer Tools</Text>
          <Pressable
            style={[styles.button, styles.buttonEdit, editMode && styles.buttonEditActive]}
            onPress={() => {
              if (!editMode) setFollowing(false);
              setEditMode((v) => !v);
              setDevToolsOpen(false);
            }}
            disabled={tracking}
          >
            <Text style={styles.buttonText}>{editMode ? 'Done editing' : 'Edit roads'}</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonTrail, showRawTrail && styles.buttonTrailActive]}
            onPress={() => setShowRawTrail((v) => !v)}
          >
            <Text style={styles.buttonText}>
              {showRawTrail ? 'Hide' : 'Show'} raw GPS trail ({rawPointTotal} pts)
            </Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonRematch]}
            onPress={rerunFullTrail}
            disabled={tracking || rawSessions.length === 0}
          >
            <Text style={styles.buttonText}>Re-run matching on full trail ({rawSessions.length} drives)</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonReset, resetConfirming && styles.buttonResetConfirm]}
            onPress={handleResetPress}
          >
            <Text style={styles.buttonText}>{resetConfirming ? 'Tap again to confirm' : 'Reset map'}</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonTrail]}
            onPress={refreshRoadData}
            disabled={tracking || refreshing}
          >
            <Text style={styles.buttonText}>
              {refreshing ? 'Refreshing…' : `Refresh road data${homeCounty ? ` (re-download ${homeCounty})` : ''}`}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonReset, clearTilesConfirming && styles.buttonResetConfirm]}
            onPress={handleClearTilesPress}
          >
            <Text style={styles.buttonText}>
              {clearTilesConfirming ? 'Tap again to confirm' : `Uninstall downloaded areas (${dynamicSegments.length} segments)`}
            </Text>
          </Pressable>
          <Text style={styles.statsNote}>home county: {homeCounty || 'none (skipped)'}</Text>
          <Text style={styles.statsNote}>tiles acquired: {knownTilesRef.current.size}</Text>
          <Pressable style={styles.closeLink} onPress={() => setDevToolsOpen(false)}>
            <Text style={styles.closeLinkText}>Close</Text>
          </Pressable>
        </View>
      )}

      {statsOpen && (
        <View style={[styles.panel, styles.panelBelow]}>
          <Text style={styles.panelTitle}>Stats</Text>
          <Text style={styles.statsLine}>
            Overall: {percentDriven.toFixed(2)}% ({(drivenLength / 1000).toFixed(2)} / {(totalLength / 1000).toFixed(1)} km)
          </Text>
          <Text style={[styles.statsLine, styles.statsDivider]}>
            Republic of Ireland: {nationalPercent.toFixed(4)}% ({(drivenLength / 1000).toFixed(2)} /{' '}
            {(nationalTotal / 1000).toFixed(0)} km)
          </Text>
          <Text style={styles.statsNote}>
            Per-county breakdown is temporarily unavailable — tiles don't carry a county tag yet, only a total across
            everywhere you've acquired data. Coming back once that's added.
          </Text>
          <Pressable style={styles.closeLink} onPress={() => setStatsOpen(false)}>
            <Text style={styles.closeLinkText}>Close</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.overlay}>
        {editMode ? (
          <>
            {editZoomedIn ? (
              <Text style={styles.status}>
                {editAction === 'exclude'
                  ? 'Tap a road to mark it private/gone (tap again to undo)'
                  : 'Tap a green road to un-mark it as driven'}
              </Text>
            ) : (
              <Text style={styles.note}>Zoom in closer to edit roads</Text>
            )}
            <View style={styles.buttonRow}>
              <Pressable
                style={[styles.smallButton, editAction === 'exclude' && styles.smallButtonActive]}
                onPress={() => setEditAction('exclude')}
              >
                <Text style={styles.smallButtonText}>Private / gone</Text>
              </Pressable>
              <Pressable
                style={[styles.smallButton, editAction === 'undrive' && styles.smallButtonActive]}
                onPress={() => setEditAction('undrive')}
              >
                <Text style={styles.smallButtonText}>Un-mark driven</Text>
              </Pressable>
            </View>
            <Text style={styles.status}>excluded: {excludedIds.size}</Text>
          </>
        ) : (
          <>
            <Text style={styles.status}>tracking: {tracking ? 'ON' : 'off'}</Text>
            <Text style={styles.status}>points: {pointCount}</Text>
            <Text style={styles.status}>{percentDriven.toFixed(2)}% of acquired roads driven</Text>
            {unmatchedPoints.length > 0 && (
              <Text style={styles.status}>unmatched (saved): {unmatchedPoints.length}</Text>
            )}
            {tracking && <Text style={styles.hint}>tap the map to add a point</Text>}
            {note ? <Text style={styles.note}>{note}</Text> : null}
          </>
        )}

        <View style={styles.buttonRow}>
          {!editMode && (
            <Pressable style={[styles.button, tracking && styles.buttonStop]} onPress={tracking ? stop : start}>
              <Text style={styles.buttonText}>{tracking ? 'Stop' : 'Start'} tracking</Text>
            </Pressable>
          )}
          {!tracking && !editMode && unmatchedPoints.length > 0 && (
            <Pressable style={[styles.button, styles.buttonRematch]} onPress={rematch}>
              <Text style={styles.buttonText}>Rematch ({unmatchedPoints.length})</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  onboardContainer: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', padding: 24 },
  onboardTitle: { color: '#fff', fontSize: 32, fontWeight: '700', marginBottom: 20 },
  onboardText: { color: '#aaa', fontSize: 14, textAlign: 'center', marginBottom: 12 },
  onboardError: { color: '#e0a030', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  countyList: { maxHeight: 320, alignSelf: 'stretch', marginTop: 8 },
  countyRow: { paddingVertical: 12, paddingHorizontal: 16, backgroundColor: '#1c1c1c', borderRadius: 8, marginBottom: 6 },
  countyRowText: { color: '#fff', fontSize: 15, textAlign: 'center' },
  skipLink: { marginTop: 16 },
  skipLinkText: { color: '#6aa9ff', fontSize: 14 },
  topRightButtons: { position: 'absolute', top: 50, right: 16 },
  recentreButton: {
    position: 'absolute',
    bottom: 260,
    right: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(17,17,17,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentreText: { color: '#6aa9ff', fontSize: 24, fontWeight: '700' },
  topLeftButtons: { position: 'absolute', top: 50, left: 16, flexDirection: 'row', gap: 8 },
  smallButton: {
    backgroundColor: 'rgba(17,17,17,0.85)',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  smallButtonActive: { backgroundColor: '#3a6fb0' },
  smallButtonText: { color: '#fff', fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  panel: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: 'rgba(17,17,17,0.95)',
    borderRadius: 12,
    padding: 16,
  },
  panelBelow: { top: 176 },
  panelTitle: { color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 10 },
  statsLine: { color: '#ccc', fontSize: 13, marginBottom: 4 },
  statsDivider: { marginTop: 6, color: '#39d353', fontWeight: '600' },
  statsNote: { color: '#777', fontSize: 11, marginTop: 6 },
  closeLink: { marginTop: 10, alignSelf: 'center' },
  closeLinkText: { color: '#6aa9ff', fontSize: 13 },
  debugBox: {
    position: 'absolute',
    top: 92,
    left: 16,
    right: 16,
    maxHeight: 80,
    backgroundColor: 'rgba(17,17,17,0.85)',
    borderRadius: 8,
    padding: 10,
  },
  debugText: { color: '#7fd67f', fontSize: 11, fontFamily: 'Courier' },
  overlay: {
    position: 'absolute',
    bottom: 40,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(17,17,17,0.85)',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  status: { color: '#aaa', fontSize: 13, marginBottom: 4, textAlign: 'center' },
  hint: { color: '#6aa9ff', fontSize: 12, marginTop: 2, textAlign: 'center' },
  note: { color: '#e0a030', fontSize: 12, marginTop: 4, textAlign: 'center' },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' },
  button: { backgroundColor: '#2a6f2a', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8, marginBottom: 8 },
  buttonStop: { backgroundColor: '#8a2a2a' },
  buttonEdit: { backgroundColor: '#2a4f8a' },
  buttonEditActive: { backgroundColor: '#8a6a2a' },
  buttonTrail: { backgroundColor: '#1f4a7a' },
  buttonTrailActive: { backgroundColor: '#3a6fb0' },
  buttonRematch: { backgroundColor: '#5a3a8a' },
  buttonReset: { backgroundColor: '#5a2a2a' },
  buttonResetConfirm: { backgroundColor: '#a03030' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center' },
});
