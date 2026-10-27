import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agent as agentApi, errorMessage, type ImageInput } from "@/lib/api";
import { applyEvent, getTabLog, useTabLog } from "@/lib/agentEvents";
import { buildTranscript, conversationEvents, type Transcript } from "@/lib/transcript";
import { clearComposerSendError, composerSendScope, useComposerSend } from "@/lib/composerSends";
import { getDraft, setDraft, subscribeDrafts, useDraft } from "@/lib/drafts";
import { useSessionIsGit } from "@/lib/quickChats";
import { hasEscapeOverlay, useShortcut } from "@/lib/hotkeys";
import { changeRange, useChanges } from "@/lib/changes";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import { localSessionBackend, terminalViewOf, type SessionBackend } from "@/lib/sessionBackend";
import { CloudOutbox, SignInNotice, commandError as cloudCommandError } from "@/components/cloud/CloudAgents";
import { CloudAgentTerminal } from "@/components/cloud/CloudAgentTerminal";
import { LeaseBar, NotesPanel, useNowUntil } from "@/components/cloud/CloudCollab";
import { SETTINGS_IGNORED_REASON, SETTINGS_LOCKED_REASON, SETTINGS_WITH_NEXT_MESSAGE, TERMINAL_APPROVAL_REASON, presenceTyping, tabGate, useCollab } from "@/lib/cloudCollab";
import { usePeople } from "@/lib/cloudPeople";
import { Chat } from "@/components/chat/Chat";
import { Composer, type Handoff } from "@/components/chat/Composer";
import { sentMessages } from "@/components/chat/useComposerHistory";
import { TerminalView } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import { History, MessageSquare, Play } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { useTerminals } from "@/lib/terminal";
import { cn } from "@/lib/cn";
import { clearTabViewError, forgetTabView, isPtyFirst, leaveTerminalView, startTabAgent, useTabViews } from "@/lib/tabViews";
import { byHandLock, isByHand, isTerminalTab, resumable, tabPaneId, tabViewIn, type Resumable } from "@/lib/tabFront";
import { useSessionStore } from "@/lib/sessions";
import { classifyRecovery, RECOVERY_MESSAGES, RECOVERY_PROMPT, recoveryFromEvents } from "@/lib/recovery";
import { RecoveryBanner } from "./RecoveryBanner";
import { ContinuationDialog } from "./ContinuationDialog";
import { useModels } from "@/lib/models";
import { openWorkspaceDelete } from "@/lib/dialogs";
import { offersWorkspaceDelete, turnLive, useWorkspaceDisposition, type RemovableWorkspace } from "@/lib/workspaceRemoval";
import { usePickerModels } from "@/lib/cloudModels";
import { TAB_STATUS_LABEL, type PastConversation, type SessionEntry, type TabEntry } from "@/types/session";
import { interruptUnanswered } from "@/types/events";

const STOP_REFUSED = "Only the person driving this tab or an admin can stop the agent.";

/**
 * One tab: its event log, the transcript built from it, and the composer.
 */
/**
 * After a turn that touched files, the obvious next steps as one-click
 * prompts. They only fill the composer; the reader still sends.
 *
 * `deleteWorkspace` is the step after those, once the worktree's pull request
 * has merged. It is the app's own action, not a prompt: an agent is never
 * asked to remove the worktree it runs in. It does not wait for a turn.
 */
export function handoffsFor(t: Transcript, changed: boolean, deleteWorkspace?: () => void): Handoff[] | undefined {
  const last = t.turns[t.turns.length - 1];
  const prompts: Handoff[] =
    last?.completed?.status === "ok" && changed
      ? [
          { label: "Commit", prompt: "Commit the current changes with a clear, conventional message. Do not push." },
          { label: "Create PR", prompt: "Push this branch and open a pull request with a title and a short description of the changes." },
          { label: "Run it", prompt: "Run the project's dev server or test suite in the background and report the first errors, if any." },
        ]
      : [];
  const steps = deleteWorkspace ? [...prompts, { label: "Delete workspace", run: deleteWorkspace }] : prompts;
  return steps.length ? steps : undefined;
}

