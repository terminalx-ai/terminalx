import { localCommands } from "@/lib/localCommands";
import { useTabRead } from "@/lib/useTabRead";
import { HeldQueueTray } from "@/components/chat/HeldQueueTray";
import { followUpRoute, heldQueueFrom, heldQueueFromFollowUps, type HeldQueueChange } from "@/lib/heldQueue";
import { usePrefs } from "@/lib/prefs";
import { localAiEditor } from "@/lib/aiEdit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agent as agentApi, errorMessage, pty, type FileInput, type ImageInput } from "@/lib/api";
import { noteComposerTyping } from "@/lib/typingNote";
import { applyEvent, getTabLog, lastSeq, respondPermissionOnce, useTabLog } from "@/lib/agentEvents";
import type { Transcript } from "@/lib/transcript";
import type { OutboxEntry } from "@/lib/cloudAgentApi";
import type { HeldFollowUpInfo } from "@terminalx/portable/workspace";
import { useConversationView } from "@/lib/conversationView";
import { clearComposerSendError, composerSendScope, hasArrived, useComposerSend } from "@/lib/composerSends";
import { getDraft, setDraft, useDraft } from "@/lib/drafts";
import { showError } from "@/lib/errorToasts";
import { useSessionIsGit } from "@/lib/quickChats";
import { hasEscapeOverlay, useShortcut } from "@/lib/hotkeys";
import { changeRange, useChanges } from "@/lib/changes";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import { localSessionBackend, RESEND_ATTACHMENTS, terminalViewOf, type HandoffActions, type SessionBackend } from "@/lib/sessionBackend";
import { CloudOutbox, SignInNotice, commandError as cloudCommandError } from "@/components/cloud/CloudAgents";
import { CloudPendingMessages, usePendingCloudMessages } from "@/components/cloud/CloudPendingMessages";
import { cloudAgentLabel } from "@/lib/cloudRowState";
import { CloudAgentTerminal } from "@/components/cloud/CloudAgentTerminal";
import { LeaseBar, NotesPanel, useNowUntil } from "@/components/cloud/CloudCollab";
import { SETTINGS_IGNORED_REASON, SETTINGS_LOCKED_REASON, SETTINGS_WITH_NEXT_MESSAGE, TERMINAL_APPROVAL_REASON, presenceTyping, tabGate, useCollab } from "@/lib/cloudCollab";
import { usePeople } from "@/lib/cloudPeople";
import { Chat } from "@/components/chat/Chat";
import { FirstMessage } from "@/components/chat/FirstMessage";
import { Composer, type Handoff } from "@/components/chat/Composer";
import { AlsoSendsTo } from "@/components/bots/BotChatApps";
import { goalCommand, goalCommandProblem } from "@/lib/goalCommand";
import { sentMessages } from "@/components/chat/useComposerHistory";
import { TerminalView } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import { TerminalPromptCard } from "@/components/chat/AskCards";
import { terminalPromptError } from "@/lib/terminalPrompt";
import { History, MessageSquare, Play, X } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { getTerminalState, openTerminal, useTerminals } from "@/lib/terminal";
import { cn } from "@/lib/cn";
import { MachineMessage } from "@/components/machines/MachineMessage";
import { cancelTerminalView, clearTabViewError, enterTerminalView, forgetTabView, isPtyFirst, leaveTerminalView, startTabAgent, useTabViews } from "@/lib/tabViews";
import { byHandLock, isByHand, isTerminalTab, resumable, tabPaneId, tabViewIn, type Resumable } from "@/lib/tabFront";
import { useSessionStore } from "@/lib/sessions";
import { classifyRecovery, CONTINUE_PROMPT, requestRefusalNotice, RECOVERY_MESSAGES, RECOVERY_PROMPT, recoveryFromEvents, unsupportedCommandNotice } from "@/lib/recovery";
import { actionReports, inputOf, RecoveryReports, reporterFor, useExposure, type RecoveryAction, type Surface } from "@/lib/recoveryReports";
import type { RecoveryKind } from "@/types/events";
import { RecoveryBanner } from "./RecoveryBanner";
import { OrgUsageLimitCard } from "./OrgUsageLimitCard";
import { useAccount } from "@/lib/account";
import { phase2Ready } from "@/lib/phase2Readiness";
import { useNoticeDeferral } from "@/lib/noticeDeferral";
import { ResetChatDialog } from "./ResetChatDialog";
import { RemoteHandoffDialog, type RemoteHandoffPurpose } from "./RemoteHandoffDialog";
import { SaveSnippetDialog } from "@/components/chat/SaveSnippetDialog";
import type { ResetTarget } from "@/components/chat/Chat";
import { ContinuationDialog } from "./ContinuationDialog";
import { otherAgent, secondOpinionPrompt } from "@/lib/agentHandoff";
import { modeLabel, modelLabel, useModels } from "@/lib/models";
import { openAgentHandoff, openWorkspaceDelete } from "@/lib/dialogs";
import { offersWorkspaceDelete, turnLive, useWorkspaceDisposition, type RemovableWorkspace } from "@/lib/workspaceRemoval";
import { usePickerModels, useRuntimeModels } from "@/lib/cloudModels";
import { TAB_STATUS_LABEL, type PastConversation, type SessionEntry, type TabEntry } from "@/types/session";
import { interruptUnanswered } from "@/types/events";
import { LocalVmTasks } from "@/components/localVm/LocalVmTasks";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { useWorkspaceSetup } from "@/lib/workspaceSetup";
import { useProjectForge } from "@/lib/projectForge";
import { checkAgentReadiness, useSignInReadiness } from "@/lib/agentReadiness";
import { AccountGoneNotice, AccountSwitchNote, useAccountSwitch } from "@/components/session/AccountSwitch";
import { MentionPeopleContext, useMentionPeople } from "@/components/chat/useMentionPeople";
import { cloudSessionKey, parseCloudWorkspaceKey } from "@/types/target";
import { markMentionsRead, useMentionMarked } from "@/lib/mentionMarks";

const newLoginIncident = () => ({ loginPane: null as string | null, launched: false, opening: false, consumed: false, cancelled: false, paused: false });

const NO_ENTRIES: OutboxEntry[] = [];
const NO_FOLLOW_UPS: HeldFollowUpInfo[] = [];
/** Said on a held message of someone else's in a shared workspace (#1328): the runtime refuses the change too. */
const HELD_NOT_YOURS = "Only whoever sent this message, or a workspace manager, can change it.";
/** A manager deletes or sends anyone's held message, but its words stay its sender's (#1328). */
const HELD_EDIT_NOT_YOURS = "Only whoever sent this message can edit it.";
const STOP_REFUSED = "Only the person driving this tab or an admin can stop the agent.";

/**
 * A view-change refusal describes that request, not an agent failure.
 * Local PTY/native tabs and cloud tabs retain their usable chat (#644/#816).
 */
export function terminalViewRefusal(message: string): string {
  const said = message.trim();
  return `The terminal view did not open: ${/[.!?]$/.test(said) ? said : `${said}.`}`;
}

/**
 * One tab: its event log, the transcript built from it, and the composer.
 */
/** How many prompts a conversation has had before its next steps (Commit, Create PR, Run it) are offered. */
export const HANDOFF_AFTER_PROMPTS = 5;

/**
 * After a turn that touched files, the obvious next steps as one-click
 * prompts. They only fill the composer; the reader still sends.
 *
 * `deleteWorkspace` is the step after those, once the worktree's pull request
 * has merged. It is the app's own action, not a prompt: an agent is never
 * asked to remove the worktree it runs in. It does not wait for a turn.
 */
export function handoffsFor(t: Transcript, changed: boolean, deleteWorkspace?: () => void, github = true): Handoff[] | undefined {
  const last = t.turns[t.turns.length - 1];
  // Early in a conversation the work is still being shaped: the steps wait until it has had some prompts.
  const prompts: Handoff[] =
    last?.completed?.status === "ok" && changed && t.turns.length >= HANDOFF_AFTER_PROMPTS
      ? [
          { label: "Commit", prompt: "Commit the current changes with a clear, conventional message. Do not push." },
          ...(github ? [{ label: "Create PR", prompt: "Push this branch and open a pull request with a title and a short description of the changes." }] : []),
          { label: "Run it", prompt: "Run the project's dev server or test suite in the background and report the first errors, if any." },
        ]
      : [];
  const steps = deleteWorkspace ? [...prompts, { label: "Delete workspace", run: deleteWorkspace }] : prompts;
  return steps.length ? steps : undefined;
}

/** Once the frame now being drawn is on screen. */
function afterPaint(then: () => void) {
  requestAnimationFrame(() => setTimeout(then, 0));
}

/** When a conversation ended, as a short local time; the day too when that was not today. */
function endedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const today = new Date().toDateString() === at.toDateString();
  return at.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** What the backend saves on a tab after a chat reset (session_reset.rs). */
type ResetTab = TabEntry & { resetTurn?: number; resetFilesRestored?: number };

/** "Reset to turn 2 · 3 files restored" */
export function resetNotice(tab: TabEntry): string {
  const { resetTurn, resetFilesRestored } = tab as ResetTab;
  const reset = typeof resetTurn === "number" ? `Reset to turn ${resetTurn}` : "Chat reset";
  return typeof resetFilesRestored === "number" ? `${reset} · ${resetFilesRestored} ${resetFilesRestored === 1 ? "file" : "files"} restored` : reset;
}

