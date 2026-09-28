import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "../styles/app.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Chat } from "@/components/chat/Chat";
import { Composer } from "@/components/chat/Composer";
import { buildTranscript } from "@/lib/transcript";
import { syntheticLog } from "./synthetic";
import type { TabEntry } from "@/types/session";
import type { StreamBlock } from "@/lib/agentEvents";

/**
 * A browser-only page mounting the real Chat and Composer over a synthetic
 * log, so layout can be measured without a webview: `?turns=300&live=1`.
 * Vite serves any root HTML in dev; the production build emits index.html alone.
 */
const params = new URLSearchParams(location.search);
const turns = Number(params.get("turns") ?? 300);
const live = params.get("live") === "1";
/** Deltas per second pushed into the live turn: `?live=1&stream=1000`. */
const streamRate = Number(params.get("stream") ?? 0);

const tab: TabEntry = {
  id: "demo-tab",
  harness: "claude",
  model: "opus",
  effort: "high",
  permissionMode: "auto",
  status: live ? "in_progress" : "idle",
  created: "",
  modified: "",
};

function Demo() {
  const events = useMemo(() => syntheticLog(turns, live), []);
  const transcript = useMemo(() => buildTranscript(events, live), [events]);
  const [draft, setDraft] = useState("");
  const [stream, setStream] = useState<StreamBlock[]>([]);

  // Stress: append text deltas at the asked rate and report long tasks.
  useEffect(() => {
    if (!live || !streamRate) return;
    let text = "";
    let events = 0;
    let longTasks = 0;
    let maxTask = 0;
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks++;
        maxTask = Math.max(maxTask, e.duration);
      }
    });
    try {
      po.observe({ entryTypes: ["longtask"] });
    } catch {
      /* not supported */
    }
    const perTick = Math.max(1, Math.round(streamRate / 60));
    let raf = 0;
    const tick = () => {
      for (let i = 0; i < perTick; i++) {
        text += ["lorem ", "ipsum ", "dolor ", "sit ", "amet, ", "\n"][events % 6];
        events++;
      }
      setStream([{ ref: { messageId: "m-stress", index: 0 }, kind: "text", text, partialJson: "", done: false }]);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const report = window.setInterval(() => {
      console.log(`[stress] events=${events} longTasks=${longTasks} maxTaskMs=${Math.round(maxTask)} chars=${text.length}`);
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(report);
      po.disconnect();
    };
  }, []);
  return (
    <TooltipProvider>
      <div className="flex h-full w-full">
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <header className="h-(--titlebar-h) shrink-0 border-b border-hairline px-3 text-sm leading-[38px] text-muted-foreground">
            demo · {turns} turns
          </header>
          <section className="flex min-h-0 flex-1 flex-col">
            <Chat
              sessionId="demo-session"
              transcript={transcript}
              stream={stream}
              cwd="/tmp/repo"
              live={live}
              answering={false}
              onAnswerPermission={() => {}}
              onAnswerQuestions={() => {}}
              footer={
                <Composer
                  tab={tab}
                  busy={live}
                  draft={draft}
                  onDraftChange={setDraft}
                  onSend={() => {}}
                  onStop={() => {}}
                  onSetModel={() => {}}
                  onSetEffort={() => {}}
                  onSetMode={() => {}}
                  contextUsed={42000}
                  contextMax={200000}
                  handoffs={live ? undefined : [{ label: "Commit", prompt: "Commit the current changes." }, { label: "Create PR", prompt: "Open a pull request." }, { label: "Run it", prompt: "Run the tests." }]}
                  autoFocus
                />
              }
            />
          </section>
        </div>
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
