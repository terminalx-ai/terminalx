import { useCallback, useEffect, useMemo, useState } from "react";
import { agent, errorMessage, type ImageInput } from "@/lib/api";
import { applyEvent, loadTab, useTabLog } from "@/lib/agentEvents";
import { buildTranscript, type Transcript } from "@/lib/transcript";
import { getDraft, setDraft, useDraft } from "@/lib/drafts";
import { patchTab } from "@/lib/sessions";
import { useHotkey } from "@/lib/hotkeys";
import { changeRange, useChanges } from "@/lib/changes";
import { Chat } from "@/components/chat/Chat";
import { Composer } from "@/components/chat/Composer";
import { TerminalView } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";
import { useTerminals } from "@/lib/terminal";
import { cn } from "@/lib/cn";
import { clearTabViewError, isPtyFirst, leaveTerminalView, startTabAgent, terminalPaneId, useTabViews } from "@/lib/tabViews";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * One tab: its event log, the transcript built from it, and the composer.
 */
/**
 * After a turn that touched files, the obvious next steps as one-click
 * prompts. They only fill the composer; the reader still sends.
 */
function handoffsFor(t: Transcript, changed: boolean): { label: string; prompt: string }[] | undefined {
  const last = t.turns[t.turns.length - 1];
  if (!last?.completed || last.completed.status !== "ok") return undefined;
  if (!changed) return undefined;
  return [
    { label: "Commit", prompt: "Commit the current changes with a clear, conventional message. Do not push." },
    { label: "Create PR", prompt: "Push this branch and open a pull request with a title and a short description of the changes." },
    { label: "Run it", prompt: "Run the project's dev server or test suite in the background and report the first errors, if any." },
  ];
}

export function TabView({ session, tab, active }: { session: SessionEntry; tab: TabEntry; active: boolean }) {
  const log = useTabLog(session.id, tab.id);
  const draft = useDraft(tab.id);
  const [error, setError] = useState<string | null>(null);
  const views = useTabViews();
  const terminalMode = views.views[tab.id] === "terminal";
  const viewError = views.errors[tab.id] ?? null;
  const terms = useTerminals();
  const ptyFirst = isPtyFirst(tab.harness);
  const paneId = terminalPaneId(tab.id);
  const pane = terms.panes.find((p) => p.id === paneId);
  const [answering, setAnswering] = useState(false);

  useEffect(() => {
    void loadTab(session.id, tab.id);
  }, [session.id, tab.id]);

  // A PTY-first tab is its CLI, so opening the tab starts it. Idempotent, and
  // the pane it lands in is adopted from the backend's own event.
  useEffect(() => {
    if (active && ptyFirst) void startTabAgent(session, tab);
  }, [active, ptyFirst, session.id, tab.id]);

  // Viewing a finished tab marks it read.
  useEffect(() => {
    if (active && tab.status === "completed") {
      void agent.markRead(session.id, tab.id);
      patchTab(session.id, tab.id, { status: "idle" });
    }
  }, [active, tab.status, session.id, tab.id]);

  const live = tab.status === "in_progress" || tab.status === "waiting";
  const transcript = useMemo(() => buildTranscript(log.events, live), [log.events, log.version, live]);
  // Whether the session's checkout differs from where the conversation
  // started, by tree diff, so a shell heredoc counts as much as an edit tool.
  const range = useMemo(() => changeRange(log.events, session.baseRef), [log.events, log.version, session.baseRef]);
  const changes = useChanges(session.cwd, range, active && !live);

  const send = useCallback(
    async (text: string, images: ImageInput[]) => {
      setError(null);
      try {
        const out = await agent.send(session.id, tab.id, text, images);
        for (const ev of out.events) applyEvent(ev);
        if (!out.queued) patchTab(session.id, tab.id, { status: "in_progress" });
      } catch (e) {
        setError(errorMessage(e));
        setDraft(tab.id, getDraft(tab.id) || text);
        throw e;
      }
    },
    [session.id, tab.id],
  );

  const stop = useCallback(() => {
    void agent.interrupt(session.id, tab.id).catch((e) => setError(errorMessage(e)));
  }, [session.id, tab.id]);

  useHotkey("escape", () => (live ? (stop(), true) : false), { enabled: active });

  const answerPermission = useCallback(
    async (requestId: string, optionId: string) => {
      setAnswering(true);
      try {
        await agent.respondPermission(session.id, tab.id, requestId, optionId);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setAnswering(false);
      }
    },
    [session.id, tab.id],
  );

  const answerQuestions = useCallback(
    async (requestId: string, answers: Record<string, string>) => {
      setAnswering(true);
      try {
        await agent.answerQuestions(session.id, tab.id, requestId, answers);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setAnswering(false);
      }
    },
    [session.id, tab.id],
  );

  const chat = (
    <Chat
      transcript={transcript}
      stream={log.stream}
      cwd={session.cwd}
      live={live}
      answering={answering}
      onAnswerPermission={answerPermission}
      onAnswerQuestions={answerQuestions}
      footer={
        <Composer
          tab={tab}
          cwd={session.cwd}
          busy={live}
          draft={draft}
          onDraftChange={(v) => {
            if (viewError) clearTabViewError(tab.id);
            setDraft(tab.id, v);
          }}
          onSend={send}
          onStop={stop}
          onSetModel={(m) => {
            patchTab(session.id, tab.id, { model: m });
            void agent.setModel(session.id, tab.id, m).catch((e) => setError(errorMessage(e)));
          }}
          onSetEffort={(e) => {
            patchTab(session.id, tab.id, { effort: e });
            void agent.setEffort(session.id, tab.id, e).catch((err) => setError(errorMessage(err)));
          }}
          onSetMode={(m) => {
            patchTab(session.id, tab.id, { permissionMode: m });
            void agent.setPermissionMode(session.id, tab.id, m).catch((e) => setError(errorMessage(e)));
          }}
          contextUsed={transcript.contextUsed ?? tab.contextUsed ?? undefined}
          contextMax={transcript.contextMax ?? tab.contextMax ?? undefined}
          handoffs={handoffsFor(transcript, changes.files.length > 0)}
          disabledReason={error ?? viewError}
          autoFocus={active}
        />
      }
    />
  );

  const info = views.info[tab.id];
  const terminal = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-xs text-muted-foreground">
        <span className="shrink-0 text-foreground">Terminal view</span>
        <span className="truncate font-mono text-[11px] text-faint" title={info?.command}>
          {info?.command}
        </span>
        <span className="ml-auto shrink-0 text-faint">
          {ptyFirst ? "The chat is the same conversation." : "The chat resumes when you switch back."}
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

  // A PTY-first tab keeps its terminal mounted under the chat: the pane holds
  // the live CLI, so unmounting it to show the transcript would throw away the
  // scrollback and resize the agent's window on every toggle. `invisible`
  // rather than `hidden` because xterm needs a laid-out box to fit itself to.
  if (ptyFirst) {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        <div className={cn("absolute inset-0 flex min-h-0 flex-col", !terminalMode && "invisible")} aria-hidden={!terminalMode}>
          {terminal}
        </div>
        {!terminalMode && <div className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background">{chat}</div>}
      </div>
    );
  }

  if (terminalMode) return terminal;
  return chat;
}
