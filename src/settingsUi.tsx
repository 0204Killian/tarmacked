// Settings, iOS-style building blocks (rounded cards of rows).
import { ReactNode } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';

// A row in Settings: what it does, and a line saying what that means.
// Settings, iOS-style: rounded cards of rows split by inset hairlines.
// A row with onPress gets a › ; `value` is a live value in grey on the right.
export function SettingsCard(props: { children: ReactNode }) {
  return <View style={settingStyles.card}>{props.children}</View>;
}
export function SettingsHeader(props: { title: string }) {
  return <Text style={settingStyles.header}>{props.title}</Text>;
}
export function SettingsRow(props: {
  key?: string;
  title: string;
  value?: string;
  onPress?: () => void;
  right?: ReactNode;
  first?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  const inner = (
    <View style={[settingStyles.rowInner, !props.first && settingStyles.divider]}>
      <Text style={[settingStyles.title, props.danger && settingStyles.danger]} numberOfLines={1}>
        {props.title}
      </Text>
      {props.value !== undefined && (
        <Text style={settingStyles.value} numberOfLines={1}>
          {props.value}
        </Text>
      )}
      {props.right}
      {props.onPress && !props.danger && <Text style={settingStyles.chevron}>›</Text>}
    </View>
  );
  if (!props.onPress) return <View style={settingStyles.row}>{inner}</View>;
  return (
    <Pressable
      style={({ pressed }: { pressed: boolean }) => [settingStyles.row, pressed && settingStyles.pressed, props.disabled && { opacity: 0.4 }]}
      onPress={props.onPress}
      disabled={props.disabled}
    >
      {inner}
    </Pressable>
  );
}
export const settingStyles = StyleSheet.create({
  card: { backgroundColor: '#1f2723', borderRadius: 12, overflow: 'hidden' },
  header: { color: '#8a8a8a', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 18, marginBottom: 6, marginLeft: 14 },
  row: { paddingLeft: 14 },
  pressed: { backgroundColor: '#2a3530' },
  rowInner: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingVertical: 10, paddingRight: 14, gap: 8 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#3a4640' },
  title: { color: '#fff', fontSize: 15, flex: 1 },
  danger: { color: '#ff6b6b' },
  value: { color: '#8a8a8a', fontSize: 15, flexShrink: 1, textAlign: 'right' },
  chevron: { color: '#5c6a63', fontSize: 20, marginTop: -2 },
  foot: { color: '#8a8a8a', fontSize: 12, lineHeight: 17, marginTop: 8, marginHorizontal: 14 },
});
