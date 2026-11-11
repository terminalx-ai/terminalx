import { useState } from "react";
import { Download, KeyRound, Loader2, RotateCw, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { dismissAgentLoginNotice, restartAgentTabs, useAgentLoginNotices, type AgentLoginNotice } from "@/lib/agentLogins";
import { errorMessage } from "@/lib/api";

/** What became of an agent's API key, with its running tabs one press from the new login (PRO-306). */
export function AgentLoginToasts() {
  return useAgentLoginNotices().map((notice) => <AgentLoginToast key={notice.id} notice={notice} />);
}

function AgentLoginToast({ notice }: { notice: AgentLoginNotice }) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = notice.stale.length;
  const Icon = notice.kind === "imported" ? Download : KeyRound;
  const restart = async () => {
    setRestarting(true);
    setError(null);
    try {
      await restartAgentTabs(notice.stale);
      dismissAgentLoginNotice(notice.id);
    } catch (e) {
      setError(`Could not restart every tab: ${errorMessage(e)}`);
      setRestarting(false);
    }
  };
  return <div role="status" aria-label={notice.title} className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-popover glass p-3 text-sm shadow-surface hairline animate-fade-in">
    <Icon className={cn("mt-0.5 size-4 shrink-0", notice.kind === "removed" ? "text-muted-foreground" : "text-add")} />
    <div className="min-w-0 flex-1">
      <div className="font-medium">{notice.title}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{notice.body}</div>
      {count > 0 && <div className="mt-2.5 flex gap-2">
        <Button size="xs" variant="outline" className="shrink-0 whitespace-nowrap" disabled={restarting} onClick={() => void restart()}>
          {restarting ? <Loader2 className="animate-spin" /> : <RotateCw />} Restart {count} {count === 1 ? "tab" : "tabs"}
        </Button>
      </div>}
      {error && <p role="alert" className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
    <button type="button" aria-label="Dismiss" onClick={() => dismissAgentLoginNotice(notice.id)}
      className="rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground">
      <X className="size-3.5" />
    </button>
  </div>;
}
