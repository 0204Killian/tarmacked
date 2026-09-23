import { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView } from 'react-native';
import MapView, { Polyline, PROVIDER_DEFAULT, MapPressEvent } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

const LOCATION_TASK_NAME = 'tarmacked-background-location';

type Point = { latitude: number; longitude: number; timestamp: number };

// In-memory only for now — real persistence comes once the core flow is
// confirmed solid on the phone.
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

// Nothing on the native side is allowed to hang the UI forever — if a call
// doesn't resolve within this window, we treat it as failed and move on,
// so the app always ends up in a known state instead of stuck on "checking…".
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
  const [region, setRegion] = useState(FALLBACK_REGION);
  const [trail, setTrail] = useState<Point[]>([]);
  const [note, setNote] = useState('');
  const [debug, setDebug] = useState('starting…');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const foregroundSub = useRef<Location.LocationSubscription | null>(null);

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
    })();
  }, []);

  useEffect(() => {
    if (tracking) {
      pollRef.current = setInterval(() => setTrail([...recordedPoints]), 2000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [tracking]);

  const start = async () => {
    recordedPoints = [];
    setTrail([]);
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
    if (!tracking) return;
    const { latitude, longitude } = e.nativeEvent.coordinate;
    recordedPoints.push({ latitude, longitude, timestamp: Date.now() });
    setTrail([...recordedPoints]);
  };

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        provider={PROVIDER_DEFAULT}
        initialRegion={region}
        showsUserLocation
        onPress={onMapPress}
      >
        {trail.length > 1 && <Polyline coordinates={trail} strokeColor="#39d353" strokeWidth={4} />}
      </MapView>

      <ScrollView style={styles.debugBox}>
        <Text style={styles.debugText}>{debug}</Text>
      </ScrollView>

      <View style={styles.overlay}>
        <Text style={styles.status}>tracking: {tracking ? 'ON' : 'off'}</Text>
        <Text style={styles.status}>points: {trail.length}</Text>
        {tracking && <Text style={styles.hint}>tap the map to add a point</Text>}
        {note ? <Text style={styles.note}>{note}</Text> : null}
        <Pressable style={[styles.button, tracking && styles.buttonStop]} onPress={tracking ? stop : start}>
          <Text style={styles.buttonText}>{tracking ? 'Stop' : 'Start'} tracking</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  debugBox: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    maxHeight: 140,
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
  status: { color: '#aaa', fontSize: 13, marginBottom: 4 },
  hint: { color: '#6aa9ff', fontSize: 12, marginTop: 2 },
  note: { color: '#e0a030', fontSize: 12, marginTop: 4, textAlign: 'center' },
  button: { backgroundColor: '#2a6f2a', paddingVertical: 12, paddingHorizontal: 28, borderRadius: 8, marginTop: 8 },
  buttonStop: { backgroundColor: '#8a2a2a' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
