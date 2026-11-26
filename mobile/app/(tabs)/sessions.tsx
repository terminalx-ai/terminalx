import { useCallback, useMemo, useState } from "react";
import { AppState, Pressable, RefreshControl, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ChevronDown, MoreHorizontal, Pin, Plus, Search, X } from "lucide-react-native";
import { chatRows, filterCounts, isCloudRow, LIST_FILTERS, listSections, PINNED_SECTION, withPinnedCloud, type ChatRow, type CloudPinRow, type ListFilter } from "@mobile/data/session-list";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { pinnedCloudRows } from "@mobile/cloud/pins";
import { useApp } from "@mobile/state/AppProvider";
import { useMacPins } from "@mobile/state/mac-pins";
import { connectionUsable, connectionWords, useConnectionState } from "@mobile/state/connection-view";
import { Button, EmptyState } from "@mobile/ui/primitives";
import { ConnectionLine } from "@mobile/ui/ConnectionLine";
import { usePullRefresh } from "@mobile/ui/pull-refresh";
import { MachineGlyph, useDeviceMenu } from "@mobile/ui/DeviceMenu";
import { MachineSwitcher } from "@mobile/ui/MachineSwitcher";
import { requestPairing } from "@mobile/state/pairing-request";
import type { PairedMachine } from "@mobile/state/machines";
import { GlassIconButton } from "@mobile/ui/glass";
import { SessionListRow } from "@mobile/ui/SessionListRow";
import { CloudWorkspaceRow } from "@mobile/ui/CloudWorkspaceRow";
import { EdgeFade } from "@mobile/ui/EdgeFade";
import { newSessionInBar, useTabBarInset } from "@mobile/ui/tab-bar-inset";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@mobile/ui/theme";

/** The filter last chosen, for as long as the app runs. */
const chosen: { filter: ListFilter } = { filter: "all" };
const rememberFilter = (filter: ListFilter) => { chosen.filter = filter; };

