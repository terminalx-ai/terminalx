import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImageInput } from "@/lib/api";
import { applyEvent, useTabLog } from "@/lib/agentEvents";
import { buildTranscript, type Transcript } from "@/lib/transcript";
import { getDraft, setDraft, useDraft } from "@/lib/drafts";
import { useSessionIsGit } from "@/lib/quickChats";
import { hasEscapeOverlay, useShortcut } from "@/lib/hotkeys";
import { changeRange, useChanges } from "@/lib/changes";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import { localSessionBackend, terminalViewOf, type SessionBackend } from "@/lib/sessionBackend";
import { CloudOutbox, commandError as cloudCommandError } from "@/components/cloud/CloudAgents";
import { CloudAgentTerminal } from "@/components/cloud/CloudAgentTerminal";
import { LeaseBar, NotesPanel, useNowUntil } from "@/components/cloud/CloudCollab";
import { SETTINGS_IGNORED_REASON, SETTINGS_LOCKED_REASON, SETTINGS_WITH_NEXT_MESSAGE, TERMINAL_APPROVAL_REASON, presenceTyping, tabGate, useCollab } from "@/lib/cloudCollab";
import { usePeople } from "@/lib/cloudPeople";
import { Chat } from "@/components/chat/Chat";
import { Composer, type Handoff } from "@/components/chat/Composer";
import { sentMessages } from "@/components/chat/useComposerHistory";
import { TerminalView } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";
import { useTerminals } from "@/lib/terminal";
import { cn } from "@/lib/cn";
import { clearTabViewError, isPtyFirst, leaveTerminalView, startTabAgent, terminalPaneId, useTabViews } from "@/lib/tabViews";
import { classifyRecovery, RECOVERY_MESSAGES, RECOVERY_PROMPT, recoveryFromEvents } from "@/lib/recovery";
import { RecoveryBanner } from "./RecoveryBanner";
import { ContinuationDialog } from "./ContinuationDialog";
import { useModels } from "@/lib/models";
import { openWorkspaceDelete } from "@/lib/dialogs";
import { offersWorkspaceDelete, turnLive, useWorkspaceDisposition, type RemovableWorkspace } from "@/lib/workspaceRemoval";
import { usePickerModels } from "@/lib/cloudModels";
import { TAB_STATUS_LABEL, type SessionEntry, type TabEntry } from "@/types/session";

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
  const [error, setError] = useState<string | null>(null);
  const views = useTabViews();
  // A cloud tab's terminal view (PRO-86) attaches to its CLI on the VM; it is
  // only there while the runtime serves it, else the tab shows its chat.
  const remoteTerminal = !local && terminalViewOf(backend, tab).available ? (backend.agentTerminal ?? null) : null;
  const terminalMode = views.views[tab.id] === "terminal" && (local || !!remoteTerminal);
  const viewError = views.errors[tab.id] ?? null;
  const terms = useTerminals();
  const ptyFirst = local && isPtyFirst(tab.harness);
  const paneId = terminalPaneId(tab.id);
  const pane = terms.panes.find((p) => p.id === paneId);
  const [answering, setAnswering] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoveryLock = useRef(false);
  const [stopped, setStopped] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);
  const { models, refresh: refreshPickerModels } = usePickerModels(useModels(tab.harness), !local, backend.modelClient, tab.harness);
  const eventRecovery = useMemo(() => recoveryFromEvents(log.events), [log.events, log.version]);
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
  const recovery = !backend.caps.recovery ? null : eventRecovery ?? (error || viewError ? classifyRecovery(error ?? viewError!) : null);
  const safeError = (e: unknown) => RECOVERY_MESSAGES[classifyRecovery(String(e))];
  // A cloud command's refusal says what happened to it (queued, view only, no key yet).
  const commandError = (e: unknown) => {
    const message = e instanceof Error ? e.message : null;
    if (message && message === backend.readOnlyReason) return message;
    return cloudCommandError(e);
  };

  const backendRef = useRef(backend);
  backendRef.current = backend;
  useEffect(() => backendRef.current.openTab(tab.id, (e) => setError(safeError(e))) ?? undefined, [backend.key, backend.generation, tab.id]);

  // A PTY-first tab is its CLI, so opening the tab starts it. Idempotent, and
  // the pane it lands in is adopted from the backend's own event.
  useEffect(() => {
    if (active && ptyFirst) void startTabAgent(session, tab);
  }, [active, ptyFirst, session.id, tab.id]);

  // Viewing a finished tab marks it read.
  useEffect(() => {
    if (active && tab.status === "completed") {
      void backendRef.current.markRead(tab.id);
      backendRef.current.patchTab(tab.id, { status: "idle" });
    }
  }, [active, tab.status, backend.key, tab.id]);

  const live = tab.status === "in_progress" || tab.status === "waiting";
  const transcript = useMemo(() => buildTranscript(log.events, live), [log.events, log.version, live]);
  // Whether the session's checkout differs from where the conversation
  // started, by tree diff, so a shell heredoc counts as much as an edit tool.
  const range = useMemo(() => changeRange(log.events, session.baseRef), [log.events, log.version, session.baseRef]);
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
      try {
        const out = await backend.send(tab.id, text, images);
        for (const ev of out.events) applyEvent(ev);
        if (!out.queued) backend.patchTab(tab.id, { status: "in_progress" });
      } catch (e) {
        setError(local ? safeError(e) : commandError(e));
        backend.setTabStatus(tab.id, "waiting");
        setDraft(tab.id, getDraft(tab.id) || text);
        throw e;
      }
    },
    [backend, local, tab.id],
  );

  const stop = useCallback(() => {
    if (gate && !gate.mayStop) {
      setError("Only the person driving this tab or an admin can stop the agent.");
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
      clearTabViewError(tab.id);
    }).catch((e) => setError(local ? safeError(e) : commandError(e))).finally(() => {
      recoveryLock.current = false;
      setRecovering(false);
    });
  }, [backend, local, tab.id, gate?.mayStop]);

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
      clearTabViewError(tab.id);
      // Recovery never touches the unsent composer draft or attachments.
    } catch (e) { setError(safeError(e)); }
    finally { recoveryLock.current = false; setRecovering(false); }
  };

  // Editors, dialogs and pickers own Escape before the agent-stop shortcut.
  // In a cloud tab's terminal view the stop key (Escape, unless remapped) belongs to the agent's own screen, as every other key does.
  useShortcut("session.stop", () => (live && !hasEscapeOverlay() && !document.activeElement?.closest(".editor-pane") ? (stop(), true) : false), {
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
  const outbox = backend.outbox;
  // What became of the last model, effort or mode chosen here (a cloud tab).
  const settingsNotice = backend.settingsNotice?.(tab.id) ?? null;
  // What Up and Down recall in the composer: this tab's own messages, plus a cloud tab's commands still on their way.
  const history = useMemo(
    () => sentMessages(transcript, outbox && { entries: outbox.entries(tab.id), followUps: outbox.followUps(tab.id) }),
    [transcript, outbox, tab.id],
  );
  const deciding = !!outbox && transcript.pendingAsks.some((ask) => outbox.deciding(ask.requestId));

  const chat = (
    <Chat
      sessionId={backend.logSessionId}
      transcript={{ ...transcript, pendingAsks: [] }}
      stream={log.stream}
      cwd={local ? session.cwd : undefined}
      live={live}
      progressing={tab.status === "in_progress" && !recovery && !transcript.pendingAsks.length}
      answering={answering || deciding}
      onAnswerPermission={answerPermission}
      onAnswerQuestions={answerQuestions}
      footer={
        <>
        {backend.caps.steer && backend.caps.write && !gate?.blocked && live && draft.trim() && (
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 text-xs text-muted-foreground">
            <span>Send queues it for when the agent pauses.</span>
            <Button size="xs" variant="outline" onClick={() => void steer()}>
              Steer now
            </Button>
          </div>
        )}
        <Composer
          tab={tab}
          cwd={local ? session.cwd : undefined}
          commands={backend.commands?.(tab)}
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
          onStop={stop}
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
            backend.patchTab(tab.id, { permissionMode: m });
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
          settingsNote={settingsNotice === "ignored" ? SETTINGS_IGNORED_REASON : settingsNotice === "pending" ? SETTINGS_WITH_NEXT_MESSAGE : null}
          settingsNoteWarning={settingsNotice === "ignored"}
          canStop={!gate || gate.mayStop}
          disabledReason={gate?.blocked ?? error ?? (viewError ? safeError(viewError) : null) ?? backend.readOnlyReason}
          autoFocus={active}
        />
        </>
      }
    />
  );

  const info = views.info[tab.id];
  const terminal = (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-3 py-1.5 text-xs text-muted-foreground">
        <span className="shrink-0 text-foreground">Terminal view · {TAB_STATUS_LABEL[tab.status]}</span>
        {live && !recovery && <Button size="xs" variant="outline" disabled={recovering} onClick={stop}>Stop session</Button>}
        <span className="min-w-0 truncate font-mono text-[11px] text-faint" title={info?.command}>
          {info?.command}
        </span>
        <span className="ml-auto min-w-0 text-faint">
          {ptyFirst ? "The chat is the same conversation." : "The chat resumes when you switch back."}
          {tab.harness === "claude" && (
            <> Claude Code may show its own diff sidebar. Type <code>/diff</code> in the terminal to hide or show it.</>
          )}
        </span>
      </div>
      {pane?.exited && (
        <div className="flex shrink-0 items-center gap-2 bg-warning/10 px-3 py-1.5 text-xs text-foreground">
          The agent's terminal exited{pane.exitCode != null ? ` (${pane.exitCode})` : ""}.
          <Button size="xs" variant="outline" className="ml-auto" onClick={() => void leaveTerminalView(session, tab)}>
            <MessageSquare /> Back to chat
          </Button>
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
  const wrap = (body: React.ReactNode) => <div className="flex h-full min-h-0 flex-col">
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
    {outbox && <CloudOutbox entries={outbox.entries(tab.id)} followUps={outbox.followUps(tab.id)} nameOf={nameOf} onSendAgain={(entry) => void outbox.sendAgain(entry).catch((e) => setError(commandError(e)))} />}
    {stopped && <div role="status" className="flex items-center gap-2 border-b border-hairline p-3 text-xs">
      Session closed. Untracked or remote commands may still be running; verify their outcome before continuing.
      <Button size="sm" disabled={recovering} onClick={() => void retry()}>Resume safely</Button>
    </div>}
    <RecoveryBanner kind={recovery} waiting={tab.status === "waiting"} asks={transcript.pendingAsks} busy={recovering || !backend.caps.write} answering={answering || deciding} answerBlockedReason={backend.approveBlockedReason ?? null} askDetail={!!shared}
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
        {!terminalMode && <div className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background">{chat}</div>}
      </div>
    );
  }

  if (terminalMode && cloudTerminal) return wrap(cloudTerminal);
  if (terminalMode) return wrap(terminal);
  return wrap(chat);
}
