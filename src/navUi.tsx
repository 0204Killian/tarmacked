// Screens for the sat-nav and the Spotify bar (v0.16). Presentational only:
// App.tsx owns the state and passes it in.

import { StyleSheet, Text, View, Pressable, TextInput, ScrollView, Image, ActivityIndicator } from 'react-native';
import type { NavRoute, NavUpdate, NewRoad } from './nav';
import { shortDistance } from './nav';
import type { Place } from '../modules/nav-kit';
import type { SpotifyState } from '../modules/spotify-remote';

const km = (m: number) => (m >= 10_000 ? (m / 1000).toFixed(0) : (m / 1000).toFixed(1));
export function minutes(s: number) {
  const m = Math.max(1, Math.round(s / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// --- search ---

export function SearchPanel(props: {
  query: string;
  onQuery: (q: string) => void;
  results: Place[];
  searching: boolean;
  onPick: (p: Place) => void;
  onClose: () => void;
}) {
  return (
    <View style={s.searchPanel}>
      <View style={s.searchRow}>
        <TextInput
          style={s.searchInput}
          value={props.query}
          onChangeText={props.onQuery}
          placeholder="Search a place or address"
          placeholderTextColor="#6f7b74"
          autoFocus
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        <Pressable style={s.closeButton} onPress={props.onClose}>
          <Text style={s.closeText}>Cancel</Text>
        </Pressable>
      </View>
      {props.searching && <ActivityIndicator color="#39d353" style={{ marginTop: 10 }} />}
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 320 }}>
        {props.results.map((p, i) => (
          <Pressable key={`${p.lat},${p.lon},${i}`} style={s.resultRow} onPress={() => props.onPick(p)}>
            <Text style={s.resultName} numberOfLines={1}>
              {p.name}
            </Text>
            {!!p.subtitle && (
              <Text style={s.resultSub} numberOfLines={1}>
                {p.subtitle}
              </Text>
            )}
          </Pressable>
        ))}
        {!props.searching && props.query.trim().length > 2 && props.results.length === 0 && <Text style={s.hint}>Nothing found.</Text>}
        {props.query.trim().length === 0 && <Text style={s.hint}>Or close this and long-press anywhere on the map.</Text>}
      </ScrollView>
    </View>
  );
}

// --- choosing a route ---

export type RouteOption = { route: NavRoute; newRoad: NewRoad | null };

export function RouteChooser(props: {
  destName: string;
  options: RouteOption[];
  chosen: number;
  loading: boolean;
  error: string;
  onChoose: (i: number) => void;
  onGo: () => void;
  onCancel: () => void;
}) {
  const fastest = props.options.reduce((b, o, i) => (o.route.duration < props.options[b].route.duration ? i : b), 0);
  // "Most new road": only worth saying when it really is more (100 m+).
  let mostNew = -1;
  props.options.forEach((o, i) => {
    if (!o.newRoad) return;
    const best = mostNew >= 0 ? props.options[mostNew].newRoad!.newM : -1;
    if (o.newRoad.newM > best) mostNew = i;
  });
  const othersBest = Math.max(0, ...props.options.filter((_, i) => i !== mostNew).map((o) => o.newRoad?.newM ?? 0));
  if (mostNew >= 0 && props.options[mostNew].newRoad!.newM - othersBest < 100) mostNew = -1;
  return (
    <View style={s.chooser}>
      <Text style={s.chooserTitle} numberOfLines={1}>
        To {props.destName}
      </Text>
      {props.loading && <ActivityIndicator color="#39d353" style={{ marginVertical: 12 }} />}
      {!!props.error && <Text style={s.error}>{props.error}</Text>}
      {props.options.map((o, i) => (
        <Pressable key={i} style={[s.routeRow, i === props.chosen && s.routeRowChosen]} onPress={() => props.onChoose(i)}>
          <View style={{ flex: 1 }}>
            <Text style={s.routeMain}>
              {minutes(o.route.duration)} <Text style={s.routeDim}>· {km(o.route.distance)} km</Text>
            </Text>
            <Text style={s.routeSub} numberOfLines={1}>
              {o.route.name ? `via ${o.route.name}` : ''}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.routeNew}>{o.newRoad ? `${km(o.newRoad.newM)} km new` : '…'}</Text>
            {i === fastest && props.options.length > 1 && <Text style={s.tag}>Fastest</Text>}
            {i === mostNew && <Text style={[s.tag, s.tagNew]}>Most new road</Text>}
          </View>
        </Pressable>
      ))}
      <View style={s.chooserButtons}>
        <Pressable style={[s.bigButton, s.cancel]} onPress={props.onCancel}>
          <Text style={s.bigButtonText}>Cancel</Text>
        </Pressable>
        <Pressable style={[s.bigButton, s.go, !props.options.length && { opacity: 0.4 }]} onPress={props.onGo} disabled={!props.options.length}>
          <Text style={s.bigButtonText}>Go</Text>
        </Pressable>
      </View>
    </View>
  );
}

