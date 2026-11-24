import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WifiOff } from "lucide-react-native";
import { CloudApiError, type CloudLifecycle } from "@mobile/cloud/api";
import type { CloudCatalog } from "@mobile/cloud/catalog";
import { TASK_HEAD, TASK_LEFT, TASK_NOTE, TASK_NOT_PICKED_UP, TASK_PHASES, TASK_UNSURE_LEFT, keptTaskKey, taskProgress, taskSettled, type TaskProgress } from "@mobile/cloud/first-task";
import { LAUNCH_STAGES, launchProgress, type LaunchProgress as Progress, launchRecovery, launchRefusal, operationActive, unanswered } from "@mobile/cloud/launch";
import { resumeFailure } from "@mobile/cloud/resume";
import { managesOrganization } from "@mobile/cloud/setup";
import { rolePhrase, stateLabel } from "@mobile/cloud/words";
import { takeConversationState } from "@mobile/state/conversation-state";
import { Notice } from "./Notice";
import { OperationStages } from "./OperationStages";
import { Button } from "./primitives";
import { HeaderLine, ScreenHeader } from "./SessionChrome";
import { useTheme } from "./theme";

/** How often the operation is read while it is under way. */
export const LAUNCH_POLL_MS = 3_000;
/** How long "running" is shown before the workspace opens by itself. */
export const OPEN_AFTER_MS = 1_200;

const LEAVE = "You can leave this page. The launch carries on, and the workspace shows in the Cloud tab.";
const NO_CANCEL = "It can no longer be canceled. Once it is running you can stop or delete it.";

/**
 * Where a launch is, in one shape for the page: 25.05's operation stages for
 * a workspace launched with no first task, and the launch's own phases
 * (25.09) for one launched with one.
 */
type Seen =
  | { life: CloudLifecycle; kind: "operation"; progress: Progress }
  | { life: CloudLifecycle; kind: "task"; progress: TaskProgress };

/**
 * A launch on the workspace's own page (25.05, 25.09): its stages until the
 * workspace runs, read from the server every few seconds. A launch with a
 * first task goes on past that, following the server's `launch.phase` until
 * the agent runs, and then opens the conversation at the launch's own tab.
 * The launch is the server's; the phone only watches, so leaving the page or
 * losing the network changes nothing about it. Cancel is offered while the
 * server says the operation can be canceled. A launch that does not finish
 * says why in one sentence and what can be done next, and what it left.
 */
