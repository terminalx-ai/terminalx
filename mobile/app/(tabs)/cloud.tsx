import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, RefreshControl, SectionList, Settings, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { CloudOrganization, CloudWorkspaceItem } from "@mobile/cloud/api";
import { workspaceTitle } from "@mobile/cloud/catalog";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { cloudSections, emptyOrganizationsLabel } from "@mobile/cloud/list";
import { codeText, listStatus, roleLabel } from "@mobile/cloud/words";
import { shortTime } from "@mobile/data/session-list";
import { useApp } from "@mobile/state/AppProvider";
import { Button, EmptyState, StatusDot } from "@mobile/ui/primitives";
import { LargeTitle } from "@mobile/ui/glass";
import { StateMark } from "@mobile/ui/MacIcon";
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
 * The title is drawn at once, in its place: the list keeps its own top inset
 * rather than waiting for the system to adjust it (#988). Until the first
 * list is read, the one kept from before is shown, or placeholder rows.
 */
export default function CloudScreen() {
  const app = useApp();
  const { palette } = useTheme();
  const bar = useTabBarInset();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const [emptyOpen, setEmptyOpen] = useState(false);

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

  return <SectionList sections={sections} keyExtractor={(item) => item.workspace.id} contentInsetAdjustmentBehavior="never" stickySectionHeadersEnabled={false} style={{ backgroundColor: palette.page }}
    contentContainerStyle={[styles.content, { paddingTop: insets.top + 6, paddingBottom: bar + 24 }]}
    scrollIndicatorInsets={{ top: insets.top, bottom: bar }}
    refreshControl={<RefreshControl refreshing={snapshot.loading && !firstLoad} onRefresh={() => void catalog?.refresh()} tintColor={palette.accent} progressViewOffset={insets.top} />}
    ListHeaderComponent={<><LargeTitle title="Cloud" />{snapshot.error ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.warning }]}>{codeText(snapshot.error)}</Text> : null}</>}
    renderSectionHeader={({ section }) => <View style={styles.sectionHeader}><Text accessibilityRole="header" numberOfLines={1} style={[styles.sectionTitle, { color: palette.muted }]}>{section.title}</Text>{section.error ? <Text style={[styles.notice, { color: palette.warning }]}>{codeText(section.error)}</Text> : null}</View>}
    renderItem={({ item, index, section }) => <WorkspaceRow item={item} title={workspaceTitle(snapshot, item.workspace)} first={index === 0} last={index === section.data.length - 1} onPress={() => open(item)} />}
    ListEmptyComponent={firstLoad ? <Placeholders />
      : snapshot.error && !snapshot.organizations.length ? undefined
      : empty.length ? <Text style={[styles.empty, { color: palette.muted }]}>No cloud workspaces you can see.</Text>
      : <EmptyState title="No organizations" detail="Cloud workspaces of your organizations appear here." />}
    ListFooterComponent={empty.length ? <EmptyOrganizations organizations={empty} open={emptyOpen} onToggle={() => setEmptyOpen((value) => !value)} /> : undefined} />;
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
  const repository = workspace.repositories?.find((entry) => entry.primary)?.fullName ?? workspace.repositories?.[0]?.fullName ?? null;
  const branch = workspace.launch?.workBranch ?? null;
  const where = [repository, branch].filter(Boolean).join(" · ");
  const when = workspace.lastActivityAt ? shortTime(workspace.lastActivityAt) : "";
  // What is said aloud also names the role (a manager's is assumed) and who else it is shared with.
  const facts = [status.words, role === "Manager" ? null : role, workspace.sharedWith ? `Shared with ${workspace.sharedWith}` : null].filter(Boolean);
  const dot = status.mark === "attention" ? palette.danger : status.mark === "running" ? palette.success : status.mark === "changing" ? palette.info : palette.faint;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${title}, ${facts.join(", ")}`} onPress={onPress} style={({ pressed }) => [styles.row, styles.cardRow, { backgroundColor: pressed ? palette.raised : palette.card, borderColor: palette.border }, first ? styles.cardTop : { borderTopColor: palette.border, borderTopWidth: StyleSheet.hairlineWidth }, last && styles.cardBottom]}>
    <View style={styles.mark}>{status.mark === "needs" || status.mark === "working" ? <StateMark state={status.mark} info={palette.info} warning={palette.warning} /> : <StatusDot color={dot} />}</View>
    <View style={styles.body}>
      <Text numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{title}</Text>
      <Text numberOfLines={1} style={[styles.status, { color: status.mark === "needs" ? palette.warning : status.mark === "attention" ? palette.danger : palette.muted }]}>{status.words}{when ? <Text style={{ color: palette.faint }}>{` · ${when}`}</Text> : null}</Text>
      {where ? <Text numberOfLines={1} style={[styles.where, { color: palette.faint }]}>{where}</Text> : null}
    </View>
    <View style={styles.chevron}><ChevronRight size={16} color={palette.faint} /></View>
  </Pressable>;
}

/** The organizations with no workspaces, as one row at the end that opens to their names. */
function EmptyOrganizations({ organizations, open, onToggle }: { organizations: CloudOrganization[]; open: boolean; onToggle(): void }) {
  const { palette } = useTheme();
  const label = emptyOrganizationsLabel(organizations.length);
  return <View style={[styles.folded, { backgroundColor: palette.card, borderColor: palette.border }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={onToggle} style={({ pressed }) => [styles.foldedRow, pressed && { backgroundColor: palette.raised }]}>
      <Text numberOfLines={1} style={[styles.foldedText, { color: palette.muted }]}>{label}</Text>
      {open ? <ChevronDown size={16} color={palette.faint} /> : <ChevronRight size={16} color={palette.faint} />}
    </Pressable>
    {open ? organizations.map((organization) => <Text key={organization.orgId} numberOfLines={1} style={[styles.emptyName, { color: palette.muted, borderTopColor: palette.border }]}>{organization.name}</Text>) : null}
  </View>;
}

/** Rows in the list's shape, drawn while the first list is read. */
function Placeholders() {
  const { palette } = useTheme();
  return <View accessibilityLabel="Loading cloud workspaces" accessibilityRole="progressbar" testID="cloud-placeholders">
    <View style={[styles.barHeading, { backgroundColor: palette.raised }]} />
    <View style={[styles.folded, styles.placeholderCard, { backgroundColor: palette.card, borderColor: palette.border }]}>{Array.from({ length: PLACEHOLDER_ROWS }, (_, index) => <View key={index} style={[styles.row, index > 0 && { borderTopColor: palette.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
      <View style={styles.mark}><StatusDot color={palette.raised} /></View>
      <View style={styles.body}>
        <View style={[styles.barTitle, { backgroundColor: palette.raised, width: `${72 - index * 12}%` }]} />
        <View style={[styles.barLine, { backgroundColor: palette.raised }]} />
        <View style={[styles.barLine, { backgroundColor: palette.raised, width: "54%" }]} />
      </View>
    </View>)}</View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24, justifyContent: "center", gap: 12 },
  content: { paddingHorizontal: 16 },
  sectionHeader: { marginTop: 20, marginBottom: 8, paddingHorizontal: 4, gap: 3 },
  sectionTitle: { fontSize: 12, fontWeight: "600", letterSpacing: 0.7, textTransform: "uppercase" },
  signInError: { fontSize: 14, lineHeight: 19, textAlign: "center" },
  notice: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  empty: { fontSize: 15, paddingHorizontal: 4, paddingVertical: 14 },
  row: { minHeight: 68, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", gap: 12, alignItems: "flex-start" },
  cardRow: { borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth },
  cardTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  cardBottom: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  chevron: { height: 22, justifyContent: "center" },
  mark: { width: 16, height: 22, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 17, lineHeight: 22, letterSpacing: -0.3 },
  status: { fontSize: 14, lineHeight: 19 },
  where: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  folded: { marginTop: 20, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  placeholderCard: { marginTop: 0 },
  foldedRow: { minHeight: 48, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10 },
  foldedText: { flex: 1, fontSize: 15 },
  emptyName: { fontSize: 15, lineHeight: 20, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  barHeading: { height: 10, width: "22%", borderRadius: 4, marginTop: 24, marginBottom: 12, marginHorizontal: 4 },
  barTitle: { height: 15, borderRadius: 5, marginTop: 3, marginBottom: 4 },
  barLine: { height: 11, width: "40%", borderRadius: 4, marginTop: 3 },
});
