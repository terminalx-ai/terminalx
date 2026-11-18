import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, RefreshControl, SectionList, Settings, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { CloudOrganization, CloudWorkspaceItem } from "@mobile/cloud/api";
import { workspaceTitle } from "@mobile/cloud/catalog";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { cloudSections, emptyOrganizationsLabel } from "@mobile/cloud/list";
import { codeText, listStatus, roleLabel } from "@mobile/cloud/words";
import { agoTime } from "@mobile/data/session-list";
import { useApp } from "@mobile/state/AppProvider";
import { Button, EmptyState, StatusDot } from "@mobile/ui/primitives";
import { LargeTitle } from "@mobile/ui/glass";
import { usePullRefresh } from "@mobile/ui/pull-refresh";
import { Spinner } from "@mobile/ui/Spinner";
import { TopBar, useTopBar } from "@mobile/ui/top-bar";
import { useTabBarInset } from "@mobile/ui/tab-bar-inset";
import { useTheme } from "@mobile/ui/theme";

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";
/** Rows drawn while the first list is read, with none kept from before. */
const PLACEHOLDER_ROWS = 3;

/**
 * The account's cloud workspaces, by organization. This screen only reads the
 * list: opening it, pulling to refresh and coming back to it start nothing.
 * While it is on the screen the list is read again now and then, so a
 * workspace someone started or stopped elsewhere shows as such (#500).
 *
 * The title is drawn at once, in its place: the list keeps its own top inset,
 * under its own top bar, rather than waiting for the system to adjust it
 * (#988, #984). Until the first
 * list is read, the one kept from before is shown, or placeholder rows.
 */
export default function CloudScreen() {
  const app = useApp();
  const { palette } = useTheme();
  const bar = useTabBarInset();
  const top = useTopBar();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const [emptyOpen, setEmptyOpen] = useState(false);
  // The list is read again when the screen opens and now and then while it is shown: only a pull shows the spinner (#983).
  const pull = usePullRefresh(() => catalog?.refresh());

  useFocusEffect(useCallback(() => {
    void catalog?.refresh();
    return catalog?.watch();
  }, [catalog]));

  const { sections, empty } = useMemo(() => cloudSections(snapshot.organizations), [snapshot.organizations]);

  // `-openWorkspace <id>` at launch (with `-openRoute /cloud`) opens that workspace
  // once the list has it, as a tap on its row does: for simulator screenshots.
  const launchWorkspace = useRef(Platform.OS === "ios" ? Settings.get("openWorkspace") : undefined);
  useEffect(() => {
    const id = launchWorkspace.current;
    if (typeof id !== "string" || !snapshot.refreshedAt) return;
    const item = sections.flatMap((section) => section.data).find((entry) => entry.workspace.id === id);
    if (!item) return;
    launchWorkspace.current = undefined;
    router.push({ pathname: "/cloud/[workspaceId]", params: { workspaceId: item.workspace.id, orgId: item.workspace.orgId, title: workspaceTitle(snapshot, item.workspace) } });
  }, [router, sections, snapshot]);

  if (!app.session) return <View style={[styles.page, { backgroundColor: palette.page }]}><EmptyState title="Sign in for cloud workspaces" detail="Cloud workspaces belong to your TerminalX account." /><Button label="Sign in" onPress={() => void app.signIn()} />{app.error ? <Text accessibilityRole="alert" style={[styles.signInError, { color: palette.danger }]}>{app.error}</Text> : null}</View>;

  // Nothing read yet and nothing kept: rows stand in for the list, under the title, until it comes.
  const firstLoad = !snapshot.refreshedAt && !snapshot.saved && !snapshot.organizations.length && !snapshot.error;
  const open = (item: CloudWorkspaceItem) => router.push({ pathname: "/cloud/[workspaceId]", params: { workspaceId: item.workspace.id, orgId: item.workspace.orgId, title: workspaceTitle(snapshot, item.workspace) } });

  // The list scrolls under its own top bar, never over the status bar (#984).
  const { contentInset, contentOffset, scrollIndicatorInsets, paddingTop } = top.insets;
  return <View style={[styles.screen, { backgroundColor: palette.page }]}><SectionList sections={sections} keyExtractor={(item) => item.workspace.id} automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" contentInset={contentInset} contentOffset={contentOffset} scrollIndicatorInsets={scrollIndicatorInsets} onScroll={top.onScroll} scrollEventThrottle={16} stickySectionHeadersEnabled={false} style={{ backgroundColor: palette.page }}
    contentContainerStyle={[styles.content, { paddingTop: paddingTop + styles.content.paddingTop, paddingBottom: bar + 24 }]}
    refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={palette.accent} progressViewOffset={paddingTop} />}
    ListHeaderComponent={<><LargeTitle title="Cloud" onLayout={(event) => top.onTitleLayout(event, paddingTop + styles.content.paddingTop)} />{snapshot.error ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.warning }]}>{codeText(snapshot.error)}</Text> : null}</>}
    renderSectionHeader={({ section }) => <View style={styles.sectionHeader}><Text accessibilityRole="header" numberOfLines={1} style={[styles.sectionTitle, { color: palette.muted }]}>{section.title}</Text>{section.error ? <Text style={[styles.notice, { color: palette.warning }]}>{codeText(section.error)}</Text> : null}</View>}
    renderItem={({ item, index, section }) => <WorkspaceRow item={item} title={workspaceTitle(snapshot, item.workspace)} first={index === 0} last={index === section.data.length - 1} onPress={() => open(item)} />}
    ListEmptyComponent={firstLoad ? <Placeholders />
      : snapshot.error && !snapshot.organizations.length ? undefined
      : empty.length ? <Text style={[styles.empty, { color: palette.muted }]}>No cloud workspaces you can see.</Text>
      : <EmptyState title="No organizations" detail="Cloud workspaces of your organizations appear here." />}
    ListFooterComponent={empty.length ? <EmptyOrganizations organizations={empty} open={emptyOpen} onToggle={() => setEmptyOpen((value) => !value)} /> : undefined} /><TopBar title="Cloud" shown={top.shown} /></View>;
}

