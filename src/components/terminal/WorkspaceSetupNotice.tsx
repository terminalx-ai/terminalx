import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { applyEvent } from "@/lib/agentEvents";
import { localSessionBackend } from "@/lib/sessionBackend";
import { selectSession, setActiveTab, useSessionStore } from "@/lib/sessions";
import { setPrefs } from "@/lib/prefs";
import { dismissSetup, revealSetup, setupFixPrompt, setupLog, setupRunKey, useWorkspaceSetups, type WorkspaceSetup } from "@/lib/workspaceSetup";
import { isTerminalTab } from "@/lib/tabFront";
import { appWindow } from "@/lib/appWindow";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WorkspaceSetupPane } from "./WorkspaceSetupPane";

export function showSetupLog(sessionId: string) {
  selectSession(sessionId);
  setPrefs({ panelOpen: true, panelTerminalOpen: true });
  revealSetup(sessionId);
}

export function WorkspaceSetupToasts() {
  const { runs, dismissed } = useWorkspaceSetups();
  return runs.filter((run) => run.status === "failed" && !dismissed.includes(setupRunKey(run))).map((run) => <SetupFailure key={setupRunKey(run)} run={run} />);
}

function SetupFailure({ run }: { run: WorkspaceSetup }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const { sessions } = useSessionStore();
  const session = sessions.find((session) => session.id === run.sessionId);
  const tab = session?.tabs.find((tab) => tab.id === session.activeTab && !isTerminalTab(tab)) ?? session?.tabs.find((tab) => !isTerminalTab(tab));
  const ask = async () => {
    if (!tab || sending) return;
    setSending(true);
    setError(null);
    try {
      const log = await setupLog(run.sessionId, run.paneId);
      const backend = localSessionBackend(run.sessionId);
      const outcome = await backend.send(tab.id, setupFixPrompt(run, log), []);
      for (const event of outcome.events) applyEvent(event);
      if (!outcome.queued) backend.patchTab(tab.id, { status: "in_progress" });
      selectSession(run.sessionId);
      void setActiveTab(run.sessionId, tab.id).catch(() => {});
      dismissSetup(run);
    } catch (error) { setError(errorMessage(error)); }
    finally { setSending(false); }
  };
  return <div role="status" className="pointer-events-auto rounded-xl bg-popover glass p-3 text-sm shadow-surface hairline">
    <div className="flex items-center justify-between gap-2">
      <span className="font-medium text-destructive">Setup failed</span>
      <Button variant="ghost" size="xs" aria-label="Dismiss setup failure" onClick={() => dismissSetup(run)}>Dismiss</Button>
    </div>
    <p className="truncate text-xs text-muted-foreground">{session?.title ?? "Workspace setup"}{run.exitCode != null && ` · Exit ${run.exitCode}`}</p>
    <div className="mt-2 flex gap-2">
      <Button size="xs" variant="outline" onClick={() => { if (appWindow() === "main") showSetupLog(run.sessionId); else setShowLog(true); }}>Show log</Button>
      <Button size="xs" variant="outline" disabled={!tab || sending} onClick={() => void ask()}>{sending ? "Sending…" : "Ask agent to fix"}</Button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    <Dialog open={showLog} onOpenChange={setShowLog}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Setup log</DialogTitle><DialogDescription>{session?.title ?? "Workspace setup"}</DialogDescription></DialogHeader>
        <div className="h-[50vh] min-h-0"><WorkspaceSetupPane run={run} /></div>
      </DialogContent>
    </Dialog>
  </div>;
}
