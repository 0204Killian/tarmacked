import { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView } from 'react-native';
import MapView, { Polyline, PROVIDER_DEFAULT, MapPressEvent, MapType } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { findNearestSegment, totalLengthMeters, segmentLengthMeters, RoadSegment, RoadFile } from './src/roadMatcher';
import kilkennyFileRaw from './assets/roads/kilkenny.json';
import laoisFileRaw from './assets/roads/laois.json';
import countyTotalsRaw from './assets/roads/county-totals.json';

const roadFiles = [kilkennyFileRaw as RoadFile, laoisFileRaw as RoadFile];
const areaLabel = roadFiles.map((f) => f.county).join(' + ');
const bundledData: RoadSegment[] = roadFiles.flatMap((f) => f.segments);

const countyTotals = countyTotalsRaw as { county: string; totalMeters: number }[];

const DRIVEN_KEY = 'tarmacked:driven:local';
const EXCLUDED_KEY = 'tarmacked:excluded:local';
const UNMATCHED_KEY = 'tarmacked:unmatched:local';
const DYNAMIC_TILES_KEY = 'tarmacked:dynamicTiles';

const LOCATION_TASK_NAME = 'tarmacked-background-location';

// Tiles for areas outside the bundled counties are fetched live from here —
// any file in a public GitHub repo is servable over plain HTTPS for free,
// so this needs no server of its own. Must match TILE_DEGREES and
// tileIdForPoint() in scripts/tile-county.js exactly.
const TILES_BASE_URL = 'https://raw.githubusercontent.com/0204Killian/tarmacked/main/tiles/';
const TILE_DEGREES = 0.05;

function tileIdForPoint(lat: number, lon: number): string {
  const latIdx = Math.floor(lat / TILE_DEGREES);
  const lonIdx = Math.floor(lon / TILE_DEGREES);
  return `t_${latIdx}_${lonIdx}`;
}

type Point = { latitude: number; longitude: number; timestamp: number };

// In-memory only — this is the current session's raw stream. Anything
// that doesn't match a road gets copied out into the persisted
// "unmatched" store before this array resets on the next Start.
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

