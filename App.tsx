import { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView } from 'react-native';
import MapView, { Polyline, PROVIDER_DEFAULT, MapPressEvent, MapType } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { findNearestSegment, totalLengthMeters, segmentLengthMeters, RoadSegment, RoadFile } from './src/roadMatcher';
import kilkennyFileRaw from './assets/roads/kilkenny.json';
import laoisFileRaw from './assets/roads/laois.json';

const roadFiles = [kilkennyFileRaw as RoadFile, laoisFileRaw as RoadFile];
const areaLabel = roadFiles.map((f) => f.county).join(' + ');
const roadData: RoadSegment[] = roadFiles.flatMap((f) => f.segments);
const roadsById = new Map(roadData.map((seg) => [seg.id, seg]));

const DRIVEN_KEY = 'tarmacked:driven:local'; // now covers Kilkenny + Laois together
const EXCLUDED_KEY = 'tarmacked:excluded:local';

const LOCATION_TASK_NAME = 'tarmacked-background-location';

type Point = { latitude: number; longitude: number; timestamp: number };

// In-memory only — persistence is for drivenIds/excludedIds (the results),
// not the raw point stream itself.
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
  const [mapTypeIndex, setMapTypeIndex] = useState(0);
  const [region, setRegion] = useState(FALLBACK_REGION);
  const [pointCount, setPointCount] = useState(0);
  const [drivenIds, setDrivenIds] = useState<Set<string>>(new Set());
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [debug, setDebug] = useState('starting…');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const foregroundSub = useRef<Location.LocationSubscription | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const [savedDriven, savedExcluded] = await Promise.all([
          AsyncStorage.getItem(DRIVEN_KEY),
          AsyncStorage.getItem(EXCLUDED_KEY),
        ]);
        if (savedDriven) setDrivenIds(new Set(JSON.parse(savedDriven)));
        if (savedExcluded) setExcludedIds(new Set(JSON.parse(savedExcluded)));
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

      setDebug((d) => d + `\nroads loaded: ${roadData.length} chunks (${areaLabel})`);
    })();
  }, []);

  useEffect(() => {
    if (tracking) {
      pollRef.current = setInterval(() => {
        const eligible = roadData.filter((seg) => !excludedIds.has(seg.id));
        setDrivenIds((prev) => {
          const next = new Set(prev);
          for (const p of recordedPoints) {
            const id = findNearestSegment(p, eligible);
            if (id) next.add(id);
          }
          return next;
        });
        setPointCount(recordedPoints.length);
      }, 2000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [tracking, excludedIds]);

  const start = async () => {
    recordedPoints = [];
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

  const eligibleSegments = roadData.filter((seg) => !excludedIds.has(seg.id));
  const totalLength = totalLengthMeters(eligibleSegments);
  const drivenLength = eligibleSegments
    .filter((seg) => drivenIds.has(seg.id))
    .reduce((sum, seg) => sum + segmentLengthMeters(seg), 0);
  const percentDriven = totalLength > 0 ? (drivenLength / totalLength) * 100 : 0;

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
          roadData.map((seg) => {
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
            const seg = roadsById.get(id);
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

      <Pressable style={styles.mapTypeButton} onPress={cycleMapType}>
        <Text style={styles.mapTypeButtonText}>{MAP_TYPES[mapTypeIndex]}</Text>
      </Pressable>

      <ScrollView style={styles.debugBox}>
        <Text style={styles.debugText}>{debug}</Text>
      </ScrollView>

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
              {percentDriven.toFixed(2)}% of {areaLabel} driven ({(drivenLength / 1000).toFixed(2)} /{' '}
              {(totalLength / 1000).toFixed(1)} km)
            </Text>
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
          {!tracking && (
            <Pressable
              style={[styles.button, styles.buttonEdit, editMode && styles.buttonEditActive]}
              onPress={() => setEditMode((v) => !v)}
            >
              <Text style={styles.buttonText}>{editMode ? 'Done editing' : 'Edit roads'}</Text>
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
  mapTypeButton: {
    position: 'absolute',
    top: 50,
    right: 16,
    backgroundColor: 'rgba(17,17,17,0.85)',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  mapTypeButtonText: { color: '#fff', fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  debugBox: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 100,
    maxHeight: 100,
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
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  button: { backgroundColor: '#2a6f2a', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8 },
  buttonStop: { backgroundColor: '#8a2a2a' },
  buttonEdit: { backgroundColor: '#2a4f8a' },
  buttonEditActive: { backgroundColor: '#8a6a2a' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
