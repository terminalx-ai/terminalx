import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageSquareDashed, Play, Send, Square, Users } from "lucide-react-native";
import { interruptUnanswered, type AgentEvent } from "@terminalx/portable/events";
import type { PendingAsk, Turn } from "@terminalx/portable/transcript";
import { leaseHeldBy, NOTE_MAX_CHARS } from "@terminalx/portable/workspaceCollab";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { workspaceTitle, type CloudCatalog } from "@mobile/cloud/catalog";
import { MACHINE_GONE_KEPT, MACHINE_GONE_TEXT, MACHINE_GONE_TITLE, machineGone, resumeFailure, resumeRetryable, type ResumeFailure } from "@mobile/cloud/resume";
import type { CloudRole } from "@mobile/cloud/api";
import { failureCause, isLaunch, launchRefusal, stopState } from "@mobile/cloud/launch";
import { accessText, attentionDetail, codeText, connectionLine, leaseLine, outboxLine, presenceLine, roleLabel, rolePhrase, whoCanStart } from "@mobile/cloud/words";
import { PROVEN_BY_LIVE_CHECK, START_WORDS } from "@mobile/cloud/start-tab";
import type { CloudWorkspaceSession } from "@mobile/cloud/workspace";
import { setConversationState, useConversationState } from "@mobile/state/conversation-state";
import { useKeyboardShown, keyboardAvoidingBehavior } from "@mobile/ui/keyboard";
import { Button, EmptyState, StatusDot } from "@mobile/ui/primitives";
import { GlassIconButton } from "@mobile/ui/glass";
import { LaunchProgress } from "@mobile/ui/LaunchProgress";
import { Notice } from "@mobile/ui/Notice";
import { StartAgentSheet, type StartedTab } from "@mobile/ui/StartAgentSheet";
import { taskUnderWay, taskWaitEnds } from "@mobile/cloud/first-task";
import { HeaderLine, ScreenHeader } from "@mobile/ui/SessionChrome";
import { workspaceActions } from "@mobile/ui/workspace-actions";
import { WorkspaceActionsButton } from "@mobile/ui/WorkspaceActionsButton";
import { TranscriptList } from "@mobile/ui/TranscriptList";
import { useTheme } from "@mobile/ui/theme";
import { CompactingLine, PermissionCard, QuestionCard, TurnCard } from "@mobile/ui/transcript";
import { useIncrementalTranscript } from "@mobile/ui/useIncrementalTranscript";
import { linkedText } from "@mobile/ui/LinkedText";
import { CloudBotQuestions } from "@mobile/ui/CloudBotQuestions";

/**
 * One cloud workspace: its agent tabs and the conversation of the chosen one.
 * A running workspace is shown live. A stopped one is shown from its saved,
 * encrypted conversation, and opening this screen starts nothing: in place of
 * the composer it says so, with Start for someone who may start it (#988).
 * Under the title, one line says its state and the person's role.
 */
export default function CloudWorkspaceScreen() {
  const params = useLocalSearchParams<{ workspaceId: string; orgId?: string; tabId?: string; title?: string; operationId?: string }>();
  const { palette } = useTheme();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const orgId = params.orgId ?? snapshot.organizations.find((entry) => entry.workspaces.some((item) => item.workspace.id === params.workspaceId))?.organization.orgId ?? null;
  // What the list says of this person's access decides whether anything is opened at all.
  const access = catalog && orgId ? catalog.access(orgId, params.workspaceId) : "unknown";
  // Leaving lets go of the connection; nothing keeps a phone attached unseen.
  useEffect(() => (catalog && orgId && access === "ok" ? catalog.retain(orgId, params.workspaceId) : undefined), [catalog, orgId, params.workspaceId, access]);
  // While in front, the list is read now and then, so a start or stop from elsewhere shows (#500); not under a screen pushed over this one.
  useFocusEffect(useCallback(() => catalog?.watch(), [catalog]));
  const session = catalog && orgId && access === "ok" ? catalog.opened(orgId, params.workspaceId) : null;

  const listed = catalog && orgId ? catalog.workspace(orgId, params.workspaceId) : null;
  // Just shared? The list this phone holds may be from before: read it once before saying no.
  const [checked, setChecked] = useState<string | null>(null);
  const key = `${orgId}/${params.workspaceId}`;
  useEffect(() => {
    if (!catalog || access !== "not-shared" || checked === key) return;
    let current = true;
    void catalog.refresh().then(() => { if (current) setChecked(key); });
    return () => { current = false; };
  }, [catalog, access, checked, key]);
  const checking = access === "not-shared" && checked !== key;
  const closed = !checking && (access === "not-shared" || access === "deleted" || access === "gone") ? accessText(access) : null;
  // A launch is shown on the workspace's own page until it runs (25.05): the one this page was opened for, or
  // the one the list says is under way or failed. Once the person has moved past it, the workspace is shown.
  const latest = catalog && orgId ? snapshot.organizations.find((entry) => entry.organization.orgId === orgId)?.workspaces.find((item) => item.workspace.id === params.workspaceId)?.latestOperation : null;
  // A launch with a first task (25.09) goes on after the machine runs, until its agent runs or does not.
  // Read again when the wait for the runtime ends, so a task left unclaimed stops holding the page.
  const now = useNowUntil(taskWaitEnds(listed?.launch));
  const listedLaunch = listed && latest && isLaunch(latest) && (listed.state === "provisioning" || (listed.state === "attention-required" && latest.state === "failed") || taskUnderWay(listed.launch, now)) ? latest.id : null;
  const [past, setPast] = useState<string | null>(null);
  // The tab the launch's agent runs in: the conversation opens there.
  const [launchTab, setLaunchTab] = useState<string | null>(null);
  const launchId = params.operationId && past !== params.operationId ? params.operationId : listedLaunch && past !== listedLaunch ? listedLaunch : null;
  if (catalog && orgId && launchId && access !== "deleted") return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title: params.title ?? "Workspace", headerShown: false }} />
    <LaunchProgress key={launchId} catalog={catalog} orgId={orgId} operationId={launchId} title={(listed ? workspaceTitle(snapshot, listed) : null) ?? params.title ?? "Workspace"}
      onOpen={(tabId) => { setLaunchTab(tabId); setPast(launchId); }} onRetried={() => setPast(launchId)} onBack={() => router.back()}
      onDelete={(workspaceId) => router.push({ pathname: "/cloud/delete", params: { orgId, workspaceId } })}
      // The canceled launch's first task is put back in the form.
      onLaunchAgain={() => router.replace({ pathname: "/cloud/new", params: { orgId, from: params.workspaceId } })}
      onFixKey={() => router.push({ pathname: "/organization/[orgId]", params: { orgId } })}
      onAgentLogins={() => router.push({ pathname: "/agent-logins", params: { orgId } })} />
  </View>;
  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title: (listed ? workspaceTitle(snapshot, listed) : null) ?? params.title ?? "Workspace" }} />
    {!catalog ? <EmptyState title="Workspace unavailable" detail="Sign in, then open it again from the Cloud tab." />
      // Access ended, also while this screen was open: the conversation goes at once, with the reason.
      : closed ? <EmptyState title={closed.title} detail={closed.detail} />
      : session && orgId ? <Workspace key={`${orgId}/${params.workspaceId}`} catalog={catalog} session={session} orgId={orgId} workspaceId={params.workspaceId} listedState={listed?.state ?? null} initialTabId={launchTab ?? params.tabId ?? null} />
      : <EmptyState title="Checking access…" detail="Reading the list of workspaces from your account." busy />}
  </View>;
}

