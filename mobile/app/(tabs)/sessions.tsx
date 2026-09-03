import { useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { ChevronRight, Search } from "lucide-react-native";
import { sessionColumn, type ColumnId } from "@terminalx/portable/dashboard";
import type { SessionSummary } from "@mobile/data/host-api";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, EmptyState, StatusDot } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

const columns: { id: ColumnId; title: string }[] = [{ id: "needs", title: "Needs you" }, { id: "working", title: "Working" }, { id: "done", title: "Done" }];

export default function SessionsScreen() {
  const app = useApp();
  const { palette } = useTheme();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const sections = useMemo(() => columns.map((column) => ({ title: column.title, id: column.id, data: app.sessions.filter((session) => columnFor(session) === column.id && matches(session, query)) })), [app.sessions, query]);

  if (!app.activeHost) return <View style={[styles.page, { backgroundColor: palette.page }]}><EmptyState title="Choose a Mac" detail="Connect to a paired Mac before opening its sessions." /><Button label="Open Machines" onPress={() => router.navigate("/(tabs)")} /></View>;

  const stageCopy = connectionCopy(app.connectionStage, app.connectionAttempt, app.activeHost.endpoint);
  return <SectionList sections={sections} keyExtractor={(item) => item.id} automaticallyAdjustContentInsets contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" stickySectionHeadersEnabled={false} style={{ backgroundColor: palette.page }} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={app.loadingSessions} onRefresh={() => void app.refreshSessions()} tintColor={palette.accent} />} ListHeaderComponent={<View style={styles.header}>
    <Card style={[styles.connection, { backgroundColor: app.connectionStage === "connected" ? `${palette.success}16` : `${palette.warning}18` }]}><StatusDot color={app.connectionStage === "connected" ? palette.success : palette.warning} /><View style={styles.flex}><Text style={[styles.connectionTitle, { color: palette.ink }]}>{app.activeHost.label}</Text><Text style={[styles.detail, { color: palette.muted }]}>{stageCopy.title}</Text>{stageCopy.hint ? <Text style={[styles.hint, { color: palette.warning }]}>{stageCopy.hint}</Text> : null}</View>{app.connectionStage !== "connected" ? <Button label="Retry" kind="secondary" onPress={() => app.connection.restart()} /> : null}</Card>
    <View style={[styles.search, { backgroundColor: palette.card, borderColor: palette.border }]}><Search size={18} color={palette.faint} /><TextInput value={query} onChangeText={setQuery} placeholder="Search sessions" placeholderTextColor={palette.faint} style={[styles.searchInput, { color: palette.ink }]} /></View>
  </View>} renderSectionHeader={({ section }) => <View style={styles.sectionHeader}><Text style={[styles.sectionTitle, { color: palette.ink }]}>{section.title}</Text><Text style={[styles.count, { color: palette.muted, backgroundColor: palette.raised }]}>{section.data.length}</Text></View>} renderItem={({ item }) => <SessionRow session={item} onPress={() => { const tab = item.tabs[0]; if (tab) router.push({ pathname: "/session/[sessionId]", params: { sessionId: item.id, tabId: tab.id, title: item.title } }); }} />} ListEmptyComponent={app.loadingSessions ? <EmptyState title="Loading sessions" detail="Reading summaries from your Mac." busy /> : app.connectionStage === "connected" ? <EmptyState title="No sessions" detail="Sessions running on this Mac will appear here." /> : <EmptyState title="Sessions are offline" detail="Cached transcripts remain available after you reopen a session from recent history." />} />;
}

function SessionRow({ session, onPress }: { session: SessionSummary; onPress(): void }) {
  const { palette } = useTheme();
  const status = columnFor(session);
  const color = status === "needs" ? palette.warning : status === "working" ? palette.accent : palette.success;
  return <Card style={styles.sessionCard}><Pressable accessibilityRole="button" disabled={!session.tabs.length} onPress={onPress} style={({ pressed }) => [styles.sessionRow, pressed && { backgroundColor: palette.raised }]}><View style={[styles.statusBar, { backgroundColor: color }]} /><View style={styles.flex}><View style={styles.titleLine}><Text numberOfLines={1} style={[styles.sessionTitle, { color: palette.ink }]}>{session.title}</Text>{session.issueRef ? <Text style={[styles.issue, { color: palette.accent }]}>{session.issueRef}</Text> : null}</View><Text numberOfLines={1} style={[styles.meta, { color: palette.muted }]}>{session.project} · {session.worktree}</Text>{session.lastPrompt ? <Text numberOfLines={2} style={[styles.prompt, { color: palette.ink }]}>{session.lastPrompt}</Text> : null}{session.lastReply ? <Text numberOfLines={2} style={[styles.reply, { color: palette.muted }]}>{session.lastReply}</Text> : null}</View><ChevronRight size={18} color={palette.faint} /></Pressable></Card>;
}

function columnFor(session: SessionSummary): ColumnId {
  return sessionColumn({ id: session.id, projectPath: session.project, cwd: session.worktree, title: session.title, modified: session.modified, archived: false, tabs: session.tabs });
}

function matches(session: SessionSummary, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const value = [session.title, session.project, session.worktree, session.issueRef ?? "", session.lastPrompt ?? "", session.lastReply ?? ""].join(" ").toLowerCase();
  return words.every((word) => value.includes(word));
}

function connectionCopy(stage: string, attempt: number, endpoint: string): { title: string; hint?: string } {
  if (stage === "connected") return { title: "Live · end-to-end encrypted" };
  const tailscale = /(?:^|\D)100\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(endpoint) || endpoint.includes(".ts.net");
  if (stage === "unreachable") return { title: "Host unreachable — re-pair?", ...(tailscale ? { hint: "Check that Tailscale is connected on this phone and Mac." } : {}) };
  if (stage === "cant-connect") return { title: `Can’t connect · attempt ${attempt}`, ...(tailscale ? { hint: "Check Tailscale connectivity." } : {}) };
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
