// The card shown after a drive (v0.17): new road, distance, time, how much
// of the county it added, and a little map. "Share" saves the card itself
// as an image (react-native-view-shot) for Messages, Instagram and so on.
// The map has no place names or background, only the lines of the roads.

import { distShort } from './units';
import React, { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { Recap, fitPaths, formatGain } from './recap';

const MAP_W = 300;
const MAP_H = 190;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const len = (m: number) => distShort(m, 100);
const duration = (ms: number) => {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
};
const shortCounty = (name: string) => name.replace(/^County /, '');

// The tarmacked T, as on the app icon.
function Logo({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <Rect x={0} y={0} width={1024} height={1024} rx={230} fill="#0f1311" />
      <Path d="M250 344L774 344" stroke="#26302b" strokeWidth={128} strokeLinecap="round" fill="none" />
      <Path d="M512 772L512 494Q512 344 362 344L250 344" stroke="#39d353" strokeWidth={128} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

export function RecapCard({ recap, onClose }: { recap: Recap; onClose: () => void }) {
  const cardRef = useRef<any>(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');
  const [oldPaths, newPaths] = useMemo(() => fitPaths([recap.oldShapes, recap.newShapes], MAP_W, MAP_H), [recap]);
  const d = new Date(recap.startedAt);
  const when = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const anyNew = recap.newM >= 50;

  const share = async () => {
    if (sharing) return;
    setSharing(true);
    setError('');
    try {
      const uri = await captureRef(cardRef, { format: 'png', quality: 1, result: 'tmpfile' });
      await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Share your drive' });
    } catch (e) {
      setError(`Couldn't share: ${(e as Error).message}`);
    } finally {
      setSharing(false);
    }
  };

  return (
    <View style={s.backdrop}>
      <View ref={cardRef} collapsable={false} style={s.card}>
        <View style={s.top}>
          <View style={s.brand}>
            <Logo size={26} />
            <Text style={s.brandText}>tarmacked</Text>
          </View>
          <Text style={s.when}>{when}</Text>
        </View>
        <View style={s.map}>
          <Svg width="100%" height="100%" viewBox={`0 0 ${MAP_W} ${MAP_H}`}>
            {oldPaths.map((p, i) => (
              <Path key={`o${i}`} d={p} stroke="#3d4a43" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            ))}
            {newPaths.map((p, i) => (
              <Path key={`n${i}`} d={p} stroke="#39d353" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            ))}
          </Svg>
        </View>
        {anyNew ? (
          <>
            <Text style={s.big}>+{len(recap.newM)}</Text>
            <Text style={s.bigSub}>of new road</Text>
          </>
        ) : (
          <>
            <Text style={[s.big, { color: '#fff' }]}>{len(recap.distanceM)}</Text>
            <Text style={s.bigSub}>all on roads you've driven before</Text>
          </>
        )}
        <View style={s.stats}>
          <View style={s.stat}>
            <Text style={s.statValue}>{len(recap.distanceM)}</Text>
            <Text style={s.statLabel}>driven</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statValue}>{duration(recap.endedAt - recap.startedAt)}</Text>
            <Text style={s.statLabel}>on the road</Text>
          </View>
          {anyNew && recap.county && recap.countyGain !== null ? (
            <View style={s.stat}>
              <Text style={s.statValue}>{formatGain(recap.countyGain)}</Text>
              <Text style={s.statLabel}>of {shortCounty(recap.county)}</Text>
            </View>
          ) : null}
        </View>
        <Text style={s.footer}>Every road counts · tarmacked.com</Text>
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View style={s.buttons}>
        <Pressable style={[s.button, s.buttonGreen]} onPress={share} disabled={sharing}>
          <Text style={s.buttonText}>{sharing ? 'Getting it ready…' : 'Share'}</Text>
        </Pressable>
        <Pressable style={[s.button, s.buttonGrey]} onPress={onClose}>
          <Text style={s.buttonText}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 50,
  },
  card: { width: '100%', maxWidth: 380, backgroundColor: '#161c19', borderRadius: 22, padding: 18 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  when: { color: '#8a948f', fontSize: 13 },
  map: { width: '100%', aspectRatio: MAP_W / MAP_H, marginTop: 14, borderRadius: 14, backgroundColor: '#0f1311', overflow: 'hidden' },
  big: { color: '#39d353', fontSize: 40, fontWeight: '800', marginTop: 16 },
  bigSub: { color: '#b8c2bd', fontSize: 15, marginTop: -2 },
  stats: { flexDirection: 'row', marginTop: 16, gap: 10 },
  stat: { flex: 1, backgroundColor: '#1f2723', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 10 },
  statValue: { color: '#fff', fontSize: 16, fontWeight: '700' },
  statLabel: { color: '#8a948f', fontSize: 12, marginTop: 2 },
  footer: { color: '#5e6a64', fontSize: 12, marginTop: 16, textAlign: 'center' },
  error: { color: '#ff6b6b', marginTop: 10 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 14, width: '100%', maxWidth: 380 },
  button: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  buttonGreen: { backgroundColor: '#2f9e44' },
  buttonGrey: { backgroundColor: '#333' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
