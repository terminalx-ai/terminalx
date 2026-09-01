import { useCallback, useEffect, useMemo, useState } from "react";
import { agent, errorMessage, type ImageInput } from "@/lib/api";
import { applyEvent, loadTab, useTabLog } from "@/lib/agentEvents";
import { buildTranscript } from "@/lib/transcript";
import { getDraft, setDraft, useDraft } from "@/lib/drafts";
import { patchTab } from "@/lib/sessions";
import { useHotkey } from "@/lib/hotkeys";
import { Chat } from "@/components/chat/Chat";
import { Composer } from "@/components/chat/Composer";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * One tab: its event log, the transcript built from it, and the composer.
 */
export function TabView({ session, tab, active }: { session: SessionEntry; tab: TabEntry; active: boolean }) {
  const log = useTabLog(session.id, tab.id);
  const draft = useDraft(tab.id);
  const [error, setError] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);

  useEffect(() => {
    void loadTab(session.id, tab.id);
  }, [session.id, tab.id]);

  // Viewing a finished tab marks it read.
  useEffect(() => {
    if (active && tab.status === "completed") {
      void agent.markRead(session.id, tab.id);
      patchTab(session.id, tab.id, { status: "idle" });
    }
  }, [active, tab.status, session.id, tab.id]);

  const live = tab.status === "in_progress" || tab.status === "waiting";
  const transcript = useMemo(() => buildTranscript(log.events, live), [log.events, log.version, live]);

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

  return (
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
          onDraftChange={(v) => setDraft(tab.id, v)}
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
          usageWindows={transcript.usageWindows}
          codexUsage={transcript.codexUsage}
          disabledReason={error}
          autoFocus={active}
        />
      }
    />
  );
}
