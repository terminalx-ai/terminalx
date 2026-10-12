import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { readRemoteFile, writeRemoteFile } from "@terminalx/portable/workspaceFiles";
import { listRepositories } from "@terminalx/portable/workspaceGit";
import { api, type AgentLoginProvider, type CloudWorkspace, type CloudWorkspaceProviderId, type CloudWorkspaceQuote, type CloudWorkspaceSnapshot } from "@/lib/api";
import { retainCloudConnection, waitCloudConnected, type CloudLease } from "@/lib/cloudConnections";
import { isOpen } from "@/lib/cloudLifecycle";
import { PROPOSAL_MAX_BYTES, PROPOSAL_PATH, ProposalError, parseProposal, preparationPrompt, proposalProblemMessage, reportedObservations, type EnvironmentProposal, type PreparationRepository } from "@/lib/environmentProposal";
import { SCRATCH_DIRECTORY, cleanupScript, verifyProposal, type RunScript, type ScriptRun, type VerifiedSource } from "@/lib/environmentVerification";
import { effectiveRunningLimit, organizationCompute } from "@/lib/organizationCompute";
import type { RecipeObservations } from "@/lib/organizationEnvironment";

// "Configure with an agent" (PRO-20), from the confirmed start to the stopped
// machine. A preparation workspace is created (the server marks it, keeps it
// private, gives it none of the organization's secrets and stops it after an
// hour whatever happens here); the agent writes its proposal; TerminalX runs
// the proposed commands itself; then the machine is stopped. Nothing here
// saves a recipe or touches the template: that is the admin's next press.

/** The server's own limit for a preparation workspace. Shown before the start; the server enforces it. */
export const PREPARATION_LIMIT_MINUTES = 60;
/** The longest idle window the server accepts for one. */
const MAX_IDLE_MINUTES = 15;
/** Verification stops starting commands this long before the server's stop. */
const DEADLINE_MARGIN_MS = 3 * 60 * 1000;
const OPERATION_POLL_MS = 3000;
const AGENT_POLL_MS = 5000;
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
/** How long the machine may sit connected with no agent on it before the run gives up and stops it. */
const AGENT_START_TIMEOUT_MS = 10 * 60 * 1000;
/** A dropped request is tried again this many times in a row before the run fails. */
const TRANSIENT_RETRIES = 3;

export interface PreparationOffer {
  provider: CloudWorkspaceProviderId;
  quote: CloudWorkspaceQuote;
  idleSuspendMinutes: number;
  running: number;
  runningLimit: number;
  /** Agents the organization has a login for; the task needs one. */
  agents: AgentLoginProvider[];
  contextRevision: string;
}

export type PreparationRefusal = "running-limit" | "provisioning-paused" | "no-agent-login" | "no-idle-window";

export class PreparationError extends Error {
  constructor(
    readonly code: PreparationRefusal | "create-refused" | "create-outcome-unknown" | "create-failed" | "unreachable" | "agent-sign-in" | "no-agent" | "no-proposal" | "bad-proposal" | "canceled" | "limit-reached" | "request-failed",
    message: string,
    /** What became of the machine once the run ended; null when there was none, or it is not known. */
    readonly machine: StopOutcome | null = null,
  ) {
    super(message);
  }
}