// --- driving ---

export function NavBanner(props: { update: NavUpdate | null; rerouting: boolean }) {
  const u = props.update;
  return (
    <View style={s.banner}>
      {props.rerouting ? (
        <Text style={s.bannerMain}>Finding a new route…</Text>
      ) : u && u.next ? (
        <>
          <Text style={s.bannerDist}>{shortDistance(u.toNext)}</Text>
          <Text style={s.bannerMain} numberOfLines={2}>
            {u.next.instruction}
          </Text>
        </>
      ) : (
        <Text style={s.bannerMain}>Waiting for GPS…</Text>
      )}
    </View>
  );
}

export function NavFooter(props: { update: NavUpdate | null; muted: boolean; onMute: () => void; onEnd: () => void; newM: number }) {
  const u = props.update;
  return (
    <View style={s.footer}>
      <View style={{ flex: 1 }}>
        {u ? (
          <>
            <Text style={s.footerMain}>
              {clock(Date.now() + u.remainingS * 1000)} <Text style={s.footerDim}>arrival</Text>
            </Text>
            <Text style={s.footerDim}>
              {minutes(u.remainingS)} · {km(u.remainingM)} km{props.newM > 0 ? ` · +${km(props.newM)} km new` : ''}
            </Text>
          </>
        ) : (
          <Text style={s.footerDim}>Starting…</Text>
        )}
      </View>
      <Pressable style={s.roundButton} onPress={props.onMute}>
        <Text style={s.roundText}>{props.muted ? '🔇' : '🔊'}</Text>
      </Pressable>
      <Pressable style={[s.bigButton, s.end]} onPress={props.onEnd}>
        <Text style={s.bigButtonText}>End</Text>
      </Pressable>
    </View>
  );
}

// --- Spotify ---

export function SpotifyBar(props: {
  state: SpotifyState;
  onConnect: () => void;
  onPrevious: () => void;
  onToggle: () => void;
  onNext: () => void;
}) {
  const st = props.state;
  if (!st.connected) {
    return (
      <Pressable style={s.spotify} onPress={props.onConnect}>
        <Text style={s.spotifyLogo}>♫</Text>
        <Text style={[s.spotifyTrack, { flex: 1 }]} numberOfLines={1}>
          {st.error ? 'Spotify: tap to reconnect' : 'Connect Spotify'}
        </Text>
      </Pressable>
    );
  }
  return (
    <View style={s.spotify}>
      {st.image ? <Image source={{ uri: st.image }} style={s.art} /> : <Text style={s.spotifyLogo}>♫</Text>}
      <View style={{ flex: 1 }}>
        <Text style={s.spotifyTrack} numberOfLines={1}>
          {st.track ?? 'Spotify'}
        </Text>
        <Text style={s.spotifyArtist} numberOfLines={1}>
          {st.artist ?? ''}
        </Text>
      </View>
      <Pressable style={s.spotifyButton} onPress={props.onPrevious} hitSlop={8}>
        <Text style={s.spotifyIcon}>⏮</Text>
      </Pressable>
      <Pressable style={s.spotifyButton} onPress={props.onToggle} hitSlop={8}>
        <Text style={s.spotifyIcon}>{st.paused ? '▶' : '⏸'}</Text>
      </Pressable>
      <Pressable style={s.spotifyButton} onPress={props.onNext} hitSlop={8}>
        <Text style={s.spotifyIcon}>⏭</Text>
      </Pressable>
    </View>
  );
}

