import { useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { ChevronRight, Search } from "lucide-react-native";
import type { ColumnId } from "@terminalx/portable/dashboard";
import { conversationRows, statusLabel, type ConversationRow } from "@mobile/data/conversations";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, EmptyState, StatusDot } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

const columns: { id: ColumnId; title: string }[] = [{ id: "needs", title: "Needs you" }, { id: "working", title: "Working" }, { id: "done", title: "Done" }];

export default function SessionsScreen() {
  const app = useApp();
  const { palette } = useTheme();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => conversationRows(app.sessions, query), [app.sessions, query]);
  const sections = useMemo(() => columns.map((column) => ({ title: column.title, id: column.id, data: rows.filter((row) => row.column === column.id) })).filter((section) => section.data.length > 0), [rows]);

  if (!app.activeHost) return <View style={[styles.page, { backgroundColor: palette.page }]}><EmptyState title="Choose a Mac" detail="Connect to a paired Mac before opening its sessions." /><Button label="Open Machines" onPress={() => router.navigate("/(tabs)")} /></View>;

  const diagnostic = [...app.logs].reverse().find((entry) => ["Trying connection paths", "Connection attempt failed", "Connected"].includes(entry.message));
  const stageCopy = connectionCopy(app.connectionStage, app.connectionAttempt);
  return <SectionList sections={sections} keyExtractor={(item) => item.key} automaticallyAdjustContentInsets contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" stickySectionHeadersEnabled={false} style={{ backgroundColor: palette.page }} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={app.loadingSessions} onRefresh={() => void app.refreshSessions()} tintColor={palette.accent} />} ListHeaderComponent={<View style={styles.header}>
    <Card style={[styles.connection, { backgroundColor: app.connectionStage === "connected" ? `${palette.success}16` : `${palette.warning}18` }]}><StatusDot color={app.connectionStage === "connected" ? palette.success : palette.warning} /><View style={styles.flex}><Text style={[styles.connectionTitle, { color: palette.ink }]}>{app.activeHost.label}</Text><Text style={[styles.detail, { color: palette.muted }]}>{stageCopy.title}</Text>{diagnostic?.detail ? <Text style={[styles.hint, { color: palette.muted }]}>{diagnostic.message}: {diagnostic.detail}</Text> : null}{stageCopy.hint ? <Text style={[styles.hint, { color: palette.warning }]}>{stageCopy.hint}</Text> : null}</View>{app.connectionStage !== "connected" ? <Button label="Retry" kind="secondary" onPress={() => app.connection.restart()} /> : null}</Card>
    <View style={[styles.search, { backgroundColor: palette.card, borderColor: palette.border }]}><Search size={18} color={palette.faint} /><TextInput value={query} onChangeText={setQuery} placeholder="Search sessions" placeholderTextColor={palette.faint} style={[styles.searchInput, { color: palette.ink }]} /></View>
  </View>} renderSectionHeader={({ section }) => <View style={styles.sectionHeader}><Text style={[styles.sectionTitle, { color: palette.ink }]}>{section.title}</Text><Text style={[styles.count, { color: palette.muted, backgroundColor: palette.raised }]}>{section.data.length}</Text></View>} renderItem={({ item }) => <SessionRow session={item} onPress={() => { router.push({ pathname: "/session/[sessionId]", params: { sessionId: item.session.id, tabId: item.tab.id, hostId: app.activeHost!.id, title: item.session.title } }); }} />} ListEmptyComponent={app.loadingSessions ? <EmptyState title="Loading sessions" detail="Reading summaries from your Mac." busy /> : app.connectionStage === "connected" ? <EmptyState title="No sessions" detail="Sessions running on this Mac will appear here." /> : <EmptyState title="Sessions are offline" detail="Cached transcripts remain available after you reopen a session from recent history." />} />;
}

function SessionRow({ session: row, onPress }: { session: ConversationRow; onPress(): void }) {
  const { session, tab, label } = row;
  const { palette } = useTheme();
  const status = row.column;
  const color = status === "needs" ? palette.warning : status === "working" ? palette.accent : palette.success;
  return <Card style={styles.sessionCard}><Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.sessionRow, pressed && { backgroundColor: palette.raised }]}><View style={[styles.statusBar, { backgroundColor: color }]} /><View style={styles.flex}><View style={styles.titleLine}><Text numberOfLines={1} style={[styles.sessionTitle, { color: palette.ink }]}>{session.title}</Text>{session.issueRef ? <Text style={[styles.issue, { color: palette.accent }]}>{session.issueRef}</Text> : null}</View><Text numberOfLines={1} style={[styles.meta, { color: palette.muted }]}>{session.project} · {session.worktree}</Text><Text style={[styles.prompt, { color: palette.ink }]}>{label}</Text><Text style={[styles.reply, { color }]}>{statusLabel(tab.status)}</Text></View><ChevronRight size={18} color={palette.faint} /></Pressable></Card>;
}

function connectionCopy(stage: string, attempt: number): { title: string; hint?: string } {
  if (stage === "connected") return { title: "Live · end-to-end encrypted" };
  if (stage === "unreachable") return { title: "Host unreachable — retrying", hint: "Check that the Mac is awake and reachable over Wi-Fi, VPN, or relay." };
  if (stage === "cant-connect") return { title: `Can’t connect · attempt ${attempt}` };
  return { title: "Reconnecting…" };
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24, justifyContent: "center", gap: 12 },
  content: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 36, gap: 9 },
  header: { gap: 12, marginBottom: 8 },
  connection: { flexDirection: "row", alignItems: "center", padding: 14, gap: 11 },
  connectionTitle: { fontSize: 16, fontWeight: "700" },
  detail: { fontSize: 13, lineHeight: 18 },
  hint: { fontSize: 12, marginTop: 3 },
  flex: { flex: 1 },
  search: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  searchInput: { flex: 1, height: 44, fontSize: 16 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12, marginBottom: 2, paddingHorizontal: 3 },
  sectionTitle: { fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  count: { minWidth: 25, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, overflow: "hidden", fontSize: 12, textAlign: "center" },
  sessionCard: { marginBottom: 1 },
  sessionRow: { minHeight: 92, padding: 14, paddingLeft: 12, flexDirection: "row", gap: 11, alignItems: "center" },
  statusBar: { alignSelf: "stretch", width: 3, borderRadius: 2 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  sessionTitle: { flex: 1, fontSize: 16, fontWeight: "700" },
  issue: { fontSize: 12, fontWeight: "700" },
  meta: { fontSize: 12, marginTop: 3 },
  prompt: { fontSize: 14, lineHeight: 19, marginTop: 8 },
  reply: { fontSize: 13, lineHeight: 18, marginTop: 3 },
});
