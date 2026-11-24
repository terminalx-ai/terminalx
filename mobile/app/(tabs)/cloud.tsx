import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, RefreshControl, SectionList, Settings, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ChevronDown, ChevronRight, Plus } from "lucide-react-native";
import type { CloudOrganization, CloudWorkspaceItem } from "@mobile/cloud/api";
import { workspaceTitle } from "@mobile/cloud/catalog";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { cloudSections, emptyOrganizationsLabel, setupCandidates } from "@mobile/cloud/list";
import { codeText } from "@mobile/cloud/words";
import { workspaceProject } from "@mobile/cloud/pins";
import { workspaceRowActions } from "@mobile/cloud/setup/workspace/actions";
import { NoComputeCard, SetupCard, SetupFold } from "@mobile/cloud/setup/first-run/parts";
import { useSetupReads } from "@mobile/cloud/setup/first-run/reads";
import { focusOrganization, hrefs, managesSetup, personalFirst, setupModel, type SetupModel } from "@mobile/cloud/setup/first-run/steps";
import { CREATE_ELSEWHERE_FIRST, INTRO, LAUNCH_ANOTHER } from "@mobile/cloud/setup/first-run/words";
import { useApp } from "@mobile/state/AppProvider";
import { useMacPins } from "@mobile/state/mac-pins";
import { Button, EmptyState } from "@mobile/ui/primitives";
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
 *
 * With no workspace anywhere it is the first run (25.01): what is missing, as
 * four steps read from the server (the organization list, the providers, the
 * agent logins), each opening its own page. Once an organization has a
 * workspace the list is the page; an organization still being set up folds
 * to one row under the ones that have workspaces, and + in the title
 * launches another.
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
  const [setupOpen, setSetupOpen] = useState<string | null>(null);
  // Pinned on the connected Mac (#1403): a long press pins a workspace's project there, as its sidebar does.
  const macPins = useMacPins();

  const { sections, empty } = useMemo(() => cloudSections(snapshot.organizations), [snapshot.organizations]);
  // Organizations with no workspaces: their setup is read from the server (two GETs each; nothing starts).
  const candidates = useMemo(() => setupCandidates(snapshot.organizations), [snapshot.organizations]);
  const setup = useSetupReads(catalog, candidates);
  const candidatesNow = useRef(candidates);
  useEffect(() => { candidatesNow.current = candidates; });

  // The list is read again when the screen opens and now and then while it is shown: only a pull shows the spinner (#983).
  const pull = usePullRefresh(() => Promise.all([catalog?.refresh(), setup.refresh(candidatesNow.current)]).then(() => undefined));

  // Coming back to the tab reads the setup again (a step may have been done on its page); the first showing reads it already.
  const refreshSetup = useRef(setup.refresh);
  useEffect(() => { refreshSetup.current = setup.refresh; });
  const focusedBefore = useRef(false);
  useFocusEffect(useCallback(() => {
    void catalog?.refresh();
    if (focusedBefore.current) void refreshSetup.current(candidatesNow.current);
    focusedBefore.current = true;
    return catalog?.watch();
  }, [catalog]));

  const models = useMemo(() => new Map(candidates.map((organization) => [organization.orgId, setupModel({ organization, reads: setup.get(organization.orgId), chosen: setup.chosen === organization.orgId, createsOrganizations: snapshot.createsOrganizations === true })])), [candidates, setup, snapshot.createsOrganizations]);

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
  // A long press offers Pin project, then Stop workspace and Delete workspace… to whoever may manage it (25.06).
  const rowActions = (item: CloudWorkspaceItem) => [
    ...macPins.cloudActions(item.workspace.orgId, workspaceProject(item.workspace), workspaceTitle(snapshot, item.workspace)),
    ...(catalog ? workspaceRowActions(item, { catalog, push: (href) => router.push(href as never) }) : []),
  ];
  const open = (item: CloudWorkspaceItem) => router.push({ pathname: "/cloud/[workspaceId]", params: { workspaceId: item.workspace.id, orgId: item.workspace.orgId, title: workspaceTitle(snapshot, item.workspace) } });
  const go = (href: string) => router.push(href as never);
  const offline = snapshot.error !== null;

  // First run: no organization has a workspace (or the account has no organization yet).
  const firstRun = !firstLoad && sections.length === 0 && !(snapshot.error && !snapshot.organizations.length);
  const focus = firstRun ? focusOrganization(candidates, setup.chosen, (orgId) => models.get(orgId)?.progress === true) : null;
  const focusModel: SetupModel | null = focus ? models.get(focus.orgId) ?? null : firstRun && !snapshot.organizations.length && snapshot.refreshedAt !== null ? setupModel({ organization: null, reads: null, chosen: false, createsOrganizations: snapshot.createsOrganizations === true }) : null;
  // With workspaces: an organization is being set up once it was chosen, or the server's lists show something of it done.
  const settingUp = firstRun ? [] : personalFirst(candidates).filter((organization) => models.get(organization.orgId)?.chosen === true);
  const folded = empty.filter((organization) => !settingUp.some((entry) => entry.orgId === organization.orgId));
  // + launches for the organization that can: the one being set up once it may launch, else the first with workspaces.
  const launchFor = firstRun ? (focus && focusModel?.canLaunch ? focus.orgId : null) : settingUp.find((organization) => models.get(organization.orgId)?.canLaunch)?.orgId ?? sections[0]?.key ?? null;

  // The list scrolls under its own top bar, never over the status bar (#984).
  const { contentInset, contentOffset, scrollIndicatorInsets, paddingTop } = top.insets;
  return <View style={[styles.screen, { backgroundColor: palette.page }]}><SectionList sections={sections} keyExtractor={(item) => item.workspace.id} automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" contentInset={contentInset} contentOffset={contentOffset} scrollIndicatorInsets={scrollIndicatorInsets} onScroll={top.onScroll} scrollEventThrottle={16} stickySectionHeadersEnabled={false} style={{ backgroundColor: palette.page }}
    contentContainerStyle={[styles.content, { paddingTop: paddingTop + styles.content.paddingTop, paddingBottom: bar + 24 }]}
    refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={palette.accent} progressViewOffset={paddingTop} />}
    ListHeaderComponent={<><LargeTitle title="Cloud" onLayout={(event) => top.onTitleLayout(event, paddingTop + styles.content.paddingTop)}>{launchFor ? <GlassIconButton label={LAUNCH_ANOTHER} size={34} icon={<Plus size={18} color={palette.ink} />} onPress={() => go(hrefs.launch(launchFor))} testID="cloud-launch" /> : null}</LargeTitle>{snapshot.error ? <View style={styles.offline}><Notice tone="warning" text={codeText(snapshot.error) ?? undefined} /></View> : null}</>}
    renderSectionHeader={({ section }) => <View style={styles.sectionHeader}><Text accessibilityRole="header" numberOfLines={1} style={[styles.sectionTitle, { color: palette.muted }]}>{section.title}</Text>{section.error ? <Text style={[styles.notice, { color: palette.warning }]}>{codeText(section.error)}</Text> : null}</View>}
    renderItem={({ item, index, section }) => <CloudWorkspaceRow item={item} title={workspaceTitle(snapshot, item.workspace)} first={index === 0} last={index === section.data.length - 1} onPress={() => open(item)} actions={rowActions(item)} />}
    ListEmptyComponent={firstLoad ? <Placeholders />
      : !firstRun ? undefined
      : focusModel?.reading || (!focusModel && focus) ? <Placeholders />
      : focusModel ? <FirstRun focus={focus} model={focusModel} members={candidates.filter((organization) => organization.orgId !== focus?.orgId && !managesSetup(organization) && models.get(organization.orgId)?.noCompute)} offline={offline} createsOrganizations={snapshot.createsOrganizations === true} onOpen={go} />
      : undefined}
    ListFooterComponent={firstRun ? undefined : <>
      {settingUp.map((organization) => <View key={organization.orgId}>
        <SectionHeader title={organization.name} />
        <SetupFold model={models.get(organization.orgId)!} open={setupOpen === organization.orgId} onToggle={() => setSetupOpen((value) => (value === organization.orgId ? null : organization.orgId))} offline={offline} onOpen={go} />
      </View>)}
      {folded.length ? <EmptyOrganizations organizations={folded} open={emptyOpen} onToggle={() => setEmptyOpen((value) => !value)} /> : null}
    </>} /><TopBar title="Cloud" shown={top.shown} /></View>;
}