export function LaunchProgress({ catalog, orgId, operationId, title, onOpen, onDelete, onRetried, onBack, onLaunchAgain, onFixKey, onAgentLogins }: {
  catalog: CloudCatalog;
  orgId: string;
  operationId: string;
  /** The workspace's name until the operation's answer gives it. */
  title: string;
  /** The workspace runs, or the person asked to see it: show it, at the first task's tab when it has one. */
  onOpen(tabId: string | null): void;
  /** Open the delete page for the workspace this launch left. */
  onDelete(workspaceId: string): void;
  /** Setup was asked for again on the same machine: the workspace's page follows it from here. */
  onRetried(): void;
  onBack(): void;
  onLaunchAgain(): void;
  /** Where the provider's key is repaired. */
  onFixKey(): void;
  /** Where the organization's agent logins are repaired, for an owner or admin. */
  onAgentLogins(): void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const api = catalog.api;
  // The operation as last read, with where it stands: a cancel's cleanup is drawn at the stage the launch had reached.
  const [seen, setSeen] = useState<Seen | null>(null);
  const setLife = useCallback((life: CloudLifecycle) => setSeen((held) => {
    const last = held?.progress.stage ?? 0;
    return life.workspace.launch
      ? { life, kind: "task", progress: taskProgress(life, last, api.serverNow()) }
      : { life, kind: "operation", progress: launchProgress(life, last) };
  }), [api]);
  const [offline, setOffline] = useState(false);
  /** A refusal of the read, of Cancel or of Retry setup, in words. */
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<"cancel" | "retry" | null>(null);
  const handlers = useRef({ onOpen });
  useEffect(() => { handlers.current = { onOpen }; });

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const answer = await api.operation(orgId, operationId);
        if (!current) return;
        setLife(answer);
        setOffline(false);
        if (!operationActive(answer.operation)) {
          // Settled: the list shows the workspace as it now stands.
          catalog.adopt(orgId, answer);
          // With a first task the launch goes on after the machine is up, until the agent runs or does not.
          if (!answer.workspace.launch || taskSettled(taskProgress(answer, 0, api.serverNow()))) return;
        }
      } catch (error) {
        if (!current) return;
        // The launch carries on without the phone; anything else the server said ends the watching.
        if (unanswered(error) || (error instanceof CloudApiError && error.unreachable)) setOffline(true);
        else return setProblem(launchRefusal(error).text);
      }
      timer = setTimeout(() => void read(), LAUNCH_POLL_MS);
    };
    void read();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [api, catalog, orgId, operationId, setLife]);

  const life = seen?.life ?? null;
  const workspace = life?.workspace ?? null;
  const tabId = workspace?.launch?.tabId ?? null;
  const running = seen?.progress.phase === "running";
  // Opens straight into the workspace once it runs, at the first task's tab; the button is for someone quicker than that.
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => handlers.current.onOpen(tabId), OPEN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [running, tabId]);
  // The agent has the first task: it is no longer kept for Launch again.
  const workspaceId = workspace?.id ?? null;
  useEffect(() => { if (running && workspaceId && seen?.kind === "task") takeConversationState(keptTaskKey(orgId, workspaceId)); }, [running, workspaceId, orgId, seen?.kind]);

  const name = workspace?.name || title;
  const provider = workspace?.providerDescriptor?.label ?? "the provider";
  const subtitle = offline ? "Offline" : [workspace ? stateLabel(workspace.state) : "Starting", rolePhrase(workspace?.you?.role)].filter(Boolean).join(" · ");
  const ownerOrAdmin = (() => {
    const organization = catalog.getSnapshot().organizations.find((entry) => entry.organization.orgId === orgId)?.organization;
    return !!organization && managesOrganization(organization);
  })();

  const cancel = () => Alert.alert("Cancel this launch?", "The machine being created is removed.", [
    { text: "Cancel launch", style: "destructive", onPress: () => {
      setAsking("cancel");
      setProblem(null);
      api.cancelOperation(orgId, operationId).then((answer) => setLife(answer), (error: unknown) => setProblem(launchRefusal(error).text)).finally(() => setAsking(null));
    } },
    { text: "Keep launching", style: "cancel" },
  ]);
  const retrySetup = () => {
    if (!workspace) return;
    setAsking("retry");
    setProblem(null);
    catalog.start(orgId, workspace.id).then(() => onRetried(), (error: unknown) => setProblem(resumeFailure(error).text)).finally(() => setAsking(null));
  };

  // Where the launch stands, in the page's own words: one phase for both kinds of launch.
  const progress = seen?.progress ?? null;
  const phase = progress?.phase ?? "launching";
  const task = seen?.kind === "task" ? seen.progress : null;
  const recovery = phase === "failed" && life ? launchRecovery(life.workspace, life.operation) : null;
  const head = phase === "launching" ? "Launching…" : phase === "starting" ? TASK_HEAD.starting : phase === "canceling" ? "Canceling…" : phase === "canceled" ? "Launch canceled"
    : phase === "failed" ? "The launch failed" : phase === "task-failed" ? TASK_HEAD.failed : phase === "task-unsure" ? TASK_HEAD.unsure : `${name} is running`;
  const note = phase === "launching" ? (progress && !progress.cancelable ? NO_CANCEL : LEAVE)
    : phase === "starting" ? (task?.notPickedUp ? null : TASK_NOTE.next)
    : phase === "canceling" ? "Removing what was created so far."
    : phase === "canceled" ? (task?.hasPrompt ? TASK_NOTE.canceled : "The machine was removed. Launching again asks for a new price.")
    : phase === "running" ? (task ? (task.hasPrompt ? TASK_NOTE.working : TASK_NOTE.ready) : "Opening it in a moment…")
    : phase === "failed" && recovery === "fix-key" ? ((progress?.stage ?? 0) <= 1 ? "No machine was created. Connect a working key, then launch again." : "Connect a working key, then retry.")
    : phase === "failed" && recovery === "ask-admin" ? "An organization admin can retry or fix this."
    : null;
  // What a first task that did not start leaves: a workspace that runs, and costs, with no conversation in it.
  const left = (phase === "task-failed" || phase === "task-unsure") && workspace?.state === "ready" ? (phase === "task-unsure" ? TASK_UNSURE_LEFT : TASK_LEFT) : null;
  const toLogins = phase === "task-failed" && task?.signIn && ownerOrAdmin;

  return <View style={styles.page}>
    <ScreenHeader title={name} onBack={onBack} subtitle={<HeaderLine testID="launch-state-line" text={subtitle} />} />
    <ScrollView contentContainerStyle={styles.content}>
      {offline ? <Notice testID="launch-offline" tone="warning" icon={(color) => <WifiOff size={16} color={color} />} text="Offline. The launch carries on without the phone; this page catches up when it is back online." /> : null}
      <Text testID="launch-head" accessibilityRole="header" style={[styles.head, { color: palette.ink }]}>{head}</Text>
      <OperationStages testID="launch-stages" stages={task ? TASK_PHASES : LAUNCH_STAGES} current={progress?.stage ?? 0} status={progress?.status ?? "running"} detail={progress?.detail} />
      {note ? <Text testID="launch-note" style={[styles.note, { color: palette.muted }]}>{note}</Text> : null}
      {task?.notPickedUp ? <Notice testID="launch-not-picked-up" tone="warning" text={TASK_NOT_PICKED_UP} /> : null}
      {left ? <Notice testID="launch-left" tone="warning" text={left} /> : null}
      {recovery === "retry-setup" ? <Notice testID="launch-left" tone="warning" text="The machine exists. Retry setup tries again on the same machine; delete it if you would rather start over." /> : null}
      {recovery === "retry-setup" && task?.hasPrompt ? <Text testID="launch-task-kept" style={[styles.note, { color: palette.muted }]}>{TASK_NOTE.kept}</Text> : null}
      {recovery === "delete" ? <Notice testID="launch-left" tone="warning" text={`Delete it and launch a new one. Check ${provider}’s dashboard if a machine is still listed there.`} /> : null}
      {problem ? <Notice testID="launch-problem" tone="danger" text={problem} /> : null}
    </ScrollView>
    <View style={[styles.foot, { paddingBottom: insets.bottom + 12 }]}>
      {phase === "launching" || phase === "canceling"
        ? <Button testID="cancel-launch" label="Cancel launch" kind="secondary" disabled={!progress?.cancelable || offline || asking !== null} accessibilityState={{ disabled: !progress?.cancelable || offline || asking !== null, busy: asking === "cancel" || phase === "canceling" }} onPress={cancel} />
        // The workspace runs while its agent starts: it can be opened already.
        : phase === "starting" ? <Button testID="open-workspace" label="Open workspace" kind="secondary" onPress={() => onOpen(null)} />
        : phase === "running" ? <Button testID="open-workspace" label="Open workspace" onPress={() => onOpen(tabId)} />
        : phase === "task-failed" || phase === "task-unsure" ? <>
          {toLogins ? <Button testID="agent-logins" label="Agent logins" onPress={onAgentLogins} /> : null}
          <Button testID="open-workspace" label="Open workspace" kind={toLogins ? "secondary" : "primary"} onPress={() => onOpen(tabId)} />
        </>
        : phase === "canceled" ? <>
          <Button testID="launch-again" label="Launch again" onPress={onLaunchAgain} />
          <Button label="Back to Cloud" kind="secondary" onPress={onBack} />
        </>
        : <>
          {recovery === "retry-setup" ? <Button testID="retry-setup" label={asking === "retry" ? "Retrying…" : "Retry setup"} disabled={asking !== null} onPress={retrySetup} /> : null}
          {recovery === "fix-key" ? <Button testID="fix-key" label="Fix the provider key" onPress={onFixKey} /> : null}
          {recovery !== "ask-admin" && workspace ? <Button testID="delete-workspace" label="Delete workspace…" kind="danger" disabled={asking !== null} onPress={() => onDelete(workspace.id)} /> : null}
          {recovery === "delete" || recovery === "ask-admin" ? <Button label="Back to Cloud" kind="secondary" onPress={onBack} /> : null}
        </>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 10 },
  head: { fontSize: 17, fontWeight: "600", lineHeight: 22, marginHorizontal: 4, marginTop: 8 },
  note: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  foot: { paddingHorizontal: 16, paddingTop: 10, gap: 8 },
});
