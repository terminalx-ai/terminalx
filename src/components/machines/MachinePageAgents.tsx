import { useEffect, useMemo } from "react";
import { Check, Download, Loader2, RotateCw } from "@/icons";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { AgentMark } from "@/components/AgentMark";
import { TerminalView } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import type { SetupProblem } from "@/lib/agentSetupFlow";
import { cn } from "@/lib/cn";
import { agentRowAction, agentRowLine, machineAgentRows, signInOwner, useMachineAgents, type MachineAgentRow } from "@/lib/machineAgents";
import {
  cancelMachineAgentSetup,
  dismissMachineAgentSetup,
  followMachineAgentSetups,
  setupTerminalFactory,
  startMachineAgentSetup,
  useMachineSetupFlow,
  type MachineSetupFlow,
} from "@/lib/machineAgentSetup";
import type { PairedMachine } from "@/types/machines";

export const pageHeading = "text-[14px] font-semibold";
export const pageCard = "overflow-hidden rounded-lg border border-hairline";

/** Why a step on the machine did not finish, in the words the local flow uses (`AgentSetup.tsx`). */
export function machineProblemText(problem: SetupProblem, agent: string, machine: string, flow: Pick<Extract<MachineSetupFlow, { phase: "failed" }>, "detail" | "busy">): string {
  switch (problem) {
    case "permission":
      return `${agent} could not be installed on ${machine}: a folder it writes to is not writable by its user. The output below names it. Fix its owner or permissions there, then try again.`;
    case "offline":
      return `${machine} could not reach the provider. Check its internet connection, then try again.`;
    case "download":
      return `The installer could not be downloaded on ${machine}. Try again in a moment; a network that blocks downloads (a proxy, a firewall) can cause this.`;
    case "install":
      return `The installer stopped before it finished. Its output is below.`;
    case "login":
      return `Sign-in did not finish. Try again and complete it in your browser.`;
    case "not_found":
      return `The installer finished, but ${machine} cannot find ${agent}. Try again, or install it in a terminal there.`;
    case "start":
      // A run in the machine's own window: the refusal says so in its own words.
      if (flow.busy) return flow.detail ?? `${agent} is already being set up on ${machine}.`;
      return `Could not start on ${machine}: ${flow.detail ?? "it did not answer"}.`;
  }
}

/**
 * Agents on a machine's page (21.10): each installed agent with its version
 * and sign-in, and each agent the machine has no CLI for. Sign in and
 * Install (`machine/4`) run in a terminal on the machine, shown here under
 * the agent's row until it exits.
 */
export function MachinePageAgents({ machine, client, connected, setupGranted }: { machine: PairedMachine; client: WorkspaceRpcClient | null; connected: boolean; setupGranted: boolean }) {
  const snapshot = useMachineAgents(connected ? client : null);
  const rows = useMemo(() => machineAgentRows(snapshot.report), [snapshot.report]);
  const owner = signInOwner(machine);
  const ids = rows.map((row) => row.id).join("\u0000");

  // A step started earlier, from this page or elsewhere, is followed when the page opens.
  useEffect(() => {
    if (!client || !connected || !setupGranted || !ids) return;
    void followMachineAgentSetups(machine.machineId, client, ids.split("\u0000"));
  }, [client, connected, setupGranted, ids, machine.machineId]);

  let body;
  if (!connected) body = <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">Its agents show once {machine.name} is connected.</p>;
  else if (!snapshot.report && snapshot.error) body = <p role="alert" className="px-3.5 py-3 text-[12.5px] text-destructive">Could not read its agents: {snapshot.error}</p>;
  else if (!snapshot.report) body = <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">Reading its agents…</p>;
  else if (!rows.length) body = <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">{machine.name} has no agents installed.</p>;
  else
    body = (
      <ul aria-label={`Agents on ${machine.name}`} className="divide-y divide-hairline">
        {rows.map((row) => (
          <AgentRow key={row.id} row={row} machine={machine} client={client} owner={owner} setupGranted={setupGranted} />
        ))}
      </ul>
    );

  return (
    <section className="grid gap-2.5" data-testid="machine-agents" aria-label="Agents">
      <h3 className={pageHeading}>Agents</h3>
      <div className={pageCard}>{body}</div>
    </section>
  );
}