/** Names for user ids, re-read whenever one is learned. */
function useNames(catalog: CloudCatalog) {
  useSyncExternalStore(catalog.people.subscribe, catalog.people.getVersion, catalog.people.getVersion);
  return catalog.people.name;
}

/** The time now, read again when `at` passes (a lease's expiry), so what depends on it updates by itself. */
function useNowUntil(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [at]);
  return now;
}

function Workspace({ catalog, session, orgId, workspaceId, listedState, initialTabId }: { catalog: CloudCatalog; session: CloudWorkspaceSession; orgId: string; workspaceId: string; listedState: string | null; initialTabId: string | null }) {
  const { palette } = useTheme();
  const router = useRouter();
  const nameOf = useNames(catalog);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [chosen, setChosen] = useState<string | null>(initialTabId);
  // The runtime's word, which can be ahead of the list (and stays so if the list cannot be read): with no
  // role nothing of the workspace is shown, not its agent tabs' titles and not who else is in it.
  const unshared = snapshot.role === "none";
  const tab = unshared ? null : (snapshot.tabs.find((entry) => entry.tabId === chosen) ?? snapshot.tabs[0] ?? null);
  const tabId = tab?.tabId ?? null;
  const live = snapshot.connection.state === "connected";
  const starting = listedState === "suspended" && snapshot.outbox.some((entry) => (entry.state === "queued" || entry.state === "leased") && (entry.wake === "queued" || entry.wake === "in-progress"));
  const listed = catalog.workspace(orgId, workspaceId);
  const listing = useCatalogSnapshot(catalog);
  // The runtime's word on the role, else the list's while nothing is running.
  const roleNow: CloudRole | null = snapshot.role ?? listed?.you?.role ?? null;
  const line = connectionLine(snapshot.connection, listedState, snapshot.problem, starting, { role: roleNow, checking: snapshot.checkingAccess });
  // The link stopped trying by itself, or was refused: it tries again only when asked.
  const canReconnect = snapshot.connection.state === "stopped" && listedState === "ready";
  const title = listed ? workspaceTitle(listing, listed) : "Workspace";
  const sharing = listedState !== null && !unshared;
  // Stop, Start and Delete, for whoever the server lets do them (25.06), behind one more button beside Sharing.
  const item = listing.organizations.find((entry) => entry.organization.orgId === orgId)?.workspaces.find((held) => held.workspace.id === workspaceId) ?? null;
  const actions = unshared ? [] : workspaceActions({ catalog, item, openDelete: () => router.push({ pathname: "/cloud/delete", params: { orgId, workspaceId } }) });
  // Beside two buttons the line has less room: the role is then said in one word.
  const role = unshared ? null : sharing && actions.length ? roleLabel(roleNow) : rolePhrase(roleNow);
  const subtitle = [line.short, role].filter(Boolean).join(" · ");
  const stop = stopState(listed, item?.latestOperation);
  const stopped = listedState === "suspended";
  const scope = `${orgId}/${workspaceId}`;

  // New conversation and Add agent tab (25.10), for a manager the runtime lets start agents from a phone.
  const manager = roleNow === "manager";
  const offer = snapshot.startOffer;
  const [sheet, setSheet] = useState<{ kind: "conversation" | "tab"; replaces?: string } | null>(null);
  // What was typed in the sheet stays when it is closed, until a conversation starts with it.
  const [sheetText, setSheetText] = useConversationState(`cloud:${scope}:start-draft`, "");
  const [waking, setWaking] = useState(false);
  const [wakeFailure, setWakeFailure] = useState<string | null>(null);
  const [promptNotSent, setPromptNotSent] = useState<string | null>(null);
  const wake = () => {
    setWaking(true);
    setWakeFailure(null);
    void catalog.start(orgId, workspaceId).catch((error: unknown) => setWakeFailure(resumeFailure(error).text));
  };
  if (waking && live) setWaking(false);
  const openSheet = (kind: "conversation" | "tab", text?: string, replaces?: string) => {
    if (text !== undefined) setSheetText(text);
    if (!stopped) return setSheet({ kind, replaces });
    // Stopped: a new conversation starts it, which is billed, so it is asked first; then the sheet opens at once.
    Alert.alert(START_WORDS.startAsk, START_WORDS.startAskText, [
      { text: "Cancel", style: "cancel" },
      { text: "Start", onPress: () => { wake(); setSheet({ kind, replaces }); } },
    ]);
  };
  const started = ({ tabId: opened, promptNotSent: notSent, text }: StartedTab) => {
    const replaced = sheet?.replaces;
    if (sheet?.kind === "conversation") setSheetText("");
    setSheet(null);
    setChosen(opened);
    // The message a gone tab could not take went with the new conversation: it is let go of, and the gone tab with it.
    if (replaced) void session.cancel(replaced).catch(() => undefined).then(() => session.dismiss(replaced));
    // The conversation exists, but its first message may not have reached the agent: it waits in the composer.
    if (notSent) {
      setConversationState(`cloud:${scope}:${opened}:draft`, text);
      setPromptNotSent(opened);
    }
  };
  const startActions = manager && live && offer === "yes" && !unshared ? {
    newConversation: () => openSheet("conversation"),
    addTab: tab && !tab.gone && tab.sessionId ? () => openSheet("tab") : undefined,
  } : undefined;
  const actionsMessage = manager && live && offer === "old" ? START_WORDS.old : undefined;
  const allActions = unshared ? [] : workspaceActions({ catalog, item, openDelete: () => router.push({ pathname: "/cloud/delete", params: { orgId, workspaceId } }), start: startActions });
  const stopAction = allActions.find((action) => action.name === "stop");
  // A tab that is gone, for the conversation under it: what a manager can do about it, or who can.
  const goneHelp: GoneHelp = manager && offer === "yes" ? { kind: "button", run: (text, id) => openSheet("conversation", text, id) }
    : manager && offer === "old" ? { kind: "text", text: START_WORDS.old }
    : { kind: "text", text: START_WORDS.goneOther };
  const strip = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    if (tabId && snapshot.tabs[snapshot.tabs.length - 1]?.tabId === tabId) strip.current?.scrollToEnd({ animated: true });
  }, [tabId, snapshot.tabs]);

  useEffect(() => (tabId ? session.view(tabId) : undefined), [session, tabId]);
  // The names behind the user ids the runtime reports; without them a short id is shown.
  useEffect(() => { void catalog.people.roster(orgId).catch(() => undefined); }, [catalog, orgId]);
  const presence = presenceLine(snapshot.collab.participants, snapshot.collab.userId, (id) => snapshot.tabs.find((entry) => entry.tabId === id)?.title ?? null, nameOf);

  return <>
    {/* The bar a session has (22.06): back, the title over its state and the person's role as plain words, and Sharing. */}
    <Stack.Screen options={{ title, headerShown: false }} />
    <ScreenHeader title={title} onBack={() => router.back()}
      subtitle={<HeaderLine testID="workspace-state-line" text={subtitle} label={[line.tone === "live" ? line.text : line.short, role].filter(Boolean).join(", ")} />}
      trailing={<>{sharing ? <GlassIconButton label="Sharing" size={40} icon={<Users size={19} color={palette.ink} strokeWidth={1.9} />} onPress={() => router.push({ pathname: "/cloud/shares", params: { orgId, workspaceId } })} /> : null}<WorkspaceActionsButton title={title} actions={allActions} message={actionsMessage} /></>} />
    {/* A warning says more than fits under the title, here, with what can be done about it. */}
    {line.tone === "warn" ? <View accessibilityRole="summary" style={[styles.banner, { backgroundColor: `${palette.warning}18` }]}>
      <StatusDot color={palette.warning} />
      <Text style={[styles.bannerText, { color: palette.ink }]}>{line.text}</Text>
      {canReconnect ? <Pressable accessibilityRole="button" accessibilityLabel="Reconnect" onPress={() => { session.reconnect(); void catalog.refresh(); }} style={[styles.reconnect, { backgroundColor: palette.raised }]}><Text style={[styles.reconnectText, { color: palette.ink }]}>Reconnect</Text></Pressable> : null}
    </View> : null}
    {presence && !unshared ? <Text accessibilityLabel={presence} style={[styles.presence, { color: palette.muted }]}>{presence}</Text> : null}
    {snapshot.error ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.warning }]}>{codeText(snapshot.error)}</Text> : null}
    {/* The person's bots that live here ask here (PRO-482): answered without the Mac. */}
    {!unshared ? <CloudBotQuestions client={session.client} live={live} /> : null}
    {snapshot.tabs.length > 1 && !unshared ? <ScrollView ref={strip} horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsContent}>{snapshot.tabs.map((entry, index) => <Pressable key={entry.tabId} accessibilityRole="tab" accessibilityState={{ selected: entry.tabId === tabId }} onPress={() => setChosen(entry.tabId)} style={[styles.tab, { backgroundColor: entry.tabId === tabId ? palette.selected : palette.raised }]}><Text numberOfLines={1} style={[styles.tabText, { color: palette.ink }]}>{entry.title ?? `Agent ${index + 1}`}</Text></Pressable>)}</ScrollView> : null}
    {unshared ? <EmptyState title={accessText("not-shared").title} detail={accessText("not-shared").detail} />
      : tab ? <Conversation key={tab.tabId} catalog={catalog} session={session} scope={scope} orgId={orgId} workspaceId={workspaceId} tabId={tab.tabId} live={live} listedState={listedState} stop={stop}
        goneHelp={goneHelp} promptNotSent={promptNotSent === tab.tabId} />
      : <View style={styles.flex}>
        <View style={[styles.flex, styles.centred]}>{live || (manager && (stopped || waking) && !starting) ? <EmptyStart manager={manager} offer={live ? offer : "yes"} disabled={!!sheet || waking}
            onStart={() => openSheet("conversation")} onStop={PROVEN_BY_LIVE_CHECK.stopAndStartReplacesRuntime && stopAction ? stopAction.run : undefined} />
          : stopped || starting || listedState === "attention-required" ? <EmptyState icon={(color) => <MessageSquareDashed size={34} color={color} strokeWidth={1.6} />} title="No conversation yet" detail={listedState === "attention-required" ? "Nothing has been saved in this workspace yet." : "Nothing was said in this workspace before it stopped."} />
          : listedState === "archived" ? <EmptyState title="No conversation yet" detail="Nothing was saved in this workspace before it was archived." />
          : <EmptyState title="Connecting…" detail="The conversation shows once this phone reaches the workspace." busy />}</View>
        {startBarShown(listedState, starting, live, stop) ? <StartBar catalog={catalog} orgId={orgId} workspaceId={workspaceId} role={roleNow} creatorId={listed?.createdBy ?? null} starting={starting} /> : null}
      </View>}
    {sheet ? <StartAgentSheet kind={sheet.kind} session={session} snapshot={snapshot} sessionId={tab?.sessionId ?? null} from={tab && !tab.gone ? tab.settings : null} text={sheetText} onText={setSheetText}
      waking={waking && !live} wakeFailure={live ? null : wakeFailure} onRetryWake={wake} onStarted={started} onClose={() => setSheet(null)} /> : null}
  </>;
}