export function TabView({
  session,
  tab,
  active,
  focused = active,
  continuationOpen = false,
  backend: given,
  gitSource,
  workspace,
}: {
  session: SessionEntry;
  tab: TabEntry;
  active: boolean;
  /** Both split panes are active; only the focused one owns keyboard shortcuts. */
  focused?: boolean;
  continuationOpen?: boolean;
  /** Where the tab runs; the local Tauri commands when absent. */
  backend?: SessionBackend;
  /** A cloud session's Git, for the after-turn handoffs; a local one reads its checkout. */
  gitSource?: GitSource;
  /** The worktree the session runs in, on the host that owns it; absent in a project's main directory. */
  workspace?: RemovableWorkspace;
}) {
  const backend = given ?? localSessionBackend(session.id);
  const local = backend.caps.local;
  const transcriptPeople = useMentionPeople(local ? null : parseCloudWorkspaceKey(backend.key)?.orgId, null);
  // Local VM task cards are behind Settings → Experimental → Local VM tasks (PRO-114).
  const localVmTasks = useExperimentalSettings(local)?.localVmTasks === true;
  const setup = useWorkspaceSetup(local ? session.id : null);
  const isGit = useSessionIsGit(session, local);
  const forge = useProjectForge(local && isGit ? session.projectPath || session.cwd : null);
  const log = useTabLog(backend.logSessionId, tab.id);
  const draft = useDraft(tab.id);
  const safeError = (e: unknown) => RECOVERY_MESSAGES[classifyRecovery(String(e))];
  // A cloud command's refusal says what happened to it (queued, view only, no key yet).
  const commandError = (e: unknown) => {
    const message = e instanceof Error ? e.message : null;
    if (message && message === backend.readOnlyReason) return message;
    return cloudCommandError(e);
  };
  const sendScope = composerSendScope(backend, tab.id);
  const sendState = useComposerSend(sendScope);
  // Native Codex still on its turn refused a send (#815): a refusal of the request, not a failure of the turn.
  // The composer says so with the message back in it; nothing is raised and the tab is left as it is.
  const sendNotice = local && sendState.error != null ? requestRefusalNotice(sendState.error) : null;
  const sendBusy = sendNotice !== null;
  const [busyRefused, setBusyRefused] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<{ endSeq: number | null; target?: ResetTarget } | null>(null);
  const [snippetPrompt, setSnippetPrompt] = useState<string | null>(null);
  const [localError, setError] = useState<string | null>(null);
  const error = localError ?? (sendState.error != null && !sendBusy ? (local ? safeError(sendState.error) : commandError(sendState.error)) : null);
  const views = useTabViews();
  // A cloud tab's terminal view (PRO-86) attaches to its CLI on the VM; it is
  // only there while the runtime serves it, else the tab shows its chat.
  const remoteTerminal = !local && terminalViewOf(backend, tab).available ? (backend.agentTerminal ?? null) : null;
  const terminalMode = tabViewIn(views.views, tab) === "terminal" && (local || !!remoteTerminal);
  const viewError = views.errors[tab.id] ?? null;
  // Over the tab, whatever the composer already says (a lease, view only): the switch is in the header.
  const viewRefusal = viewError && (!local || isPtyFirst(tab.harness)) ? terminalViewRefusal(viewError) : null;
  const terms = useTerminals();
  const ptyFirst = local && isPtyFirst(tab.harness);
  const paneId = tabPaneId(tab);
  const pane = terms.panes.find((p) => p.id === paneId);
  // A tab follows what runs in its terminal (#437). `terminalTab`: no agent is there, and the tab is a
  // terminal whose chat is the conversation it last held, to read and to resume. `byHand`: its agent
  // was started in the terminal by hand, and the chat is that CLI's conversation, followed.
  const terminalTab = local && isTerminalTab(tab);
  const byHand = local && isByHand(tab);
  const harnesses = useSessionStore().harnesses;
  const agentName = useCallback((harness: string) => harnesses.find((candidate) => candidate.id === harness)?.name ?? harness, [harnesses]);
  const agentLabel = agentName(tab.harness);
  // An earlier conversation of this tab that is being read, in place of the one it holds now.
  const [viewing, setViewing] = useState<PastConversation | null>(null);
  // The trigger is the button itself, so a mouse click, an accessibility press and Return all open it.
  const conversationsMenu = useRowMenu();
  const [resuming, setResuming] = useState(false);
  const readOnly = terminalTab || !!viewing;
  const [answering, setAnswering] = useState(false);
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const recoveryLock = useRef(false);
  const [stopped, setStopped] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);
  const { models, refresh: refreshPickerModels } = usePickerModels(useModels(tab.harness), !local, backend.modelClient, tab.harness);
  // The tab's log holds every conversation it has held; the chat is one of them.
  const conversation = viewing ? (viewing.id ?? null) : (tab.conversation ?? null);
  // Built on as the log grows (#727): `events` and the transcript stay the
  // same objects while only a streaming preview moves, so nothing below is
  // worked out again for it, and a new event costs as much in a long
  // conversation as in a short one.
  const view = useConversationView(log, conversation);
  const events = view.events();
  const talked = view.conversationsWithMessages();
  // The ones before the current that have anything in them, newest first.
  const earlier = useMemo(
    () => (tab.history ?? []).filter((past) => talked.has(past.id ?? null)).reverse(),
    [tab.history, talked],
  );
  const eventRecovery = useMemo(() => (readOnly ? null : recoveryFromEvents(events)), [events, readOnly]);
  // PRO-30: on a shared cloud workspace, who may send, stop and answer here.
  const shared = backend.collab ?? null;
  const collab = useCollab(shared?.key ?? `local:${session.id}`);
  const collabLive = !!shared?.client && collab.available && !!shared.you;
  // The roster gives names to presence, leases and follow-ups; only a live shared workspace shows them.
  const nameOf = usePeople(collabLive);
  // A lease is the live runtime's word: while reconnecting, the last one seen says nothing about who drives now.
  const lease = shared && collabLive ? (collab.leases[tab.id] ?? null) : null;
  const now = useNowUntil(lease?.expiresAt);
  const tabLive = tab.status === "in_progress" || tab.status === "waiting";
  const gate = shared ? tabGate(shared.you, lease, now, tabLive, nameOf) : null;
  const mayHandOff = !readOnly && backend.caps.write && !backend.readOnlyReason && (!gate || gate.mayConfigure);
  const counterpart = local && mayHandOff ? otherAgent(tab.harness, harnesses) : undefined;
  // A remote session hands off on its runtime (#1327), to an agent installed there: the other one, named
  // even when the handoff is off so the composer can say why, and offered once the runtime lists it.
  const runtimeAgents = useRuntimeModels(local ? null : backend.modelClient)?.agents ?? null;
  const remoteOther = !local && !readOnly ? otherAgent(tab.harness, harnesses.map((harness) => ({ ...harness, available: true }))) : undefined;
  const handoff = !local && mayHandOff ? backend.handoff : undefined;
  const remoteCounterpart = handoff && remoteOther && runtimeAgents?.some((agent) => agent.id === remoteOther.id) ? remoteOther : undefined;
  // The dialog keeps the actions it was opened with: a backend rebuilt meanwhile (a new outbox, a reconnect) neither reloads nor closes it.
  const [remoteHandoff, setRemoteHandoff] = useState<{ agent: string; purpose: RemoteHandoffPurpose; actions: HandoffActions } | null>(null);
  const handOffTo = remoteCounterpart && handoff ? (purpose: RemoteHandoffPurpose) => setRemoteHandoff({ agent: remoteCounterpart.id, purpose, actions: handoff }) : undefined;
  const [notesOpen, setNotesOpen] = useState(false);
  // The retry and resume flows restart a local agent process; a cloud tab's runtime recovers itself.
  // A tab that is a terminal has no agent to recover: what went wrong there is said as it is.
  const recovery = !backend.caps.recovery || readOnly ? null : eventRecovery ?? (error || (viewError && !viewRefusal) ? classifyRecovery(error ?? viewError!) : null);
  const loginTurn = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (!ev.subagent && ev.payload.type === "user_message" && !ev.payload.queued && ev.payload.text !== RECOVERY_PROMPT) return ev.seq;
    }
  }, [events]);

  // One login terminal and one automatic authenticated retry belong to this turn.
  // Replacing or unmounting its view revokes even work already awaiting Stop.
  const initialLogin = useMemo(newLoginIncident,
    [backend.key, backend.generation, session.id, tab.id, tab.harness, conversation, tab.front, loginTurn]);
  const [replacementLogin, setReplacementLogin] = useState<{ initial: typeof initialLogin; incident: typeof initialLogin } | null>(null);
  const loginIncident = replacementLogin?.initial === initialLogin ? replacementLogin.incident : initialLogin;
  const currentLogin = useRef(loginIncident);
  currentLogin.current = loginIncident;
  const [loginPending, setLoginPending] = useState<typeof loginIncident | null>(null);
  const continuationLogin = useRef<typeof loginIncident | null>(null);
  useEffect(() => {
    loginIncident.cancelled = false;
    return () => { loginIncident.cancelled = true; };
  }, [loginIncident]);
  const cancelLogin = () => {
    currentLogin.current.cancelled = true;
    setLoginPending(null);
  };
  const restoreContinuationLogin = () => {
    const incident = continuationLogin.current;
    continuationLogin.current = null;
    if (!incident || incident !== currentLogin.current || incident.cancelled) return;
    incident.paused = false;
    // Opening the dialog stops the process and clears its recovery event.
    // Dismissing it leaves the interrupted turn available to sign in/retry.
    setError(RECOVERY_MESSAGES.signed_out);
  };


  const backendRef = useRef(backend);
  backendRef.current = backend;
  useEffect(() => backendRef.current.openTab(tab.id, (e) => setError(safeError(e))) ?? undefined, [backend.key, backend.generation, tab.id]);

  // A PTY-first tab is its CLI, so opening the tab starts it. Idempotent, and
  // the pane it lands in is adopted from the backend's own event.
  // Again when what is in its terminal changes: a tab that became a terminal is given its shell.
  // Shown in its chat, an archived or removed-workspace session's agent, or one stopped for sitting idle, waits for
  // its next message instead (#696); a terminal view needs its CLI whatever it is.
  const front = tab.front ?? "agent";
  useEffect(() => {
    if (active && ptyFirst) void startTabAgent(session, tab, { opened: tabViewIn(views.views, tab) !== "terminal" });
  }, [active, ptyFirst, session.id, tab.id, front]);

  // The face picked for what was in the terminal before does not stand for what is there now. Neither
  // does "Session closed": that was said of the agent Stop ended, not of the one there since.
  const shownFront = useRef(front);
  useEffect(() => {
    if (shownFront.current === front) return;
    shownFront.current = front;
    forgetTabView(tab.id);
    setStopped(false);
  }, [front, tab.id]);

  // An earlier conversation is read until the tab moves on, or it is no longer one of the tab's.
  useEffect(() => {
    if (viewing && !(tab.history ?? []).some((past) => (past.id ?? null) === (viewing.id ?? null))) setViewing(null);
  }, [tab.history, viewing]);

  /** Start the tab's agent again on one of its conversations, in the place of the idle shell. */
  const resume = useCallback(
    (target: Resumable) => {
      setResuming(true);
      setError(null);
      void agentApi
        .resumeConversation(session.id, tab.id, target.harness, target.providerSessionId)
        .then(() => setViewing(null))
        .catch((e) => setError(errorMessage(e)))
        .finally(() => setResuming(false));
    },
    [session.id, tab.id],
  );

  useTabRead(active, backend.key, tab, backend.markRead);
  // A mention's @ on the session row goes while the session is on screen here (PRO-141),
  // including a mention that arrives while it is.
  const mentionedWorkspace = local ? null : parseCloudWorkspaceKey(backend.key);
  const mentionKey = mentionedWorkspace ? cloudSessionKey(mentionedWorkspace.orgId, mentionedWorkspace.workspaceId, backend.logSessionId) : "";
  const mentionedHere = useMentionMarked(mentionKey);
  useEffect(() => {
    if (active && mentionedHere && mentionedWorkspace) markMentionsRead(mentionedWorkspace.orgId, mentionedWorkspace.workspaceId, backend.logSessionId);
  }, [active, mentionedHere, mentionedWorkspace?.orgId, mentionedWorkspace?.workspaceId, backend.logSessionId]);

  // Nothing is running in a conversation that is only being read. A remote session offers it
  // through its runtime (#1326) when that keeps the turns' checkpoints; `unavailable` says why not.
  const turnActions = backend.turns;
  const canReset = !!turnActions && !readOnly && !byHand && !tab.transport && !tab.history?.length && !tab.conversation
    && (tab.harness === "claude" || tab.harness === "codex") && !(local && session.worktreeRemoved);
  const live = !readOnly && (tab.status === "in_progress" || tab.status === "waiting");
  // Fork from a turn (PRO-379): what a reset can cut, a fork can copy.
  const canFork = canReset;
  const turnSettings = useMemo(() => ({ effort: tab.effort, permissionMode: tab.permissionMode }), [tab.effort, tab.permissionMode]);
  // Switch account (#980): this computer's accounts, so a local tab's only, and not while it is only read.
  const accountSwitch = useAccountSwitch(session, tab, local && !readOnly);
  // Only while the turn it met runs: once that has ended, the message in the composer is simply unsent. A command
  // native Codex cannot run (#1498) is refused whatever the turn is doing, so that notice stays until the next send.
  const commandNotice = local && sendState.error != null ? unsupportedCommandNotice(sendState.error) : null;
  const busyNotice = commandNotice ?? (live ? sendNotice ?? busyRefused : null);
  useEffect(() => {
    if (!live) setBusyRefused(null);
  }, [live]);
  const projected = view.transcript(live);
  const transcript = useMemo(() => log.permissionResponses?.size
    ? { ...projected, pendingAsks: projected.pendingAsks.filter(ask => log.permissionResponses?.get(ask.requestId) !== "answered") }
    : projected, [projected, log.permissionResponses]);
  // The live terminal can need an answer even while the chat's selection is
  // historical. Hidden tabs and history shown in the chat do not hold notices.
  useNoticeDeferral(active && (terminalMode || !readOnly) && (!!recovery || tab.status === "waiting"));
  // Whether the session's checkout differs from where the conversation
  // started, by tree diff, so a shell heredoc counts as much as an edit tool.
  const range = useMemo(() => changeRange(events, session.baseRef), [events, session.baseRef]);
  const changes = useChanges(local ? (session.cwd ? localGitSource(session.cwd) : undefined) : gitSource, range, isGit && active && !live);

  // What of this tab's warnings is on screen, and what is pressed about them (#815). A local tab's only: a
  // cloud tab's runtime recovers itself. Shown means in front, in a window that is not hidden.
  const reporter = useMemo(
    () => (local && backend.caps.recovery && !readOnly ? reporterFor(backend.logSessionId, tab.id, active) : null),
    [local, backend.caps.recovery, readOnly, backend.logSessionId, tab.id, active],
  );
  const warningUp = !!recovery || (tab.status === "waiting" && !transcript.pendingAsks.length);
  const bannerShown = useExposure({ reporter, surface: "banner", present: warningUp, reason: recovery, placement: terminalMode ? "top" : "composer" });
  const notice = busyNotice ?? error;
  const noticeShown = useExposure({ reporter, surface: "composer_notice", present: !!notice && !terminalMode, reason: busyNotice || !error ? null : classifyRecovery(error) });
  // The warning the dialog was opened for, which Stop has taken down by the time it shows.
  const [continueFor, setContinueFor] = useState<RecoveryKind | null>(null);
  // The agent a usage-limit card's "Switch to" continues in (PRO-200); null continues as the dialog chooses.
  const [continueHarness, setContinueHarness] = useState<string | null>(null);
  const { status: accountStatus } = useAccount();
  const dialogShown = useExposure({ reporter, surface: "dialog", present: continueOpen, reason: continueFor });
  const continueDone = useRef<ReturnType<ReturnType<typeof actionReports>["start"]> | null>(null);
  const pressedState = useRef({ recovery, status: tab.status });
  pressedState.current = { recovery, status: tab.status };
  const actions = useMemo(() => actionReports(reporter, () => ({
    reason: pressedState.current.recovery, tabStatus: pressedState.current.status,
    sinceExposureMs: bannerShown.sinceMs() ?? noticeShown.sinceMs(),
  })), [reporter, bannerShown, noticeShown]);

  // Once the worktree's pull request has merged, the chat offers to delete
  // it. Read while the chat is shown and no turn runs in this session, so a
  // merge made elsewhere appears without a new turn.
  const sessionLive = session.tabs.some((t) => turnLive(t.status));
  const disposition = useWorkspaceDisposition(workspace?.host, active && !terminalMode && !sessionLive);
  const offerDelete = !!workspace && offersWorkspaceDelete(disposition, sessionLive || workspace.host.turnRunning(disposition?.sessionIds ?? []));
  // Only ever the standard removal dialog: it checks again, names the sessions that go, and asks.
  const deleteWorkspace = offerDelete ? () => openWorkspaceDelete(workspace.projectPath, workspace.path, workspace.name, workspace.host) : undefined;

  const blockedRef = useRef<string | null>(null);
  blockedRef.current = gate?.blocked ?? null;
  // The composer has already put the message in the chat and taken it back
  // out of the draft (#727); a failure puts it back there.
  const { followUps } = usePrefs();
  // A cloud or machine tab's runtime holds its follow-ups itself (#1328); a local tab's are in its events.
  const remoteFollowUps = useMemo(() => backend.outbox?.followUps(tab.id) ?? NO_FOLLOW_UPS, [backend.outbox, tab.id]);
  const heldQueue = useMemo(() => (backend.outbox ? heldQueueFromFollowUps(remoteFollowUps) : heldQueueFrom(events)), [backend.outbox, remoteFollowUps, events]);
  const changeHeldQueue = useCallback(async (change: HeldQueueChange) => {
    if (blockedRef.current) throw new Error(blockedRef.current);
    if (!backend.changeHeldQueue) throw new Error("This session does not support held follow-ups.");
    if (change.type === "edit") {
      const item = heldQueue.items.find(item => item.id === change.id);
      const problem = goalCommandProblem(change.text, tab.harness, !!(item?.images.length || item?.files?.length), (backend.commands?.(tab) ?? (local ? localCommands(session.cwd, tab.harness) : null))?.known()?.commands ?? []);
      if (problem === "unsupported") throw new Error("Goals work in Codex chats only. Open a Codex tab to set a goal, or change this held message's text.");
      if (problem === "empty") throw new Error("Type a goal after /goal, like “/goal ship saved views with tests”.");
    }
    const out = await backend.changeHeldQueue(tab.id, change);
    for (const event of out.events) applyEvent(event);
    if (!out.queued) backend.patchTab(tab.id, { status: "in_progress" });
  }, [backend, tab, heldQueue, local, session.cwd]);
  const send = useCallback(
    async (text: string, images: ImageInput[], alternate = false, files?: FileInput[]) => {
      // A viewer, or someone else holds this tab's lease (PRO-30): nothing is queued.
      if (blockedRef.current) throw new Error(blockedRef.current);
      currentLogin.current.cancelled = true;
      setLoginPending(null);
      setError(null);
      setBusyRefused(null);
      setStopped(false);
      // Each local send is timed, by this window's clock: Send pressed, the
      // message first on screen as sending, the runtime's answer here, and the
      // message on screen as sent. The runtime notes when it received the
      // send and when the agent took it, beside these.
      const pressedAt = Date.now();
      let drawnAt: number | undefined;
      afterPaint(() => { drawnAt = Date.now(); });
      // A held follow-up's files (PRO-290) are stored now and held by reference, like a sent message's.
      const route = files?.length && !backend.storeFiles ? "now" : followUpRoute(followUps, alternate);
      // "Now" on a cloud or machine tab whose runtime holds follow-ups (#1328): into the running turn,
      // as a local CLI takes a message mid-turn. Words only: a command, a goal or an attachment is held.
      const steerNow = !local && !!backend.changeHeldQueue && backend.caps.steer && route === "now" && tab.status === "in_progress"
        && !images.length && !files?.length && !/^\s*[/!]/.test(text) && goalCommand(text) === null;
      try {
        const held = backend.changeHeldQueue && route !== "now";
        const stored = held && files?.length && backend.storeFiles ? await backend.storeFiles(files) : undefined;
        const out = steerNow
          ? await backend.steer(tab.id, text).then(() => ({ events: [], queued: true }))
          : held
          ? await backend.changeHeldQueue!(tab.id, { type: "enqueue", text, images, ...(stored?.length ? { files: stored } : {}), sendNow: route === "interrupt" })
          : await (files?.length ? backend.send(tab.id, text, images, { pressedAt, files }) : local ? backend.send(tab.id, text, images, { pressedAt }) : backend.send(tab.id, text, images));
        const answeredAt = Date.now();
        for (const ev of out.events) applyEvent(ev);
        if (!out.queued) backend.patchTab(tab.id, { status: "in_progress" });
        const seq = out.events.find((ev) => ev.payload.type === "user_message")?.seq;
        if (local && seq != null) {
          afterPaint(() => void agentApi.reportSendShown(backend.logSessionId, tab.id, seq, { pressedAt, drawnAt, answeredAt, shownAt: Date.now() }).catch(() => {}));
        }
      } catch (e) {
        // The composer keeps the message and says why (`busyNotice`); the running turn is not touched.
        if (local && requestRefusalNotice(e)) throw e;
        setError(local ? safeError(e) : commandError(e));
        if (!backend.changeHeldQueue || route === "now") backend.setTabStatus(tab.id, "waiting");
        throw e;
      }
    },
    [backend, local, tab.id, tab.status, followUps],
  );
  const sentAfter = useCallback(() => lastSeq(backend.logSessionId, tab.id), [backend.logSessionId, tab.id]);
  // The message being sent, until its own event is in the conversation: the
  // runtime's broadcast of it can come before its answer to the send.
  const pendingMessage = sendState.pending?.message ?? null;
  const sending = useMemo(() => (pendingMessage && !readOnly && !hasArrived(events, pendingMessage) ? pendingMessage : null), [pendingMessage, events, readOnly]);

  // A message the agent dropped unanswered (#722) goes again as a new message, as it was sent, images and all.
  // Like a recovery, it is sent through the backend: a failure must not land in the composer's draft.
  const sendAgain = useCallback(
    (seq: number) => {
      if (blockedRef.current || !backend.resendMessage) {
        actions.rejected("send_again", blockedRef.current ? "blocked" : "unavailable", "chat");
        return;
      }
      setError(null);
      const done = actions.start("send_again", "chat");
      backend.resendMessage(tab.id, seq).then((out) => {
        setStopped(false);
        for (const ev of out.events) applyEvent(ev);
        if (!out.queued) backend.patchTab(tab.id, { status: "in_progress" });
        done("ok");
      }, (e) => {
        refused(e);
        done("failed", failure(e));
      });
    },
    [backend, tab.id, actions],
  );

  // The provider interrupts and delivers its own queue; acceptance updates the transcript.
  const sendQueuedNow = useCallback(
    (seq: number) => {
      setError(null);
      backend.sendQueuedNow?.(tab.id, seq).catch((e) => setError(local ? safeError(e) : commandError(e)));
    },
    [backend, local, tab.id],
  );

  // The newest event when the last interrupt was sent. Until a turn has ended
  // after it, the agent has not answered: the tab is still working on the turn
  // Escape was meant for.
  const [interruptedAt, setInterruptedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!live) setInterruptedAt(null);
  }, [live]);
  const interrupts = backend.caps.interrupt;
  const unanswered = useMemo(
    () => interrupts && live && interruptUnanswered(log.events, interruptedAt),
    [interrupts, live, interruptedAt, log.events, log.version],
  );

  // Escape, as the agent's own screen takes it (#427): the turn is
  // interrupted and the agent's process stays, so nothing here is closed,
  // settled or resumed. The turn shows as stopped when the agent says so.
  const interrupt = useCallback(() => {
    if (gate && !gate.mayStop) {
      actions.rejected("interrupt", "blocked", "chat");
      setError(STOP_REFUSED);
      return;
    }
    // Read now, not at the last render: the turn this is for may have ended since.
    const events = getTabLog(backend.logSessionId, tab.id).events;
    setInterruptedAt(events.length ? events[events.length - 1].seq : 0);
    const done = actions.start("interrupt", "chat");
    void backend.interrupt(tab.id).then(() => done("ok"), (e) => {
      setError(local ? safeError(e) : commandError(e));
      done("failed", failure(e));
    });
  }, [backend, local, tab.id, gate?.mayStop, actions]);

  // The hard stop: the agent's process is ended and the banner offers to resume.
  // `surface`: where it was pressed, for the tab's recovery incidents (#815).
  const stop = useCallback((surface: Surface = "chat") => {
    if (gate && !gate.mayStop) {
      actions.rejected("stop", "blocked", surface);
      setError(STOP_REFUSED);
      return;
    }
    const incident = currentLogin.current;
    setLoginPending(null);
    if (recoveryLock.current) {
      incident.cancelled = true;
      actions.rejected("stop", "in_progress", surface);
      return;
    }
    incident.paused = true;
    recoveryLock.current = true;
    setRecovering(true);
    const done = actions.start("stop", surface);
    void backend.stop(tab.id).then(() => {
      incident.cancelled = true;
      backend.setTabStatus(tab.id, "idle");
      // A queued cloud stop ends the turn on the runtime; there is nothing local to resume.
      if (backend.caps.recovery) setStopped(true);
      setError(null);
      clearComposerSendError(sendScope);
      clearTabViewError(tab.id);
      done("ok");
    }).catch((e) => {
      setError(local ? safeError(e) : commandError(e));
      done("failed", failure(e));
    }).finally(() => {
      incident.paused = false;
      recoveryLock.current = false;
      setRecovering(false);
    });
  }, [backend, local, tab.id, gate?.mayStop, sendScope, actions]);

  // A failed send or recovery's error, said as a warning; native Codex still on its turn
  // refused the request instead (#815), which the composer says without raising anything.
  function refused(e: unknown) {
    if (local && requestRefusalNotice(e)) setBusyRefused(requestRefusalNotice(e));
    else setError(safeError(e));
  }
  // What a failed action's result says of its error: the warning it would be, never its words.
  function failure(e: unknown): { errorKind?: RecoveryKind } {
    return local && requestRefusalNotice(e) ? {} : { errorKind: classifyRecovery(String(e)) };
  }

  // One recovery at a time. It sends through the backend, not the composer's
  // `send`, whose failure would write the message into an empty draft. A
  // second press while one runs is told as rejected (#815).
  const recover = async (action: RecoveryAction, surface: Surface, sendRecovery: () => Promise<Awaited<ReturnType<SessionBackend["send"]>> | null>) => {
    if (recoveryLock.current) {
      actions.rejected(action, "in_progress", surface);
      return;
    }
    recoveryLock.current = true;
    setRecovering(true);
    const done = actions.start(action, surface);
    try {
      const out = await sendRecovery();
      if (!out) { done("cancelled"); return; }
      setStopped(false);
      for (const ev of out.events) applyEvent(ev);
      setError(null);
      clearComposerSendError(sendScope);
      clearTabViewError(tab.id);
      done("ok");
      // Recovery never touches the unsent composer draft or attachments.
    } catch (e) {
      refused(e);
      done("failed", failure(e));
    }
    finally { recoveryLock.current = false; setRecovering(false); }
  };

  const retry = (model?: string, surface: Surface = "banner") => {
    if (!model && recovery === "signed_out" && signInAgent && !loginIncident.cancelled) return requestSignIn();
    cancelLogin();
    return recover(model ? "choose_model" : "retry", surface, async () => {
      // Await confirmed local exit before starting a replacement. Remote
      // outcomes remain unknown and the continuation asks to verify them.
      await backend.stop(tab.id);
      if (model) {
        await backend.setModel(tab.id, model);
        backend.patchTab(tab.id, { model });
      }
      return backend.send(tab.id, RECOVERY_PROMPT, []);
    });
  };

  // The agent carries on in the same conversation (#665). Nothing is stopped: a
  // send starts an agent whose process has gone, and one still running takes it as its next turn.
  const sendContinue = (surface: Surface = "banner") => {
    if (recovery === "signed_out" && signInAgent && !loginIncident.cancelled) return requestSignIn();
    cancelLogin();
    return recover("continue_here", surface, () => backend.send(tab.id, CONTINUE_PROMPT, []));
  };

  // The agent never received the last prompt (#663): it goes again as it was sent, images and all.
  const resend = async () => {
    if (recoveryLock.current || !backend.resendUnsent) {
      actions.rejected("resend", recoveryLock.current ? "in_progress" : "unavailable");
      return;
    }
    recoveryLock.current = true;
    setRecovering(true);
    const done = actions.start("resend");
    try {
      const out = await backend.resendUnsent(tab.id);
      setStopped(false);
      for (const ev of out.events) applyEvent(ev);
      if (!out.queued) backend.patchTab(tab.id, { status: "in_progress" });
      setError(null);
      done("ok");
    } catch (e) {
      refused(e);
      done("failed", failure(e));
    }
    finally { recoveryLock.current = false; setRecovering(false); }
  };

  // Editors, dialogs and pickers own Escape before the agent does, and with nothing running the key is nobody's.
  // So does an edit open in the chat (a held follow-up's, PRO-380): `data-owns-escape` on it says so.
  const takesKey = () => live && !hasEscapeOverlay() && !document.activeElement?.closest(".editor-pane, [data-owns-escape]");
  // The chat's Escape is the agent's Escape. In the terminal view (local or cloud) the action is not bound at all:
  // there the key is typed into the agent's own screen, like every other key.
  useShortcut("session.interrupt", () => (takesKey() ? (actions.pressedWith("shortcut"), interrupt(), true) : false), {
    enabled: focused && active && !continuationOpen && !terminalMode && interrupts,
  });
  // The hard stop has no keys unless the reader gives it some. A cloud tab's terminal view passes those through too.
  useShortcut("session.stop", () => (takesKey() ? (actions.pressedWith("shortcut"), stop("chat"), true) : false), {
    enabled: focused && active && !continuationOpen && !(remoteTerminal && terminalMode),
  });

  const answerPermission = useCallback(
    async (requestId: string, optionId: string) => {
      setPermissionNotice(null);
      try {
        const outcome = await respondPermissionOnce(backend.logSessionId, tab.id, requestId,
          () => backend.respondPermission(tab.id, requestId, optionId));
        if (outcome === "already_answered") setPermissionNotice("This request was already answered or is no longer open.");
      } catch (e) {
        setError(local ? safeError(e) : commandError(e));
      }
    },
    [backend, local, tab.id],
  );

  const answerQuestions = useCallback(
    async (requestId: string, answers: Record<string, string>) => {
      setAnswering(true);
      try {
        await backend.answerQuestions(tab.id, requestId, answers);
      } catch (e) {
        setError(local ? safeError(e) : commandError(e));
      } finally {
        setAnswering(false);
      }
    },
    [backend, local, tab.id],
  );

  // A question the CLI drew in its own terminal (PRO-460): only the runtime's own refusals are said as they are.
  const answerTerminalPrompt = useCallback(
    async (promptId: string, choice: number | null) => {
      if (!backend.answerTerminalPrompt) return;
      setAnswering(true);
      try {
        await backend.answerTerminalPrompt(tab.id, promptId, choice);
      } catch (e) {
        setError(terminalPromptError(e));
      } finally {
        setAnswering(false);
      }
    },
    [backend, tab.id],
  );

  // The goal card's Pause and Resume are Codex's own `/goal pause` and `/goal resume`, sent now rather than held
  // behind the turn; Edit puts the goal in the composer to change (PRO-380).
  const sendGoalCommand = useCallback((command: string) => {
    if (blockedRef.current) return;
    setError(null);
    void backend.send(tab.id, command, []).then((out) => {
      for (const ev of out.events) applyEvent(ev);
    }, (e) => setError(local ? safeError(e) : commandError(e)));
  }, [backend, local, tab.id]);
  const editGoal = useCallback((objective: string) => {
    const put = () => {
      setDraft(tab.id, `/goal ${objective}`);
      focusDraftEnd();
    };
    // A message half written in the composer is not lost to the goal: the reader says whether it goes.
    const current = getDraft(tab.id).trim();
    if (!current || goalCommand(current) !== null) return put();
    showError("Edit puts the goal in the composer, which holds a message you haven't sent", undefined, {
      title: "Replace your draft with the goal?",
      key: `goal-edit:${tab.id}`,
      tone: "warning",
      icon: "target",
      copy: false,
      actions: [{ label: "Replace the draft", primary: true, run: put }],
    });
  }, [tab.id]);
  const focusDraftEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLTextAreaElement>(`[data-tab-composer="${CSS.escape(tab.id)}"] textarea[data-composer]`);
      composer?.focus({ preventScroll: true });
      composer?.setSelectionRange(composer.value.length, composer.value.length);
    });
  }, [tab.id]);
  // A /goal is checked as it is sent (PRO-380): it never goes as a steer, which would pass it to the agent as words.
  const steerable = goalCommand(draft) === null;
  const chatAgent = useMemo(() => ({ id: tab.harness, name: agentLabel }), [tab.harness, agentLabel]);
  const steer = useCallback(async () => {
    const text = draft.trim();
    if (!text || goalCommand(text) !== null) return;
    setError(null);
    try {
      await backend.steer(tab.id, text);
      setDraft(tab.id, "");
    } catch (e) {
      setError(commandError(e));
    }
  }, [backend, draft, tab.id]);
  // What cannot be changed from the chat for a CLI the reader started by hand, and why: said under the pickers too,
  // since a disabled picker's own reason is only a tooltip.
  const handLock = useMemo(() => byHandLock(tab, agentLabel), [tab, agentLabel]);
  const byHandNote = byHand
    ? `${agentLabel} was started by hand in this tab's terminal. ${handLock.model ? "Its model, effort and permission mode are" : "Its permission mode is"} changed there: TerminalX only restarts an agent it launched.`
    : null;
  // The conversation the chat is showing, when the app can start it again; and the one the tab holds, which its terminal offers.
  const reading = resumable(viewing ?? tab);
  const held = resumable(tab);
  const outbox = backend.outbox;
  // What became of the last model, effort or mode chosen here (a cloud tab).
  const settingsNotice = backend.settingsNotice?.(tab.id) ?? null;
  // A cloud tab's agent with no way to sign in in its workspace (PRO-78).
  const signIn = backend.signIn?.(tab.id) ?? null;
  // What Up and Down recall in the composer: this tab's own messages, plus a cloud tab's commands still on their way.
  const outboxEntries = useMemo(() => outbox?.entries(tab.id) ?? NO_ENTRIES, [outbox, tab.id]);
  const outboxFollowUps = remoteFollowUps;
  // Held messages are in the tray when the runtime takes changes to them (#1328), not drawn again in the chat.
  const heldInTray = !!backend.changeHeldQueue;
  const heldRow = useCallback((id: string) => {
    const actorId = remoteFollowUps.find((followUp) => followUp.clientCommandId === id)?.actorId;
    if (!actorId || !shared?.you || shared.you.listed === false) return undefined;
    const mine = actorId === shared.you.userId;
    if (mine) return undefined;
    const manager = shared.you.role === "manager";
    return { author: nameOf(actorId), locked: manager ? null : HELD_NOT_YOURS, editLocked: HELD_EDIT_NOT_YOURS };
  }, [remoteFollowUps, shared, nameOf]);
  const history = useMemo(
    () => sentMessages(transcript, outbox && { entries: outboxEntries, followUps: outboxFollowUps }),
    [transcript, outbox, outboxEntries, outboxFollowUps],
  );
  // #1291: a cloud tab's messages on their way, drawn at the transcript's end as Queued cards until the conversation has them.
  const pendingMessages = usePendingCloudMessages(`${backend.key}:${tab.id}`, outboxEntries, outboxFollowUps, events, tab.historyRead !== false);
  const chatPending = useMemo(() => (heldInTray ? pendingMessages.filter((message) => message.phase !== "held") : pendingMessages), [heldInTray, pendingMessages]);
  const resendCommand = useCallback((entry: OutboxEntry) => {
    if (!outbox) return;
    setError(null);
    void outbox.sendAgain(entry).catch((e) => setError(commandError(e)));
  }, [outbox]);
  const removeCommand = useCallback((entry: OutboxEntry) => {
    if (!outbox) return;
    setError(null);
    void outbox.remove(entry).catch((e) => setError(commandError(e)));
  }, [outbox]);
  const deciding = transcript.pendingAsks.some(ask => log.permissionResponses?.get(ask.requestId) === "sending" || outbox?.deciding(ask.requestId));

  // Signed out of the agent itself (not TerminalX's account): Claude Code signs in
  // from its own prompt, so its terminal is shown with `/login` typed; Codex signs
  // in from a command of its own, run in a shell tab. Other agents say how themselves.
  const signInAgent = !local || recovery !== "signed_out"
    ? undefined
    : ptyFirst && tab.harness === "claude"
      ? async (incident: typeof loginIncident) => {
          await enterTerminalView(session, tab);
          if (!loginCurrent(incident)) throw new Error("Sign-in cancelled");
          // The command, then Return on its own, as a key and not as pasted text.
          await pty.write(paneId, "/login");
          await new Promise((done) => setTimeout(done, 120));
          if (!loginCurrent(incident)) throw new Error("Sign-in cancelled");
          await pty.write(paneId, "\r");
        }
      : tab.harness === "codex"
        ? async (incident: typeof loginIncident) => {
            const pane = await openTerminal(session.id, session.cwd, 100, 24, { title: "Codex sign-in", command: "codex login" });
            incident.loginPane = pane.id;
          }
        : undefined;

  const loginAllowed = useRef(false);
  loginAllowed.current = local && !readOnly && !session.worktreeRemoved && backend.caps.write && !backend.readOnlyReason && !gate?.blocked && !transcript.pendingAsks.length && !continueOpen && !continuationOpen;
  const loginCurrent = (incident: typeof loginIncident) => currentLogin.current === incident && !incident.cancelled && !incident.paused && loginAllowed.current;
  const refreshLogin = useSignInReadiness(loginPending === loginIncident && loginCurrent(loginIncident) && !recovering ? tab.harness : null, () => {
    const incident = loginIncident;
    if (!loginCurrent(incident) || incident.opening || incident.consumed || recovery !== "signed_out" || recoveryLock.current) return;
    setLoginPending(null);
    void recover("retry", "banner", async () => {
      await backend.stop(tab.id);
      if (!loginCurrent(incident)) return null;
      incident.consumed = true;
      return backend.send(tab.id, RECOVERY_PROMPT, []);
    });
  });

  async function requestSignIn() {
    if (!signInAgent || !loginAllowed.current || recoveryLock.current) return;
    let incident = currentLogin.current;
    if (incident.cancelled) {
      // Stop revokes the old automatic attempt permanently. An explicit
      // Sign in starts a new incident; late work from the old one stays revoked.
      incident = newLoginIncident();
      currentLogin.current = incident;
      setReplacementLogin({ initial: initialLogin, incident });
    }
    if (!loginCurrent(incident) || incident.opening) return;
    if (incident.loginPane && !getTerminalState().panes.some(pane => pane.id === incident.loginPane && !pane.exited)) {
      // Login commands exit on success too. Verify credentials before deciding
      // that this terminal needs to be opened again.
      incident.opening = true;
      const readiness = await checkAgentReadiness(tab.harness);
      incident.opening = false;
      if (!loginCurrent(incident) || recoveryLock.current) return;
      if (readiness.state !== "signed_out") {
        incident.consumed = false;
        if (loginPending === incident) await refreshLogin();
        else setLoginPending(incident);
        return;
      }
      incident.loginPane = null;
      incident.launched = false;
      incident.consumed = false;
      setLoginPending(null);
    }
    if (incident.launched) {
      // An explicit retry may recover a failed delivery; readiness events
      // alone never re-arm a consumed automatic attempt.
      incident.consumed = false;
      if (loginPending === incident) await refreshLogin();
      else setLoginPending(incident);
      return;
    }
    incident.launched = true;
    incident.opening = true;
    const done = actions.start("sign_in");
    try {
      await signInAgent(incident);
      // Opening a terminal proves nothing about credentials. Readiness probes
      // while pending, on return, PTY exit, or Retry decide whether the turn can resume.
      if (currentLogin.current === incident && !incident.cancelled) setLoginPending(incident);
      done("ok");
    } catch (e) {
      incident.launched = false;
      if (loginCurrent(incident)) setError(safeError(e));
      done("failed", failure(e));
    } finally { incident.opening = false; }
  }

  // Pending requests and recovery sit with the composer in the chat, where the
  // reply goes; over a terminal there is no composer, so they head the pane.
  // A request on its own is part of the turn: the chat draws it inline, at the
  // messages' width, after what the agent said (PRO-382).
  // Only while the tab waits on it, as the banner did: once the turn moves on, an answer on its way is no request.
  const asksInChat = !recovery && tab.status === "waiting" && transcript.pendingAsks.length > 0;
  // A quick chat (`isQuickChat`) has no project: its path is a scratch directory that names nothing.
  const projectName = session.kind === "quick" ? null : session.projectPath.split("/").filter(Boolean).pop() ?? null;
  const askMeta = [tab.permissionMode ? modeLabel(tab.permissionMode) : null, projectName].filter(Boolean).join(" · ") || null;
  // A question the agent's CLI drew in its own terminal and is stopped on (PRO-460). A request or a recovery says
  // more; over the terminal the reader is looking at the question itself.
  const terminalPrompt = !recovery && tab.status === "waiting" && transcript.pendingAsks.length === 0 ? transcript.terminalPrompt : undefined;
  /** Stop the tab and open the continuation dialog: in `harness` when a usage-limit card's Switch asked for one. */
  const continueInNewSession = (harness: string | null) => {
    if (recoveryLock.current) {
      actions.rejected("continue_new", "in_progress");
      return;
    }
    // A dialog is tentative: suspend automatic retry until dismissal,
    // and revoke it only when the handoff is actually delivered.
    if (recovery === "signed_out") {
      loginIncident.paused = true;
      continuationLogin.current = loginIncident;
    }
    recoveryLock.current = true;
    setRecovering(true);
    // Told once the dialog ends: delivered (with where to), cancelled, or the stop before it failed.
    const done = actions.start("continue_new");
    const shownFor = recovery;
    void backend.stop(tab.id).then(() => {
      continueDone.current = done;
      setContinueFor(shownFor);
      setContinueHarness(harness);
      setContinueOpen(true);
    }).catch(e => {
      setError(safeError(e));
      restoreContinuationLogin();
      done("failed", failure(e));
    }).finally(() => {
      recoveryLock.current = false;
      setRecovering(false);
    });
  };

  // A cloud tab on its organization's login at the provider's usage limit: an admin has to act (PRO-200, design 17.13).
  const cloudOrg = local ? null : parseCloudWorkspaceKey(backend.key)?.orgId ?? null;
  const orgUsageLimit = recovery === "usage_limit" && !!cloudOrg && phase2Ready(accountStatus, cloudOrg, "usageLimitCard") && !transcript.pendingAsks.length;
  const banner = (placement: "top" | "composer") => orgUsageLimit && cloudOrg ? (placement === "top" ? null :
    <OrgUsageLimitCard harness={tab.harness} organizationId={cloudOrg}
      organization={accountStatus.organizations?.find((org) => org.id === cloudOrg)?.name ?? "the organization"}
      resetsAt={transcript.rateLimit?.resetsAt ?? null} busy={recovering || !backend.caps.write}
      onSwitch={backend.caps.write && !readOnly ? (harness) => continueInNewSession(harness) : undefined} />
  ) : terminalPrompt ? (placement === "top" ? null :
    <div className="mx-auto w-full max-w-3xl shrink-0 bg-chat px-6 pb-2">
      <TerminalPromptCard prompt={terminalPrompt} agent={cloudAgentLabel(tab.harness)}
        busy={recovering || answering || !backend.caps.write} blockedReason={backend.approveBlockedReason ?? null}
        onAnswer={backend.answerTerminalPrompt ? (choice) => void answerTerminalPrompt(terminalPrompt.id, choice) : undefined}
        onOpenTerminal={ptyFirst ? () => void enterTerminalView(session, tab) : undefined}
        aside={<Button size="sm" variant="ghost" className="text-muted-foreground" disabled={recovering || !backend.caps.write} onClick={() => stop("banner")}>Stop session</Button>} />
    </div>
  ) : (placement === "composer" && asksInChat ? null :
    <RecoveryBanner placement={placement} kind={recovery} limit={transcript.rateLimit ?? null} waiting={tab.status === "waiting"} native={tab.transport === "experimentalCodexStdio"} asks={transcript.pendingAsks} busy={recovering || !backend.caps.write} answering={answering || deciding} answerBlockedReason={backend.approveBlockedReason ?? null}
        models={models.filter(m => m.id !== tab.model && !m.upgrade)} onOpenModels={refreshPickerModels} onPermission={answerPermission} onQuestions={answerQuestions}
        onPressed={actions.pressedWith}
        accounts={tab.providerSessionId ? { choices: recovery === "signed_out" ? accountSwitch.targets : accountSwitch.withRoom, switching: accountSwitch.switching, error: accountSwitch.error, onSwitch: (account) => void accountSwitch.switchTo(account) } : null}
        onRetry={(model) => void retry(model)} onStop={() => stop("banner")} onSendContinue={() => void sendContinue()} onResend={backend.resendUnsent && !gate?.blocked ? () => void resend() : undefined}
        signInPending={loginPending === loginIncident && !loginIncident.cancelled}
        onSignIn={signInAgent ? () => void requestSignIn() : undefined}
        onContinue={() => continueInNewSession(null)} />
  );

  // What the worktree's branch changes, over the composer: a local chat on its own branch.

  const chat = (
    <RecoveryReports.Provider value={reporter}>
    <Chat
      sessionId={backend.logSessionId}
      tabId={tab.id}
      checkpointTabId={(turnActions || backend.checkpoints) && !readOnly ? tab.id : undefined}
      checkpoints={turnActions?.checkpoints ?? backend.checkpoints}
      transcript={asksInChat ? transcript : { ...transcript, pendingAsks: [] }}
      active={active}
      takesKeys={focused && active && !continuationOpen && !terminalMode}
      askDetail
      askMeta={askMeta}
      answerBlockedReason={backend.approveBlockedReason ?? null}
      stream={log.stream}
      cwd={local ? session.cwd : undefined}
      live={live}
      // Until the saved conversation is read, an empty chat is one still loading, not one with nothing in it.
      loading={!readOnly && (!!tab.loadingHistory || (local && !log.loaded))}
      progressing={live && tab.status === "in_progress" && !recovery && !transcript.pendingAsks.length}
      answering={answering || deciding || recovering || !backend.caps.write}
      onAnswerPermission={answerPermission}
      onAnswerQuestions={answerQuestions}
      onSendQueuedNow={backend.sendQueuedNow && !gate?.blocked ? sendQueuedNow : undefined}
      sending={sending}
      pending={outbox && chatPending.length > 0 && (
        <CloudPendingMessages
          messages={chatPending}
          workspace={outbox.workspaceStatus}
          nameOf={nameOf}
          onSendAgain={!readOnly && !gate?.blocked ? resendCommand : undefined}
          onRemove={!readOnly ? removeCommand : undefined}
          // Escape for the running turn; the runtime then sends what it holds.
          onSendNow={interrupts && live && !readOnly && !gate?.blocked ? interrupt : undefined}
        />
      )}
      firstMessage={local && !readOnly && log.firstMessage && <FirstMessage message={log.firstMessage} session={session} agent={agentLabel} setup={setup} />}
      onReset={canReset ? (endSeq, target) => setResetTarget({ endSeq, target }) : undefined}
      onRetryInNewChat={local && mayHandOff ? (turn) => { if (turn.prompt) openAgentHandoff(session, tab, tab.harness, turn.prompt.text, true, { images: turn.prompt.images, files: turn.prompt.files }); }
        // On a runtime (#1327) the prompt's text: its attachments are not kept to send again, as for Retry.
        : handoff ? (turn) => {
          if (!turn.prompt) return;
          if (turn.prompt.images?.length || turn.prompt.files?.length) showError("Couldn't retry in a new chat", RESEND_ATTACHMENTS);
          else setRemoteHandoff({ agent: tab.harness, purpose: { kind: "retry", prompt: turn.prompt.text }, actions: handoff });
        } : undefined}
      onSendAgain={backend.resendMessage && !gate?.blocked ? sendAgain : undefined}
      onRetry={backend.resendMessage && !gate?.blocked && !readOnly ? sendAgain : undefined}
      onSecondOpinion={counterpart ? (turn) => openAgentHandoff(session, tab, counterpart.id, secondOpinionPrompt(turn))
        : handOffTo ? (turn) => handOffTo({ kind: "review", prompt: secondOpinionPrompt(turn) }) : undefined}
      secondOpinionAgent={(counterpart ?? remoteCounterpart)?.name}
      onFork={canFork && turnActions ? (endSeq, into) => void turnActions.fork(tab.id, endSeq, into).then(
        (forked) => { if (forked.note) showError(forked.note, undefined, { title: into === "tab" ? "Forked to a new tab" : "Forked to a new session" }); },
        (e) => showError("Couldn't fork the conversation", e)) : undefined}
      onSaveSnippet={setSnippetPrompt}
      // What a local tab offers and this one cannot, shown off with why (#1289).
      unavailable={readOnly ? undefined : backend.unavailable}
      turnSettings={turnSettings}
      agent={chatAgent}
      onGoalCommand={tab.harness === "codex" && !readOnly && backend.caps.write && !gate?.blocked ? sendGoalCommand : undefined}
      onEditGoal={tab.harness === "codex" && !readOnly && backend.caps.write && !gate?.blocked ? editGoal : undefined}
      footer={
        <>
        {local && localVmTasks ? <LocalVmTasks key={JSON.stringify([session.id, tab.id, conversation])} session={session} tab={tab} conversation={conversation} active={active} readOnly={readOnly} selectedPrompt={draft} /> : null}
        {
        readOnly ? (
          // A conversation that is not running is read, and resumed from here: there is nobody to send to.
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-6 pb-4 pt-2 text-xs text-muted-foreground" role="status" data-testid="conversation-read-only">
            <span className="min-w-0 flex-1">
              {viewing
                ? `An earlier conversation in this tab, with ${agentName(viewing.harness)}. It is kept as it was.`
                : `${agentLabel} is not running in this tab. Its conversation is kept here.`}
              {error ? <span className="mt-1 block text-warning">{error}</span> : null}
            </span>
            {viewing ? (
              <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>
                Back to the current one
              </Button>
            ) : null}
            {reading && terminalTab ? (
              <Button size="sm" variant="outline" disabled={resuming} onClick={() => resume(reading)} data-testid="conversation-resume">
                <Play /> Resume here
              </Button>
            ) : null}
          </div>
        ) : (
        <>
        <AccountSwitchNote tabId={tab.id} reportedModel={transcript.model} modelName={(id) => modelLabel(tab.harness, id)} />
        {recovery !== "signed_out" && <AccountGoneNotice gone={accountSwitch.gone} targets={tab.providerSessionId ? accountSwitch.targets : []} switching={accountSwitch.switching} error={accountSwitch.error} onSwitch={(account) => void accountSwitch.switchTo(account)} />}
        {banner("composer")}
        {backend.caps.steer && backend.caps.write && !gate?.blocked && live && draft.trim() && steerable && (!backend.changeHeldQueue || followUps === "hold") && (
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-6 text-xs text-muted-foreground">
            <span>Send queues it for when the agent pauses.</span>
            <Button size="xs" variant="outline" onClick={() => void steer()}>
              Steer now
            </Button>
          </div>
        )}
        {backend.changeHeldQueue && <div className="mx-auto w-full max-w-3xl px-6"><HeldQueueTray key={tab.id} scope={tab.id} queue={heldQueue} onChange={changeHeldQueue} disabled={!!gate?.blocked} busy={live}
          unavailable={local ? undefined : { move: backend.unavailable?.moveHeld, pause: backend.unavailable?.pauseHeld }} row={local ? undefined : heldRow} /></div>}
        <Composer
          beforeSend={local && session.bot?.home && typeof session.bot.id === "string" ? <AlsoSendsTo botId={session.bot.id} /> : undefined}
          aiEditor={local && tab.harness === "claude" ? localAiEditor(session.id, tab.id) : null}
          aiEditorUnavailable={local ? "The AI Editor works in Claude Code tabs for now" : "The AI Editor works in local tabs for now"}
          setupRunning={setup?.status === "running" || setup?.status === "pending" || setup?.status === "stopping"}
          followUps={backend.changeHeldQueue ? followUps : undefined}
          sendScope={sendScope}
          tab={tab}
          cwd={local ? session.cwd : undefined}
          // A tab that is not on screen asks its runtime for nothing: on a runtime that answers
          // in order, its command list held up the terminal view of the tab that is (#449).
          commands={local || active ? backend.commands?.(tab) : null}
          files={backend.files?.()}
          people={local ? null : backend.people?.()}
          prs={local ? null : backend.prs?.()}
          remote={!local}
          attachFiles={backend.caps.files}
          busy={live}
          draft={draft}
          onDraftChange={(v) => {
            if (viewError) clearTabViewError(tab.id);
            setDraft(tab.id, v);
            if (collabLive && v) presenceTyping(shared!.key);
            // Not switched to another account while the person types here (#981).
            if (local && v) noteComposerTyping(session.id, tab.id);
          }}
          onSend={send}
          sentAfter={sentAfter}
          history={history}
          hasConversation={transcript.turns.length > 0}
          agentHandoff={counterpart ? { id: counterpart.id, name: counterpart.name, run: () => openAgentHandoff(session, tab, counterpart.id) }
            : remoteCounterpart && handOffTo ? { id: remoteCounterpart.id, name: remoteCounterpart.name, run: () => handOffTo({ kind: "continue" }) }
            // Off on this remote session, with why, where a local one offers it (#1289).
            : remoteOther && !handoff && backend.unavailable?.agentHandoff ? { id: remoteOther.id, name: remoteOther.name, unavailable: backend.unavailable.agentHandoff } : undefined}
          // Stop is Escape first; once that went unanswered, the same control ends the process.
          onStop={interrupts && !unanswered ? () => interrupt() : () => stop("chat")}
          stopMode={!interrupts ? "stop" : unanswered ? "force" : "interrupt"}
          onSetModel={(m) => {
            if (gate && !gate.mayConfigure) return;
            if (recovery) { void retry(m, "chat"); return; }
            // Not patched in here: the tab's model is what the agent is running, and the
            // session's own update says when that has changed or is still on its way (#404).
            void backend.setModel(tab.id, m).catch((e) => setError(local ? safeError(e) : commandError(e)));
          }}
          onSetEffort={(e) => {
            if (gate && !gate.mayConfigure) return;
            void backend.setEffort(tab.id, e).catch((err) => setError(local ? safeError(err) : commandError(err)));
          }}
          onSetMode={(m) => {
            if (gate && !gate.mayConfigure) return;
            // Not patched in here either: the tab's mode is the one the agent is in (#417).
            void backend.setPermissionMode(tab.id, m).catch((e) => setError(local ? safeError(e) : commandError(e)));
          }}
          reportedModel={transcript.model}
          turns={transcript.turns}
          compacting={transcript.compacting}
          modelsAreLocal={local}
          modelClient={backend.modelClient}
          contextUsed={transcript.contextUsed ?? tab.contextUsed ?? undefined}
          contextMax={transcript.contextMax ?? tab.contextMax ?? undefined}
          handoffs={handoffsFor(transcript, isGit && changes.files.length > 0, deleteWorkspace, !local || forge !== "localOnly")}
          disabled={!!gate?.blocked}
          settingsLockedReason={gate && !gate.mayConfigure ? SETTINGS_LOCKED_REASON : null}
          modelLockedReason={handLock.model}
          modeLockedReason={handLock.mode}
          settingsNote={settingsNotice === "ignored" ? SETTINGS_IGNORED_REASON : settingsNotice === "pending" ? SETTINGS_WITH_NEXT_MESSAGE : byHandNote}
          settingsNoteWarning={settingsNotice === "ignored"}
          canStop={!gate || gate.mayStop}
          disabledReason={gate?.blocked ?? busyNotice ?? error ?? (viewError && local && !viewRefusal ? safeError(viewError) : null) ?? (backend.sendHeldReason && backend.readOnlyReason === backend.sendHeldReason ? null : backend.readOnlyReason)}
          heldReason={backend.sendHeldReason ?? null}
          autoFocus={active && focused}
          onOpenCodexTab={counterpart?.id === "codex" ? () => openAgentHandoff(session, tab, "codex")
            : remoteCounterpart?.id === "codex" && handOffTo ? () => handOffTo({ kind: "continue" }) : undefined}
        />
        </>
        )
        }
        </>
      }
    />
    </RecoveryReports.Provider>
  );

  const terminal = (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-terminal">
      {/* No bar over a terminal that is working: what it would say (its state, its command line, how the chat
          relates to it) the tab already shows or nobody needs. Its few controls sit in the terminal's corner
          toolbar, shown on hover; only a problem below, such as an exit or an error, takes a row. */}
      <span className="sr-only" data-testid="terminal-view-title">{terminalTab ? "Terminal" : `Terminal view · ${TAB_STATUS_LABEL[tab.status]}`}</span>
      {terminalTab && error && (
        <div role="alert" className="shrink-0 bg-warning/10 px-3 py-1.5 text-xs text-foreground">{error}</div>
      )}
      {pane?.exited && (
        <div className="flex shrink-0 items-center gap-2 bg-warning/10 px-3 py-1.5 text-xs text-foreground">
          {terminalTab ? "The shell exited" : "The agent's terminal exited"}{pane.exitCode != null ? ` (${pane.exitCode})` : ""}.
          {terminalTab ? (
            <Button size="xs" variant="outline" className="ml-auto" onClick={() => void startTabAgent(session, tab)}>
              New shell
            </Button>
          ) : (
            <Button size="xs" variant="outline" className="ml-auto" onClick={() => void leaveTerminalView(session, tab)}>
              <MessageSquare /> Back to chat
            </Button>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <TerminalView
          id={paneId}
          visible={active && terminalMode}
          focused={focused}
          pinned={terminalTab && !!held && !pane?.exited}
          actions={
            <>
              {terminalTab && held && !pane?.exited && (
                <Button size="xs" variant="ghost" disabled={resuming} onClick={() => resume(held)} data-testid="terminal-resume">
                  <Play /> Resume {agentLabel}
                </Button>
              )}
              {live && !recovery && <Button size="xs" variant="ghost" disabled={recovering} onClick={(e) => { actions.pressedWith(inputOf(e)); stop("chat"); }}>Stop session</Button>}
            </>
          }
        />
      </div>
    </div>
  );

  // The same header as a local tab's terminal view; what it attaches to is on the VM.
  const cloudTerminal = remoteTerminal && (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-terminal">
      {/* Like the local view: a row only when there is something wrong to say. */}
      <div className={remoteTerminal.client ? "sr-only" : "flex min-h-8 shrink-0 items-center border-b border-hairline px-3 py-1.5 text-xs text-muted-foreground"}>
        <span className="shrink-0 text-foreground" data-testid="cloud-terminal-view-title">
          Terminal view · {remoteTerminal.client ? TAB_STATUS_LABEL[tab.status] : remoteTerminal.asleep ? "Stopped" : "Not connected"}
        </span>
      </div>
      <CloudAgentTerminal
        target={remoteTerminal}
        generation={backend.generation}
        tabId={tab.id}
        active={active && terminalMode}
        // Whoever may not send may not type; nor may a driver who cannot approve what the agent asks on its own screen.
        blocked={gate?.blocked ?? backend.readOnlyReason ?? (gate && !gate.mayConfigure ? TERMINAL_APPROVAL_REASON : null)}
        you={collabLive ? (shared?.you ?? null) : null}
      />
    </div>
  );

  // The body sits in a flex column: the chat (`flex-1`) takes the height left
  // under the bars above and scrolls inside it. In a plain block it grew as
  // tall as its transcript and pushed the composer out of the window.
  // `@Name` chips in the transcript (PRO-141), for every reader: oneself included.
  const wrap = (body: React.ReactNode) => <MentionPeopleContext.Provider value={transcriptPeople}><div className="flex h-full min-h-0 flex-col bg-chat">
    {collabLive && shared?.client && (
      <LeaseBar
        collabKey={shared.key}
        client={shared.client}
        tabId={tab.id}
        lease={lease}
        turnRunning={tabLive}
        you={shared.you}
        notesOpen={notesOpen}
        onToggleNotes={() => setNotesOpen((open) => !open)}
        noteCount={collab.notes[tab.id]?.notes.length ?? 0}
        unreadNotes={collab.unreadNotes[tab.id] ?? 0}
      />
    )}
    {views.waiting[tab.id] && (
      <div role="status" className="flex shrink-0 items-center gap-2 bg-veil px-3 py-1.5 text-xs" data-testid="terminal-view-pending">
        <span className="min-w-0 flex-1">Terminal view will open when Codex finishes this turn. You can interrupt the turn to open it sooner.</span>
        <Button variant="ghost" size="xs" onClick={() => cancelTerminalView(tab.id)}>Stay in chat</Button>
      </div>
    )}
    {viewRefusal && (
      <div role="alert" className="flex shrink-0 items-center gap-2 bg-warning/10 px-3 py-1.5 text-xs text-foreground" data-testid="terminal-view-refused">
        <span className="min-w-0 flex-1">{viewRefusal}</span>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => clearTabViewError(tab.id)}>
          <X />
        </Button>
      </div>
    )}
    {signIn && (signIn.machine ? (
      // A machine's agent signs in there, from its page (21.09), not through an organization's logins.
      <div className="shrink-0 border-b border-hairline px-3 py-2" data-testid="machine-agent-sign-in">
        <MachineMessage kind="signIn" name={signIn.machine} agent={cloudAgentLabel(tab.harness)} />
      </div>
    ) : (
      <SignInNotice info={{ harness: tab.harness, signIn: signIn.signIn }} organizationId={signIn.organizationId} />
    ))}
    {outbox && <CloudOutbox entries={outbox.entries(tab.id)} nameOf={nameOf} onSendAgain={resendCommand} />}
    {earlier.length > 0 && (
      // The tab held other conversations before this one: another agent was run in its terminal, or the same one on something else.
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1 text-xs text-muted-foreground" data-testid="tab-conversations">
        <History className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {viewing ? `Reading an earlier conversation with ${agentName(viewing.harness)}` : `${earlier.length} earlier conversation${earlier.length === 1 ? "" : "s"} in this tab`}
        </span>
        <DropdownMenu {...conversationsMenu.root}>
          <DropdownMenuTrigger asChild {...conversationsMenu.trigger}>
            <Button size="xs" variant="outline" className="ml-auto shrink-0">Conversations</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[16rem]">
            <DropdownMenuLabel>This tab's conversations</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setViewing(null)} data-testid="conversation-current">
              <AgentMark id={tab.harness} decorative />
              <span className="min-w-0 truncate">{tab.title?.trim() || agentLabel}</span>
              <span className="ml-auto pl-3 text-[11px] text-faint">{terminalTab ? "last" : "current"}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {earlier.map((past) => (
              <DropdownMenuItem
                key={past.id ?? "first"}
                onSelect={() => {
                  setViewing(past);
                  // It is read in the chat, whichever face the tab was showing.
                  if (terminalMode) void leaveTerminalView(session, tab);
                }}
              >
                <AgentMark id={past.harness} decorative />
                <span className="min-w-0 truncate">{past.title?.trim() || agentName(past.harness)}</span>
                {past.ended ? <span className="ml-auto pl-3 text-[11px] text-faint">{endedAt(past.ended)}</span> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )}
    {stopped && !terminalTab && <div role="status" className="flex items-center gap-2 border-b border-hairline p-3 text-xs">
      Session closed. Untracked or remote commands may still be running; verify their outcome before continuing.
      <Button size="sm" disabled={recovering} onClick={(e) => { actions.pressedWith(inputOf(e)); void retry(undefined, "chat"); }}>Resume safely</Button>
      <Button size="sm" variant="outline" disabled={recovering} title={'Send "continue" to the agent in this conversation'} onClick={(e) => { actions.pressedWith(inputOf(e)); void sendContinue("chat"); }}>Continue here</Button>
    </div>}
    {permissionNotice && <p role="status" className="shrink-0 border-b border-hairline px-4 py-2 text-xs text-muted-foreground">{permissionNotice}</p>}
    {terminalMode && banner("top")}
    {canReset && tab.resetBackupId && !live && <div role="status" className="flex items-center gap-2 border-b border-hairline px-4 py-2 text-xs text-muted-foreground">
      <span>{resetNotice(tab)}</span>
      <Button size="xs" variant="ghost" onClick={() => setResetTarget({ endSeq: null })}>Undo reset</Button>
    </div>}
    {snippetPrompt !== null && <SaveSnippetDialog prompt={snippetPrompt} onClose={() => setSnippetPrompt(null)} />}
    {remoteHandoff && (
      <RemoteHandoffDialog
        key={`${tab.id}:${remoteHandoff.agent}:${remoteHandoff.purpose.kind}`}
        handoff={remoteHandoff.actions}
        source={tab}
        agent={remoteHandoff.agent}
        modelClient={backend.modelClient ?? null}
        purpose={remoteHandoff.purpose}
        where={backend.key.startsWith("machine:") ? "the machine" : "the workspace"}
        onClose={() => setRemoteHandoff(null)}
      />
    )}
    {resetTarget && turnActions && <ResetChatDialog reset={(endSeq, resetFiles, confirm) => turnActions.reset(tab.id, endSeq, resetFiles, confirm)} endSeq={resetTarget.endSeq} target={resetTarget.target} agent={agentLabel}
      filesRestored={resetTarget.endSeq === null ? (tab as ResetTab).resetFilesRestored : undefined} onClose={() => setResetTarget(null)} onWarning={setError} />}
    {continueOpen && <ContinuationDialog session={session} source={tab} initialHarness={continueHarness ?? undefined}
      onDelivered={(to) => {
        if (continuationLogin.current === currentLogin.current) cancelLogin();
        continuationLogin.current = null;
        dialogShown.end("submitted");
        continueDone.current?.("ok", { targetSession: to.sessionId, targetTab: to.tabId });
        continueDone.current = null;
      }}
      onClose={() => {
        dialogShown.end("cancelled");
        continueDone.current?.("cancelled");
        continueDone.current = null;
        setContinueOpen(false);
        setContinueHarness(null);
        restoreContinuationLogin();
      }} />}
    {collabLive && notesOpen && shared?.client ? (
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
        <NotesPanel collabKey={shared.key} client={shared.client} tabId={tab.id} onClose={() => setNotesOpen(false)} />
      </div>
    ) : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
    )}
  </div></MentionPeopleContext.Provider>;

  // A PTY-first tab keeps its terminal mounted under the chat: the pane holds
  // the live CLI, so unmounting it to show the transcript would throw away the
  // scrollback and resize the agent's window on every toggle. `invisible`
  // rather than `hidden` because the terminal is sized from this laid-out
  // box. The xterm itself is out of the document until the terminal is shown
  // (`TerminalView`), so the CLI's redraws cost nothing while the chat is up.
  if (ptyFirst) {
    return wrap(
      <div className="relative flex h-full min-h-0 flex-1 flex-col">
        <div className={cn("absolute inset-0 flex min-h-0 flex-col", !terminalMode && "invisible")} aria-hidden={!terminalMode}>
          {terminal}
        </div>
        {!terminalMode && <div className="absolute inset-0 z-10 flex min-h-0 flex-col bg-chat">{chat}</div>}
      </div>
    );
  }

  if (terminalMode && cloudTerminal) return wrap(cloudTerminal);
  if (terminalMode) return wrap(terminal);
  return wrap(chat);
}
