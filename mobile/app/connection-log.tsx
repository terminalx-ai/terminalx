import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnectionLogs } from "@mobile/state/AppProvider";
import { Card } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/** The connection log, newest first (#987: moved here from Settings, behind a link). */
export default function ConnectionLogScreen() {
  const logs = useConnectionLogs();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: palette.page }} contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}>
    <Text style={[styles.detail, { color: palette.muted }]}>{`${logs.length} ${logs.length === 1 ? "entry" : "entries"}, kept on this phone only.`}</Text>
    <Card style={styles.log}>{logs.length ? [...logs].reverse().map((entry) => <View key={entry.id} style={styles.logRow}>
      <Text style={[styles.logTime, { color: palette.faint }]}>{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</Text>
      <View style={styles.flex}><Text selectable style={[styles.detail, { color: entry.level === "error" ? palette.danger : entry.level === "warning" ? palette.warning : palette.ink }]}>{entry.message}</Text>{entry.detail ? <Text selectable style={[styles.logDetail, { color: palette.muted }]}>{entry.detail}</Text> : null}</View>
    </View>) : <Text style={[styles.detail, { color: palette.muted }]}>No connection attempts yet.</Text>}</Card>
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12 },
  log: { padding: 14, gap: 11 },
  logRow: { flexDirection: "row", gap: 10 },
  logTime: { width: 70, fontSize: 11, fontVariant: ["tabular-nums"] },
  logDetail: { fontSize: 11, marginTop: 2 },
  detail: { fontSize: 13, lineHeight: 19 },
  flex: { flex: 1 },
});