/** What a gone tab's unsent message has under it (25.10): New conversation for a manager who can start one, else a sentence. */
type GoneHelp = { kind: "button"; run(text: string, clientCommandId: string): void } | { kind: "text"; text: string };

/**
 * A running workspace with no conversation (25.10): a manager can start one
 * here; on a runtime too old for that they are told to restart it; anyone
 * else is told who can. While the runtime has not said yet, nothing is offered.
 */
function EmptyStart({ manager, offer, disabled, onStart, onStop }: { manager: boolean; offer: "yes" | "old" | "no" | null; disabled: boolean; onStart(): void; onStop?(): void }) {
  const icon = (color: string) => <MessageSquareDashed size={34} color={color} strokeWidth={1.6} />;
  if (offer === null) return <EmptyState icon={icon} title={START_WORDS.emptyTitle} detail="" busy />;
  if (!manager || offer === "no") return <EmptyState icon={icon} title={START_WORDS.emptyTitle} detail={START_WORDS.emptyOther} />;
  if (offer === "old") return <View testID="empty-old">
    <EmptyState icon={icon} title={START_WORDS.emptyTitle} detail={START_WORDS.old} />
    {onStop ? <View style={styles.emptyAction}><Button label="Stop workspace" kind="secondary" onPress={onStop} /></View> : null}
  </View>;
  return <View testID="empty-start">
    <EmptyState icon={icon} title={START_WORDS.emptyTitle} detail={START_WORDS.emptyManager} />
    <View style={styles.emptyAction}><Button testID="empty-start-button" label={START_WORDS.emptyButton} disabled={disabled} onPress={onStart} /></View>
  </View>;
}

