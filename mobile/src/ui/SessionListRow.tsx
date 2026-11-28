import { memo, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Pin } from "lucide-react-native";
import { statusTooltip } from "@terminalx/portable/sessionStatus";
import { shortTime, spokenTime, type ChatRow } from "@mobile/data/session-list";
import { MutedMark, useSessionOverride } from "./notifications/SessionNotifications";
import { markColor, RowStatusMark } from "./RowStatusMark";
import { rowActionProps, type RowAction } from "./row-actions";
import { useTheme } from "./theme";

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

/**
 * A session as 22.04 lists it: its status mark, its title, its status in
 * words (with how many tabs it has), its branch in small type, and when it
 * was last active. Nothing else ends the row. A session with several tabs
 * opens in place to list them, each with its own mark, title and time.
 *
 * `first` and `last` round the card the row sits in, one card per section.
 *
 * A session pinned on the Mac carries a small pin by its time, except in the
 * Pinned section (`inPinned`), whose heading says so (#1403). `actions` are
 * what a long press offers: Pin or Unpin, when the Mac takes them.
 */
export const SessionListRow = memo(function SessionListRow({ row, hostId, first, last, onOpen, inPinned = false, actions = [] }: { row: ChatRow; hostId: string; first: boolean; last: boolean; onOpen(tabId: string): void; inPinned?: boolean; actions?: RowAction[] }) {
  const { palette } = useTheme();
  const [open, setOpen] = useState(false);
  const many = row.tabs.length > 1;
  const color = markColor(row.status.mark, palette);
  const words = row.status.mark === "idle" ? palette.muted : color;
  const tabs = many ? `${row.tabs.length} tabs` : "";
  // Muted on this phone (#990): a small mark, and said.
  const muted = useSessionOverride(hostId, row.session.id) === "mute" ? "notifications muted" : "";
  const pinMark = row.pinned && !inPinned;
  const label = [row.title, pinMark ? "pinned" : "", row.status.words, tabs, muted, row.branch ? `branch ${row.branch}` : "", spokenTime(row.time)].filter(Boolean).join(", ");
  return <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }, first && styles.top, last && styles.bottom]}>
    {first ? null : <View style={[styles.divider, { backgroundColor: palette.border }]} />}
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={many ? `${open ? "Hides" : "Shows"} its tabs. ${statusTooltip(row.status.status)}` : statusTooltip(row.status.status)}
      accessibilityState={many ? { expanded: open } : undefined}
      {...rowActionProps(row.title, actions)}
      onPress={() => many ? setOpen(!open) : onOpen(row.tabId)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.raised }, first && styles.top, last && !open && styles.bottom]}
    >
      <View style={styles.mark}><RowStatusMark mark={row.status.mark} palette={palette} /></View>
      <View style={styles.body}>
        <Text numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{row.title}</Text>
        <Text numberOfLines={1} style={styles.status}>
          <Text style={[styles.words, { color: words }]}>{row.status.words}</Text>
          {tabs ? <Text style={{ color: palette.muted }}>{` · ${tabs}`}</Text> : null}
        </Text>
        {row.branch ? <Text numberOfLines={1} style={[styles.branch, { color: palette.faint }]}>{row.branch}</Text> : null}
      </View>
      <View style={styles.trailing}>
        <Text style={[styles.time, { color: palette.faint }]}>{shortTime(row.time)}</Text>
        <View style={styles.marks}>
          {pinMark ? <Pin testID="pin-mark" size={13} color={palette.faint} strokeWidth={1.9} /> : null}
          <MutedMark hostId={hostId} sessionId={row.session.id} />
        </View>
      </View>
    </Pressable>
    {many && open ? row.tabs.map((tab, index) => <View key={tab.id}>
      <View style={[styles.divider, { backgroundColor: palette.border }]} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[tab.name, tab.status.words, spokenTime(tab.time)].filter(Boolean).join(", ")}
        accessibilityHint={statusTooltip(tab.status.status)}
        onPress={() => onOpen(tab.id)}
        style={({ pressed }) => [styles.tab, pressed && { backgroundColor: palette.raised }, last && index === row.tabs.length - 1 && styles.bottom]}
      >
        <View style={styles.tabMark}><RowStatusMark mark={tab.status.mark} palette={palette} size={16} /></View>
        <Text numberOfLines={1} style={[styles.tabName, { color: palette.ink }]}>{tab.name}</Text>
        <Text style={[styles.time, { color: palette.faint }]}>{shortTime(tab.time)}</Text>
      </Pressable>
    </View>) : null}
  </View>;
});

const RADIUS = 16;
// After 22.04: rows in a card per section, a 20pt mark at the edge, three lines, the time at the end.
const styles = StyleSheet.create({
  trailing: { alignItems: "flex-end", gap: 6 },
  marks: { flexDirection: "row", alignItems: "center", gap: 6 },
  card: { marginHorizontal: 16, borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  top: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: RADIUS, borderTopRightRadius: RADIUS },
  bottom: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: RADIUS, borderBottomRightRadius: RADIUS },
  divider: { height: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, minHeight: 56, paddingHorizontal: 14, paddingVertical: 12 },
  mark: { marginTop: 1, width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: "600", letterSpacing: -0.3 },
  status: { marginTop: 2, fontSize: 13, lineHeight: 18 },
  words: { fontWeight: "600" },
  branch: { marginTop: 3, fontSize: 12, lineHeight: 16, fontFamily: MONO },
  time: { fontSize: 13, lineHeight: 21, fontVariant: ["tabular-nums"] },
  // A tab, a step in, under its session's title.
  tab: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, paddingLeft: 46, paddingRight: 14, paddingVertical: 10 },
  tabMark: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  tabName: { flex: 1, fontSize: 15, letterSpacing: -0.2 },
});
