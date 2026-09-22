import { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

const LOCATION_TASK_NAME = 'tarmacked-background-location';

type Point = { latitude: number; longitude: number; timestamp: number };

// In-memory only for this v0.1 skeleton. Real persistence (so a drive
// survives an app restart) comes in the next version, once we know the
// build/sideload chain actually works end to end.
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

export default function App() {
  const [tracking, setTracking] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState('checking…');
  const [pointCount, setPointCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    (async () => {
      const fg = await Location.requestForegroundPermissionsAsync();
      const bg = await Location.requestBackgroundPermissionsAsync();
      setPermissionStatus(`foreground: ${fg.status} / background: ${bg.status}`);
    })();
  }, []);

  useEffect(() => {
    if (tracking) {
      pollRef.current = setInterval(() => setPointCount(recordedPoints.length), 1000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [tracking]);

  const start = async () => {
    recordedPoints = [];
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 5000,
      distanceInterval: 20,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'tarmacked is tracking',
        notificationBody: 'Recording this drive',
      },
    });
    setTracking(true);
  };

  const stop = async () => {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    setTracking(false);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>tarmacked</Text>
      <Text style={styles.status}>{permissionStatus}</Text>
      <Text style={styles.status}>tracking: {tracking ? 'ON' : 'off'}</Text>
      <Text style={styles.status}>points recorded: {pointCount}</Text>
      <Pressable style={[styles.button, tracking && styles.buttonStop]} onPress={tracking ? stop : start}>
        <Text style={styles.buttonText}>{tracking ? 'Stop' : 'Start'} tracking</Text>
      </Pressable>
      <ScrollView style={styles.log}>
        <Text style={styles.logText}>
          v0.1 skeleton — proving the cloud build, sideload and background GPS permission work.
          Map view, road snapping and county stats come next.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#fff', fontSize: 32, fontWeight: '700', marginBottom: 24 },
  status: { color: '#aaa', fontSize: 14, marginBottom: 4 },
  button: { backgroundColor: '#2a6f2a', paddingVertical: 14, paddingHorizontal: 32, borderRadius: 8, marginTop: 24 },
  buttonStop: { backgroundColor: '#8a2a2a' },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  log: { marginTop: 32, maxHeight: 100 },
  logText: { color: '#666', fontSize: 12, textAlign: 'center' },
});
