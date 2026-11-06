import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, CircleAlert, ExternalLink, Loader2 } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { AgentSetup } from "@/components/session/AgentSetup";
import { Button } from "@/components/ui/button";
import { useAgentReadiness, type AgentReadiness } from "@/lib/agentReadiness";
import { cn } from "@/lib/cn";
import { refreshHarnesses } from "@/lib/sessions";
import type { HarnessInfo } from "@/types/session";

const BADGES: Record<AgentReadiness["state"], string> = {
  missing: "Not installed",
  signed_out: "Sign in required",
  ready: "Ready",
  unknown: "Login not checked",
};

/** Header and instructions share one probe, including while it is refreshing. */
export function AgentSetupCard({ harness }: { harness: HarnessInfo }) {
  const readiness = useAgentReadiness(harness.id, true);
  const state = readiness.value?.state ?? "unknown";
  return <li className="flex items-start gap-3 px-3 py-2.5">
    <AgentMark id={harness.id} className="mt-0.5 size-4" decorative />
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{harness.name}</span>
        <span className={cn("flex items-center gap-1 text-[11px]", !readiness.checking && state === "ready" ? "text-add" : "text-faint")}>
          {readiness.checking ? <Loader2 className="size-3 animate-spin" /> : state === "ready" ? <Check className="size-3" /> : <CircleAlert className="size-3" />}
          {readiness.checking ? "Checking…" : BADGES[state]}
        </span>
      </div>
      <div className="mt-2"><AgentSetup harness={harness} value={readiness.value} checking={readiness.checking} onRefresh={() => {
        void refreshHarnesses().then(() => readiness.refresh()).catch(() => readiness.refresh());
      }} /></div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
        {harness.caps.images && <span>images</span>}
        {harness.caps.permissionModes && <span>permission modes</span>}
        {harness.caps.effort && <span>effort</span>}
        {harness.caps.slashCommands && <span>slash commands</span>}
        {harness.caps.resume && <span>resume</span>}
        {harness.caps.fork && <span>fork</span>}
      </div>
    </div>
    {!readiness.checking && state === "missing" && <Button size="xs" variant="ghost" onClick={() => void openUrl(harness.installUrl)}>
      Get it <ExternalLink />
    </Button>}
  </li>;
}
