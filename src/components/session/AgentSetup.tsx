import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, Loader2, RotateCw } from "@/icons";
import { Button } from "@/components/ui/button";
import { TerminalView } from "@/components/terminal/TerminalView";
import { copyText } from "@/lib/clipboard";
import { READINESS_LABELS, type AgentReadiness } from "@/lib/agentReadiness";
import { cancelAgentSetup, dismissAgentSetup, retryAgentSetup, setupActive, startAgentSetup, useAgentSetupFlow, type AgentSetupFlow, type SetupProblem } from "@/lib/agentSetupFlow";
import type { HarnessInfo } from "@/types/session";

/** What the status line says while a setup run is under way or has stopped. */
export function setupStatus(flow: AgentSetupFlow): string | null {
  if (flow.phase === "running") return flow.step === "install" ? (flow.chain ? "Installing · sign-in next" : "Installing") : "Signing in";
  if (flow.phase === "checking") return "Checking installation and login…";
  if (flow.phase === "failed") return "Setup did not finish";
  return null;
}

function problemText(problem: SetupProblem, harness: HarnessInfo, detail?: string): string {
  switch (problem) {
    case "permission":
      return `${harness.name} could not be installed: a folder it writes to is not writable by you (often left behind by an earlier install with sudo). The output below names it. Fix its owner or permissions, then try again.`;
    case "offline":
      return `Could not reach the provider. Check the internet connection, then try again.`;
    case "download":
      return `The installer could not be downloaded. Try again in a moment; a network that blocks downloads (a sign-in page, a proxy) can cause this.`;
    case "install":
      return `The installer stopped before it finished. Its output is below.`;
    case "login":
      return `Sign-in did not finish. Try again and complete it in your browser.`;
    case "not_found":
      return `The installer finished, but TerminalX cannot find ${harness.binary}. Try again to look for it, or follow the setup guide.`;
    case "start":
      return `Could not start: ${detail ?? "the background service is not available"}.`;
  }
}

/**
 * The same setup at first launch, in Settings → Agents and in the new-session
 * view: install the agent and sign in to it from here (PRO-152), or copy the
 * commands and run them in a terminal of one's own.
 */
export function AgentSetup({ harness, value, checking, onRefresh, compact = false }: {
  harness: HarnessInfo;
  value: AgentReadiness | null;
  checking: boolean;
  onRefresh: () => void;
  /** The welcome screen's: the agent's name first, no path or own re-check, and a word about what to do once ready. */
  compact?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const flow = useAgentSetupFlow(harness.id);
  const active = setupActive(flow);
  const state = value?.state ?? "unknown";
  const command = state === "missing" ? harness.installHint : harness.id === "codex" ? "codex login" : "claude auth login";
  const status = active ? setupStatus(flow) : checking ? "Checking installation and login…" : READINESS_LABELS[state];
  const install = state === "missing";
  return <section aria-label={`${harness.name} setup`} className="min-w-0 rounded-lg bg-well p-3 text-xs">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {compact && <span className="text-[13px] font-medium">{harness.name}</span>}
      <span role="status" className={compact ? "text-muted-foreground" : "font-medium"}>{status}</span>
      {value?.version && <span className="text-muted-foreground">{compact ? value.version : `${harness.name} ${value.version}`}</span>}
      {!compact && value?.checkedAt && <time dateTime={value.checkedAt} className="text-faint">Checked {new Date(value.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
      {/* The welcome screen checks every agent again from one button of its own. */}
      {!compact && <Button type="button" size="xs" variant="ghost" disabled={checking || active} onClick={onRefresh}>Check again</Button>}
    </div>
    {!compact && harness.path && <p className="mt-1 break-all font-mono text-[11px] text-faint">{harness.path}</p>}
    {active ? <SetupRun harness={harness} flow={flow} /> : state === "ready" ? <p className="mt-1 text-muted-foreground">{compact
      ? `${harness.name} is ready. Open a project above to start a session with it.`
      : "Local login found. Provider access and model availability are checked when you run a task."}</p> : <>
      {harness.installable ? <>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button type="button" size="xs" variant={state === "unknown" ? "secondary" : "default"} disabled={checking} aria-label={install ? `Install ${harness.name} and sign in` : `Sign in to ${harness.name}`}
            onClick={() => void startAgentSetup(harness.id, install ? "install" : "login", { chain: install })}>
            {install && <Download />} {install ? "Install and sign in" : "Sign in"}
          </Button>
          <span className="min-w-0 text-muted-foreground">{install
            ? `Runs ${harness.name}'s official installer here, then its sign-in. Node and npm are not needed.`
            : state === "signed_out" ? `Runs ${harness.name}'s own sign-in here and opens your browser to finish.`
            : "The login could not be verified. You can continue if your CLI already works, or sign in again."}</span>
        </div>
        <p className="mt-2 text-faint">Or run it in a terminal of your own:</p>
      </> : <p className="mt-2 text-muted-foreground">{install
        ? "Open a terminal and run this command to install the provider's CLI, then sign in."
        : state === "signed_out" ? `Open a terminal and run this command to sign in to ${harness.name}.`
        : "The login could not be verified. You can continue if your CLI already works, or sign in and check again."}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all rounded bg-background px-2 py-1">{command}</code>
        <Button type="button" size="xs" variant="outline" onClick={() => {
          void copyText(command).then(() => setCopyStatus("Copied"), () => setCopyStatus("Could not copy. Select the command to copy it."));
        }}>Copy command</Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => void openUrl(harness.installUrl)}>Setup guide</Button>
        {copyStatus && <span role="status">{copyStatus}</span>}
      </div>
      {!compact && <p className="mt-2 text-faint">A TerminalX account is optional for local work. This signs in to the agent provider.</p>}
    </>}
  </section>;
}

/** A run under way, or stopped: what it is doing, why it stopped, and its terminal. */
function SetupRun({ harness, flow }: { harness: HarnessInfo; flow: Extract<AgentSetupFlow, { phase: "running" | "checking" | "failed" }> }) {
  const pane = flow.pane;
  return <div className="mt-2 min-w-0">
    {flow.phase === "failed" ? <div role="alert" className="rounded-md bg-destructive/10 px-2.5 py-2 text-destructive">
      <p>{problemText(flow.problem, harness, flow.detail)}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button type="button" size="xs" variant="secondary" onClick={() => void retryAgentSetup(harness.id)}><RotateCw /> Try again</Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => void openUrl(harness.installUrl)}>Setup guide</Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => dismissAgentSetup(harness.id)}>{pane ? "Hide output" : "Dismiss"}</Button>
      </div>
    </div> : <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
      <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
      <span className="min-w-0 flex-1">{flow.phase === "checking"
        ? "Checking installation and login…"
        : flow.step === "install"
          ? `Running ${harness.name}'s official installer.${flow.chain ? " Sign-in follows." : ""}`
          : `Signing in to ${harness.name}. Finish in your browser; TerminalX checks again when it is done.`}</span>
      <Button type="button" size="xs" variant="ghost" aria-label={`Cancel ${harness.name} setup`} onClick={() => cancelAgentSetup(harness.id)}>Cancel</Button>
    </div>}
    {pane && <div data-testid="agent-setup-terminal" aria-label={`${harness.name} setup output`} role="region"
      className="mt-2 h-52 min-w-0 overflow-hidden rounded-md bg-background py-1 hairline">
      <TerminalView id={pane} visible redraw={false} />
    </div>}
  </div>;
}
