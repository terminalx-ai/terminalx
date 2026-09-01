import React, { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "../styles/app.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Chat } from "@/components/chat/Chat";
import { Composer } from "@/components/chat/Composer";
import { buildTranscript } from "@/lib/transcript";
import { syntheticLog } from "./synthetic";
import type { TabEntry } from "@/types/session";

/**
 * A browser-only page mounting the real Chat and Composer over a synthetic
 * log, so layout can be measured without a webview: `?turns=300&live=1`.
 * Vite serves any root HTML in dev; the production build emits index.html alone.
 */
const params = new URLSearchParams(location.search);
const turns = Number(params.get("turns") ?? 300);
const live = params.get("live") === "1";

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
  return (
    <TooltipProvider>
      <div className="flex h-full w-full">
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <header className="h-(--titlebar-h) shrink-0 border-b border-hairline px-3 text-sm leading-[38px] text-muted-foreground">
            demo · {turns} turns
          </header>
          <section className="flex min-h-0 flex-1 flex-col">
            <Chat
              transcript={transcript}
              stream={[]}
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
