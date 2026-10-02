// Screens for the sat-nav (v0.18). Presentational only: App.tsx owns the
// state and passes it in.

import { StyleSheet, Text, View, Pressable, TextInput, ScrollView, ActivityIndicator } from 'react-native';
import type { NavUpdate } from './nav';
import { shortDistance } from './nav';
import type { PlannedRoute, Avoid } from './router';
import type { Place } from './places';

const km = (m: number) => (m >= 10_000 ? (m / 1000).toFixed(0) : (m / 1000).toFixed(1));
export function minutes(s: number) {
  const m = Math.max(1, Math.round(s / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// An arrow for each kind of manoeuvre (Ireland: roundabouts go clockwise).
const ARROWS: Record<string, string> = {
  straight: '↑', 'slight-left': '↖', 'slight-right': '↗', left: '←', right: '→', 'sharp-left': '↙', 'sharp-right': '↘',
  'u-turn': '↶', roundabout: '↻', merge: '↑', exit: '↗', arrive: '⚑', depart: '↑', ferry: '⛴',
};

// --- search ---

export function SearchPanel(props: {
  query: string;
  onQuery: (q: string) => void;
  results: Place[];
  searching: boolean;
  note: string;
  onPick: (p: Place) => void;
  onClose: () => void;
}) {
  const q = props.query.trim();
  return (
    <View style={s.searchPanel}>
      <View style={s.searchRow}>
        <TextInput
          style={s.searchInput}
          value={props.query}
          onChangeText={props.onQuery}
          placeholder="Town, address, Eircode or business"
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
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 340 }}>
        {props.results.map((p, i) => (
          <Pressable key={`${p.source}${p.lat},${p.lon},${i}`} style={s.resultRow} onPress={() => props.onPick(p)}>
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
        {props.searching && <ActivityIndicator color="#39d353" style={{ marginTop: 10 }} />}
        {!props.searching && q.length > 1 && props.results.length === 0 && <Text style={s.hint}>Nothing found.</Text>}
        {!!props.note && <Text style={s.hint}>{props.note}</Text>}
        {q.length === 0 && <Text style={s.hint}>Or close this and long-press anywhere on the map to drop a pin.</Text>}
      </ScrollView>
    </View>
  );
}

// --- choosing a route ---

export function RouteChooser(props: {
  destName: string;
  options: PlannedRoute[];
  chosen: number;
  loading: string; // what it's doing, or ''
  error: string;
  onChoose: (i: number) => void;
  onGo: () => void;
  onCancel: () => void;
  avoid: Avoid;
  onAvoid: (k: keyof Avoid) => void;
}) {
  const fastest = props.options.find((o) => o.mode === 'fastest') ?? props.options[0];
  return (
    <View style={s.chooser}>
      <Text style={s.chooserTitle} numberOfLines={1}>
        To {props.destName}
      </Text>
      {!!props.loading && (
        <View style={s.loadingRow}>
          <ActivityIndicator color="#39d353" />
          <Text style={s.loadingText}>{props.loading}</Text>
        </View>
      )}
      <View style={s.avoidRow}>
        <Text style={s.avoidLabel}>Avoid</Text>
        {AVOIDS.map(([k, label]) => (
          <Pressable key={k} style={[s.avoidChip, props.avoid[k] && s.avoidChipOn]} onPress={() => props.onAvoid(k)} disabled={!!props.loading}>
            <Text style={[s.avoidText, props.avoid[k] && s.avoidTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {!!props.error && <Text style={s.error}>{props.error}</Text>}
      {props.options.map((o, i) => {
        const extra = fastest && o !== fastest ? Math.round((o.duration - fastest.duration) / 60) : 0;
        return (
          <Pressable key={i} style={[s.routeRow, i === props.chosen && s.routeRowChosen]} onPress={() => props.onChoose(i)}>
            <View style={{ flex: 1 }}>
              <Text style={s.routeMain}>
                {minutes(o.duration)} <Text style={s.routeDim}>· {km(o.distance)} km</Text>
              </Text>
              <Text style={s.routeSub} numberOfLines={1}>
                {o.roadNames.length ? `via ${o.roadNames.filter((n) => /^[MNRAB]\d/.test(n)).slice(0, 3).join(', ') || o.roadNames.slice(0, 2).join(', ')}` : ''}
              </Text>
              {usesNote(o) ? <Text style={s.usesNote}>{usesNote(o)}</Text> : null}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.routeNew}>{km(o.newM)} km new</Text>
              <Text style={[s.tag, o.mode === 'new' && s.tagNew]}>
                {o.mode === 'new' ? `New roads${extra > 0 ? ` · +${extra} min` : ''}` : props.options.length > 1 ? 'Fastest' : 'Fastest · also the most new road'}
              </Text>
            </View>
          </Pressable>
        );
      })}
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

const AVOIDS: [keyof Avoid, string][] = [
  ['tolls', 'Tolls'],
  ['motorways', 'Motorways'],
  ['unpaved', 'Unpaved'],
  ['ferries', 'Ferries'],
];

// What a route uses that you might mind: always tolls and ferries; the
// rest only when you asked to avoid them and there was no way round.
function usesNote(r: PlannedRoute): string {
  const u = r.uses;
  const out: string[] = [];
  const forced = (asked: boolean | undefined) => (asked ? ' (no way round)' : '');
  if (u.tollM > 0) out.push(`ⓘ Tolls${forced(r.avoid.tolls)}`);
  if (u.ferryM > 0) out.push(`⛴ Ferry${forced(r.avoid.ferries)}`);
  if (r.avoid.motorways && u.motorwayM > 0) out.push('Motorway (no way round)');
  if (r.avoid.unpaved && u.unpavedM > 0) out.push('Unpaved road (no way round)');
  return out.join(' · ');
}

// --- driving ---

export function NavBanner(props: { update: NavUpdate | null; rerouting: boolean }) {
  const u = props.update;
  // Close to a turn, the banner turns bright so it catches the eye.
  const close = !!u?.next && !u.next.final && u.toNext < 300;
  return (
    <View style={[s.banner, close && s.bannerClose]}>
      {props.rerouting ? (
        <Text style={s.bannerMain}>Finding a new route…</Text>
      ) : u && u.next ? (
        <View style={s.bannerRow}>
          <Text style={s.arrow}>{ARROWS[u.next.kind ?? ''] ?? '↑'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.bannerDist}>{shortDistance(u.toNext)}</Text>
            <Text style={s.bannerMain} numberOfLines={2}>
              {u.next.instruction}
            </Text>
          </View>
        </View>
      ) : (
        <Text style={s.bannerMain}>Waiting for GPS…</Text>
      )}
    </View>
  );
}

export function SpeedLimit(props: { kmh: number }) {
  if (!props.kmh) return null;
  return (
    <View style={s.limit}>
      <Text style={[s.limitText, props.kmh >= 100 && { fontSize: 19 }]}>{props.kmh}</Text>
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

const card = { backgroundColor: 'rgba(17,17,17,0.95)', borderRadius: 14 };

const s = StyleSheet.create({
  searchPanel: { position: 'absolute', top: 56, left: 12, right: 12, padding: 12, ...card },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchInput: { flex: 1, backgroundColor: '#222a26', color: '#fff', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  closeButton: { paddingHorizontal: 6, paddingVertical: 8 },
  closeText: { color: '#6aa9ff', fontSize: 15 },
  resultRow: { paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2c3430' },
  resultName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  resultSub: { color: '#8a948e', fontSize: 12, marginTop: 2 },
  hint: { color: '#8a948e', fontSize: 13, marginTop: 10 },

  chooser: { position: 'absolute', left: 12, right: 12, bottom: 28, padding: 14, ...card },
  chooserTitle: { color: '#fff', fontSize: 17, fontWeight: '800', marginBottom: 8 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 10 },
  loadingText: { color: '#9aa59f', fontSize: 13 },
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
  avoidRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' },
  avoidLabel: { color: '#9aa59f', fontSize: 12, fontWeight: '700', marginRight: 2 },
  avoidChip: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 14, backgroundColor: '#262d29' },
  avoidChipOn: { backgroundColor: '#8a5a1a' },
  avoidText: { color: '#cfd8d2', fontSize: 12, fontWeight: '600' },
  avoidTextOn: { color: '#fff' },
  usesNote: { color: '#e8c070', fontSize: 12, marginTop: 3, fontWeight: '600' },
  bigButton: { borderRadius: 12, paddingVertical: 13, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  bigButtonText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  cancel: { backgroundColor: '#333', flex: 1 },
  go: { backgroundColor: '#2a6f2a', flex: 2 },
  end: { backgroundColor: '#8a2a2a' },

  banner: { position: 'absolute', top: 52, left: 12, right: 12, paddingVertical: 12, paddingHorizontal: 16, ...card, backgroundColor: 'rgba(24,52,34,0.96)' },
  bannerClose: { backgroundColor: 'rgba(36,120,60,0.98)' },
  bannerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  arrow: { color: '#fff', fontSize: 44, fontWeight: '900', width: 48, textAlign: 'center' },
  bannerDist: { color: '#fff', fontSize: 28, fontWeight: '900' },
  bannerMain: { color: '#fff', fontSize: 17, fontWeight: '700', marginTop: 2 },

  limit: { position: 'absolute', left: 16, bottom: 118, width: 54, height: 54, borderRadius: 27, backgroundColor: '#fff', borderWidth: 5, borderColor: '#d0202a', alignItems: 'center', justifyContent: 'center' },
  limitText: { color: '#111', fontSize: 21, fontWeight: '900' },

  footer: { position: 'absolute', left: 12, right: 12, bottom: 28, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, ...card },
  footerMain: { color: '#fff', fontSize: 20, fontWeight: '800' },
  footerDim: { color: '#9aa59f', fontSize: 13, fontWeight: '600' },
  roundButton: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center' },
  roundText: { fontSize: 20 },
});