/** When a conversation ended, as a short local time; the day too when that was not today. */
function endedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const today = new Date().toDateString() === at.toDateString();
  return at.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function TabView({
  session,
  tab,
  active,
  continuationOpen = false,
  backend: given,
  gitSource,
  workspace,
}: {
  session: SessionEntry;
  tab: TabEntry;
  active: boolean;
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
  const isGit = useSessionIsGit(session);
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
  const [localError, setError] = useState<string | null>(null);
  const error = localError ?? (sendState.error != null ? (local ? safeError(sendState.error) : commandError(sendState.error)) : null);
  const views = useTabViews();
  // A cloud tab's terminal view (PRO-86) attaches to its CLI on the VM; it is
  // only there while the runtime serves it, else the tab shows its chat.
  const remoteTerminal = !local && terminalViewOf(backend, tab).available ? (backend.agentTerminal ?? null) : null;
  const terminalMode = tabViewIn(views.views, tab) === "terminal" && (local || !!remoteTerminal);
  const viewError = views.errors[tab.id] ?? null;
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
  const [recovering, setRecovering] = useState(false);
  const recoveryLock = useRef(false);
  const [stopped, setStopped] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);
  const { models, refresh: refreshPickerModels } = usePickerModels(useModels(tab.harness), !local, backend.modelClient, tab.harness);
  // The tab's log holds every conversation it has held; the chat is one of them.
  const conversation = viewing ? (viewing.id ?? null) : (tab.conversation ?? null);
  const events = useMemo(() => conversationEvents(log.events, conversation), [log.events, log.version, conversation]);
  // The ones before the current that have anything in them, newest first.
  const earlier = useMemo(
    () => (tab.history ?? []).filter((past) => conversationEvents(log.events, past.id ?? null).some((event) => event.payload.type === "user_message")).reverse(),
    [tab.history, log.events, log.version],
  );
  const eventRecovery = useMemo(() => (readOnly ? null : recoveryFromEvents(events)), [events, log.version, readOnly]);
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
  const [notesOpen, setNotesOpen] = useState(false);
  // The retry and resume flows restart a local agent process; a cloud tab's runtime recovers itself.
  // A tab that is a terminal has no agent to recover: what went wrong there is said as it is.
  const recovery = !backend.caps.recovery || readOnly ? null : eventRecovery ?? (error || viewError ? classifyRecovery(error ?? viewError!) : null);


  const backendRef = useRef(backend);
  backendRef.current = backend;
  useEffect(() => backendRef.current.openTab(tab.id, (e) => setError(safeError(e))) ?? undefined, [backend.key, backend.generation, tab.id]);

  // A PTY-first tab is its CLI, so opening the tab starts it. Idempotent, and
  // the pane it lands in is adopted from the backend's own event.
  // Again when what is in its terminal changes: a tab that became a terminal is given its shell.
  const front = tab.front ?? "agent";
  useEffect(() => {
    if (active && ptyFirst) void startTabAgent(session, tab);
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

  // Viewing a finished tab marks it read.
  useEffect(() => {
    if (active && tab.status === "completed") {
      void backendRef.current.markRead(tab.id);
      backendRef.current.patchTab(tab.id, { status: "idle" });
    }
  }, [active, tab.status, backend.key, tab.id]);

  // Nothing is running in a conversation that is only being read.
  const live = !readOnly && (tab.status === "in_progress" || tab.status === "waiting");
  const transcript = useMemo(() => buildTranscript(events, live), [events, log.version, live]);
  // Whether the session's checkout differs from where the conversation
  // started, by tree diff, so a shell heredoc counts as much as an edit tool.
  const range = useMemo(() => changeRange(events, session.baseRef), [events, log.version, session.baseRef]);
  const changes = useChanges(local ? (session.cwd ? localGitSource(session.cwd) : undefined) : gitSource, range, isGit && active && !live);

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
  const send = useCallback(
    async (text: string, images: ImageInput[]) => {
      // A viewer, or someone else holds this tab's lease (PRO-30): nothing is queued.
      if (blockedRef.current) throw new Error(blockedRef.current);
      setError(null);
      setStopped(false);
      let draftEdited = false;
      const unsubscribeDraft = subscribeDrafts((id) => {
        if (id === tab.id) draftEdited = true;
      });
      try {
        const out = await backend.send(tab.id, text, images);
        for (const ev of out.events) applyEvent(ev);
        if (!out.queued) backend.patchTab(tab.id, { status: "in_progress" });
      } catch (e) {
        setError(local ? safeError(e) : commandError(e));
        backend.setTabStatus(tab.id, "waiting");
        if (!draftEdited) setDraft(tab.id, getDraft(tab.id) || text);
        throw e;
      } finally {
        unsubscribeDraft();
      }
    },
    [backend, local, tab.id],
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
      setError(STOP_REFUSED);
      return;
    }
    // Read now, not at the last render: the turn this is for may have ended since.
    const events = getTabLog(backend.logSessionId, tab.id).events;
    setInterruptedAt(events.length ? events[events.length - 1].seq : 0);
    void backend.interrupt(tab.id).catch((e) => setError(local ? safeError(e) : commandError(e)));
  }, [backend, local, tab.id, gate?.mayStop]);

  // The hard stop: the agent's process is ended and the banner offers to resume.
  const stop = useCallback(() => {
    if (gate && !gate.mayStop) {
      setError(STOP_REFUSED);
      return;
    }
    if (recoveryLock.current) return;
    recoveryLock.current = true;
    setRecovering(true);
    void backend.stop(tab.id).then(() => {
      backend.setTabStatus(tab.id, "idle");
      // A queued cloud stop ends the turn on the runtime; there is nothing local to resume.
      if (backend.caps.recovery) setStopped(true);
      setError(null);
      clearComposerSendError(sendScope);
      clearTabViewError(tab.id);
    }).catch((e) => setError(local ? safeError(e) : commandError(e))).finally(() => {
      recoveryLock.current = false;
      setRecovering(false);
    });
  }, [backend, local, tab.id, gate?.mayStop, sendScope]);

  const retry = async (model?: string) => {
    if (recoveryLock.current) return;
    recoveryLock.current = true;
    setRecovering(true);
    try {
      // Await confirmed local exit before starting a replacement. Remote
      // outcomes remain unknown and the continuation asks to verify them.
      await backend.stop(tab.id);
      if (model) {
        await backend.setModel(tab.id, model);
        backend.patchTab(tab.id, { model });
      }
      const out = await backend.send(tab.id, RECOVERY_PROMPT, []);
      setStopped(false);
      for (const ev of out.events) applyEvent(ev);
      setError(null);
      clearComposerSendError(sendScope);
      clearTabViewError(tab.id);
      // Recovery never touches the unsent composer draft or attachments.
    } catch (e) { setError(safeError(e)); }
    finally { recoveryLock.current = false; setRecovering(false); }
  };

  // Editors, dialogs and pickers own Escape before the agent does, and with nothing running the key is nobody's.
  const takesKey = () => live && !hasEscapeOverlay() && !document.activeElement?.closest(".editor-pane");
  // The chat's Escape is the agent's Escape. In the terminal view (local or cloud) the action is not bound at all:
  // there the key is typed into the agent's own screen, like every other key.
  useShortcut("session.interrupt", () => (takesKey() ? (interrupt(), true) : false), {
    enabled: active && !continuationOpen && !terminalMode && interrupts,
  });
  // The hard stop has no keys unless the reader gives it some. A cloud tab's terminal view passes those through too.
  useShortcut("session.stop", () => (takesKey() ? (stop(), true) : false), {
    enabled: active && !continuationOpen && !(remoteTerminal && terminalMode),
  });

  const answerPermission = useCallback(
    async (requestId: string, optionId: string) => {
      setAnswering(true);
      try {
        await backend.respondPermission(tab.id, requestId, optionId);
      } catch (e) {
        setError(local ? safeError(e) : commandError(e));
      } finally {
        setAnswering(false);
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

  const steer = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
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
  const history = useMemo(
    () => sentMessages(transcript, outbox && { entries: outbox.entries(tab.id), followUps: outbox.followUps(tab.id) }),
    [transcript, outbox, tab.id],
  );
  const deciding = !!outbox && transcript.pendingAsks.some((ask) => outbox.deciding(ask.requestId));

  // Pending requests and recovery sit with the composer in the chat, where the
  // reply goes; over a terminal there is no composer, so they head the pane.
  const banner = (placement: "top" | "composer") => (
    <RecoveryBanner placement={placement} kind={recovery} limit={transcript.rateLimit ?? null} waiting={tab.status === "waiting"} asks={transcript.pendingAsks} busy={recovering || !backend.caps.write} answering={answering || deciding} answerBlockedReason={backend.approveBlockedReason ?? null}
        models={models.filter(m => m.id !== tab.model && !m.upgrade)} onOpenModels={refreshPickerModels} onPermission={answerPermission} onQuestions={answerQuestions}
        onRetry={retry} onStop={stop} onContinue={() => {
          if (recoveryLock.current) return;
          recoveryLock.current = true;
          setRecovering(true);
          void backend.stop(tab.id).then(() => setContinueOpen(true)).catch(e => setError(safeError(e))).finally(() => {
            recoveryLock.current = false;
            setRecovering(false);
          });
        }} />
  );

  const chat = (
    <Chat
      sessionId={backend.logSessionId}
      transcript={{ ...transcript, pendingAsks: [] }}
      stream={log.stream}
      cwd={local ? session.cwd : undefined}
      live={live}
      loading={!readOnly && !!tab.loadingHistory}
      progressing={live && tab.status === "in_progress" && !recovery && !transcript.pendingAsks.length}
      answering={answering || deciding}
      onAnswerPermission={answerPermission}
      onAnswerQuestions={answerQuestions}
      onSendQueuedNow={backend.sendQueuedNow && !gate?.blocked ? sendQueuedNow : undefined}
      footer={
        readOnly ? (
          // A conversation that is not running is read, and resumed from here: there is nobody to send to.
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-4 pt-2 text-xs text-muted-foreground" role="status" data-testid="conversation-read-only">
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
        {banner("composer")}
        {backend.caps.steer && backend.caps.write && !gate?.blocked && live && draft.trim() && (
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 text-xs text-muted-foreground">
            <span>Send queues it for when the agent pauses.</span>
            <Button size="xs" variant="outline" onClick={() => void steer()}>
              Steer now
            </Button>
          </div>
        )}
        <Composer
          sendScope={sendScope}
          tab={tab}
          cwd={local ? session.cwd : undefined}
          // A tab that is not on screen asks its runtime for nothing: on a runtime that answers
          // in order, its command list held up the terminal view of the tab that is (#449).
          commands={local || active ? backend.commands?.(tab) : null}
          files={backend.files?.()}
          remote={!local}
          busy={live}
          draft={draft}
          onDraftChange={(v) => {
            if (viewError) clearTabViewError(tab.id);
            setDraft(tab.id, v);
            if (collabLive && v) presenceTyping(shared!.key);
          }}
          onSend={send}
          history={history}
          // Stop is Escape first; once that went unanswered, the same control ends the process.
          onStop={interrupts && !unanswered ? interrupt : stop}
          stopMode={!interrupts ? "stop" : unanswered ? "force" : "interrupt"}
          onSetModel={(m) => {
            if (gate && !gate.mayConfigure) return;
            if (recovery) { void retry(m); return; }
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
          modelsAreLocal={local}
          modelClient={backend.modelClient}
          contextUsed={transcript.contextUsed ?? tab.contextUsed ?? undefined}
          contextMax={transcript.contextMax ?? tab.contextMax ?? undefined}
          handoffs={handoffsFor(transcript, isGit && changes.files.length > 0, deleteWorkspace)}
          disabled={!!gate?.blocked}
          settingsLockedReason={gate && !gate.mayConfigure ? SETTINGS_LOCKED_REASON : null}
          modelLockedReason={handLock.model}
          modeLockedReason={handLock.mode}
          settingsNote={settingsNotice === "ignored" ? SETTINGS_IGNORED_REASON : settingsNotice === "pending" ? SETTINGS_WITH_NEXT_MESSAGE : byHandNote}
          settingsNoteWarning={settingsNotice === "ignored"}
          canStop={!gate || gate.mayStop}
          disabledReason={gate?.blocked ?? error ?? (viewError ? safeError(viewError) : null) ?? backend.readOnlyReason}
          autoFocus={active}
        />
        </>
        )
      }
    />
  );

  const info = views.info[tab.id];
  const terminal = (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-3 py-1.5 text-xs text-muted-foreground">
        <span className="shrink-0 text-foreground" data-testid="terminal-view-title">{terminalTab ? "Terminal" : `Terminal view · ${TAB_STATUS_LABEL[tab.status]}`}</span>
        {live && !recovery && <Button size="xs" variant="outline" disabled={recovering} onClick={stop}>Stop session</Button>}
        {!terminalTab && (
          <span className="min-w-0 truncate font-mono text-[11px] text-faint" title={info?.command}>
            {info?.command}
          </span>
        )}
        <span className="ml-auto min-w-0 text-faint">
          {terminalTab
            ? "No agent is running in this tab. Start one here and the tab becomes its tab."
            : byHand
              ? `${agentLabel} was started in this terminal. The chat is the same conversation.`
              : ptyFirst
                ? "The chat is the same conversation."
                : "The chat resumes when you switch back."}
          {tab.harness === "claude" && !terminalTab && (
            <> Claude Code may show its own diff sidebar. Type <code>/diff</code> in the terminal to hide or show it.</>
          )}
        </span>
        {terminalTab && held && !pane?.exited && (
          <Button size="xs" variant="outline" disabled={resuming} onClick={() => resume(held)} data-testid="terminal-resume">
            <Play /> Resume {agentLabel}
          </Button>
        )}
      </div>
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
        <TerminalView id={paneId} visible={active && terminalMode} />
      </div>
    </div>
  );

  // The same header as a local tab's terminal view; what it attaches to is on the VM.
  const cloudTerminal = remoteTerminal && (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-3 py-1.5 text-xs text-muted-foreground">
        <span className="shrink-0 text-foreground" data-testid="cloud-terminal-view-title">
          Terminal view · {remoteTerminal.client ? TAB_STATUS_LABEL[tab.status] : remoteTerminal.asleep ? "Stopped" : "Not connected"}
        </span>
        <span className="ml-auto min-w-0 text-faint">The chat is the same conversation.</span>
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
  const wrap = (body: React.ReactNode) => <div className="flex h-full min-h-0 flex-col bg-chat">
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
    {signIn && <SignInNotice info={{ harness: tab.harness, signIn: signIn.signIn }} organizationId={signIn.organizationId} />}
    {outbox && <CloudOutbox entries={outbox.entries(tab.id)} followUps={outbox.followUps(tab.id)} nameOf={nameOf} onSendAgain={(entry) => void outbox.sendAgain(entry).catch((e) => setError(commandError(e)))} />}
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
      <Button size="sm" disabled={recovering} onClick={() => void retry()}>Resume safely</Button>
    </div>}
    {terminalMode && banner("top")}
    {continueOpen && <ContinuationDialog session={session} source={tab} onClose={() => setContinueOpen(false)} />}
    {collabLive && notesOpen && shared?.client ? (
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
        <NotesPanel collabKey={shared.key} client={shared.client} tabId={tab.id} onClose={() => setNotesOpen(false)} />
      </div>
    ) : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
    )}
  </div>;

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
