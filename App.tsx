import { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import MapView, { Polyline, PROVIDER_DEFAULT, MapPressEvent, MapType } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { findNearestSegment, totalLengthMeters, segmentLengthMeters, RoadSegment } from './src/roadMatcher';
import countyTotalsRaw from './assets/roads/county-totals.json';

const countyTotals = countyTotalsRaw as { county: string; totalMeters: number }[];

const DRIVEN_KEY = 'tarmacked:driven:local';
const EXCLUDED_KEY = 'tarmacked:excluded:local';
const UNMATCHED_KEY = 'tarmacked:unmatched:local';
const DYNAMIC_TILES_KEY = 'tarmacked:dynamicTiles';
const ONBOARDED_KEY = 'tarmacked:onboarded';
const HOME_COUNTY_KEY = 'tarmacked:homeCounty';

const LOCATION_TASK_NAME = 'tarmacked-background-location';

// Every road tile — anywhere, including "home" counties — is fetched live
// from here. Any file in a public GitHub repo is servable over plain
// HTTPS for free, so this needs no server of its own. Must match
// TILE_DEGREES and tileIdForPoint() in scripts/tile-county.js exactly.
const TILES_BASE_URL = 'https://raw.githubusercontent.com/0204Killian/tarmacked/main/tiles/';
const TILE_DEGREES = 0.05;

function tileIdForPoint(lat: number, lon: number): string {
  const latIdx = Math.floor(lat / TILE_DEGREES);
  const lonIdx = Math.floor(lon / TILE_DEGREES);
  return `t_${latIdx}_${lonIdx}`;
}

type Point = { latitude: number; longitude: number; timestamp: number };
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
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [resetConfirming, setResetConfirming] = useState(false);
  const [mapTypeIndex, setMapTypeIndex] = useState(0);
  const [region, setRegion] = useState(FALLBACK_REGION);
  const [pointCount, setPointCount] = useState(0);
  const [drivenIds, setDrivenIds] = useState<Set<string>>(new Set());
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [unmatchedPoints, setUnmatchedPoints] = useState<Point[]>([]);
  const [dynamicSegments, setDynamicSegments] = useState<RoadSegment[]>([]);
  const [note, setNote] = useState('');
  const [debug, setDebug] = useState('starting…');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const foregroundSub = useRef<Location.LocationSubscription | null>(null);
  const loadedRef = useRef(false);
  const processedIndexRef = useRef(0);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownTilesRef = useRef<Set<string>>(new Set());

  // Check onboarding state and load any previously saved data.
  useEffect(() => {
    (async () => {
      try {
        const [savedOnboarded, savedHomeCounty, savedDriven, savedExcluded, savedUnmatched, savedTiles] =
          await Promise.all([
            AsyncStorage.getItem(ONBOARDED_KEY),
            AsyncStorage.getItem(HOME_COUNTY_KEY),
            AsyncStorage.getItem(DRIVEN_KEY),
            AsyncStorage.getItem(EXCLUDED_KEY),
            AsyncStorage.getItem(UNMATCHED_KEY),
            AsyncStorage.getItem(DYNAMIC_TILES_KEY),
          ]);
        if (savedDriven) setDrivenIds(new Set(JSON.parse(savedDriven)));
        if (savedExcluded) setExcludedIds(new Set(JSON.parse(savedExcluded)));
        if (savedUnmatched) setUnmatchedPoints(JSON.parse(savedUnmatched));
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

  // Once we know onboarding is needed, fetch the list of counties available
  // to download (whatever's in the index — grows over time as more
  // counties get tiled).
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
        setRegion({
          latitude: current.coords.latitude,
          longitude: current.coords.longitude,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        });
        setDebug((d) => d + `\nposition: ${current.coords.latitude.toFixed(4)}, ${current.coords.longitude.toFixed(4)}`);
      } catch (e) {
        setDebug((d) => d + `\nposition: FAILED — ${(e as Error).message} (using fallback map region)`);
      }
    })();
  }, [onboarded]);

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
    } catch (e) {
      setOnboardingError(`Download failed: ${(e as Error).message}. Check your connection and try again.`);
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
    try {
      const res = await fetch(`${TILES_BASE_URL}${tileId}.json`);
      if (!res.ok) {
        knownTilesRef.current.add(tileId);
        return;
      }
      const data = await res.json();
      const newSegments: RoadSegment[] = data.segments || [];
      knownTilesRef.current.add(tileId);
      if (newSegments.length === 0) return;

      setDebug((d) => d + `\nacquired new tile: ${tileId} (${newSegments.length} segments)`);
      setDynamicSegments((prev) => [...prev, ...newSegments]);
      saveDynamicTiles([{ tileId, segments: newSegments }]).catch((e) => console.warn('failed to persist tile', e));
    } catch {
      // Network failure — don't mark as known, so a later attempt can retry.
    }
  };

  useEffect(() => {
    if (tracking) {
      pollRef.current = setInterval(() => {
        const eligible = dynamicSegments.filter((seg) => !excludedIds.has(seg.id));
        const newPoints = recordedPoints.slice(processedIndexRef.current);
        processedIndexRef.current = recordedPoints.length;

        if (newPoints.length > 0) {
          const newlyUnmatched: Point[] = [];
          setDrivenIds((prev) => {
            const next = new Set(prev);
            for (const p of newPoints) {
              const id = findNearestSegment(p, eligible);
              if (id) {
                next.add(id);
              } else {
                newlyUnmatched.push(p);
                tryFetchTile(tileIdForPoint(p.latitude, p.longitude));
              }
            }
            return next;
          });
          if (newlyUnmatched.length > 0) {
            setUnmatchedPoints((prev) => [...prev, ...newlyUnmatched]);
          }
        }

        setPointCount(recordedPoints.length);
      }, 2000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [tracking, excludedIds, dynamicSegments]);

  const start = async () => {
    recordedPoints = [];
    processedIndexRef.current = 0;
    setPointCount(0);
    setNote('');
    try {
      await withTimeout(
        Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 5000,
          distanceInterval: 20,
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
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 5000, distanceInterval: 20 },
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
    const eligible = dynamicSegments.filter((seg) => !excludedIds.has(seg.id));
    const newPoints = recordedPoints.slice(processedIndexRef.current);
    processedIndexRef.current = recordedPoints.length;
    if (newPoints.length > 0) {
      const newlyUnmatched: Point[] = [];
      setDrivenIds((prev) => {
        const next = new Set(prev);
        for (const p of newPoints) {
          const id = findNearestSegment(p, eligible);
          if (id) {
            next.add(id);
          } else {
            newlyUnmatched.push(p);
            tryFetchTile(tileIdForPoint(p.latitude, p.longitude));
          }
        }
        return next;
      });
      if (newlyUnmatched.length > 0) {
        setUnmatchedPoints((prev) => [...prev, ...newlyUnmatched]);
      }
    }
    setTracking(false);
  };

  const onMapPress = (e: MapPressEvent) => {
    if (!tracking || editMode) return;
    const { latitude, longitude } = e.nativeEvent.coordinate;
    recordedPoints.push({ latitude, longitude, timestamp: Date.now() });
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

    const eligible = dynamicSegments.filter((seg) => !excludedIds.has(seg.id));
    const stillUnmatched: Point[] = [];
    let recovered = 0;
    setDrivenIds((prevDriven) => {
      const next = new Set(prevDriven);
      for (const p of unmatchedPoints) {
        const id = findNearestSegment(p, eligible);
        if (id) {
          next.add(id);
          recovered++;
        } else {
          stillUnmatched.push(p);
        }
      }
      return next;
    });
    setUnmatchedPoints(stillUnmatched);
    setNote(`Rematch: recovered ${recovered} of ${unmatchedPoints.length} saved points`);
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
    setResetConfirming(false);
    setDevToolsOpen(false);
  };

  const segmentsById = new Map(dynamicSegments.map((seg) => [seg.id, seg]));
  const eligibleSegments = dynamicSegments.filter((seg) => !excludedIds.has(seg.id));
  const totalLength = totalLengthMeters(eligibleSegments);
  const drivenLength = eligibleSegments
    .filter((seg) => drivenIds.has(seg.id))
    .reduce((sum, seg) => sum + segmentLengthMeters(seg), 0);
  const percentDriven = totalLength > 0 ? (drivenLength / totalLength) * 100 : 0;

  const otherCountiesTotal = countyTotals.reduce((sum, c) => sum + c.totalMeters, 0);
  const nationalTotal = totalLength + otherCountiesTotal;
  const nationalPercent = nationalTotal > 0 ? (drivenLength / nationalTotal) * 100 : 0;

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
        style={styles.map}
        provider={PROVIDER_DEFAULT}
        mapType={MAP_TYPES[mapTypeIndex]}
        initialRegion={region}
        showsUserLocation
        onPress={onMapPress}
      >
        {editMode &&
          dynamicSegments.map((seg) => {
            const isExcluded = excludedIds.has(seg.id);
            return (
              <Polyline
                key={seg.id}
                coordinates={seg.coords.map(([lat, lon]) => ({ latitude: lat, longitude: lon }))}
                strokeColor={isExcluded ? '#a03030' : '#555'}
                strokeWidth={isExcluded ? 4 : 2}
                lineDashPattern={isExcluded ? [6, 4] : undefined}
                tappable
                onPress={() => toggleExcluded(seg.id)}
              />
            );
          })}

        {!editMode &&
          Array.from(drivenIds).map((id) => {
            if (excludedIds.has(id)) return null;
            const seg = segmentsById.get(id);
            if (!seg) return null;
            return (
              <Polyline
                key={id}
                coordinates={seg.coords.map(([lat, lon]) => ({ latitude: lat, longitude: lon }))}
                strokeColor="#39d353"
                strokeWidth={5}
              />
            );
          })}
      </MapView>

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
              setEditMode((v) => !v);
              setDevToolsOpen(false);
            }}
            disabled={tracking}
          >
            <Text style={styles.buttonText}>{editMode ? 'Done editing' : 'Edit roads'}</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonReset, resetConfirming && styles.buttonResetConfirm]}
            onPress={handleResetPress}
          >
            <Text style={styles.buttonText}>{resetConfirming ? 'Tap again to confirm' : 'Reset map'}</Text>
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
            <Text style={styles.status}>Edit mode — tap a road to mark it private/gone</Text>
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
  topLeftButtons: { position: 'absolute', top: 50, left: 16, flexDirection: 'row', gap: 8 },
  smallButton: {
    backgroundColor: 'rgba(17,17,17,0.85)',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
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
  buttonRematch: { backgroundColor: '#5a3a8a' },
  buttonReset: { backgroundColor: '#5a2a2a' },
  buttonResetConfirm: { backgroundColor: '#a03030' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center' },
});