/** Whether the composer's place holds the Start bar: stopped, stopping, or starting and not running yet. */
function startBarShown(listedState: string | null, starting: boolean, live: boolean, stop: "stopping" | "failed" | null = null): boolean {
  // Stopping, or a stop that failed: the composer is gone, and the bar says which (25.06).
  return stop !== null || listedState === "suspended" || listedState === "resuming" || listedState === "provisioning" || (listedState === "attention-required" && !live) || starting;
}

/**
 * In place of the composer while a workspace is stopped: Start, for its
 * managers (the server lets only them), and who can start it for a viewer. A
 * driver keeps the composer, whose message starts it (see `Conversation`).
 * Starting it is billed, so it is asked first. When it runs, the composer is back.
 */
function StartBar({ catalog, orgId, workspaceId, role, creatorId, starting }: { catalog: CloudCatalog; orgId: string; workspaceId: string; role: CloudRole | null; creatorId: string | null; starting: boolean }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const nameOf = useNames(catalog);
  const [asking, setAsking] = useState(false);
  // One request at a time, also between a tap and the render that disables the button.
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<ResumeFailure | null>(null);
  // No answer came, but the list shows it starting: said as under way, not as a failure (#1290).
  const [unconfirmed, setUnconfirmed] = useState(false);
  const listedWorkspace = catalog.workspace(orgId, workspaceId);
  const listedState = listedWorkspace?.state ?? null;
  const changing = starting || asking || listedState === "resuming" || listedState === "provisioning";
  const mayStart = role === "manager";
  const needsAttention = listedState === "attention-required";
  const operation = catalog.getSnapshot().organizations.find((entry) => entry.organization.orgId === orgId)?.workspaces.find((item) => item.workspace.id === workspaceId)?.latestOperation;
  // As the desktop offers it: any failed resume can be retried; the detail says what failed and what else may be needed.
  const retryResume = needsAttention && resumeRetryable(operation, listedWorkspace);
  // Stopping, or a stop the provider did not carry out (25.06): said here, with the retry the console offers.
  const stop = stopState(catalog.workspace(orgId, workspaceId), operation);
  const [stopRefusal, setStopRefusal] = useState<string | null>(null);
  const router = useRouter();
  const listedRepositories = catalog.workspace(orgId, workspaceId)?.repositories;
  const fullName = listedRepositories?.find((entry) => entry.primary)?.fullName ?? listedRepositories?.[0]?.fullName ?? null;
  const repository = fullName ? `https://github.com/${fullName}` : null;
  const retryStop = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setAsking(true);
    setStopRefusal(null);
    void catalog.stop(orgId, workspaceId).catch((error: unknown) => setStopRefusal(launchRefusal(error).text)).finally(() => {
      inFlight.current = false;
      setAsking(false);
    });
  };
  // The machine is gone (#1581), as the server says since #1589: nothing to retry. Delete the workspace, or launch a new one in its organization.
  if (needsAttention && machineGone(operation, listedWorkspace)) return <View testID="machine-gone-bar" style={[styles.startBar, styles.goneBar, { backgroundColor: palette.card, borderColor: palette.border, marginBottom: insets.bottom + 8 }]}>
    <Text style={[styles.startTitle, { color: palette.ink }]}>{MACHINE_GONE_TITLE}</Text>
    <Text style={[styles.startDetail, { color: palette.muted }]}>{MACHINE_GONE_TEXT} {MACHINE_GONE_KEPT}</Text>
    {mayStart
      ? <View style={styles.goneActions}>
        <Button testID="machine-gone-delete" label="Delete workspace…" kind="secondary" size="small" onPress={() => router.push({ pathname: "/cloud/delete", params: { orgId, workspaceId } })} />
        <Button testID="machine-gone-new" label="New workspace" size="small" onPress={() => router.push({ pathname: "/cloud/new", params: repository ? { orgId, repository } : { orgId } })} />
      </View>
      : <Text style={[styles.startDetail, { color: palette.muted }]}>{creatorId ? `${nameOf(creatorId)}, its creator, or an organization owner or admin` : "Its creator or an organization owner or admin"} can delete it.</Text>}
  </View>;
  if (stop) return <View testID="stop-bar" style={[styles.startBar, { backgroundColor: palette.card, borderColor: palette.border, marginBottom: insets.bottom + 8 }]}>
    <View style={styles.flex}>
      <Text style={[styles.startTitle, { color: palette.ink }]}>{stop === "stopping" ? "Stopping the workspace…" : "It did not stop"}</Text>
      <Text style={[styles.startDetail, { color: palette.muted }]}>{stop === "stopping" ? "Saving the workspace, then suspending the machine." : `${failureCause({ errorCode: operation?.errorCode ?? undefined })} It may still be running, and billing.`}</Text>
      {stopRefusal ? <Text accessibilityRole="alert" style={[styles.startDetail, { color: palette.danger }]}>{stopRefusal}</Text> : null}
    </View>
    {stop === "stopping" ? <Button label="Stopping…" kind="secondary" size="small" disabled /> : mayStart ? <Button label={asking ? "Stopping…" : "Retry stop"} size="small" disabled={asking} onPress={retryStop} /> : null}
  </View>;
  const start = () => Alert.alert(retryResume ? "Retry resume?" : failure ? "Try starting again?" : "Start this workspace?", "It is billed to the organization while it runs.", [
    { text: "Cancel", style: "cancel" },
    { text: retryResume ? "Retry resume" : failure ? "Try again" : "Start", onPress: () => {
      if (inFlight.current) return;
      inFlight.current = true;
      setAsking(true);
      setFailure(null);
      setUnconfirmed(false);
      void catalog.start(orgId, workspaceId).then((outcome) => setUnconfirmed(outcome === "in-progress"), (error: unknown) => setFailure(resumeFailure(error))).finally(() => {
        inFlight.current = false;
        setAsking(false);
      });
    } },
  ]);
  const detail = changing ? (unconfirmed ? "The service has not confirmed yet, but the workspace is starting. The composer appears when it is running." : "The composer appears when it is running.")
    : needsAttention ? (retryResume ? (mayStart ? `${attentionDetail(operation?.errorCode)} Retry resume, or open it on the desktop to see more.` : `${attentionDetail(operation?.errorCode)} ${creatorId ? `${nameOf(creatorId)}, its creator, or an organization owner or admin` : "Its creator or an organization owner or admin"} can retry resume.`) : "This workspace needs attention. Open it on the desktop to see how to recover.")
    : mayStart ? "Start it to send a message." : whoCanStart(creatorId ? nameOf(creatorId) : null);
  const label = changing ? "Starting…" : retryResume ? "Retry resume" : failure?.retry ? "Try again" : "Start";
  // In the composer's place, as a card like it (22.06).
  return <View testID="start-bar" style={[styles.startBar, { backgroundColor: palette.card, borderColor: palette.border, marginBottom: insets.bottom + 8 }]}>
    <View style={styles.flex}>
      <Text style={[styles.startTitle, { color: palette.ink }]}>{changing ? "Starting the workspace…" : needsAttention ? "This workspace needs attention" : failure ? "The workspace did not start" : "This workspace is stopped"}</Text>
      <Text style={[styles.startDetail, { color: palette.muted }]}>{detail}</Text>
      {/* A refusal is about the last Start: once the workspace starts after all (from elsewhere too), it is past. */}
      {failure && !changing ? <Text accessibilityRole="alert" style={[styles.startDetail, { color: palette.danger }]}>{failure.text}</Text> : null}
    </View>
    {mayStart && (!needsAttention || retryResume) && (!failure || failure.retry || changing) ? <Button label={label} size="small" icon={changing ? undefined : (color) => <Play size={14} color={color} />} disabled={changing} onPress={start} /> : null}
  </View>;
}