const card = { backgroundColor: 'rgba(17,17,17,0.95)', borderRadius: 14 };

const s = StyleSheet.create({
  searchPanel: { position: 'absolute', top: 56, left: 12, right: 12, padding: 12, ...card },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchInput: { flex: 1, backgroundColor: '#222a26', color: '#fff', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  closeButton: { paddingHorizontal: 6, paddingVertical: 8 },
  closeText: { color: '#6aa9ff', fontSize: 15 },
  resultRow: { paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: '#222' },
  resultName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  resultSub: { color: '#8a948e', fontSize: 12, marginTop: 2 },
  hint: { color: '#8a948e', fontSize: 13, marginTop: 10 },

  chooser: { position: 'absolute', left: 12, right: 12, bottom: 28, padding: 14, ...card },
  chooserTitle: { color: '#fff', fontSize: 17, fontWeight: '800', marginBottom: 8 },
  error: { color: '#e8c070', fontSize: 13, marginBottom: 8 },
  routeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 10, borderRadius: 10, marginBottom: 6, backgroundColor: '#1b211e' },
  routeRowChosen: { backgroundColor: 'rgba(58,141,255,0.22)', borderWidth: 1, borderColor: '#3a8dff' },
  routeMain: { color: '#fff', fontSize: 17, fontWeight: '800' },
  routeDim: { color: '#9aa59f', fontSize: 14, fontWeight: '600' },
  routeSub: { color: '#9aa59f', fontSize: 12, marginTop: 2 },
  routeNew: { color: '#39d353', fontSize: 14, fontWeight: '700' },
  tag: { color: '#cfd8d2', fontSize: 11, fontWeight: '700', marginTop: 3 },
  tagNew: { color: '#39d353' },
  chooserButtons: { flexDirection: 'row', gap: 10, marginTop: 6 },
  bigButton: { borderRadius: 12, paddingVertical: 13, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  bigButtonText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  cancel: { backgroundColor: '#333', flex: 1 },
  go: { backgroundColor: '#2a6f2a', flex: 2 },
  end: { backgroundColor: '#8a2a2a' },

  banner: { position: 'absolute', top: 52, left: 12, right: 12, paddingVertical: 12, paddingHorizontal: 16, ...card, backgroundColor: 'rgba(28,74,42,0.97)' },
  bannerDist: { color: '#fff', fontSize: 30, fontWeight: '900' },
  bannerMain: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: 2 },

  footer: { position: 'absolute', left: 12, right: 12, bottom: 28, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, ...card },
  footerMain: { color: '#fff', fontSize: 20, fontWeight: '800' },
  footerDim: { color: '#9aa59f', fontSize: 13, fontWeight: '600' },
  roundButton: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center' },
  roundText: { fontSize: 20 },

  spotify: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 10, ...card, backgroundColor: 'rgba(17,17,17,0.92)' },
  spotifyLogo: { color: '#1db954', fontSize: 22, width: 36, textAlign: 'center' },
  art: { width: 36, height: 36, borderRadius: 4 },
  spotifyTrack: { color: '#fff', fontSize: 14, fontWeight: '700' },
  spotifyArtist: { color: '#9aa59f', fontSize: 12 },
  spotifyButton: { paddingHorizontal: 6, paddingVertical: 4 },
  spotifyIcon: { color: '#fff', fontSize: 20 },
});
