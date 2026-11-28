import { memo, useCallback, useMemo } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@mobile/state/AppProvider";
import { useConnectionLogs } from "@mobile/state/connection-log-store";
import type { ConnectionLogEntry } from "@mobile/transport/connection";
import { Card } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

const LOG_TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const ConnectionLogRow = memo(function ConnectionLogRow({ entry, first, last }: { entry: ConnectionLogEntry; first: boolean; last: boolean }) {
  const { palette } = useTheme();
  const formattedTime = useMemo(() => LOG_TIME_FMT.format(new Date(entry.at)), [entry.at]);
  return <View style={[styles.logCardRow, { backgroundColor: palette.card, borderColor: palette.border }, first && styles.cardTop, last && styles.cardBottom]}>
    <View style={styles.logRow}>
      <Text style={[styles.logTime, { color: palette.faint }]}>{formattedTime}</Text>
      <View style={styles.flex}>
        <Text selectable style={[styles.detail, { color: entry.level === "error" ? palette.danger : entry.level === "warning" ? palette.warning : palette.ink }]}>{entry.message}</Text>
        {entry.detail ? <Text selectable style={[styles.logDetail, { color: palette.muted }]}>{entry.detail}</Text> : null}
      </View>
    </View>
  </View>;
});

const keyExtractor = (entry: ConnectionLogEntry) => entry.id;

/** The connection log, newest first (#987: moved here from Settings, behind a link; P-79 virtualized). */
export default function ConnectionLogScreen() {
  const storeLogs = useConnectionLogs();
  const app = useApp();
  const logs = storeLogs.length ? storeLogs : app.logs;
  const reversed = useMemo(() => [...logs].reverse(), [logs]);
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const renderItem = useCallback(
    ({ item, index }: { item: ConnectionLogEntry; index: number }) => (
      <ConnectionLogRow entry={item} first={index === 0} last={index === reversed.length - 1} />
    ),
    [reversed.length],
  );
  return <FlatList
    data={reversed}
    keyExtractor={keyExtractor}
    renderItem={renderItem}
    contentInsetAdjustmentBehavior="automatic"
    style={{ backgroundColor: palette.page }}
    contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}
    initialNumToRender={25}
    maxToRenderPerBatch={25}
    windowSize={7}
    ListHeaderComponent={<Text style={[styles.detail, styles.header, { color: palette.muted }]}>{`${logs.length} ${logs.length === 1 ? "entry" : "entries"}, kept on this phone only.`}</Text>}
    ListEmptyComponent={<Card style={styles.log}><Text style={[styles.detail, { color: palette.muted }]}>No connection attempts yet.</Text></Card>}
  />;
}

const styles = StyleSheet.create({
  page: { padding: 16 },
  header: { marginBottom: 12 },
  log: { padding: 14, gap: 11 },
  logCardRow: { borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 6 },
  cardTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 14 },
  cardBottom: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: 16, borderBottomRightRadius: 16, paddingBottom: 14 },
  logRow: { flexDirection: "row", gap: 10 },
  logTime: { width: 70, fontSize: 11, fontVariant: ["tabular-nums"] },
  logDetail: { fontSize: 11, marginTop: 2 },
  detail: { fontSize: 13, lineHeight: 19 },
  flex: { flex: 1 },
});