function SectionHeader({ title }: { title: string }) {
  const { palette } = useTheme();
  return <View style={styles.sectionHeader}><Text accessibilityRole="header" numberOfLines={1} style={[styles.sectionTitle, { color: palette.muted }]}>{title}</Text></View>;
}

/**
 * The first run (25.01): the organization being set up as one card of four
 * steps, under the intro until step 1 is done and under its name after;
 * above it, each organization where this person is a member that has no
 * compute yet. With no organization at all, step 1 creates one where the
 * server takes that from the phone, and otherwise says where it is made.
 */
function FirstRun({ focus, model, members, offline, createsOrganizations, onOpen }: { focus: CloudOrganization | null; model: SetupModel; members: CloudOrganization[]; offline: boolean; createsOrganizations: boolean; onOpen(href: string): void }) {
  const { palette } = useTheme();
  return <View testID="cloud-first-run">
    {members.map((organization) => <View key={organization.orgId}><SectionHeader title={organization.name} /><NoComputeCard organization={organization.name} /></View>)}
    {focus && model.chosen ? <SectionHeader title={focus.name} /> : <Text style={[styles.intro, { color: palette.muted }]}>{INTRO}</Text>}
    <View style={styles.firstRunCard}>
      {focus && model.noCompute ? <NoComputeCard organization={focus.name} /> : null}
      <SetupCard model={model} offline={offline} onOpen={onOpen} />
      {!focus && !createsOrganizations ? <Text style={[styles.note, { color: palette.muted }]}>{CREATE_ELSEWHERE_FIRST}</Text> : null}
    </View>
  </View>;
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
  offline: { marginTop: 10 },
  intro: { fontSize: 15, lineHeight: 21, paddingHorizontal: 4, marginTop: 14, marginBottom: 12 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  firstRunCard: { gap: 12 },
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