export default function SessionsScreen() {
  const app = useApp();
  const { palette } = useTheme();
  const router = useRouter();
  const [filter, setFilterState] = useState<ListFilter>(() => chosen.filter);
  const setFilter = (next: ListFilter) => { rememberFilter(next); setFilterState(next); };
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const insets = useSafeAreaInsets();
  const bar = useTabBarInset();
  const [headerHeight, setHeaderHeight] = useState(insets.top + 104);
  const [switching, setSwitching] = useState(false);
  // Where the top bar ends, for the dropdown under the name.
  const [topBarBottom, setTopBarBottom] = useState(48);
  // Row status facts are cached on the Mac; a silent refresh keeps them current while this list is in view.
  // A change on the Mac (a question, an approval) is pushed at once as `sessions.changed`; this only catches PR and workspace facts.
  useFocusEffect(useCallback(() => {
    const timer = setInterval(() => {
      if (AppState.currentState === "active" && app.connectionStage === "connected") void app.refreshSessions();
    }, 10_000);
    return () => clearInterval(timer);
  }, [app.connectionStage, app.refreshSessions]));
  const state = useConnectionState(app);
  const pull = usePullRefresh(app.refreshSessions);
  // Pairing lives on the Machines tab: Pair again and Add a machine go there with it open (PRO-465).
  const openPairing = () => { requestPairing(); router.navigate("/(tabs)"); };
  // Removing or disconnecting the computer from here goes back to the device list.
  const menu = useDeviceMenu({
    onRemoved: () => router.navigate("/(tabs)"),
    onPairAgain: openPairing,
    onDisconnect: () => { app.disconnectHost(); router.navigate("/(tabs)"); },
  });
  // What the Mac pinned (#1403): its sessions, and the cloud projects whose workspaces this phone's account can see.
  const pins = useMacPins();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const anyCloudPinned = Object.keys(pins.cloud).length > 0;
  // The cloud list is read when the Sessions list shows pinned cloud projects, as the Cloud tab reads it when it opens.
  useFocusEffect(useCallback(() => { if (anyCloudPinned) void catalog?.refresh(); }, [anyCloudPinned, catalog]));
  // Words typed in the search: results stay by project, pinned ones among them with their pin.
  const querying = query.trim().length > 0;
  const rows = useMemo(() => chatRows(app.sessions, query), [app.sessions, query]);
  const cloudRows = useMemo(() => pinnedCloudRows(snapshot, pins.cloud), [pins.cloud, snapshot]);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const sections = useMemo(() => withPinnedCloud(listSections(rows, filter, querying), cloudRows, filter, querying), [cloudRows, filter, querying, rows]);

  if (!app.activeHost) return <View style={[styles.page, { backgroundColor: palette.page }]}><EmptyState title="Choose a Mac" detail="Connect to a paired Mac before opening its sessions." /><Button label="Open Machines" onPress={() => router.navigate("/(tabs)")} /></View>;

  const host = app.activeHost;
  const connected = connectionUsable(state);
  const open = (row: ChatRow, tabId = row.tabId) => router.push({ pathname: "/session/[sessionId]", params: { sessionId: row.session.id, tabId, hostId: host.id, title: row.title } });
  const openCloud = (row: CloudPinRow) => router.push({ pathname: "/cloud/[workspaceId]", params: { workspaceId: row.item.workspace.id, orgId: row.orgId, title: row.title } });
  const closeSearch = () => { setQuery(""); setSearching(false); };
  const hostName = menu.nameOf(host);
  const current = menu.machines.paired.find((machine) => machine.id === host.id);
  // Another machine: connect to it, and this list shows its sessions (PRO-465).
  const choose = (machine: PairedMachine) => {
    setSwitching(false);
    if (machine.active) return;
    closeSearch();
    void app.connectHost(machine.host);
  };
  const empty = state === "updating" && !app.sessions.length ? <EmptyState title="Loading sessions" detail="Reading summaries from your Mac." />
    : query.trim() && !rows.length ? <EmptyState title="No matches" detail="No session's title, branch, project or tabs have those words." />
    : filter === "needs" && rows.length ? <EmptyState title="Nothing waits for you" detail="Sessions waiting for your answer or approval will appear here." />
    : filter === "working" && rows.length ? <EmptyState title="Nothing is working" detail="Sessions whose agent is working will appear here." />
    : connected ? <EmptyState title="No sessions" detail="Sessions running on this Mac will appear here." />
    : <EmptyState title="No saved sessions" detail="This Mac's sessions appear here once the phone connects." />;
  const waiting = filter === "needs" && counts.needs ? <Text style={[styles.footnote, { color: palette.muted }]}>{counts.needs === 1 ? "1 session is waiting for you." : `${counts.needs} sessions are waiting for you.`}</Text> : undefined;

  // The Mac, search and the filters stay at the top as the list scrolls under them, fading away there.
  const header = <View onLayout={({ nativeEvent }) => setHeaderHeight(nativeEvent.layout.height)} style={[styles.sticky, { paddingTop: insets.top }]}>
    <EdgeFade edge="top" height={headerHeight + 28} />
    {/* Solid behind the status area: the list fades under the header but is never drawn over the clock (#984). */}
    <View testID="top-bar-status" style={[styles.status, { height: insets.top, backgroundColor: palette.page }]} />
    <View style={styles.header}>
      {/* The Mac these sessions are on. */}
      <View style={styles.topBar} onLayout={({ nativeEvent }) => setTopBarBottom(nativeEvent.layout.y + nativeEvent.layout.height)}>
        {/* The Mac's name with a chevron, and beneath it the connection in the words every screen uses (#983).
            A tap opens "Switch machine"; a long press, like "…", opens its actions (PRO-465, 22.08). */}
        <Pressable accessibilityRole="button" accessibilityLabel={`Switch machine, ${hostName}`} accessibilityHint="Lists your paired machines" accessibilityValue={{ text: connectionWords(state) ?? undefined }} accessibilityActions={[{ name: "options", label: "Machine options" }]} onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "options") menu.open(host); }} onPress={() => setSwitching(true)} onLongPress={() => menu.open(host)} style={styles.hostName}>
          <MachineGlyph icon={current?.icon ?? "laptop"} color={palette.ink} size={21} />
          <View style={styles.hostTitles}>
            <View style={styles.nameLine}>
              <Text numberOfLines={1} style={[styles.hostText, { color: palette.ink }]}>{hostName}</Text>
              <ChevronDown size={16} color={palette.muted} strokeWidth={2} />
            </View>
            <ConnectionLine state={state} />
          </View>
        </Pressable>
        <View style={styles.flex} />
        {/* Only once the phone has really failed to reach the Mac: it keeps trying by itself meanwhile. */}
        {state === "waiting" ? <Button label="Try again" kind="secondary" onPress={app.retryConnection} style={styles.retry} /> : null}
        {state === "held" ? <Button label="Reconnect" kind="secondary" onPress={() => app.connection.restart("reconnect was chosen", true)} style={styles.retry} /> : null}
        <GlassIconButton label={searching ? "Close search" : "Search sessions"} size={40} icon={searching ? <X size={20} color={palette.ink} strokeWidth={1.6} /> : <Search size={20} color={palette.ink} strokeWidth={1.6} />} onPress={() => searching ? closeSearch() : setSearching(true)} />
        {/* Where the tab bar has no New session (Android): start one from here. */}
        {newSessionInBar() ? null : <GlassIconButton label="New session" size={40} icon={<Plus size={20} color={palette.ink} strokeWidth={1.8} />} onPress={() => router.push("/session/new")} />}
        <GlassIconButton label="Machine options" size={40} icon={<MoreHorizontal size={20} color={palette.ink} strokeWidth={1.8} />} onPress={() => menu.open(host)} />
      </View>
      {searching ? <View style={[styles.search, { backgroundColor: palette.raised, borderColor: palette.border }]}>
        <Search size={16} color={palette.muted} />
        <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="Search titles, branches, projects" placeholderTextColor={palette.faint} accessibilityLabel="Search sessions" autoCorrect={false} autoCapitalize="none" returnKeyType="search" clearButtonMode="while-editing" style={[styles.searchInput, { color: palette.ink }]} />
      </View> : null}
      {/* What the phone is opened for: everything, what waits on you, what is working. */}
      <View accessibilityRole="tablist" style={styles.filters}>
        {LIST_FILTERS.map((item) => {
          const on = filter === item.id;
          return <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={`${item.label}, ${counts[item.id]}`} hitSlop={{ top: 5, bottom: 5 }} onPress={() => setFilter(item.id)} style={[styles.filter, { backgroundColor: on ? palette.ink : palette.raised }]}>
            <Text style={[styles.filterText, { color: on ? palette.page : palette.ink }]}>{item.label}<Text style={styles.filterCount}>{`  ${counts[item.id]}`}</Text></Text>
          </Pressable>;
        })}
      </View>
    </View>
  </View>;

  const switcher = switching ? <MachineSwitcher machines={menu.machines.paired} top={insets.top + topBarBottom + 4} onChoose={choose} onAdd={() => { setSwitching(false); openPairing(); }} onClose={() => setSwitching(false)} /> : null;

  return <View style={[styles.screen, { backgroundColor: palette.page }]}>{menu.element}{switcher}<SectionList
    sections={sections}
    keyExtractor={(item) => item.key}
    contentInsetAdjustmentBehavior="never"
    keyboardShouldPersistTaps="handled"
    keyboardDismissMode="on-drag"
    stickySectionHeadersEnabled={false}
    style={{ backgroundColor: palette.page }}
    // The last row scrolls clear of the floating tab bar.
    contentContainerStyle={{ paddingTop: headerHeight + 4, paddingBottom: bar + 24 }}
    scrollIndicatorInsets={{ top: headerHeight, bottom: bar }}
    refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={palette.accent} progressViewOffset={headerHeight} />}
    renderSectionHeader={({ section }) => section.key === PINNED_SECTION
      // Pinned, with a pin as the Mac's sidebar draws it (02.04).
      ? <View accessibilityRole="header" accessibilityLabel="Pinned" style={styles.sectionLine}><Pin size={12} color={palette.muted} strokeWidth={2} /><Text numberOfLines={1} style={[styles.section, styles.sectionText, { color: palette.muted }]}>{section.title}</Text></View>
      : section.title ? <Text accessibilityRole="header" numberOfLines={1} style={[styles.section, { color: palette.muted }]}>{section.title}</Text> : null}
    renderSectionFooter={() => <View style={styles.sectionGap} />}
    renderItem={({ item, index, section }) => isCloudRow(item)
      ? <CloudWorkspaceRow item={item.item} title={item.title} cloud first={index === 0} last={index === section.data.length - 1} onPress={() => openCloud(item)} actions={pins.cloudActions(item.orgId, item.identity, item.title)} style={styles.cloudRow} />
      : <SessionListRow row={item} hostId={host.id} first={index === 0} last={index === section.data.length - 1} inPinned={section.key === PINNED_SECTION} actions={pins.sessionActions(item)} onOpen={(tabId) => open(item, tabId)} />}
    ListFooterComponent={waiting}
    ListEmptyComponent={empty}
  />{header}</View>;
}