const serverCode = (failure: unknown): string => {
  const code = (failure as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
};

/**
 * What starting would cost and whether it may start at all. It prices a
 * machine; it starts none. At the organization's running limit it refuses
 * here, before a quote is asked for.
 */
export async function offerPreparation(provider: CloudWorkspaceProviderId): Promise<PreparationOffer> {
  const [view, setup, logins] = await Promise.all([organizationCompute.policy(), api.cloudWorkspaceSetup(provider), api.cloudAgentLogins()]);
  const runningLimit = effectiveRunningLimit(view);
  if (view.policy.provisioningPaused) throw new PreparationError("provisioning-paused", "New cloud machines are paused for this organization.");
  if (view.counts.running >= runningLimit)
    throw new PreparationError("running-limit", `The organization is at its running limit (${view.counts.running} of ${runningLimit} running). Stop a workspace first.`);
  // A login that was revoked or has stopped working would only fail on the machine, after it was paid for.
  const agents = logins.credentials.filter((login) => (login.state ?? "connected") === "connected").map((login) => login.provider);
  if (!agents.length) throw new PreparationError("no-agent-login", "The organization has no working agent login. Add or reconnect one under Agent logins first.");
  const idle = setup.allowedIdleSuspendMinutes.filter((minutes) => minutes > 0 && minutes <= MAX_IDLE_MINUTES).sort((a, b) => a - b)[0];
  if (idle === undefined) throw new PreparationError("no-idle-window", "This provider offers no short idle-stop setting, which a preparation machine needs.");
  const quote = await api.cloudWorkspaceQuote({ provider, ...setup.defaults, idleSuspendMinutes: idle });
  return { provider, quote, idleSuspendMinutes: idle, running: view.counts.running, runningLimit, agents, contextRevision: view.contextRevision };
}

export type PreparationPhase =
  | { step: "creating" }
  | { step: "connecting" }
  | { step: "agent"; waitingForPermission: boolean }
  | { step: "verifying"; detail: string }
  | { step: "stopping" };

export interface PreparationRequest {
  offer: PreparationOffer;
  agent: AgentLoginProvider;
  repositories: PreparationRepository[];
  /** One key for this start: a retry after a lost response must not make a second machine. */
  idempotencyKey: string;
  /** Marks the proposal file as written in this run; the agent is told to copy it. */
  token: string;
}

export interface PreparationResult {
  workspaceId: string;
  proposal: EnvironmentProposal;
  observations: RecipeObservations;
  /** Where each checked copy came from; empty when TerminalX could not run the checks itself. */
  sources: VerifiedSource[];
  /** What the stop request came to. The server's own limit applies whatever it says. */
  machine: StopOutcome;
}

/**
 * `stopping`: the server accepted the stop. `busy`: it is already changing
 * state (starting, or on its way down) and was not asked again. `failed`: the
 * request was refused or lost. `deleted`: it never finished starting, so it
 * was removed instead.
 */
export type StopOutcome = "stopping" | "busy" | "failed" | "deleted";

export interface PreparationHandle {
  /** Known as soon as the machine exists, so the screen can name it even if the run fails. */
  onWorkspace?: (workspace: CloudWorkspace) => void;
  onPhase?: (phase: PreparationPhase) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new PreparationError("canceled", "Canceled."));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new PreparationError("canceled", "Canceled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

// The one line typed into a terminal. `exec` makes the terminal's shell
// become the script, so the terminal exits with the script's own code. The
// script runs in a new non-interactive bash that reads no profile or rc file
// and inherits no environment but a standard PATH: what the agent left in
// shell start-up files or variables does not reach it, and a tool must be on
// the standard PATH to be found, as it must be when a version is built.
// It is still typed into a shell the agent's files have already configured;
// that shell could have been made to do something else with this line.
export const TERMINAL_LINE =
  'builtin exec /usr/bin/env -i HOME="$HOME" USER="$USER" LANG=C.UTF-8 TERM=dumb PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/bash --noprofile --norc';

/**
 * Runs a script in the workspace through a terminal of its own, which is how
 * a client learns an exit code from the runtime. The script is written to a
 * file first, so no command text passes through the terminal's line input.
 */
export function terminalRunner(client: WorkspaceRpcClient): RunScript {
  let sequence = 0;
  let prepared = false;
  return async (script, timeoutMs): Promise<ScriptRun> => {
    if (!prepared) {
      await client.mutate("fs.mkdir", { path: SCRATCH_DIRECTORY });
      prepared = true;
    }
    const path = `${SCRATCH_DIRECTORY}/run-${++sequence}.sh`;
    await writeRemoteFile(client, path, `${script}\n`, undefined);
    const terminal = await client.createPty({ cols: 120, rows: 32 });
    const started = Date.now();
    return new Promise<ScriptRun>((resolve) => {
      let settled = false;
      let attachment: { detach(): void } | null = null;
      const finish = (exitCode: number | null, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        attachment?.detach();
        // Ends whatever is still running, and frees the terminal's slot.
        void client.killPty(terminal.ptyId).catch(() => undefined);
        resolve({ exitCode, timedOut, durationMs: Date.now() - started });
      };
      const timer = setTimeout(() => finish(null, true), timeoutMs);
      client
        .attachPty(terminal.ptyId, { onData: () => undefined, onExit: (code) => finish(code, false), onGone: () => finish(null, false) })
        .then((attached) => {
          attachment = attached;
          if (settled) attached.detach();
          return client.write(terminal.ptyId, `${TERMINAL_LINE} ${path}\r`);
        })
        .catch(() => finish(null, false));
    });
  };
}

async function waitForOperation(snapshot: CloudWorkspaceSnapshot, signal?: AbortSignal): Promise<CloudWorkspaceSnapshot> {
  let current = snapshot;
  while (isOpen(current.operation)) {
    await sleep(OPERATION_POLL_MS, signal);
    current = await api.cloudWorkspaceOperation(current.operation.id, current.workspace.orgId);
  }
  return current;
}

const repositoryOfRemote = (remote: string | null): string | null => {
  const match = remote?.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
};

/** Where each repository is checked out, by `owner/name` in lower case. */
async function repositoryDirectories(client: WorkspaceRpcClient): Promise<Record<string, string>> {
  const directories: Record<string, string> = {};
  for (const repository of await listRepositories(client)) {
    const name = repositoryOfRemote(repository.remote);
    if (name && !(name in directories)) directories[name] = repository.repo;
  }
  return directories;
}

const isMissing = (failure: unknown) => serverCode(failure) === "not_found";

/** One request to the runtime, tried again when it is merely dropped. A refusal the caller understands is passed through at once. */
async function steady<T>(request: () => Promise<T>, passThrough: (failure: unknown) => boolean, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (failure) {
      if (passThrough(failure) || attempt >= TRANSIENT_RETRIES) throw failure;
      await sleep(AGENT_POLL_MS, signal);
    }
  }
}

/** Waits for the agent to stop working and for the proposal file of this run, whichever the deadline allows. */
async function awaitProposal(client: WorkspaceRpcClient, path: string, request: PreparationRequest, deadline: number, handle: PreparationHandle): Promise<EnvironmentProposal> {
  const started = Date.now();
  let sawAgent = false;
  let idleWithoutFile = 0;
  for (;;) {
    if (Date.now() >= deadline) throw new PreparationError("limit-reached", "The agent did not finish before the preparation machine's time limit.");
    const tabs = await steady(() => client.listAgentTabs(), () => false, handle.signal);
    if (tabs.some((tab) => tab.signIn)) throw new PreparationError("agent-sign-in", "The agent could not sign in on the preparation machine. Check the organization's agent login.");
    sawAgent ||= tabs.length > 0;
    // A machine with no agent on it does nothing useful; it is not kept awake waiting for one.
    if (!sawAgent && Date.now() - started >= AGENT_START_TIMEOUT_MS) throw new PreparationError("no-agent", "The agent never started on the preparation machine.");
    const waiting = tabs.some((tab) => tab.status === "waiting" || tab.pendingPermissions.length > 0);
    const working = waiting || tabs.some((tab) => tab.status === "in_progress");
    handle.onPhase?.({ step: "agent", waitingForPermission: waiting });
    if (sawAgent && !working) {
      // The agent is done: its file is read once it has stopped, never mid-write.
      let content: string | null = null;
      try {
        content = (await steady(() => readRemoteFile(client, path, { maxBytes: PROPOSAL_MAX_BYTES, signal: handle.signal }), isMissing, handle.signal)).text ?? "";
      } catch (failure) {
        if (!isMissing(failure)) throw failure;
      }
      if (content !== null) {
        try {
          return parseProposal(content, request.repositories, request.token);
        } catch (failure) {
          // A file without this run's token is not the agent's answer: it is as if there were none yet.
          if (!(failure instanceof ProposalError && failure.problem === "not-this-run")) throw new PreparationError("bad-proposal", proposalProblemMessage(failure));
        }
      }
      // Between turns a tab reads idle for a moment; give it a few looks before deciding there is no answer.
      if (++idleWithoutFile >= 6) throw new PreparationError("no-proposal", "The agent stopped without writing its proposal.");
    } else idleWithoutFile = 0;
    await sleep(AGENT_POLL_MS, handle.signal);
  }
}

/**
 * The whole run. Whatever happens after the machine exists (success, a
 * failure, a cancel), it ends by asking the server to stop the machine.
 */
export async function runPreparation(request: PreparationRequest, handle: PreparationHandle = {}): Promise<PreparationResult> {
  const { offer, repositories } = request;
  handle.onPhase?.({ step: "creating" });
  let created: CloudWorkspaceSnapshot;
  try {
    created = await api.cloudWorkspaceCreate({
      name: `Environment preparation ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      quoteId: offer.quote.id,
      accessMode: "private",
      confirmProviderSpend: true,
      idempotencyKey: request.idempotencyKey,
      repositories: repositories.map((repository) => ({ cloneUrl: `https://github.com/${repository.owner}/${repository.name}`, ref: repository.defaultBranch })),
      launch: { agent: request.agent, mode: "bypassPermissions", prompt: preparationPrompt(repositories, request.token) },
      preparation: true,
    });
  } catch (failure) {
    const code = serverCode(failure);
    // No answer is not a refusal: the server may have made the machine.
    throw new PreparationError(createOutcomeUnknown(code) ? "create-outcome-unknown" : "create-refused", createRefusalMessage(code));
  }
  const workspace = created.workspace;
  handle.onWorkspace?.(workspace);
  const target = { orgId: workspace.orgId, workspaceId: workspace.id };
  let lease: CloudLease | null = null;
  let client: WorkspaceRpcClient | null = null;
  let ready = false;
  try {
    const settled = await waitForOperation(created, handle.signal);
    if (settled.operation.state !== "succeeded") throw new PreparationError("create-failed", "The preparation machine could not be started.");
    ready = true;
    const stopAfter = settled.workspace.preparation?.stopAfter ?? workspace.preparation?.stopAfter ?? workspace.createdAt + PREPARATION_LIMIT_MINUTES * 60_000;
    const deadline = stopAfter - DEADLINE_MARGIN_MS;

    handle.onPhase?.({ step: "connecting" });
    lease = await retainCloudConnection(target, "connect");
    try {
      client = await waitCloudConnected(lease, CONNECT_TIMEOUT_MS, { stoppedIsError: true });
    } catch {
      throw new PreparationError("unreachable", "TerminalX could not connect to the preparation machine.");
    }
    if (handle.signal?.aborted) throw new PreparationError("canceled", "Canceled.");

    const directories = await repositoryDirectories(client);
    const first = repositories[0];
    const home = directories[`${first.owner}/${first.name}`.toLowerCase()] ?? ".";
    const proposal = await awaitProposal(client, home === "." ? PROPOSAL_PATH : `${home}/${PROPOSAL_PATH}`, request, deadline, handle);

    let observations: RecipeObservations;
    let sources: VerifiedSource[] = [];
    try {
      const run = terminalRunner(client);
      const reader = client;
      ({ observations, sources } = await verifyProposal(proposal, run, {
        directories,
        deadline,
        signal: handle.signal,
        onProgress: (detail) => handle.onPhase?.({ step: "verifying", detail }),
        readScratch: async (name) => {
          try {
            return (await readRemoteFile(reader, `${SCRATCH_DIRECTORY}/${name}`, { maxBytes: 4096 })).text ?? null;
          } catch {
            return null;
          }
        },
      }));
      await run(cleanupScript, 60_000).catch(() => undefined);
    } catch (failure) {
      if (handle.signal?.aborted) throw new PreparationError("canceled", "Canceled.");
      // TerminalX could not run the commands itself. What is left is the
      // agent's own account, and it is kept labelled as exactly that.
      console.error("environment verification failed", failure);
      observations = reportedObservations(proposal);
      sources = [];
    }
    handle.onPhase?.({ step: "stopping" });
    lease.release();
    lease = null;
    return { workspaceId: workspace.id, proposal, observations, sources, machine: await stopPreparation(workspace) };
  } catch (failure) {
    lease?.release();
    lease = null;
    handle.onPhase?.({ step: "stopping" });
    // A machine that never finished starting cannot be suspended: this run made it, and removes it.
    const machine = ready ? await stopPreparation(workspace) : await discardUnstartedPreparation(workspace);
    const canceled = handle.signal?.aborted && !(failure instanceof PreparationError && failure.code !== "canceled");
    const known = failure instanceof PreparationError ? failure : null;
    throw new PreparationError(canceled ? "canceled" : (known?.code ?? "request-failed"), `${canceled ? "Canceled." : (known?.message ?? "The preparation run failed.")} ${machineSentence(machine)}`, machine);
  }
}

/** What to tell the admin about the machine, in one sentence that claims no more than the server said. */
export function machineSentence(machine: StopOutcome): string {
  switch (machine) {
    case "stopping":
      return "The preparation machine is being stopped.";
    case "deleted":
      return "The preparation machine had not finished starting and is being deleted.";
    case "busy":
      return "The preparation machine was already changing state, so it was not asked to stop again. Check it in the list below.";
    case "failed":
      return "TerminalX could not stop the preparation machine. Stop it from the list below; the server stops it at its time limit regardless.";
  }
}

/**
 * Asks the server to stop a preparation machine. It only ever stops: it never
 * falls back to deleting, so a "Stop" can never remove a machine.
 */
export async function stopPreparation(workspace: Pick<CloudWorkspace, "id" | "orgId">): Promise<StopOutcome> {
  try {
    await api.cloudWorkspaceSuspend(workspace.id, workspace.orgId);
    return "stopping";
  } catch (failure) {
    return serverCode(failure) === "cloud_workspace_operation_in_progress" ? "busy" : "failed";
  }
}

/** For the run's own machine when its create never finished: a create in flight can be canceled only by deleting. */
async function discardUnstartedPreparation(workspace: Pick<CloudWorkspace, "id" | "orgId">): Promise<StopOutcome> {
  try {
    await api.cloudWorkspaceDelete(workspace.id, true, workspace.orgId);
    return "deleted";
  } catch {
    return "failed";
  }
}

/** Codes that mean the create got no answer, as the native client names them, or no code at all. */
export const createOutcomeUnknown = (code: string) => code === "" || code === "cloud_workspace_create_outcome_unknown" || code === "cloud_workspace_request_outcome_unknown";

export function createRefusalMessage(code: string): string {
  switch (code) {
    case "organization_admin_required":
      return "Only organization owners and admins can configure the environment with an agent.";
    case "cloud_workspace_concurrency_exceeded":
    case "cloud_workspace_member_concurrency_exceeded":
      return "The organization is at its running limit. Stop a workspace first.";
    case "cloud_workspace_quota_exceeded":
      return "The organization is at its workspace limit. Delete or archive a workspace first.";
    case "cloud_provisioning_paused":
      return "New cloud machines are paused for this organization.";
    case "cloud_workspace_create_budget_exceeded":
      return "You have created as many workspaces as the organization allows for now. Try again later.";
    case "cloud_workspace_quote_expired":
      return "The price shown is out of date. Close this and start again to see the current one.";
    case "cloud_workspace_agent_credential_required":
      return "The organization has no login for that agent.";
    case "cloud_workspace_repository_not_accessible":
    case "cloud_workspace_repository_credential_required":
      return "TerminalX cannot reach one of those repositories with the organization's GitHub access.";
    case "cloud_workspace_request_invalid":
      return "This server does not accept preparation machines, or refused the request as invalid.";
    case "":
    case "cloud_workspace_create_outcome_unknown":
    case "cloud_workspace_request_outcome_unknown":
      // No answer from the server: the request may have been applied.
      return "TerminalX did not get an answer, so a preparation machine may have been started. Press Try again to ask for the same machine, not a second one. If one is listed below and you do not want it, stop or delete it; the server stops it at its time limit regardless.";
    default:
      return "The server refused to start the preparation machine. Nothing was started.";
  }
}