function AgentRow({ row, machine, client, owner, setupGranted }: { row: MachineAgentRow; machine: PairedMachine; client: WorkspaceRpcClient | null; owner: string; setupGranted: boolean }) {
  const flow = useMachineSetupFlow(machine.machineId, row.id);
  const action = agentRowAction(row, setupGranted);
  const start = (step: "install" | "login") => client && void startMachineAgentSetup(machine.machineId, client, row.id, step);
  return (
    <li data-testid="machine-agent" data-agent={row.id} data-sign-in={row.signIn ?? undefined} data-installed={row.installed}>
      <div className="flex min-h-12 items-center gap-3 px-3.5 py-2">
        <AgentMark id={row.id} decorative className={cn("size-4", row.installed ? "text-muted-foreground" : "text-faint")} />
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-[13px] font-medium", !row.installed && "text-muted-foreground")}>{row.name}</div>
          <div className="truncate text-[12px] text-faint" data-testid="machine-agent-line">
            {agentRowLine(row, owner)}
          </div>
        </div>
        {flow ? null : row.signIn === "signedIn" ? (
          <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-add" data-testid="machine-agent-signed-in">
            <Check className="size-3.5" aria-hidden /> Signed in
          </span>
        ) : action === "login" ? (
          <Button size="sm" variant="outline" className="shrink-0" disabled={!client} aria-label={`Sign in to ${row.name} on ${machine.name}`} onClick={() => start("login")}>
            Sign in
          </Button>
        ) : action === "install" ? (
          <Button size="sm" variant="outline" className="shrink-0" disabled={!client} aria-label={`Install ${row.name} on ${machine.name}`} onClick={() => start("install")}>
            <Download /> Install
          </Button>
        ) : null}
      </div>
      {flow && <SetupRun flow={flow} row={row} machine={machine} client={client} onRetry={() => start(flow.step)} />}
    </li>
  );
}

/** A step under way on the machine, or stopped: what it is doing, why it stopped, and its terminal. */
function SetupRun({ flow, row, machine, client, onRetry }: { flow: MachineSetupFlow; row: MachineAgentRow; machine: PairedMachine; client: WorkspaceRpcClient | null; onRetry: () => void }) {
  const create = useMemo(() => (flow.ptyId && client ? setupTerminalFactory(client, flow.ptyId) : undefined), [client, flow.ptyId]);
  return (
    <div className="grid gap-2 px-3.5 pb-3" data-testid="machine-agent-setup" data-phase={flow.phase} data-step={flow.step}>
      {flow.phase === "failed" ? (
        <div role="alert" className="rounded-md bg-destructive/10 px-2.5 py-2 text-[12.5px] text-destructive">
          <p>{machineProblemText(flow.problem, row.name, machine.name, flow)}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Button type="button" size="sm" variant="secondary" disabled={!client} onClick={onRetry}>
              <RotateCw /> Try again
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => dismissMachineAgentSetup(machine.machineId, row.id)}>
              {flow.terminal ? "Hide output" : "Dismiss"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
          <span className="min-w-0 flex-1" role="status">
            {flow.phase === "checking"
              ? `Checking ${row.name} on ${machine.name}…`
              : flow.step === "install"
                ? `Running ${row.name}'s official installer on ${machine.name}.`
                : `Signing in to ${row.name} on ${machine.name}. Open the address it prints in your browser; the sign-in stays on ${machine.name}.`}
          </span>
          {flow.phase === "running" && (
            <Button type="button" size="sm" variant="ghost" aria-label={`Cancel ${row.name} setup`} onClick={() => cancelMachineAgentSetup(machine.machineId, client, row.id)}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {flow.terminal && (
        <div data-testid="machine-agent-setup-terminal" role="region" aria-label={`${row.name} setup output on ${machine.name}`} className="h-52 min-w-0 overflow-hidden rounded-md bg-background py-1 hairline">
          <TerminalView id={flow.terminal} visible redraw={false} create={create} />
        </div>
      )}
    </div>
  );
}