const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24, justifyContent: "center", gap: 12 },
  flex: { flex: 1 },
  screen: { flex: 1 },
  sticky: { position: "absolute", top: 0, left: 0, right: 0 },
  status: { position: "absolute", top: 0, left: 0, right: 0 },
  header: { gap: 10, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 10 },
  hostName: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 9, minHeight: 44 },
  hostTitles: { flexShrink: 1, gap: 1 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  hostText: { flexShrink: 1, fontSize: 17, fontWeight: "600", letterSpacing: -0.4 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 8 },
  filters: { flexDirection: "row", gap: 8 },
  filter: { minHeight: 34, borderRadius: 10, paddingHorizontal: 12, justifyContent: "center" },
  filterText: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  filterCount: { opacity: 0.6 },
  retry: { minHeight: 34, paddingHorizontal: 14 },
  // A section's name over its card, as 22.04: small capitals, quiet.
  section: { fontSize: 12, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase", marginTop: 8, marginBottom: 8, marginHorizontal: 20 },
  sectionLine: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, marginBottom: 8, marginHorizontal: 20 },
  sectionText: { marginTop: 0, marginBottom: 0, marginHorizontal: 0, flexShrink: 1 },
  // A cloud row sits in the card its section's other rows do.
  cloudRow: { marginHorizontal: 16 },
  sectionGap: { height: 10 },
  footnote: { fontSize: 14, textAlign: "center", marginTop: 8 },
});