export default function App() {
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
  // Tiles already fetched successfully, or confirmed not to exist (404) —
  // avoids hammering the same tile repeatedly. Network failures are NOT
  // added here, so a signal blip can be retried later.
  const knownTilesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const [savedDriven, savedExcluded, savedUnmatched, savedTiles] = await Promise.all([
          AsyncStorage.getItem(DRIVEN_KEY),
          AsyncStorage.getItem(EXCLUDED_KEY),
          AsyncStorage.getItem(UNMATCHED_KEY),
          AsyncStorage.getItem(DYNAMIC_TILES_KEY),
        ]);
        if (savedDriven) setDrivenIds(new Set(JSON.parse(savedDriven)));
        if (savedExcluded) setExcludedIds(new Set(JSON.parse(savedExcluded)));
        if (savedUnmatched) setUnmatchedPoints(JSON.parse(savedUnmatched));
        if (savedTiles) {
          const parsed = JSON.parse(savedTiles) as { tileId: string; segments: RoadSegment[] }[];
          setDynamicSegments(parsed.flatMap((t) => t.segments));
          parsed.forEach((t) => knownTilesRef.current.add(t.tileId));
        }
      } catch (e) {
        console.warn('failed to load saved roads', e);
      } finally {
        loadedRef.current = true;
      }
    })();
  }, []);

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

      setDebug((d) => d + `\nroads loaded: ${bundledData.length} chunks (${areaLabel})`);
    })();
  }, []);

  // Tries fetching one tile from GitHub. Succeeds silently, fails
  // silently (no signal, or that area isn't tiled yet) — either way the
  // point that triggered it just stays in the unmatched backlog.
  const tryFetchTile = async (tileId: string) => {
    if (knownTilesRef.current.has(tileId)) return;
    try {
      const res = await fetch(`${TILES_BASE_URL}${tileId}.json`);
      if (!res.ok) {
        knownTilesRef.current.add(tileId); // confirmed not available — don't keep retrying
        return;
      }
      const data = await res.json();
      const newSegments: RoadSegment[] = data.segments || [];
      knownTilesRef.current.add(tileId);
      if (newSegments.length === 0) return;

      setDebug((d) => d + `\nacquired new tile: ${tileId} (${newSegments.length} segments)`);
      setDynamicSegments((prev) => {
        const merged = [...prev, ...newSegments];
        AsyncStorage.getItem(DYNAMIC_TILES_KEY)
          .then((raw) => {
            const existing = raw ? JSON.parse(raw) : [];
            const withoutThis = existing.filter((t: any) => t.tileId !== tileId);
            const updated = [...withoutThis, { tileId, segments: newSegments }];
            return AsyncStorage.setItem(DYNAMIC_TILES_KEY, JSON.stringify(updated));
          })
          .catch((e) => console.warn('failed to persist tile', e));
        return merged;
      });
    } catch {
      // Network failure (e.g. no signal) — don't mark as known, so a
      // later attempt (next poll, or Rematch) can retry once signal returns.
    }
  };

  useEffect(() => {
    if (tracking) {
      pollRef.current = setInterval(() => {
        const eligible = [...bundledData, ...dynamicSegments].filter((seg) => !excludedIds.has(seg.id));
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
    const eligible = [...bundledData, ...dynamicSegments].filter((seg) => !excludedIds.has(seg.id));
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
    // Also try acquiring tiles for every still-unmatched point — useful if
    // you're back in signal since they were first recorded.
    unmatchedPoints.forEach((p) => tryFetchTile(tileIdForPoint(p.latitude, p.longitude)));

    const eligible = [...bundledData, ...dynamicSegments].filter((seg) => !excludedIds.has(seg.id));
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

  const allKnownSegments = [...bundledData, ...dynamicSegments];
  const segmentsById = new Map(allKnownSegments.map((seg) => [seg.id, seg]));
  const eligibleSegments = allKnownSegments.filter((seg) => !excludedIds.has(seg.id));
  const totalLength = totalLengthMeters(eligibleSegments);
  const drivenLength = eligibleSegments
    .filter((seg) => drivenIds.has(seg.id))
    .reduce((sum, seg) => sum + segmentLengthMeters(seg), 0);
  const percentDriven = totalLength > 0 ? (drivenLength / totalLength) * 100 : 0;

  const countyStats = roadFiles.map((f) => {
    const eligible = f.segments.filter((s) => !excludedIds.has(s.id));
    const total = totalLengthMeters(eligible);
    const driven = eligible.filter((s) => drivenIds.has(s.id)).reduce((sum, s) => sum + segmentLengthMeters(s), 0);
    return { county: f.county, total, driven, percent: total > 0 ? (driven / total) * 100 : 0 };
  });

  const otherCountiesTotal = countyTotals.reduce((sum, c) => sum + c.totalMeters, 0);
  const nationalTotal = totalLength + otherCountiesTotal;
  const nationalPercent = nationalTotal > 0 ? (drivenLength / nationalTotal) * 100 : 0;

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
          allKnownSegments.map((seg) => {
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
          <Text style={styles.statsNote}>dynamic tiles acquired: {knownTilesRef.current.size}</Text>
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
          {countyStats.map((c) => (
            <Text key={c.county} style={styles.statsLine}>
              {c.county}: {c.percent.toFixed(2)}% ({(c.driven / 1000).toFixed(2)} / {(c.total / 1000).toFixed(1)} km)
            </Text>
          ))}
          <Text style={[styles.statsLine, styles.statsDivider]}>
            Republic of Ireland: {nationalPercent.toFixed(4)}% ({(drivenLength / 1000).toFixed(2)} /{' '}
            {(nationalTotal / 1000).toFixed(0)} km)
          </Text>
          <Text style={styles.statsNote}>
            National figure includes {areaLabel} plus dynamically-acquired areas plus total-length-only estimates for
            the rest of the Republic.
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
            <Text style={styles.status}>
              {percentDriven.toFixed(2)}% of {areaLabel}
              {dynamicSegments.length > 0 ? ' + acquired areas' : ''} driven
            </Text>
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
