// tarmacked Premium (v0.21): what it adds, and the one-time unlock. The
// core app (recording, the map, counties, badges, the sat-nav, backups)
// is free and stays free.
import { StyleSheet, Text, View, Pressable, ActivityIndicator } from 'react-native';

export const PREMIUM_ID = 'com.tarmacked.app.premium';

const FEATURES: { title: string; text: string }[] = [
  { title: 'Scenic drives', text: 'The Wild Atlantic Way, the Sally Gap, the Ring of Kerry and more, with your progress on each. New ones keep coming.' },
  { title: 'Heatmap', text: 'Every road coloured by how often you drive it.' },
  { title: 'Your roads and records', text: 'Your most driven roads, longest drives and biggest days for new road.' },
];

export function Paywall(props: {
  premium: boolean;
  price: string | null; // null while loading, '' if the store can't be reached
  busy: boolean;
  message: string;
  onBuy: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  return (
    <View style={s.backdrop}>
      <View style={s.card}>
        <Text style={s.title}>tarmacked Premium</Text>
        <Text style={s.lead}>{props.premium ? "It's unlocked on this phone. Thank you for supporting tarmacked." : 'One payment, yours for good. It helps keep tarmacked free for everyone else.'}</Text>
        {FEATURES.map((f) => (
          <View key={f.title} style={s.feature}>
            <Text style={s.featureTitle}>{f.title}</Text>
            <Text style={s.featureText}>{f.text}</Text>
          </View>
        ))}
        <Text style={s.free}>Recording, your map, county stats and badges, the sat-nav and backups are free, and stay free.</Text>
        {props.message ? <Text style={s.message}>{props.message}</Text> : null}
        {!props.premium && (
          <Pressable style={[s.buy, (props.busy || !props.price) && { opacity: 0.6 }]} onPress={props.onBuy} disabled={props.busy || !props.price}>
            {props.busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={s.buyText}>{props.price === null ? 'Loading…' : props.price ? `Unlock for ${props.price}` : 'Not available right now'}</Text>
            )}
          </Pressable>
        )}
        <View style={s.links}>
          {!props.premium && (
            <Pressable onPress={props.onRestore} disabled={props.busy} hitSlop={8}>
              <Text style={s.link}>Restore purchase</Text>
            </Pressable>
          )}
          <Pressable onPress={props.onClose} hitSlop={8}>
            <Text style={s.link}>{props.premium ? 'Done' : 'Not now'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** Shown in place of a Premium feature: what it is, and the way in. */
export function LockedCard(props: { title: string; text: string; onUnlock: () => void }) {
  return (
    <View style={s.locked}>
      <Text style={s.lockedTitle}>{props.title}</Text>
      <Text style={s.featureText}>{props.text}</Text>
      <Pressable style={s.lockedButton} onPress={props.onUnlock}>
        <Text style={s.lockedButtonText}>Premium</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#161c19', borderRadius: 18, padding: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: '#26302b' },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 6 },
  lead: { color: '#cfd8d2', fontSize: 15, lineHeight: 21, marginBottom: 12 },
  feature: { marginBottom: 10 },
  featureTitle: { color: '#39d353', fontSize: 15, fontWeight: '700' },
  featureText: { color: '#aab4ad', fontSize: 13, lineHeight: 18, marginTop: 2 },
  free: { color: '#8a8a8a', fontSize: 12, lineHeight: 17, marginTop: 4 },
  message: { color: '#e8c070', fontSize: 13, marginTop: 10 },
  buy: { backgroundColor: '#2f6f3a', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 14 },
  buyText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  links: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  link: { color: '#6aa9ff', fontSize: 14 },
  locked: { backgroundColor: '#1a201d', borderRadius: 12, padding: 14, marginVertical: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: '#26302b' },
  lockedTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  lockedButton: { alignSelf: 'flex-start', backgroundColor: '#2f6f3a', borderRadius: 14, paddingVertical: 6, paddingHorizontal: 14, marginTop: 10 },
  lockedButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