const EMPTY_EVENTS: readonly AgentEvent[] = [];
const keyOfTurn = (turn: Turn) => turn.key;
const renderCloudTurn = ({ item }: { item: Turn }) => <TurnCard turn={item} deliveredTo="workspace" />;

function Conversation({ catalog, session, scope, orgId, workspaceId, tabId, live, listedState, stop, goneHelp, promptNotSent }: { catalog: CloudCatalog; session: CloudWorkspaceSession; scope: string; orgId: string; workspaceId: string; tabId: string; live: boolean; listedState: string | null; stop: "stopping" | "failed" | null; goneHelp: GoneHelp; promptNotSent: boolean }) {
  const { palette } = useTheme();
  // Docked at the bottom: clear of the home indicator and the screen's rounded corners, as the session screen's composer is.
  const insets = useSafeAreaInsets();
  const keyboardShown = useKeyboardShown();
  const dockBottom = { paddingBottom: (keyboardShown ? 0 : insets.bottom) + 12 };
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const tab = snapshot.tabs.find((entry) => entry.tabId === tabId);
  const [draft, setDraft] = useConversationState(`cloud:${scope}:${tabId}:draft`, "");
  const [sending, setSending] = useState(false);
  const answeringQuestion = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const nameOf = useNames(catalog);
  const [notesOpen, setNotesOpen] = useState(false);
  const [note, setNote] = useConversationState(`cloud:${scope}:${tabId}:note`, "");
  const shared = snapshot.collab.available;
  const lease = snapshot.collab.leases[tabId] ?? null;
  const now = useNowUntil(lease?.expiresAt ?? null);
  const wheel = leaseLine(lease, snapshot.collab.userId, snapshot.role, now, nameOf);
  const notes = snapshot.collab.notes[tabId] ?? [];
  const events = tab?.events;
  // A compaction is shown as running only while the tab's live feed has caught up; otherwise its status is unknown (#644).
  const continuous = tab?.continuous === true;
  const transcript = useIncrementalTranscript(events ?? EMPTY_EVENTS, live, continuous);
  const outbox = snapshot.outbox.filter((entry) => entry.tabId === tabId);
  const pending = outbox.filter((entry) => entry.kind !== "permission-decision" && outboxLine(entry, listedState === "suspended", nameOf));

  const mayWrite = snapshot.role === "manager" || snapshot.role === "driver";
  const stopped = listedState === "suspended";
  // Asked to start by a message that is on its way: the workspace is starting, as far as anyone here can tell.
  const starting = stopped && snapshot.outbox.some((entry) => (entry.state === "queued" || entry.state === "leased") && (entry.wake === "queued" || entry.wake === "in-progress"));
  // Written earlier and still on the phone, for a workspace that is stopped now: held until the person says to start it.
  // Also what the server holds for a workspace that stopped before it was delivered: nothing starts it until the person says so.
  const held = stopped ? outbox.filter((entry) => entry.state === "unsent" || entry.asleep) : [];
  const roleHere: CloudRole | null = snapshot.role ?? catalog.workspace(orgId, workspaceId)?.you?.role ?? null;
  // A driver may not start a stopped workspace with Start (/resume is for its managers), but a message they
  // queue wakes it (contract §11.2): for them the composer stays, and sending asks first, as it always has.
  const sendStarts = stopped && !starting && roleHere === "driver";
  const working = tab?.status === "in_progress";
  // Stop is Escape first (#427), as on the desktop: the turn is interrupted and the agent's process stays. While the
  // turn it was sent to is still the one running, the same button is the stop that ends the process. A runtime that
  // cannot take an interrupt (older, or not connected) only has that stop.
  const [interruptedAt, setInterruptedAt] = useState<number | null>(null);
  if (!working && interruptedAt !== null) setInterruptedAt(null);
  const unanswered = working && interruptUnanswered(events ?? [], interruptedAt);

  const run = async (action: () => Promise<unknown>, done?: () => void) => {
    setSending(true);
    setFailure(null);
    try {
      await action();
      done?.();
      // The list says when a workspace that was asked to start is running.
      void catalog.refresh();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const holder = leaseHeldBy(error);
      setFailure(holder ? `${nameOf(holder.holderId)} is driving this tab.` : (codeText(typeof code === "string" ? code : null) ?? "That did not work."));
    } finally {
      setSending(false);
    }
  };

  /** The one question that comes before anything here starts a stopped workspace. */
  const confirmStart = (what: string, go: () => Promise<unknown>, done?: () => void) =>
    Alert.alert("Start this workspace?", `It is stopped. ${what} starts it, and it is billed to the organization while it runs.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Start and send", onPress: () => void run(go, done) },
    ]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const start = () => confirmStart("Sending this message", () => session.send(tabId, text, { allowWake: true }), () => setDraft(""));
    if (stopped) return start();
    setSending(true);
    setFailure(null);
    try {
      await session.send(tabId, text);
      setDraft("");
      void catalog.refresh();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      // It was stopped from elsewhere since this screen last heard: ask, as for any stopped workspace.
      if (code === "would-wake") start();
      else setFailure(codeText(typeof code === "string" ? code : null) ?? "That did not work.");
    } finally {
      setSending(false);
    }
  };

  const sendHeld = () => confirmStart(held.length === 1 ? "Sending the message that is waiting" : `Sending the ${held.length} messages that are waiting`, () => session.deliverHeld({ allowWake: true }));

  const stopAgent = () => {
    if (!snapshot.interrupts || unanswered) return void run(() => session.stop(tabId));
    // Read now, not at the last render: the turn this is for may have ended since.
    const seen = session.getSnapshot().tabs.find((entry) => entry.tabId === tabId)?.events ?? [];
    setInterruptedAt(seen.length ? seen[seen.length - 1].seq : 0);
    void run(() => session.interrupt(tabId));
  };

  const decide = (ask: PendingAsk, optionId: string) => void run(() => session.decide(tabId, { requestId: ask.requestId, optionId }));
  // A question is answered as the desktop answers a cloud tab's: the same decision command, carrying the answers (#979).
  // One at a time: a second tap lands before the first one's render, and would only be told the question is already answered.
  const answer = (ask: PendingAsk, answers: Record<string, string>) => {
    if (answeringQuestion.current) return;
    answeringQuestion.current = true;
    void run(() => session.decide(tabId, { requestId: ask.requestId, answers })).finally(() => { answeringQuestion.current = false; });
  };
  /** What the runtime said of this phone's answer when it would not take it: someone answered first. */
  const refusedAnswer = (ask: PendingAsk) => {
    const entry = outbox.find((item) => item.kind === "permission-decision" && item.requestId === ask.requestId && item.state === "rejected");
    return entry ? codeText(entry.category) ?? "That answer was not taken." : undefined;
  };

  const addNote = () => {
    const text = note.trim();
    if (!text || sending) return;
    void run(() => session.postNote(tabId, text), () => setNote(""));
  };

  return <KeyboardAvoidingView style={styles.flex} behavior={keyboardAvoidingBehavior()} keyboardVerticalOffset={92}>
    {shared ? <View style={[styles.wheel, { borderBottomColor: palette.border }]}>
      <Text accessibilityLabel={wheel.text} numberOfLines={1} style={[styles.wheelText, { color: wheel.mine ? palette.accent : palette.muted }]}>{wheel.text}</Text>
      {wheel.canTake ? <Pressable accessibilityRole="button" disabled={sending} onPress={() => void run(() => session.takeWheel(tabId))} style={styles.wheelAction}><Text style={[styles.wheelActionText, { color: palette.accent }]}>Take the wheel</Text></Pressable> : null}
      {wheel.canRelease ? <Pressable accessibilityRole="button" disabled={sending} onPress={() => void run(() => session.releaseWheel(tabId))} style={styles.wheelAction}><Text style={[styles.wheelActionText, { color: palette.accent }]}>Release</Text></Pressable> : null}
      {wheel.canTakeOver ? <Pressable accessibilityRole="button" disabled={sending} onPress={() => void run(() => session.takeOverWheel(tabId))} style={styles.wheelAction}><Text style={[styles.wheelActionText, { color: palette.accent }]}>Take over</Text></Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: notesOpen }} onPress={() => setNotesOpen((open) => !open)} style={styles.wheelAction}><Text style={[styles.wheelActionText, { color: palette.ink }]}>{`Notes${notes.length ? ` (${notes.length})` : ""}`}</Text></Pressable>
    </View> : null}
    {shared && notesOpen ? <View style={[styles.notes, { backgroundColor: palette.card, borderBottomColor: palette.border }]}>
      <Text style={[styles.notesHint, { color: palette.muted }]}>Notes are for the people here. They are not sent to the agent.</Text>
      <ScrollView style={styles.notesList}>{notes.length ? notes.map((entry) => <Text key={entry.id} selectable style={[styles.noteLine, { color: palette.ink }]}><Text style={{ color: palette.accent, fontWeight: "700" }}>{entry.authorId === snapshot.collab.userId ? "You" : nameOf(entry.authorId)}</Text>{"  "}{linkedText(entry.text)}</Text>) : <Text style={[styles.notesHint, { color: palette.muted }]}>No notes yet.</Text>}</ScrollView>
      <View style={styles.composeLine}>
        <TextInput value={note} onChangeText={setNote} multiline maxLength={NOTE_MAX_CHARS} placeholder="Add a note for people here" placeholderTextColor={palette.faint} style={[styles.input, { color: palette.ink }]} />
        <Button label="Add note" kind="secondary" disabled={!note.trim() || sending} onPress={addNote} />
      </View>
    </View> : null}
    {/* Opens at the newest turn, as the desktop and the session screen do; the asks and messages waiting sit at that edge. */}
    <TranscriptList key={tabId ?? "none"} data={transcript.turns} keyExtractor={keyOfTurn}
      earlier={tab?.truncated ? <Text style={[styles.notice, { color: palette.muted }]}>Earlier messages are not in the saved conversation.</Text> : null}
      ListEmptyComponent={tab?.noKey ? <EmptyState title="Not readable on this phone yet" detail={codeText("no-key")!} /> : <EmptyState title="No conversation yet" detail={live ? "This tab has not published any turns." : "Nothing has been saved for this tab."} />}
      renderItem={renderCloudTurn}
      latest={<>
        {transcript.compacting ? <CompactingLine /> : null}
        {transcript.pendingAsks.map((ask) => ask.kind === "questions"
          // The question and its options are for everyone here; answering is for those who may approve.
          ? <QuestionCard key={ask.requestId} ask={ask} stateKey={`cloud:${scope}:${tabId}`} connected={!stopped} answering={sending || session.outbox.isDeciding(ask.requestId)} readOnly={snapshot.canApprove ? null : CANNOT_ANSWER} error={refusedAnswer(ask)} onAnswer={(answers) => answer(ask, answers)} />
          : snapshot.canApprove
          ? <PermissionCard key={ask.requestId} ask={ask} connected={!stopped} answering={sending || session.outbox.isDeciding(ask.requestId)} onRespond={(optionId) => decide(ask, optionId)} />
          : <Text key={ask.requestId} style={[styles.notice, { color: palette.warning }]}>The agent is waiting for a permission ({ask.title ?? ask.toolName ?? "request"}). Waiting for someone who can approve.</Text>)}
        {pending.map((entry) => { const line = tab?.gone ? { tone: "warn" as const, text: START_WORDS.gone } : outboxLine(entry, stopped, nameOf)!; return <View key={entry.clientCommandId} testID={tab?.gone ? "gone-message" : undefined} style={styles.pending}>
          {entry.text ? <Text numberOfLines={3} style={[styles.pendingText, { color: palette.ink, backgroundColor: palette.selected }]}>{entry.text}</Text> : null}
          <Text style={[styles.pendingState, { color: line.tone === "warn" ? palette.warning : palette.muted }]}>{entry.kind === "stop" ? "Stop: " : ""}{line.text}</Text>
          {tab?.gone ? (goneHelp.kind === "button"
            ? <Button testID="gone-new-conversation" label={START_WORDS.goneButton} kind="secondary" size="small" onPress={() => goneHelp.run(entry.text ?? "", entry.clientCommandId)} />
            : <Text style={[styles.pendingState, styles.goneHelp, { color: palette.muted }]}>{goneHelp.text}</Text>)
          : entry.state === "unsent" || entry.state === "queued" ? <Pressable accessibilityRole="button" accessibilityLabel={entry.text ? `Cancel the message: ${entry.text.slice(0, 60)}` : "Cancel this command"} onPress={() => void run(() => session.cancel(entry.clientCommandId))} style={styles.cancel}><Text style={[styles.pendingState, { color: palette.accent }]}>Cancel</Text></Pressable> : null}
        </View>; })}
        {held.length && mayWrite ? <Button label={held.length === 1 ? "Send it and start the workspace" : `Send ${held.length} messages and start the workspace`} kind="secondary" disabled={sending} onPress={sendHeld} style={styles.held} /> : null}
      </>} />
    {failure ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.danger }]}>{failure}</Text> : null}
    {promptNotSent && draft.trim() ? <View style={styles.promptNotice}><Notice testID="prompt-not-sent" tone="warning" text={START_WORDS.promptNotSent} /></View> : null}
    {startBarShown(listedState, starting, live, stop) && (!sendStarts || stop !== null)
      ? <StartBar catalog={catalog} orgId={orgId} workspaceId={workspaceId} role={roleHere} creatorId={catalog.workspace(orgId, workspaceId)?.createdBy ?? null} starting={starting} />
      : mayWrite && listedState !== "archived" && listedState !== null
      ? <View style={[styles.composer, dockBottom, { backgroundColor: palette.card, borderTopColor: palette.border }]}>
        {!snapshot.hasKey ? <Text style={[styles.notice, { color: palette.muted }]}>{codeText("no-key")}</Text> : null}
        {wheel.heldByOther ? <Text style={[styles.notice, { color: palette.warning }]}>{`${nameOf(lease?.holderId)} is driving this tab. ${wheel.canTakeOver ? "Take over to send." : "You can send when they release it."}`}</Text> : null}
        <View style={styles.composeLine}>
          <TextInput accessibilityLabel={stopped ? "Message for the agent. Sending starts the workspace." : "Message for the agent"} value={draft} onChangeText={(value) => { setDraft(value); if (value) session.typingIn(tabId); }} multiline editable={snapshot.hasKey && !wheel.heldByOther} placeholder={stopped ? "Message (starts the workspace)" : "Message the agent"} placeholderTextColor={palette.faint} style={[styles.input, { color: palette.ink }]} />
          {working && !stopped && (!wheel.heldByOther || snapshot.role === "manager") ? <Pressable accessibilityRole="button" accessibilityLabel={unanswered ? "Stop the session" : "Stop the agent"} accessibilityHint={unanswered ? "Ends the agent's process. The conversation resumes with the next message." : undefined} disabled={sending} onPress={stopAgent} style={[styles.round, { backgroundColor: unanswered ? palette.danger : palette.raised }]}><Square size={16} color={unanswered ? palette.accentInk : palette.ink} /></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={!draft.trim() || sending || !snapshot.hasKey || wheel.heldByOther} onPress={() => void send()} style={[styles.round, { backgroundColor: palette.accent }, (!draft.trim() || sending || !snapshot.hasKey || wheel.heldByOther) && styles.disabled]}><Send size={17} color={palette.accentInk} /></Pressable>
        </View>
      </View>
      : <View style={[styles.composer, dockBottom, { backgroundColor: palette.card, borderTopColor: palette.border }]}><Text style={[styles.notice, { color: palette.muted }]}>{listedState === "archived" ? "This workspace is archived. Its conversation can be read." : listedState === null ? codeText("cloud_workspace_not_found") : codeText("read-only")}</Text></View>}
  </KeyboardAvoidingView>;
}

/** Why someone who may not approve sees a question without Answer and Skip (contract §21.4). */
const CANNOT_ANSWER = "Only someone allowed to approve can answer this question.";

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  centred: { justifyContent: "center" },
  banner: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 16, paddingVertical: 10 },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  // The title and, under it, the state and the role in plain words.
  // An icon button with a full 44 pt target.
  reconnectText: { fontSize: 12, fontWeight: "600" },
  goneBar: { flexDirection: "column", alignItems: "stretch", gap: 6 },
  goneActions: { flexDirection: "row", gap: 8, marginTop: 4 },
  startBar: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 12, marginTop: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, borderCurve: "continuous", paddingHorizontal: 14, paddingVertical: 12 },
  startTitle: { fontSize: 15, fontWeight: "600", lineHeight: 20 },
  startDetail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  presence: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingTop: 6 },
  // Wraps on a narrow phone: the buttons go under the driver's name rather than squeezing it.
  wheel: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, paddingLeft: 16, paddingRight: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  wheelText: { flexGrow: 1, flexShrink: 1, minWidth: 120, fontSize: 13, fontWeight: "600" },
  wheelAction: { minHeight: 44, paddingHorizontal: 10, justifyContent: "center" },
  wheelActionText: { fontSize: 13, fontWeight: "600" },
  notes: { paddingHorizontal: 16, paddingVertical: 10, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  notesHint: { fontSize: 12, lineHeight: 17 },
  notesList: { maxHeight: 180 },
  noteLine: { fontSize: 14, lineHeight: 20, paddingVertical: 3 },
  notice: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 6 },
  tabs: { flexGrow: 0 },
  tabsContent: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  tab: { minHeight: 36, maxWidth: 220, paddingHorizontal: 13, borderRadius: 10, justifyContent: "center" },
  tabText: { fontSize: 14, fontWeight: "600" },
  pending: { alignItems: "flex-end", gap: 4, marginTop: 12 },
  pendingText: { maxWidth: "88%", borderRadius: 17, borderBottomRightRadius: 5, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, lineHeight: 22, overflow: "hidden", opacity: 0.7 },
  pendingState: { fontSize: 12, lineHeight: 17 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, paddingBottom: 12, gap: 6 },
  composeLine: { flexDirection: "row", alignItems: "flex-end", gap: 9 },
  input: { flex: 1, maxHeight: 120, minHeight: 42, paddingHorizontal: 10, paddingVertical: 9, fontSize: 16 },
  round: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
  reconnect: { minHeight: 32, paddingHorizontal: 11, borderRadius: 9, justifyContent: "center" },
  cancel: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "flex-end" },
  held: { marginTop: 10 },
  emptyAction: { paddingHorizontal: 24, marginTop: 4 },
  goneHelp: { maxWidth: "88%", textAlign: "right" },
  promptNotice: { paddingHorizontal: 12, paddingBottom: 8 },
});
