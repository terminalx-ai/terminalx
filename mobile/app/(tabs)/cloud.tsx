import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, RefreshControl, SectionList, Settings, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ChevronDown, ChevronRight, Plus } from "lucide-react-native";
import type { CloudOrganization, CloudWorkspaceItem } from "@mobile/cloud/api";
import { workspaceTitle } from "@mobile/cloud/catalog";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { cloudSections, emptyOrganizationsLabel } from "@mobile/cloud/list";
import { SETUP_TEXT, setupView, type SetupStepKey } from "@mobile/cloud/setup";
import { useSetupChoice } from "@mobile/cloud/setup-choice";
import { SETUP_PATHS, stepHref } from "@mobile/cloud/setup-routes";
import { useOrganizationSetups } from "@mobile/cloud/useSetup";
import { codeText } from "@mobile/cloud/words";
import { workspaceProject } from "@mobile/cloud/pins";
import { useApp } from "@mobile/state/AppProvider";
import { useMacPins } from "@mobile/state/mac-pins";
import { Button, EmptyState } from "@mobile/ui/primitives";
import { FoldedSetup, NoComputeCard, SetupCard } from "@mobile/ui/CloudSetup";
import { CloudWorkspaceRow } from "@mobile/ui/CloudWorkspaceRow";
import { GlassIconButton, LargeTitle } from "@mobile/ui/glass";
import { Notice } from "@mobile/ui/Notice";
import { usePullRefresh } from "@mobile/ui/pull-refresh";
import { TopBar, useTopBar } from "@mobile/ui/top-bar";
import { useTabBarInset } from "@mobile/ui/tab-bar-inset";
import { useTheme } from "@mobile/ui/theme";

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
 *
 * With no workspaces anywhere the page is the setup itself (25.01): the four
 * steps of the organization being set up, each read from the server, and the
 * button for the one to do next. Once other organizations have workspaces,
 * the one still being set up folds to a row under them.
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
  // Pinned on the connected Mac (#1403): a long press pins a workspace's project there, as its sidebar does.
  const macPins = useMacPins();
  // The list is read again when the screen opens and now and then while it is shown: only a pull shows the spinner (#983).
  const { sections, empty } = useMemo(() => cloudSections(snapshot.organizations), [snapshot.organizations]);

  // The organization being set up (25.01): the one chosen on this phone while it has no workspaces; on first
  // run, before anything was chosen, the personal one. How far its setup is, is the server's to say.
  const choice = useSetupChoice(app.ready === false ? undefined : app.session?.user.userId ?? null);
  const { store, setups } = useOrganizationSetups(catalog);
  const listed = sections.length > 0;
  const chosen = choice.orgId ? snapshot.organizations.find((entry) => entry.organization.orgId === choice.orgId) ?? null : null;
  const personal = snapshot.organizations.find((entry) => entry.organization.isPersonal && !entry.workspaces.length && !entry.error)?.organization ?? null;
  const settingUp = chosen && !chosen.workspaces.length && !chosen.error ? chosen.organization : null;
  // An account the service lists no organization for starts at the same step: creating one is on its page.
  const firstRun = choice.ready && !chosen && !listed;
  const firstOrganization = firstRun ? personal ?? snapshot.organizations[0]?.organization ?? null : null;
  const view = settingUp ? setupView(settingUp, true, setups.get(settingUp.orgId)) : firstRun ? setupView(firstOrganization, false, undefined) : null;
  // Someone who may not set up the chosen organization still sees their own, under it.
  const own = settingUp && view?.noCompute && personal && personal.orgId !== settingUp.orgId ? personal : null;
  const ownView = own ? setupView(own, true, setups.get(own.orgId)) : null;
  const readIds = [settingUp?.orgId, own?.orgId].filter((id): id is string => !!id).join(" ");
  const readSetups = useCallback(() => Promise.all(readIds.split(" ").filter(Boolean).map((id) => store?.read(id))), [readIds, store]);

  const pull = usePullRefresh(() => Promise.all([catalog?.refresh(), readSetups()]));

  useFocusEffect(useCallback(() => {
    void catalog?.refresh();
    // Also on coming back from a step's page: what it changed is read again.
    void readSetups();
    return catalog?.watch();
  }, [catalog, readSetups]));

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
  const pinActions = (item: CloudWorkspaceItem) => macPins.cloudActions(item.workspace.orgId, workspaceProject(item.workspace), workspaceTitle(snapshot, item.workspace));
  const open = (item: CloudWorkspaceItem) => router.push({ pathname: "/cloud/[workspaceId]", params: { workspaceId: item.workspace.id, orgId: item.workspace.orgId, title: workspaceTitle(snapshot, item.workspace) } });

  const openStep = (orgId: string | null) => (step: SetupStepKey) => router.push(stepHref(step, orgId));
  // The setup is the page while nothing is listed; then the service's warning is drawn as the board's notice.
  const setupPage = !listed && (settingUp || firstRun);
  const offline = snapshot.error === "cloud_workspace_unavailable" || !!view?.stale;
  // + launches another workspace (25.01): once the organization being set up can, and wherever one already has some.
  const launchIn = settingUp && view?.canLaunch ? settingUp.orgId : snapshot.organizations.find((entry) => entry.workspaces.length > 0)?.organization.orgId ?? null;
  const shownInSetup = new Set([settingUp?.orgId, firstOrganization?.orgId, own?.orgId]);
  const folded = empty.filter((organization) => !shownInSetup.has(organization.orgId));
  const setup = settingUp && view ? <>
    <SetupHeading title={settingUp.name} first={!listed && !snapshot.error} />
    {listed ? <FoldedSetup view={view} onPress={() => router.push(SETUP_PATHS.steps)} />
      : view.noCompute ? <NoComputeCard name={settingUp.name} />
      : <SetupCard testID="setup-card" view={view} offline={offline} onOpen={openStep(settingUp.orgId)} />}
    {!listed && own && ownView ? <><SetupHeading title={own.name} /><SetupCard testID="setup-card-own" view={ownView} offline={offline} button={false} onOpen={openStep(own.orgId)} /></> : null}
  </> : null;

  // The list scrolls under its own top bar, never over the status bar (#984).
  const { contentInset, contentOffset, scrollIndicatorInsets, paddingTop } = top.insets;
  return <View style={[styles.screen, { backgroundColor: palette.page }]}><SectionList sections={sections} keyExtractor={(item) => item.workspace.id} automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" contentInset={contentInset} contentOffset={contentOffset} scrollIndicatorInsets={scrollIndicatorInsets} onScroll={top.onScroll} scrollEventThrottle={16} stickySectionHeadersEnabled={false} style={{ backgroundColor: palette.page }}
    contentContainerStyle={[styles.content, { paddingTop: paddingTop + styles.content.paddingTop, paddingBottom: bar + 24 }]}
    refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={palette.accent} progressViewOffset={paddingTop} />}
    ListHeaderComponent={<><LargeTitle title="Cloud" onLayout={(event) => top.onTitleLayout(event, paddingTop + styles.content.paddingTop)}>{launchIn ? <GlassIconButton testID="launch-workspace" label="Launch a workspace" icon={<Plus size={22} color={palette.ink} />} onPress={() => router.push(stepHref("launch", launchIn))} /> : null}</LargeTitle>{snapshot.error ? setupPage ? <View style={styles.warning}><Notice tone="warning" text={codeText(snapshot.error) ?? undefined} /></View> : <Text accessibilityRole="alert" style={[styles.notice, { color: palette.warning }]}>{codeText(snapshot.error)}</Text> : null}</>}
    renderSectionHeader={({ section }) => <View style={styles.sectionHeader}><Text accessibilityRole="header" numberOfLines={1} style={[styles.sectionTitle, { color: palette.muted }]}>{section.title}</Text>{section.error ? <Text style={[styles.notice, { color: palette.warning }]}>{codeText(section.error)}</Text> : null}</View>}
    renderItem={({ item, index, section }) => <CloudWorkspaceRow item={item} title={workspaceTitle(snapshot, item.workspace)} first={index === 0} last={index === section.data.length - 1} onPress={() => open(item)} actions={pinActions(item)} />}
    ListEmptyComponent={firstLoad ? <Placeholders />
      : snapshot.error && !snapshot.organizations.length ? undefined
      : setup ? setup
      : firstRun && view ? <><Text style={[styles.intro, { color: palette.muted }]}>{SETUP_TEXT.intro}</Text><SetupCard testID="setup-card" view={view} offline={offline} onOpen={openStep(null)} /></>
      // What this phone kept of the setup is still being read: nothing is said of it on a guess.
      : undefined}
    ListFooterComponent={listed && setup || folded.length ? <>{listed ? setup : null}{folded.length ? <EmptyOrganizations organizations={folded} open={emptyOpen} onToggle={() => setEmptyOpen((value) => !value)} /> : null}</> : undefined} /><TopBar title="Cloud" shown={top.shown} /></View>;
}

/** The name of the organization being set up, over its steps, as a section of the list is headed. */
function SetupHeading({ title, first }: { title: string; first?: boolean }) {
  const { palette } = useTheme();
  return <View style={[styles.sectionHeader, first && styles.firstHeader]}><Text accessibilityRole="header" numberOfLines={1} style={[styles.sectionTitle, { color: palette.muted }]}>{title}</Text></View>;
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
  firstHeader: { marginTop: 4 },
  intro: { fontSize: 15, lineHeight: 21, marginHorizontal: 4, marginBottom: 14 },
  warning: { marginTop: 8, marginBottom: 4 },
  row: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", gap: 12, alignItems: "flex-start" },
  body: { flex: 1, minWidth: 0 },
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
