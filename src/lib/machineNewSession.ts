import { WorkspaceRpcError, type MachineProject, type RuntimeAgent, type RuntimeIssueRef, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { thisComputer } from "@/lib/platform";
import { newCloudAgentTab } from "@/lib/cloudAgents";
import { machineAgentScope } from "@/lib/machineCatalog";
import { selectCloudSession } from "@/lib/sessions";
import { machineSessionKey } from "@/types/target";
import type { MachineConnectionState, PairedMachine } from "@/types/machines";
import { seenText } from "@/components/machines/machineText";
import { runningText } from "@/components/machines/useRunningSessions";

/**
 * A new session on a paired machine from the new-session form (PRO-348,
 * screen 21.07, docs/MACHINES.md "As built (PRO-348)").
 *
 * The form's "Where it runs" menu lists each paired machine with a second
 * line ({@link machineWhereRow}); with one chosen, the project, branch and
 * agents come from that machine, and Create calls `session.create` there
 * with the project's `projectId` ({@link createMachineSession}). The runtime
 * cuts the worktree beside the project on the machine and sends the first
 * prompt itself, so the prompt travels inside the one idempotent create.
 */

/** An agent's login on the machine (PRO-350 adds it to `runtime.agents`); absent from a runtime that does not say. */
export type MachineAgentSignIn = "signedIn" | "signedOut" | "unknown";

/** `runtime.agents` as this form reads it: an older runtime sends no `signIn`. */
export type MachineAgentReport = Pick<RuntimeAgent, "id" | "name"> & { signIn?: MachineAgentSignIn };

/** What one machine's row in the "Where it runs" menu says, and whether it can be chosen. */
export interface MachineWhereRow {
  enabled: boolean;
  /** The second line: route, running sessions, then one reason or the free memory. */
  detail: string;
}

export interface MachineWhereInput {
  state: MachineConnectionState;
  machine: Pick<PairedMachine, "lastSeenAt">;
  /** Sessions working or waiting there; null until its session list is known. */
  running: number | null;
  /** Memory left on the machine (`lifecycle.resources`); null where it does not report it. */
  freeBytes: number | null;
  /** Its agents (`runtime.agents`); null until read. */
  agents: readonly MachineAgentReport[] | null;
  /** Its projects (`machine.projects`); null until known. */
  projects: readonly Pick<MachineProject, "name" | "archived">[] | null;
  /** The project the form is on now, by name: a machine without it says so. */
  wantedProject: string | null;
}

const GB = 1_000_000_000;

/** "14 GB", "9.2 GB": decimal gigabytes, as a spec sheet says them. */
export function memoryText(bytes: number): string {
  const gb = bytes / GB;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  const one = Math.round(gb * 10) / 10;
  return `${Number.isInteger(one) ? one.toFixed(0) : one.toFixed(1)} GB`;
}

/** No agent there can start a session: none installed, or every one definitely signed out. A sign-in nobody reported is no reason. */
export function noSignedInAgent(agents: readonly MachineAgentReport[] | null): string | null {
  if (!agents) return null;
  if (agents.length === 0) return "no agent installed there";
  return agents.every((agent) => agent.signIn === "signedOut") ? "no agent signed in there" : null;
}

/**
 * The menu row of a paired machine (21.07): "Direct · 3 sessions running ·
 * 14 GB memory free". An offline machine is listed but cannot be chosen, with
 * when it was last seen; one that needs an update, is updating, or no longer
 * allows this computer likewise, with why. A connected machine that has no
 * signed-in agent, or lacks the form's project, can be chosen and says so.
 */
export function machineWhereRow(input: MachineWhereInput, now = Date.now()): MachineWhereRow {
  const { state } = input;
  switch (state.state) {
    case "direct":
    case "relay": {
      const parts = [state.state === "direct" ? "Direct" : "Relay"];
      if (input.running !== null) parts.push(runningText(input.running));
      const listed = input.projects?.filter((project) => !project.archived) ?? null;
      const reason =
        noSignedInAgent(input.agents) ??
        (input.wantedProject && listed && !listed.some((project) => project.name === input.wantedProject) ? `${input.wantedProject} is not a project there` : null) ??
        (listed && listed.length === 0 ? "no projects there yet" : null);
      if (reason) parts.push(reason);
      else if (input.freeBytes !== null) parts.push(`${memoryText(input.freeBytes)} memory free`);
      return { enabled: true, detail: parts.join(" · ") };
    }
    case "offline": {
      const seen = state.lastSeenAt ?? input.machine.lastSeenAt;
      return { enabled: false, detail: seen ? `Offline · last seen ${seenText(seen, now)}` : `Offline · never reached from ${thisComputer}` };
    }
    case "needsUpdate":
      return { enabled: false, detail: state.side === "thisMac" ? `Needs update · it runs a newer TerminalX than ${thisComputer}` : "Needs update · it runs an older TerminalX" };
    case "updating":
      return { enabled: false, detail: "Updating · back in under a minute" };
    case "accessRemoved":
      return { enabled: false, detail: `No longer allows ${thisComputer} · pair again in Settings → Machines` };
    case "connecting":
      return { enabled: false, detail: "Connecting…" };
    case "reconnecting":
      return { enabled: false, detail: "Reconnecting…" };
    default:
      return { enabled: false, detail: "Not connected" };
  }
}

/**
 * The project the form starts on when a machine is chosen: the one asked
 * for, else the one named like the project the form was on, else the
 * machine's first. Archived projects are never offered.
 */
export function pickMachineProject(projects: readonly MachineProject[], asked: string | null, wantedName: string | null): MachineProject | null {
  const listed = projects.filter((project) => !project.archived);
  return listed.find((project) => project.projectId === asked) ?? listed.find((project) => project.name === wantedName) ?? listed[0] ?? null;
}

/** The chosen agent's login there, for the line under the form; null while nothing is known. */
export function agentSignIn(agents: readonly MachineAgentReport[] | null, agentId: string | null | undefined): MachineAgentSignIn | null {
  const agent = agentId ? agents?.find((entry) => entry.id === agentId) : undefined;
  return agent?.signIn ?? null;
}

/**
 * One create's idempotency id, kept while the request stays the same: a
 * Create pressed again after the connection gave up is the same request, and
 * the runtime answers it with the session it already made, so the first
 * prompt goes once. A changed request, a create that succeeded, or one the
 * runtime refused (an answer, not a lost one) starts a new id.
 */
export class CreateAttempt {
  private kept: { digest: string; id: string } | null = null;

  constructor(private readonly fresh: () => string) {}

  idFor(request: unknown): string {
    const digest = JSON.stringify(request);
    if (this.kept?.digest !== digest) this.kept = { digest, id: this.fresh() };
    return this.kept.id;
  }

  /** The create ended: forget the id unless the answer was lost on the way. */
  settle(error: unknown | null) {
    if (error === null || error instanceof WorkspaceRpcError) this.kept = null;
  }

  /** Back to This Mac, or another machine: nothing carries over. */
  reset() {
    this.kept = null;
  }
}

/** What a new session on a machine starts with. */
export interface MachineSessionRequest {
  machineId: string;
  projectId: string;
  agent: string;
  model: string;
  effort: string | null;
  mode: string;
  prompt: string;
  title: string;
  useWorktree: boolean;
  /** The worktree's name (the issue's, or one drawn from the prompt); the runtime draws one without it. */
  worktreeName?: string | null;
  /** `session-base/1`: the branch the worktree is cut from; the project's default without it. */
  baseRef?: string | null;
  /** Started from an issue (`pipeline/1` on the machine): carried on to a pull request unless `pipeline` is false. */
  issue?: { ref: RuntimeIssueRef; body: string | null; pipeline: boolean } | null;
  pipelineOptions?: { autoMerge: boolean; resolveConflicts: boolean };
  /** Settings → Experimental → Native Codex, as a cloud start sends it (#644). */
  nativeCodex?: boolean;
}

export interface MachineSessionCreated {
  key: string;
  sessionId: string;
  tabId: string;
  /** The session exists but its first prompt did not go: the runtime's words, also in the tab's transcript. */
  startError: string | null;
  /** Why the runtime started no pipeline for an issue. */
  pipelineNote: string | null;
}

/** The `session.create` parameters of a request, as the attempt's digest and the wire both see them. */
export function machineCreateParams(request: MachineSessionRequest) {
  const issue = request.issue && request.issue.ref ? request.issue : null;
  return {
    projectId: request.projectId,
    agent: request.agent,
    model: request.model || undefined,
    effort: request.effort,
    mode: request.mode,
    prompt: request.prompt,
    title: request.title,
    useWorktree: request.useWorktree,
    worktreeName: request.useWorktree ? (request.worktreeName ?? null) : null,
    baseRef: request.useWorktree ? (request.baseRef ?? null) : null,
    nativeCodex: request.nativeCodex || undefined,
    ...(issue ? { issue: issue.ref, issueBody: issue.body, pipeline: issue.pipeline } : {}),
    ...(request.pipelineOptions ? { pipelineOptions: request.pipelineOptions } : {}),
  };
}

/**
 * Create the session on the machine and open it in the machine session view
 * (`select: false` leaves the window where it is). `clientRequestId` comes
 * from a {@link CreateAttempt}, so a retry after a lost answer is not a second
 * session.
 */
export async function createMachineSession(client: WorkspaceRpcClient, request: MachineSessionRequest, clientRequestId: string, options: { select?: boolean } = {}): Promise<MachineSessionCreated> {
  const params = machineCreateParams(request);
  // An issue goes only to a machine that carries issues on; an older one would start a plain session silently.
  if (params.issue && !client.hasCapability("pipeline/1")) {
    delete (params as Partial<typeof params>).issue;
    delete (params as Partial<typeof params>).issueBody;
    delete (params as Partial<typeof params>).pipeline;
  }
  const created = await newCloudAgentTab(machineAgentScope(request.machineId), client, { ...params, clientRequestId });
  const key = machineSessionKey(request.machineId, request.projectId, created.sessionId);
  if (options.select !== false) selectCloudSession(key);
  return { key, sessionId: created.sessionId, tabId: created.tabId, startError: created.startError, pipelineNote: created.pipelineNote };
}