/**
 * A workspace as the Sessions list lists a session: its mark, its title, what
 * it is doing and when, then where it works. An organization's rows share one
 * card, as in the design: the first and last round it off.
 */
function WorkspaceRow({ item, title, first, last, onPress }: { item: CloudWorkspaceItem; title: string; first: boolean; last: boolean; onPress(): void }) {
  const { palette } = useTheme();
  const { workspace } = item;
  const status = listStatus(workspace);
  const role = roleLabel(workspace.you?.role);
  const providerLabel = workspace.providerDescriptor?.label;
  const provider = typeof providerLabel === "string" && providerLabel.trim() ? providerLabel : workspace.provider;
  const repository = workspace.repositories?.find((entry) => entry.primary)?.fullName ?? workspace.repositories?.[0]?.fullName ?? null;
  const branch = workspace.launch?.workBranch ?? null;
  const where = [provider, repository, branch].filter(Boolean).join(" · ");
  const when = workspace.lastActivityAt ? agoTime(workspace.lastActivityAt) : "";
  // What is said aloud also names the role (a manager's is assumed) and who else it is shared with.
  const facts = [status.words, role === "Manager" ? null : role, workspace.sharedWith ? `Shared with ${workspace.sharedWith}` : null, provider].filter(Boolean);
  // As the Sessions list colours its words (22.06): blue work, amber waits, red trouble, green running, grey rest.
  const tone = status.mark === "working" || status.mark === "changing" ? palette.info : status.mark === "needs" ? palette.warning : status.mark === "attention" ? palette.danger : status.mark === "running" ? palette.success : palette.muted;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${title}, ${facts.join(", ")}`} onPress={onPress} style={({ pressed }) => [styles.row, styles.cardRow, { backgroundColor: pressed ? palette.raised : palette.card, borderColor: palette.border }, first ? styles.cardTop : { borderTopColor: palette.border, borderTopWidth: StyleSheet.hairlineWidth }, last && styles.cardBottom]}>
    <View style={styles.mark}>{status.mark === "working" ? <Spinner size={18} color={palette.info} /> : <StatusDot color={tone} />}</View>
    <View style={styles.body}>
      <Text numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{title}</Text>
      <Text numberOfLines={1} style={[styles.status, { color: palette.muted }]}><Text style={[styles.words, { color: status.mark === "running" ? palette.muted : tone }]}>{status.words}</Text>{when ? ` · ${when}` : null}</Text>
      {where ? <Text numberOfLines={1} style={[styles.where, { color: palette.faint }]}>{where}</Text> : null}
    </View>
    <View style={styles.chevron}><ChevronRight size={18} color={palette.faint} /></View>
  </Pressable>;
}

/** The organizations with no workspaces, as one row at the end that opens to their names. */
function EmptyOrganizations({ organizations, open, onToggle }: { organizations: CloudOrganization[]; open: boolean; onToggle(): void }) {
  const { palette } = useTheme();
  const label = emptyOrganizationsLabel(organizations.length);
  return <View style={[styles.folded, { backgroundColor: palette.card, borderColor: palette.border }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={onToggle} style={({ pressed }) => [styles.foldedRow, pressed && { backgroundColor: palette.raised }]}>
      <Text numberOfLines={1} style={[styles.foldedText, { color: palette.muted }]}>{label}</Text>
      {open ? <ChevronDown size={18} color={palette.faint} /> : <ChevronRight size={18} color={palette.faint} />}
    </Pressable>
    {open ? organizations.map((organization) => <Text key={organization.orgId} numberOfLines={1} style={[styles.emptyName, { color: palette.muted, borderTopColor: palette.border }]}>{organization.name}</Text>) : null}
  </View>;
}

/** Rows in the list's shape, drawn while the first list is read. */
function Placeholders() {
  const { palette } = useTheme();
  return <View accessibilityLabel="Loading cloud workspaces" accessibilityRole="progressbar" testID="cloud-placeholders">
    <View style={[styles.barHeading, { backgroundColor: palette.raised }]} />
    <View style={[styles.folded, styles.placeholderCard, { backgroundColor: palette.card, borderColor: palette.border }]}>{Array.from({ length: PLACEHOLDER_ROWS }, (_, index) => <View key={index} style={[styles.row, styles.placeholderRow, index > 0 && { borderTopColor: palette.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
      <View style={[styles.barMark, { backgroundColor: palette.raised }]} />
      <View style={styles.body}>
        <View style={[styles.bar, { backgroundColor: palette.raised, width: `${[70, 55, 64][index % 3]}%` }]} />
        <View style={[styles.bar, styles.barLine, { backgroundColor: palette.raised }]} />
      </View>
    </View>)}</View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24, justifyContent: "center", gap: 12 },
  screen: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 6 },
  sectionHeader: { marginTop: 18, marginBottom: 8, paddingHorizontal: 4, gap: 3 },
  sectionTitle: { fontSize: 12, fontWeight: "600", letterSpacing: 0.84, textTransform: "uppercase" },
  signInError: { fontSize: 14, lineHeight: 19, textAlign: "center" },
  notice: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  empty: { fontSize: 15, paddingHorizontal: 4, paddingVertical: 14 },
  row: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", gap: 12, alignItems: "flex-start" },
  cardRow: { borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth },
  cardTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  cardBottom: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  chevron: { height: 21, justifyContent: "center" },
  mark: { width: 18, height: 21, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, lineHeight: 21, letterSpacing: -0.3, fontWeight: "600" },
  status: { marginTop: 2, fontSize: 13, lineHeight: 18 },
  words: { fontWeight: "600" },
  where: { marginTop: 3, fontFamily: MONO, fontSize: 12, lineHeight: 16 },
  folded: { marginTop: 14, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  placeholderCard: { marginTop: 0 },
  placeholderRow: { alignItems: "center" },
  foldedRow: { minHeight: 48, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10 },
  foldedText: { flex: 1, fontSize: 15 },
  emptyName: { fontSize: 15, lineHeight: 20, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  barHeading: { height: 10, width: "22%", borderRadius: 4, marginTop: 24, marginBottom: 12, marginHorizontal: 4 },
  // Placeholder rows as 22.06 draws them: a round mark, the title, and a fainter line under it.
  barMark: { width: 18, height: 18, borderRadius: 9 },
  bar: { height: 12, borderRadius: 6, marginTop: 2 },
  barLine: { width: "38%", marginTop: 8, opacity: 0.6 },
});
