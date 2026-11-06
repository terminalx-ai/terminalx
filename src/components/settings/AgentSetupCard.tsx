import { Check, CircleAlert, Loader2 } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { AgentSetup } from "@/components/session/AgentSetup";
import { useAgentReadiness, type AgentReadiness } from "@/lib/agentReadiness";
import { setupActive, useAgentSetupFlow, type AgentSetupFlow } from "@/lib/agentSetupFlow";
import { cn } from "@/lib/cn";
import { refreshHarnesses } from "@/lib/sessions";
import type { HarnessInfo } from "@/types/session";

const BADGES: Record<AgentReadiness["state"], string> = {
  missing: "Not installed",
  signed_out: "Sign in required",
  ready: "Ready",
  unknown: "Login not checked",
};

/** The badge while a setup run is under way or has stopped (PRO-152). */
function runBadge(flow: AgentSetupFlow): string {
  if (flow.phase === "running") return flow.step === "install" ? "Installing…" : "Signing in…";
  if (flow.phase === "checking") return "Checking…";
  return "Setup did not finish";
}

/** Header and instructions share one probe, including while it is refreshing. */
export function AgentSetupCard({ harness }: { harness: HarnessInfo }) {
  const readiness = useAgentReadiness(harness.id, true);
  const flow = useAgentSetupFlow(harness.id);
  const state = readiness.value?.state ?? "unknown";
  const run = setupActive(flow) ? flow : null;
  const busy = readiness.checking || run?.phase === "running" || run?.phase === "checking";
  return <li className="flex items-start gap-3 px-3 py-2.5">
    <AgentMark id={harness.id} className="mt-0.5 size-4" decorative />
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{harness.name}</span>
        <span className={cn("flex items-center gap-1 text-[11px]", !busy && !run && state === "ready" ? "text-add" : "text-faint")}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : !run && state === "ready" ? <Check className="size-3" /> : <CircleAlert className="size-3" />}
          {run ? runBadge(run) : readiness.checking ? "Checking…" : BADGES[state]}
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
  </li>;
}
