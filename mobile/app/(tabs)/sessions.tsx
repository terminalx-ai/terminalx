import { useMemo, useState } from "react";
import { Platform, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ChevronDown, ChevronRight, Laptop } from "lucide-react-native";
import { branchChats, chatRows, projectGroups, shortTime, type ChatRow } from "@mobile/data/session-list";
import { useApp } from "@mobile/state/AppProvider";
import { Button, EmptyState, StatusDot } from "@mobile/ui/primitives";
import { useDeviceMenu } from "@mobile/ui/DeviceMenu";
import { GlassIconButton } from "@mobile/ui/glass";
import { MacIcon, StateMark } from "@mobile/ui/MacIcon";
import { AgentMark } from "@mobile/ui/AgentMark";
import { ChatListRow } from "@mobile/ui/ChatListRow";
import { EdgeFade } from "@mobile/ui/EdgeFade";
import { useTabBarInset } from "@mobile/ui/tab-bar-inset";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@mobile/ui/theme";

type ListView = "chats" | "projects";
const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";
/** The view last chosen, for as long as the app runs. */
let lastView: ListView = "chats";

export default function SessionsScreen() {
  const app = useApp();
  const { palette } = useTheme();
  const router = useRouter();
  const [view, setViewState] = useState<ListView>(lastView);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const setView = (next: ListView) => { lastView = next; setViewState(next); };
  const insets = useSafeAreaInsets();
  const bar = useTabBarInset();
  const [headerHeight, setHeaderHeight] = useState(insets.top + 56);
  // Removing the computer from here goes back to the device list.
  const menu = useDeviceMenu({ onRemoved: () => router.navigate("/(tabs)") });
  const rows = useMemo(() => chatRows(app.sessions), [app.sessions]);
  const groups = useMemo(() => projectGroups(rows), [rows]);
  const sections = useMemo(() => view === "chats"
    ? (rows.length ? [{ key: "chats", title: "", needs: 0, data: rows }] : [])
    : groups.map((group) => ({ key: group.project, title: group.project, needs: group.needs, data: collapsed.has(group.project) ? [] : group.rows })), [collapsed, groups, rows, view]);

  if (!app.activeHost) return <View style={[styles.page, { backgroundColor: palette.page }]}><EmptyState title="Choose a Mac" detail="Connect to a paired Mac before opening its sessions." /><Button label="Open Machines" onPress={() => router.navigate("/(tabs)")} /></View>;

  const host = app.activeHost;
  const connected = app.connectionStage === "connected";
  const diagnostic = connected ? undefined : [...app.logs].reverse().find((entry) => ["Trying connection paths", "Relay path failed", "Connection attempt failed"].includes(entry.message));
  const stage = connectionCopy(app.connectionStage, app.connectionAttempt);
  const open = (row: ChatRow, tabId = row.tabId) => router.push({ pathname: "/session/[sessionId]", params: { sessionId: row.session.id, tabId, hostId: host.id, title: row.title } });
  const toggle = (project: string) => setCollapsed((current) => { const next = new Set(current); if (next.has(project)) next.delete(project); else next.add(project); return next; });
  const projects = view === "projects";

  // The Mac and the view switch stay at the top as the list scrolls under them, fading away there.
  const header = <View onLayout={({ nativeEvent }) => setHeaderHeight(nativeEvent.layout.height)} style={[styles.sticky, { paddingTop: insets.top }]}>
    <EdgeFade edge="top" height={headerHeight + 28} />
    <View style={styles.header}>
      {/* The Mac these chats are on. */}
      <View style={styles.topBar}>
        <Pressable accessibilityRole="button" accessibilityHint="Opens device options" onPress={() => menu.open(host)} onLongPress={() => menu.open(host)} style={styles.hostName}>
          <Laptop size={21} color={palette.ink} strokeWidth={1.8} />
          <Text numberOfLines={1} style={[styles.hostText, { color: palette.ink }]}>{menu.nameOf(host)}</Text>
          <StatusDot color={connected ? palette.success : palette.warning} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Device options for ${menu.nameOf(host)}`} hitSlop={10} onPress={() => menu.open(host)} style={styles.hostChevron}><ChevronDown size={16} color={palette.muted} /></Pressable>
        <View style={styles.flex} />
        {/* The button shows where it goes: the list of chats from the projects, the projects from the list. */}
        <GlassIconButton label={projects ? "Show all chats" : "Group by project"} size={40} icon={<MacIcon name={projects ? "LayoutList" : "FolderTree"} size={20} color={palette.ink} strokeWidth={1.4} />} onPress={() => setView(projects ? "chats" : "projects")} />
      </View>
      {!connected ? <View style={styles.offline}>
        <Text style={[styles.offlineText, { color: palette.muted }]}><Text style={{ color: palette.warning }}>{stage.title}. </Text>{diagnostic?.detail ? `${diagnostic.message}: ${diagnostic.detail}` : stage.hint ?? "Showing what this phone saved."}</Text>
        <Button label="Retry" kind="secondary" onPress={() => app.connection.restart("retry was tapped")} style={styles.retry} />
      </View> : null}
    </View>
  </View>;

  return <View style={[styles.screen, { backgroundColor: palette.page }]}>{menu.element}<SectionList
    sections={sections}
    keyExtractor={(item) => item.key}
    contentInsetAdjustmentBehavior="never"
    keyboardShouldPersistTaps="handled"
    stickySectionHeadersEnabled={false}
    style={{ backgroundColor: palette.page }}
    contentContainerStyle={[styles.content, { paddingTop: headerHeight + 4, paddingBottom: bar + 16 }]}
    scrollIndicatorInsets={{ top: headerHeight, bottom: bar }}
    refreshControl={<RefreshControl refreshing={app.loadingSessions} onRefresh={() => void app.refreshSessions()} tintColor={palette.accent} progressViewOffset={headerHeight} />}
    renderSectionHeader={({ section }) => projects ? <ProjectHeader title={section.title} open={!collapsed.has(section.key)} onPress={() => toggle(section.key)} /> : null}
    renderItem={({ item }) => projects ? <ProjectChat row={item} onOpen={(tabId) => open(item, tabId)} /> : <ChatListRow row={item} onPress={() => open(item)} />}
    ListEmptyComponent={app.loadingSessions ? <EmptyState title="Loading sessions" detail="Reading summaries from your Mac." busy />
      : connected ? <EmptyState title="No sessions" detail="Sessions running on this Mac will appear here." />
      : <EmptyState title="Sessions are offline" detail="Cached transcripts remain available after you reopen a session from recent history." />}
  />{header}</View>;
}

/** A project as the Mac's project list heads it: a folder and the project's name. */
function ProjectHeader({ title, open, onPress }: { title: string; open: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title} onPress={onPress} style={({ pressed }) => [styles.project, pressed && { backgroundColor: palette.raised }]}>
    <MacIcon name="Folder" size={18} color={palette.muted} strokeWidth={1.3} />
    <Text numberOfLines={1} style={[styles.projectTitle, { color: palette.ink }]}>{title}</Text>
    {open ? null : <ChevronRight size={16} color={palette.faint} />}
  </Pressable>;
}

/**
 * A branch under its project, as on the Mac: named by its branch, else by its
 * title. A branch holding several chats (tabs on the Mac) says how many, and
 * opens to list them; one with a single chat opens it.
 */
function ProjectChat({ row, onOpen }: { row: ChatRow; onOpen(tabId: string): void }) {
  const { palette } = useTheme();
  const [open, setOpen] = useState(false);
  const chats = branchChats(row.session);
  const many = chats.length > 1;
  const state = row.state === "needs" ? "needs you" : row.state === "working" ? "working" : "";
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={many ? { expanded: open } : undefined} accessibilityLabel={[row.name, many ? `${chats.length} chats` : "", state, row.preview].filter(Boolean).join(", ")} onPress={() => many ? setOpen(!open) : onOpen(row.tabId)} style={({ pressed }) => [styles.channel, row.branched ? styles.branchRow : styles.titleRow, pressed && { backgroundColor: palette.raised }]}>
      {row.branched ? <MacIcon name="GitBranch" size={16} color={palette.muted} strokeWidth={1.35} /> : null}
      <Text numberOfLines={1} style={[row.branched ? styles.branchName : styles.chatTitle, { color: palette.ink }]}>{row.name}</Text>
      {row.state !== "done" ? <StateMark state={row.state} info={palette.info} warning={palette.warning} /> : many ? null : <Text style={[styles.time, { color: palette.faint }]}>{shortTime(row.time)}</Text>}
      {many ? <View style={[styles.count, { backgroundColor: palette.raised }]}>
        <Text style={[styles.countText, { color: palette.muted }]}>{chats.length}</Text>
        {open ? <ChevronDown size={13} color={palette.muted} /> : <ChevronRight size={13} color={palette.muted} />}
      </View> : null}
    </Pressable>
    {many && open ? chats.map((chat) => <Pressable key={chat.id} accessibilityRole="button" accessibilityLabel={[chat.name, chat.state === "needs" ? "needs you" : chat.state === "working" ? "working" : ""].filter(Boolean).join(", ")} onPress={() => onOpen(chat.id)} style={({ pressed }) => [styles.tabRow, pressed && { backgroundColor: palette.raised }]}>
      <AgentMark id={chat.harness} size={14} color={palette.muted} />
      <Text numberOfLines={1} style={[styles.tabName, { color: palette.ink }]}>{chat.name}</Text>
      <StateMark state={chat.state} info={palette.info} warning={palette.warning} />
    </Pressable>) : null}
  </View>;
}

function connectionCopy(stage: string, attempt: number): { title: string; hint?: string } {
  if (stage === "connected") return { title: "Live · end-to-end encrypted" };
  if (stage === "unreachable") return { title: "Unreachable", hint: "Check that the Mac is awake and reachable over Wi-Fi, VPN, or relay." };
  if (stage === "cant-connect") return { title: `Can’t connect · attempt ${attempt}` };
  return { title: "Reconnecting…" };
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24, justifyContent: "center", gap: 12 },
  flex: { flex: 1 },
  screen: { flex: 1 },
  content: {},
  sticky: { position: "absolute", top: 0, left: 0, right: 0 },
  header: { gap: 10, paddingHorizontal: 20, paddingTop: 2, paddingBottom: 6 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 10 },
  hostName: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 9, minHeight: 44 },
  hostText: { flexShrink: 1, fontSize: 17, fontWeight: "600", letterSpacing: -0.4 },
  hostChevron: { height: 44, justifyContent: "center", marginLeft: -6 },
  offline: { flexDirection: "row", alignItems: "center", gap: 12 },
  offlineText: { flex: 1, fontSize: 13, lineHeight: 18 },
  retry: { minHeight: 34, paddingHorizontal: 14 },
  // As on the Mac: a project's folder at the edge, its branches a step in, quiet times at the end.
  time: { fontSize: 12, letterSpacing: 0, fontVariant: ["tabular-nums"], fontFamily: MONO },
  // Each level steps in to where its parent's name starts: project 20, branch 32, chat 58.
  project: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 20, marginTop: 14 },
  projectTitle: { flex: 1, fontSize: 17, fontWeight: "600", letterSpacing: -0.3 },
  channel: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 50, paddingRight: 20 },
  branchRow: { paddingLeft: 32 },
  titleRow: { paddingLeft: 32 },
  branchName: { flex: 1, fontSize: 15, fontFamily: MONO, letterSpacing: -0.2 },
  chatTitle: { flex: 1, fontSize: 16, letterSpacing: -0.3 },
  count: { flexDirection: "row", alignItems: "center", gap: 3, height: 22, borderRadius: 11, paddingLeft: 8, paddingRight: 5 },
  countText: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  // A branch's chats, a step further in, their marks under the branch's name.
  tabRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingLeft: 58, paddingRight: 20 },
  tabName: { flex: 1, fontSize: 15, letterSpacing: -0.2 },
});
