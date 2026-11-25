import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Download, Loader2, RotateCw, X } from "@/icons";
import { AgentMark, agentVendor } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { TerminalView } from "@/components/terminal/TerminalView";
import { copyText } from "@/lib/clipboard";
import { READINESS_LABELS, type AgentReadiness } from "@/lib/agentReadiness";
import { cancelAgentSetup, dismissAgentSetup, retryAgentSetup, setupActive, startAgentSetup, useAgentSetupFlow, useSetupTerminalHost, type AgentSetupFlow, type SetupProblem } from "@/lib/agentSetupFlow";
import type { HarnessInfo } from "@/types/session";
import { cn } from "@/lib/cn";

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
 * The same setup in Settings → Agents and in the new-session view: install
 * the agent and sign in to it from here (PRO-152), or copy the commands and
 * run them in a terminal of one's own. First run draws the same steps as a
 * card per agent ({@link AgentSetupCard}).
 */
export function AgentSetup({ harness, value, checking, onRefresh, headless = false, newSession = false }: {
  harness: HarnessInfo;
  value: AgentReadiness | null;
  checking: boolean;
  onRefresh: () => void;
  /** Settings → Agents: the agent's tab says its status, version and path above this, so only what to do is shown. */
  headless?: boolean;
  /** Keep the composer focused: only setup/recovery, without the executable path. */
  newSession?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const flow = useAgentSetupFlow(harness.id);
  const active = setupActive(flow);
  const state = value?.state ?? "unknown";
  const command = setupCommand(harness, state);
  const status = active ? setupStatus(flow) : checking ? "Checking installation and login…" : READINESS_LABELS[state];
  const install = state === "missing";
  if (newSession && state === "ready" && !active) return null;
  return <section aria-label={`${harness.name} setup`} className="min-w-0 rounded-lg bg-well p-3 text-xs">
    {!headless && <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span role="status" className="font-medium">{status}</span>
      {value?.version && <span className="text-muted-foreground">{`${harness.name} ${value.version}`}</span>}
      {value?.checkedAt && <time dateTime={value.checkedAt} className="text-faint">Checked {new Date(value.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
      <Button type="button" size="xs" variant="ghost" disabled={checking || active} onClick={onRefresh}>Check again</Button>
    </div>}
    {!newSession && !headless && harness.path && <p className="mt-1 break-all font-mono text-[11px] text-faint">{harness.path}</p>}
    {active ? <SetupRun harness={harness} flow={flow} /> : state === "ready" ? <p className="mt-1 text-muted-foreground">Local login found. Provider access and model availability are checked when you run a task.</p> : <>
      {harness.installable ? <>
        <p className="mt-1.5 text-muted-foreground">{install
          ? `Runs ${harness.name}'s official installer here, then its sign-in. Node and npm are not needed.`
          : state === "signed_out" ? `Runs ${harness.name}'s own sign-in here and opens your browser to finish.`
          : "The login could not be verified. You can continue if your CLI already works, or sign in again."}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button type="button" size="xs" variant={state === "unknown" ? "secondary" : "default"} disabled={checking} aria-label={install ? `Install ${harness.name} and sign in` : `Sign in to ${harness.name}`}
            onClick={() => void startAgentSetup(harness.id, install ? "install" : "login", { chain: install })}>
            {install && <Download />} {install ? "Install and sign in" : "Sign in"}
          </Button>
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
      {!newSession && <p className="mt-2 text-faint">A TerminalX account is optional for local work. This signs in to the agent provider.</p>}
    </>}
  </section>;
}

/** The command that moves an agent on when it is run by hand: its install, or its sign-in. */
function setupCommand(harness: HarnessInfo, state: AgentReadiness["state"]): string {
  return state === "missing" ? harness.installHint : harness.id === "codex" ? "codex login" : "claude auth login";
}

/** "Ready", as the first-run screen marks an agent that can run. */
export function ReadyBadge() {
  return <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-add/10 px-2 text-xs text-add"><Check aria-hidden className="size-3" />Ready</span>;
}

/**
 * One agent on the first-run screen (PRO-399): its mark in a tile, its name
 * and who makes it, where it stands, and the one action that moves it on at
 * the right. A run started from it shows its terminal inside the card, under
 * the status line. An agent the app cannot install itself shows the command
 * to run instead of that action.
 */
export function AgentSetupCard({ harness, value, checking }: { harness: HarnessInfo; value: AgentReadiness | null; checking: boolean }) {
  const [copyStatus, setCopyStatus] = useState("");
  const flow = useAgentSetupFlow(harness.id);
  const active = setupActive(flow);
  const state = value?.state ?? "unknown";
  const install = state === "missing";
  const vendor = agentVendor(harness.id);
  const running = active && flow.phase !== "failed";
  const status = active ? setupStatus(flow) : checking ? "Checking installation and login…" : READINESS_LABELS[state];
  const command = setupCommand(harness, state);
  return <section aria-label={`${harness.name} setup`} className={cn("flex min-w-0 items-start gap-3 rounded-lg border bg-card p-3", running ? "border-accent/40" : "border-border")}>
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md bg-muted"><AgentMark id={harness.id} className="size-[18px]" decorative /></span>
    <div className="min-w-0 flex-1">
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-40">
          <div className="text-[13px] font-medium leading-5">{harness.name}{vendor && <span className="text-xs font-normal text-muted-foreground"> by {vendor}</span>}</div>
          <div className={cn("flex items-center gap-1.5 text-xs leading-4", running ? "text-accent" : "text-muted-foreground")}>
            {running && <Loader2 aria-hidden className="size-3 shrink-0 animate-spin" />}
            <span role="status">{status}</span>
            {!active && value?.version && <span className="font-mono text-faint">{value.version}</span>}
          </div>
        </div>
        {running ? <Button type="button" variant="ghost" aria-label={`Cancel ${harness.name} setup`} onClick={() => cancelAgentSetup(harness.id)}>Cancel</Button>
          : active ? null
          : state === "ready" ? <ReadyBadge />
          : harness.installable ? <Button type="button" variant="outline" disabled={checking} aria-label={install ? `Install ${harness.name} and sign in` : `Sign in to ${harness.name}`}
            onClick={() => void startAgentSetup(harness.id, install ? "install" : "login", { chain: install })}>
            {install ? "Install and sign in" : "Sign in"}
          </Button> : null}
      </div>
      {active ? <SetupRun harness={harness} flow={flow} card /> : state !== "ready" && !harness.installable && <div className="mt-2 text-xs text-muted-foreground">
        <p>{!command ? "Install it with its setup guide, then sign in." : install ? "Open a terminal and run this command to install it, then sign in." : `Open a terminal and run this command to sign in to ${harness.name}.`}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {command && <code className="min-w-0 break-all rounded bg-background px-2 py-1">{command}</code>}
          {command && <Button type="button" size="sm" variant="outline" onClick={() => {
            void copyText(command).then(() => setCopyStatus("Copied"), () => setCopyStatus("Could not copy. Select the command to copy it."));
          }}>Copy command</Button>}
          <Button type="button" size="sm" variant="ghost" onClick={() => void openUrl(harness.installUrl)}>Setup guide</Button>
          {copyStatus && <span role="status">{copyStatus}</span>}
        </div>
      </div>}
    </div>
  </section>;
}

/**
 * New Session's word on one agent (#1064): a single line, and only when this Mac knows the agent is
 * missing or signed out. An unverified login or a check still under way says nothing, since the CLI may
 * work. The line offers the install or sign-in and the setup guide; the full setup opens from it on
 * demand, and shows by itself while a run it started is under way or has stopped.
 */
export function AgentSetupNotice({ harness, value, checking, onRefresh, blocking, onDismiss }: {
  harness: HarnessInfo;
  value: AgentReadiness | null;
  checking: boolean;
  onRefresh: () => void;
  /** No other agent can start this chat: say so, and that the draft stays. */
  blocking: boolean;
  /** Set when the person picked this agent for setup: closing the notice drops that pick. */
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const flow = useAgentSetupFlow(harness.id);
  const active = setupActive(flow);
  const state = value?.state;
  if (!active && state !== "missing" && state !== "signed_out") return null;
  if (active || open) return <div className="min-w-0">
    <AgentSetup newSession harness={harness} value={value} checking={checking} onRefresh={onRefresh} />
    {!active && <div className="mt-1 flex justify-end">
      <Button type="button" size="xs" variant="ghost" aria-expanded onClick={() => setOpen(false)}>Hide details</Button>
    </div>}
  </div>;
  const install = state === "missing";
  const text = install
    ? (blocking ? `Install ${harness.name} to start a chat. Your draft is kept.` : `${harness.name} isn't installed.`)
    : (blocking ? `Sign in to ${harness.name} to start a chat. Your draft is kept.` : `${harness.name} is signed out.`);
  return <div role="note" aria-label={`${harness.name} setup`} data-testid="agent-setup-notice"
    className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-well py-1.5 pl-3 pr-1.5 text-xs">
    <span className="min-w-0 flex-1 text-muted-foreground">{text}</span>
    {harness.installable && <Button type="button" size="xs" disabled={checking} aria-label={install ? `Install ${harness.name} and sign in` : `Sign in to ${harness.name}`}
      onClick={() => void startAgentSetup(harness.id, install ? "install" : "login", { chain: install })}>
      {install && <Download />} {install ? "Install and sign in" : "Sign in"}
    </Button>}
    <Button type="button" size="xs" variant="ghost" onClick={() => void openUrl(harness.installUrl)}>Setup guide</Button>
    <Button type="button" size="xs" variant="ghost" aria-expanded={false} onClick={() => setOpen(true)}>Details</Button>
    {onDismiss && <Button type="button" size="icon-xs" variant="ghost" aria-label={`Dismiss ${harness.name} setup`} onClick={onDismiss}><X /></Button>}
  </div>;
}

/**
 * A run under way, or stopped: what it is doing, why it stopped, and its terminal.
 * The first-run card says what is running in its own status line and holds Cancel.
 */
function SetupRun({ harness, flow, card = false }: { harness: HarnessInfo; flow: Extract<AgentSetupFlow, { phase: "running" | "checking" | "failed" }>; card?: boolean }) {
  const pane = flow.pane;
  const host = useSetupTerminalHost(pane);
  // First run has no text under 12px (PRO-399): its buttons are a size up.
  const size = card ? "sm" : "xs";
  return <div className={cn("min-w-0 text-xs", card ? "mt-3" : "mt-2")}>
    {flow.phase === "failed" ? <div role="alert" className="rounded-md bg-destructive/10 px-2.5 py-2 text-destructive">
      <p>{problemText(flow.problem, harness, flow.detail)}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button type="button" size={size} variant="secondary" onClick={() => void retryAgentSetup(harness.id)}><RotateCw /> Try again</Button>
        <Button type="button" size={size} variant="ghost" onClick={() => void openUrl(harness.installUrl)}>Setup guide</Button>
        <Button type="button" size={size} variant="ghost" onClick={() => dismissAgentSetup(harness.id)}>{pane ? "Hide output" : "Dismiss"}</Button>
      </div>
    </div> : card ? null : <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
      <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
      <span className="min-w-0 flex-1">{flow.phase === "checking"
        ? "Checking installation and login…"
        : flow.step === "install"
          ? `Running ${harness.name}'s official installer.${flow.chain ? " Sign-in follows." : ""}`
          : `Signing in to ${harness.name}. Finish in your browser; TerminalX checks again when it is done.`}</span>
      <Button type="button" size="xs" variant="ghost" aria-label={`Cancel ${harness.name} setup`} onClick={() => cancelAgentSetup(harness.id)}>Cancel</Button>
    </div>}
    {pane && <div data-testid="agent-setup-terminal" aria-label={`${harness.name} setup output`} role="region"
      className={cn("h-52 min-w-0 overflow-hidden rounded-md bg-background py-1 hairline", !(card && flow.phase !== "failed") && "mt-2")}>
      {host
        ? <TerminalView id={pane} visible redraw={false} />
        : <p className="flex h-full items-center justify-center px-3 text-center text-faint">The output is showing in the view in front.</p>}
    </div>}
  </div>;
}
