import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sessionStatus } from "@terminalx/portable/sessionStatus";
import { WorkspaceRpcError, type CleanupCandidate, type CleanupProject, type MachineProject, type RuntimeSession, type WorkspaceCapability, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { getTabLog, lastSeq } from "@/lib/agentEvents";
import { attachCloudAgentTab, decideCloudAgent, getCloudAgents, sendToCloudAgent, syncLiveTabs, type CloudAgentTab } from "@/lib/cloudAgents";
import { settledReason } from "@/lib/cloudControl";
import { allMachineSessions, getMachineCatalog, liveMachineClient, machineAgentScope, machineSessionStatus, updateMachineSession, type MachineSessionRow } from "@/lib/machineCatalog";
import { getMachineConnections, isMachineDisconnected, reconnectMachine } from "@/lib/machineConnections";
import { createMachineSession, type MachineSessionRequest } from "@/lib/machineNewSession";
import { FIRST_RUN_PERMISSION_MODE, pickerMode } from "@/lib/models";
import { getPrefs } from "@/lib/prefs";
import { machineProjectKey, machineSessionKey, parseMachineKey } from "@/types/target";
import type { MachineConnectionState } from "@/types/machines";

/**
 * Paired machines for the `terminalx` CLI (PRO-356, docs/MACHINES.md "As
 * built (PRO-356)"). The control socket hands a `machine.*` command to this
 * window (`machine_control_request`) once native code has resolved the
 * machine and refused one that cannot answer (`machine_control.rs`); the
 * answer goes back with `cloud_control_reply`.
 *
 * Every command runs over the one connection this window already holds to
 * the machine, with the code its views use, so the CLI does what the person
 * can do there and nothing more:
 *
 * - Lists come from the machine catalog: live while connected, the last
 *   known rows otherwise (`fresh: false`).
 * - `sessions.create` is the new-session form's `session.create`, with one
 *   idempotency id per `--idempotency-key`.
 * - `send` and a permission's decision go live (`agent-commands/1`), as the
 *   composer and the approval card send them on a machine.
 * - `read` replays the tab from the machine; `wait` follows it live.
 * - Worktrees are the clean-up's (`cleanup/1`): the machine checks each
 *   removal again, as Settings → Storage does.
 *
 * Nothing here opens a connection of its own, and a machine that is not
 * connected is refused with a code, never waited on past a few seconds.
 */

type Params = Record<string, unknown>;

/** A refusal the CLI prints as `code: message`, with what to do about it. */
export class MachineControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery: string | null = null,
  ) {
    super(message);
    this.name = "MachineControlError";
  }
}

const invalid = (message: string) => new MachineControlError("invalid_arguments", message, "Run terminalx --help and correct the named argument.");
const notFound = (message: string, recovery: string | null = null) => new MachineControlError("not_found", message, recovery);

function text(params: Params, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function required(params: Params, key: string): string {
  const value = text(params, key);
  if (!value) throw invalid(`Missing ${key}.`);
  return value;
}

/** The machine native code resolved: `{ machineId, name }`. */
interface Machine {
  machineId: string;
  name: string;
}

function machineOf(params: Params): Machine {
  const machine = params.machine as Partial<Machine> | undefined;
  if (!machine || typeof machine.machineId !== "string" || typeof machine.name !== "string") throw invalid("Name the machine with --machine MACHINE.");
  return { machineId: machine.machineId, name: machine.name };
}

// ---- the connection ----------------------------------------------------------

/** How long a command waits for a machine that is attaching or on its first round of routes. */
export const CONNECT_WITHIN_MS = 10_000;
const CONNECT_POLL_MS = 250;

const TRY_AGAIN = (name: string) => `Check it with terminalx machines status "${name}", and run the command again once it is connected. Nothing was sent.`;

/** Why a machine in `state` cannot answer now, in native code's words (`machine_control::refusal`); null while it may. */
export function stateRefusal(name: string, state: MachineConnectionState): MachineControlError | null {
  switch (state.state) {
    case "idle":
    case "connecting":
    case "direct":
    case "relay":
      return null;
    case "reconnecting":
      return new MachineControlError("machine_offline", `${name} is not connected: its link was lost and TerminalX is reconnecting.`, TRY_AGAIN(name));
    case "offline":
      return new MachineControlError("machine_offline", `${name} is offline: no route to it answers.`, TRY_AGAIN(name));
    case "needsUpdate":
      return state.side === "thisMac"
        ? new MachineControlError("machine_needs_update", `${name} runs a newer TerminalX than this computer.`, "Update TerminalX on this computer.")
        : new MachineControlError("machine_needs_update", `${name} needs a newer TerminalX to work with this computer.`, `Update TerminalX on ${name}.`);
    case "updating":
      return new MachineControlError("machine_updating", `${name} is updating to TerminalX ${state.version}.`, "Run the command again in a minute: it is back in under one.");
    case "accessRemoved":
      return new MachineControlError("machine_access_removed", `${name} no longer lets this computer operate it.`, `Pair again with a new code from ${name}: terminalx machines add --code CODE.`);
    case "disconnected":
      return new MachineControlError("machine_disconnected", `The person at ${name} disconnected this computer.`, `Ask them to let this computer back on ${name}, then press Try again in TerminalX.`);
  }
}

type Sleep = (ms: number) => Promise<void>;
const pause: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The machine's live client. A machine this window holds no connection to
 * yet is attached (as "Try again" does); one on its first round of routes
 * gets {@link CONNECT_WITHIN_MS}. Anything else is refused at once.
 */
export async function connectedClient(machine: Machine, sleep: Sleep = pause, now: () => number = Date.now): Promise<WorkspaceRpcClient> {
  if (isMachineDisconnected(machine.machineId)) {
    throw new MachineControlError("machine_offline", `${machine.name} was disconnected in this TerminalX window.`, `Press Try again on ${machine.name} in TerminalX, then run the command again. Nothing was sent.`);
  }
  const deadline = now() + CONNECT_WITHIN_MS;
  let attached = false;
  for (;;) {
    const client = liveMachineClient(machine.machineId);
    if (client) return client;
    const store = getMachineConnections();
    const state = store.states[machine.machineId] ?? { state: "idle" };
    const refused = stateRefusal(machine.name, state);
    if (refused) throw refused;
    const attachError = store.attachErrors[machine.machineId];
    if (attachError) throw new MachineControlError("machine_offline", `${machine.name} could not be connected: ${attachError}`, TRY_AGAIN(machine.name));
    if (!attached && !store.connections[machine.machineId]) {
      attached = true;
      await reconnectMachine(machine.machineId).catch(() => undefined);
    }
    if (now() >= deadline) {
      throw new MachineControlError("machine_offline", `${machine.name} did not connect within ${CONNECT_WITHIN_MS / 1000} s.`, TRY_AGAIN(machine.name));
    }
    await sleep(Math.min(CONNECT_POLL_MS, Math.max(0, deadline - now())));
  }
}

/** The namespace a command needs, refused by name on a machine whose version does not serve it. */
function needs(client: WorkspaceRpcClient, machine: Machine, capability: WorkspaceCapability, what: string) {
  if (client.hasCapability(capability)) return;
  const record = getMachineConnections().machines.find((candidate) => candidate.machineId === machine.machineId);
  const version = record?.version ? ` ${record.version}` : "";
  throw new MachineControlError("machine_unsupported", `${machine.name} runs TerminalX${version}, which does not serve ${what} (${capability}).`, `Update TerminalX on ${machine.name}; terminalx machines status "${machine.name}" shows its version.`);
}

/** A refusal from the machine itself, in the CLI's shape. */
function fromMachine(error: unknown): MachineControlError | unknown {
  if (!(error instanceof WorkspaceRpcError)) return error;
  if (error.code === "capability_not_granted" || error.code === "method_not_found") return new MachineControlError("machine_unsupported", error.message, "Update TerminalX on the machine.");
  if (error.code === "disconnected" || error.code === "timeout") return new MachineControlError("machine_offline", error.message, "Check the machine with terminalx machines status, then try again. A message already sent is not sent twice: read the session before repeating it.");
  return new MachineControlError(error.code, error.message);
}

// ---- projects and sessions ---------------------------------------------------

function projectView(machine: Machine, project: MachineProject) {
  return {
    key: machineProjectKey(machine.machineId, project.projectId),
    projectId: project.projectId,
    machine: { id: machine.machineId, name: machine.name },
    name: project.name,
    // The machine's own path: display only.
    path: project.path,
    kind: project.kind,
    defaultBranch: project.defaultBranch,
    archived: project.archived,
  };
}

async function projectsOf(client: WorkspaceRpcClient): Promise<MachineProject[]> {
  try {
    return await client.machineProjects();
  } catch (error) {
    throw fromMachine(error);
  }
}

/** A project by its key, id, name (any case) or path on the machine. */
function pickProject(machine: Machine, projects: readonly MachineProject[], selector: string): MachineProject {
  const parsed = selector.startsWith("machine:") ? parseMachineKey(selector) : null;
  const id = parsed?.projectId ?? selector;
  const found =
    projects.find((project) => project.projectId === id) ??
    projects.find((project) => project.path === selector || project.path.replace(/\/+$/, "") === selector.replace(/\/+$/, "")) ??
    (() => {
      const named = projects.filter((project) => project.name.toLowerCase() === selector.toLowerCase());
      if (named.length > 1) throw new MachineControlError("ambiguous_selector", `${named.length} projects on ${machine.name} are called ${selector}.`, "Name it by its key, as terminalx projects list --machine prints it.");
      return named[0];
    })();
  if (!found) throw notFound(`${machine.name} has no project ${selector}.`, `List them with terminalx projects list --machine "${machine.name}".`);
  return found;
}

function sessionView(machine: Machine, row: MachineSessionRow, projects: readonly MachineProject[]) {
  const project = projects.find((candidate) => candidate.projectId === row.projectId);
  return {
    key: row.key,
    id: row.sessionId,
    // The column `sessions list --all-machines` adds: null is this computer.
    machine: { id: machine.machineId, name: machine.name },
    projectKey: machineProjectKey(row.machineId, row.projectId),
    projectName: project?.name ?? null,
    title: row.title,
    branch: row.branch,
    worktreeName: row.worktreeName,
    created: row.created,
    modified: row.modified,
    archived: row.archived,
    pinned: row.pinned,
    status: machineSessionStatus(row),
    detailedStatus: row.rowStatus ? sessionStatus(row.rowStatus) : null,
    // False: the machine is away, and this is what it last said.
    fresh: row.source === "live",
    tabs: row.tabs.map((tab) => ({ id: tab.tabId, agent: tab.harness, title: tab.title, status: tab.status, pendingApprovals: tab.pendingApprovals })),
  };
}

function rowsOf(machineId: string): MachineSessionRow[] {
  return allMachineSessions().filter((row) => row.machineId === machineId);
}

async function projectsList(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  return { machine: { id: machine.machineId, name: machine.name }, projects: (await projectsOf(client)).map((project) => projectView(machine, project)) };
}

async function sessionsList(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  const projects = await projectsOf(client);
  const asked = text(params, "project");
  const project = asked ? pickProject(machine, projects, asked) : null;
  const archived = params.archived === true;
  const sessions = rowsOf(machine.machineId)
    .filter((row) => row.archived === archived && (!project || row.projectId === project.projectId))
    .map((row) => sessionView(machine, row, projects));
  return { machine: { id: machine.machineId, name: machine.name }, sessions };
}

/**
 * `sessions list --all-machines`: every paired machine's sessions, from the
 * catalog, whether or not it is connected now, and how each machine stands.
 */
function sessionsListAll(params: Params) {
  const archived = params.archived === true;
  const { machines, states } = getMachineConnections();
  const catalog = getMachineCatalog().machines;
  const sessions = machines.flatMap((record) => {
    const machine = { machineId: record.machineId, name: record.name };
    const projects = catalog[record.machineId]?.projects ?? [];
    return rowsOf(record.machineId)
      .filter((row) => row.archived === archived)
      .map((row) => sessionView(machine, row, projects));
  });
  return {
    sessions,
    machines: machines.map((record) => {
      const state = states[record.machineId] ?? { state: "idle" };
      const refused = stateRefusal(record.name, state);
      return { machineId: record.machineId, name: record.name, state: state.state, fresh: catalog[record.machineId]?.source === "live", problem: refused ? { code: refused.code, message: refused.message } : null };
    }),
  };
}

/** One idempotency id per `--idempotency-key`, for this run of the app: a retry is the same create. */
const createIds = new Map<string, string>();
const KEPT_IDS = 500;

async function sessionsCreate(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  const project = pickProject(machine, await projectsOf(client), required(params, "project"));
  const prompt = required(params, "prompt");
  const prefs = getPrefs();
  const agent = text(params, "agent") ?? "claude";
  const explicitMode = typeof params.mode === "string";
  const mode = pickerMode(explicitMode ? (text(params, "mode") ?? "") : prefs.lastMode)?.id;
  if (explicitMode && !mode) throw invalid(`Unknown permission mode ${String(params.mode)}.`);
  const useWorktree = params.useWorktree !== false;
  const baseRef = text(params, "base");
  if (baseRef) needs(client, machine, "session-base/1", "starting a worktree from another branch");
  const request: MachineSessionRequest = {
    machineId: machine.machineId,
    projectId: project.projectId,
    agent,
    model: text(params, "model") ?? "",
    effort: text(params, "effort"),
    mode: mode ?? FIRST_RUN_PERMISSION_MODE,
    prompt,
    title: text(params, "title") ?? "",
    useWorktree,
    worktreeName: useWorktree ? text(params, "name") : null,
    baseRef: useWorktree ? baseRef : null,
    nativeCodex: params.nativeCodex === true || undefined,
  };
  const key = text(params, "idempotencyKey");
  const scoped = key ? `${machine.machineId}\0${key}` : null;
  let requestId = scoped ? createIds.get(scoped) : undefined;
  if (!requestId) {
    requestId = client.requestId();
    if (scoped) {
      createIds.set(scoped, requestId);
      if (createIds.size > KEPT_IDS) createIds.delete(createIds.keys().next().value!);
    }
  }
  let created;
  try {
    created = await createMachineSession(client, request, requestId, { select: false });
  } catch (error) {
    throw fromMachine(error);
  }
  return {
    created: "session",
    session: created.key,
    sessionId: created.sessionId,
    tabId: created.tabId,
    machine: { id: machine.machineId, name: machine.name },
    project: { key: machineProjectKey(machine.machineId, project.projectId), name: project.name },
    startError: created.startError,
  };
}

/** A session on the machine and the tab a command acts on. */
interface Target {
  key: string;
  sessionId: string;
  tab: CloudAgentTab | null;
}

/** Sessions the machine lists now, when the catalog has not heard of one yet (one the CLI just made). */
async function listedSessions(client: WorkspaceRpcClient): Promise<RuntimeSession[]> {
  try {
    return await client.listSessions();
  } catch (error) {
    throw fromMachine(error);
  }
}

function matchOne<T>(candidates: T[], id: (value: T) => string, selector: string, what: string): T | null {
  const exact = candidates.filter((candidate) => id(candidate) === selector);
  if (exact.length === 1) return exact[0];
  const prefixed = selector.length >= 4 ? candidates.filter((candidate) => id(candidate).startsWith(selector)) : [];
  if (prefixed.length > 1) throw new MachineControlError("ambiguous_selector", `More than one ${what} starts with ${selector}.`, "Use the full id or the machine: key.");
  return prefixed[0] ?? null;
}

/**
 * A session by its `machine:` key, its id (or a unique start of it), or one
 * of its agent tabs' ids; then the tab `--tab` names, the one the target
 * named, the session's active one, or the one worked in last.
 */
async function resolveTarget(machine: Machine, client: WorkspaceRpcClient, selector: string, wantedTab: string | null): Promise<Target> {
  const scope = machineAgentScope(machine.machineId);
  const parsed = selector.startsWith("machine:") ? parseMachineKey(selector) : null;
  if (selector.startsWith("machine:") && !parsed?.sessionId) throw invalid(`${selector} is not a session's key: a session's is machine:<machine>:<project>:<session>.`);
  const wanted = parsed?.sessionId ?? selector;
  let sessions: { id: string; projectId: string | null; activeTab: string | null }[] = rowsOf(machine.machineId).map((row) => ({ id: row.sessionId, projectId: row.projectId, activeTab: row.activeTab }));
  let session = matchOne(sessions, (candidate) => candidate.id, wanted, "session");
  let tabs = getCloudAgents(scope).tabs.filter((tab) => !tab.placeholder);
  let namedTab = !session && !parsed ? matchOne(tabs, (tab) => tab.tabId, wanted, "tab") : null;
  if (!session && !namedTab) {
    sessions = (await listedSessions(client)).map((listed) => ({ id: listed.id, projectId: listed.projectId ?? null, activeTab: listed.activeTab ?? null }));
    await syncLiveTabs(scope, client).catch(() => undefined);
    tabs = getCloudAgents(scope).tabs.filter((tab) => !tab.placeholder);
    session = matchOne(sessions, (candidate) => candidate.id, wanted, "session");
    namedTab = !session && !parsed ? matchOne(tabs, (tab) => tab.tabId, wanted, "tab") : null;
  }
  if (namedTab) session = sessions.find((candidate) => candidate.id === namedTab!.info.sessionId) ?? { id: namedTab.info.sessionId, projectId: null, activeTab: null };
  if (!session) throw notFound(`${machine.name} has no session ${selector}.`, `List them with terminalx sessions list --machine "${machine.name}".`);
  const key = session.projectId ? machineSessionKey(machine.machineId, session.projectId, session.id) : selector;
  let own = tabs.filter((tab) => tab.info.sessionId === session!.id);
  if (!own.length) {
    await syncLiveTabs(scope, client).catch(() => undefined);
    own = getCloudAgents(scope).tabs.filter((tab) => !tab.placeholder && tab.info.sessionId === session!.id);
  }
  const tabId = wantedTab ?? namedTab?.tabId ?? null;
  if (tabId) {
    const tab = own.find((candidate) => candidate.tabId === tabId);
    if (!tab) throw notFound(`Session ${key} has no agent tab ${tabId}.`, `List its tabs with terminalx tabs list ${key}.`);
    return { key, sessionId: session.id, tab };
  }
  const active = own.find((candidate) => candidate.tabId === session!.activeTab);
  const latest = [...own].sort((a, b) => b.info.modified.localeCompare(a.info.modified))[0] ?? null;
  return { key, sessionId: session.id, tab: active ?? latest };
}

function requireTab(target: Target): CloudAgentTab {
  if (!target.tab) throw notFound(`Session ${target.key} has no agent tab.`);
  return target.tab;
}

async function sessionsRename(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  needs(client, machine, "session/2", "renaming a session");
  const target = await resolveTarget(machine, client, required(params, "session"), null);
  const title = required(params, "title");
  try {
    await client.updateSession(target.sessionId, { title });
  } catch (error) {
    throw fromMachine(error);
  }
  return { session: target.key, title };
}

async function sessionsArchive(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  needs(client, machine, "session/2", "archiving a session");
  const archived = params.archived === true;
  const named = Array.isArray(params.sessions) ? params.sessions.filter((value): value is string => typeof value === "string") : [];
  if (!named.length) throw invalid("Missing sessions.");
  // All are found before any changes, so a typo changes nothing.
  const targets = [];
  for (const selector of named) targets.push(await resolveTarget(machine, client, selector, null));
  const done: string[] = [];
  for (const target of targets) {
    try {
      if (target.key.startsWith("machine:")) await updateMachineSession(target.key, { archived });
      else await client.updateSession(target.sessionId, { archived });
    } catch (error) {
      const failed = fromMachine(error);
      const message = failed instanceof Error ? failed.message : String(failed);
      throw new MachineControlError(failed instanceof MachineControlError ? failed.code : "machine_error", `${message} (${done.length} of ${targets.length} ${archived ? "archived" : "unarchived"} before it: ${done.join(", ") || "none"}).`);
    }
    done.push(target.key);
  }
  return { sessions: done, archived };
}

async function tabsList(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  const target = await resolveTarget(machine, client, required(params, "session"), null);
  const tabs = getCloudAgents(machineAgentScope(machine.machineId)).tabs.filter((tab) => !tab.placeholder && tab.info.sessionId === target.sessionId);
  return {
    session: target.key,
    tabs: tabs.map((tab) => ({ id: tab.tabId, agent: tab.info.harness, title: tab.info.title, status: tab.info.status, model: tab.info.model, effort: tab.info.effort, mode: tab.info.permissionMode, pendingApprovals: tab.info.pendingPermissions.length, lastSeq: tab.info.lastSeq })),
  };
}

// ---- send, read, wait --------------------------------------------------------

/** `send --idempotency-key`: the answer a key already got, for this run of the app. */
const sent = new Map<string, Promise<unknown>>();
/** How far each tab's transcript was known when the CLI last sent to it: a status from before the message ends no wait. */
const lastSends = new Map<string, number>();
const sendKey = (machineId: string, tabId: string) => `${machineId}\0${tabId}`;

function send(params: Params): Promise<unknown> {
  const key = text(params, "idempotencyKey");
  if (!key) return sendOnce(params);
  const scoped = `${machineOf(params).machineId}\0${text(params, "target") ?? ""}\0${key}`;
  const earlier = sent.get(scoped);
  if (earlier) return earlier;
  const attempt = sendOnce(params);
  sent.set(scoped, attempt);
  if (sent.size > KEPT_IDS) sent.delete(sent.keys().next().value!);
  // A send that was refused may be asked for again with the same key.
  attempt.catch(() => sent.get(scoped) === attempt && sent.delete(scoped));
  return attempt;
}

async function sendOnce(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  const message = required(params, "text");
  const target = await resolveTarget(machine, client, required(params, "target"), text(params, "tab"));
  const tab = requireTab(target);
  const scope = machineAgentScope(machine.machineId);
  const knew = Math.max(tab.info.lastSeq, lastSeq(target.sessionId, tab.tabId));
  try {
    await sendToCloudAgent(scope, tab.tabId, message, client);
  } catch (error) {
    throw fromMachine(error);
  }
  lastSends.delete(sendKey(machine.machineId, tab.tabId));
  lastSends.set(sendKey(machine.machineId, tab.tabId), knew);
  if (lastSends.size > KEPT_IDS) lastSends.delete(lastSends.keys().next().value!);
  // Live: the machine took it (typed now, or queued behind the running turn there).
  return { session: target.key, tabId: tab.tabId, state: "applied" };
}

/**
 * Stream the tab from the machine for as long as `work` runs: its replay
 * fills the transcript held here first. A tab this window already streams
 * (it is on screen) is read as it is.
 */
async function following<T>(machine: Machine, client: WorkspaceRpcClient, tab: CloudAgentTab, work: () => Promise<T>): Promise<T> {
  const scope = machineAgentScope(machine.machineId);
  const current = getCloudAgents(scope).tabs.find((candidate) => candidate.tabId === tab.tabId);
  if (current?.live) return work();
  let stop: () => void;
  try {
    stop = await attachCloudAgentTab(scope, tab.tabId, client);
  } catch (error) {
    throw fromMachine(error);
  }
  try {
    return await work();
  } finally {
    stop();
  }
}

async function read(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  const target = await resolveTarget(machine, client, required(params, "target"), text(params, "tab"));
  const tab = requireTab(target);
  return following(machine, client, tab, async () => {
    let events = getTabLog(target.sessionId, tab.tabId).events.filter((event) => event.payload.type !== "delta");
    const since = typeof params.since === "number" ? params.since : null;
    const tail = typeof params.tail === "number" ? params.tail : null;
    if (since !== null) events = events.filter((event) => event.seq > since);
    if (tail !== null) events = events.slice(Math.max(0, events.length - tail));
    const current = getCloudAgents(machineAgentScope(machine.machineId)).tabs.find((candidate) => candidate.tabId === tab.tabId) ?? tab;
    return { session: target.key, tabId: tab.tabId, status: current.info.status, events };
  });
}

/** While following, the machine's own events say when the tab settles; this only re-reads them. */
const WAIT_POLL_MS = 1_000;
/** One call waits at most this long; the CLI asks again until its own timeout. */
export const WAIT_CHUNK_SECONDS = 30;

/** Until the tab needs someone or its turn ends, within one short call. */
export async function waitForMachineTab(params: Params, sleep: Sleep = pause, now: () => number = Date.now) {
  const machine = machineOf(params);
  const client = await connectedClient(machine, sleep, now);
  const seconds = typeof params.timeoutSeconds === "number" ? Math.min(Math.max(params.timeoutSeconds, 0), WAIT_CHUNK_SECONDS) : WAIT_CHUNK_SECONDS;
  const deadline = now() + seconds * 1000;
  const target = await resolveTarget(machine, client, required(params, "target"), text(params, "tab"));
  const tab = requireTab(target);
  const scope = machineAgentScope(machine.machineId);
  return following(machine, client, tab, async () => {
    for (;;) {
      if (client.connection.state !== "connected") {
        throw new MachineControlError("machine_offline", `${machine.name} went away during the wait.`, TRY_AGAIN(machine.name));
      }
      const current = getCloudAgents(scope).tabs.find((candidate) => candidate.tabId === tab.tabId) ?? tab;
      const events = getTabLog(target.sessionId, tab.tabId).events;
      const sentAt = lastSends.get(sendKey(machine.machineId, tab.tabId));
      // A message the CLI sent that the machine has not written down yet: its turn has not begun.
      const onItsWay = sentAt !== undefined && current.info.lastSeq <= sentAt;
      const settled = settledReason(current.info, events, onItsWay);
      if (settled) return { session: target.key, tabId: tab.tabId, ...settled, status: current.info.status };
      if (now() >= deadline) return { session: target.key, tabId: tab.tabId, reason: "timeout", status: current.info.status };
      await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - now())));
    }
  });
}

// ---- permissions -------------------------------------------------------------

interface PermissionOption {
  id: string;
  label?: string;
  kind?: string;
}

function optionsOf(options: unknown[]): PermissionOption[] {
  return options.filter((option): option is PermissionOption => !!option && typeof option === "object" && typeof (option as PermissionOption).id === "string");
}

function pendingOf(machineId: string) {
  return getCloudAgents(machineAgentScope(machineId)).tabs.flatMap((tab) =>
    tab.info.pendingPermissions.map((permission) => ({ tab, permission })),
  );
}

async function permissionsList(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  await syncLiveTabs(machineAgentScope(machine.machineId), client).catch(() => undefined);
  const rows = rowsOf(machine.machineId);
  return {
    machine: { id: machine.machineId, name: machine.name },
    permissions: pendingOf(machine.machineId).map(({ tab, permission }) => {
      const row = rows.find((candidate) => candidate.sessionId === tab.info.sessionId);
      return {
        requestId: permission.requestId,
        session: row?.key ?? tab.info.sessionId,
        tabId: tab.tabId,
        toolName: permission.toolName,
        input: permission.input,
        options: optionsOf(permission.options),
      };
    }),
  };
}

async function decide(params: Params, allow: boolean) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  needs(client, machine, "agent-commands/1", "answering a permission request");
  const scope = machineAgentScope(machine.machineId);
  await syncLiveTabs(scope, client).catch(() => undefined);
  const selector = required(params, "request");
  const found = matchOne(pendingOf(machine.machineId), (pending) => pending.permission.requestId, selector, "permission request");
  if (!found) throw new MachineControlError("request_lapsed", `${machine.name} holds no permission request ${selector}.`, `Refresh with terminalx permissions list --machine "${machine.name}" and use a current request id.`);
  const options = optionsOf(found.permission.options);
  const asked = text(params, "option");
  const option = allow
    ? asked
      ? options.find((candidate) => candidate.id === asked)
      : (options.find((candidate) => candidate.kind === "allow_once") ?? options.find((candidate) => candidate.kind !== "deny"))
    : (options.find((candidate) => candidate.kind === "deny") ?? options.find((candidate) => candidate.id === "deny"));
  if (!option) {
    const ids = options.map((candidate) => candidate.id).join(", ") || "none";
    throw invalid(asked ? `Request ${found.permission.requestId} has no option ${asked}; its options are ${ids}.` : `Request ${found.permission.requestId} has no ${allow ? "allow" : "deny"} option; its options are ${ids}.`);
  }
  try {
    await decideCloudAgent(scope, found.tab.tabId, { requestId: found.permission.requestId, optionId: option.id }, client);
  } catch (error) {
    throw fromMachine(error);
  }
  const row = rowsOf(machine.machineId).find((candidate) => candidate.sessionId === found.tab.info.sessionId);
  return { session: row?.key ?? found.tab.info.sessionId, tabId: found.tab.tabId, requestId: found.permission.requestId, decision: option.id };
}

// ---- worktrees ---------------------------------------------------------------

/** The machine's projects with the clean-up's view of their worktrees, matched to `machine.projects` by path. */
async function scan(machine: Machine, client: WorkspaceRpcClient, asked: string | null): Promise<{ project: MachineProject | null; scanned: CleanupProject }[]> {
  needs(client, machine, "cleanup/1", "listing and removing worktrees");
  const projects = await projectsOf(client);
  const only = asked ? pickProject(machine, projects, asked) : null;
  let scanned: CleanupProject[];
  try {
    scanned = await client.scanCleanup();
  } catch (error) {
    throw fromMachine(error);
  }
  const trim = (path: string) => path.replace(/\/+$/, "");
  return scanned
    .map((entry) => ({ project: projects.find((project) => trim(project.path) === trim(entry.path)) ?? null, scanned: entry }))
    .filter((entry) => !only || entry.project?.projectId === only.projectId);
}

function worktreeView(machine: Machine, candidate: CleanupCandidate) {
  const rows = rowsOf(machine.machineId);
  return {
    name: candidate.name,
    // The machine's own path: display only.
    path: candidate.path,
    branch: candidate.branch,
    managed: candidate.managed,
    verdict: candidate.verdict,
    reason: candidate.reason,
    lastActivity: candidate.lastActivity,
    sessions: candidate.sessions.map((session) => {
      const id = (session as { id?: string; sessionId?: string }).id ?? (session as { sessionId?: string }).sessionId ?? "";
      return { ...session, key: rows.find((row) => row.sessionId === id)?.key ?? null };
    }),
  };
}

async function worktreesList(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  const projects = await scan(machine, client, text(params, "project"));
  return {
    machine: { id: machine.machineId, name: machine.name },
    projects: projects.map(({ project, scanned }) => ({
      key: project ? machineProjectKey(machine.machineId, project.projectId) : null,
      name: project?.name ?? scanned.name,
      path: scanned.path,
      note: scanned.note,
      worktrees: scanned.candidates.map((candidate) => worktreeView(machine, candidate)),
    })),
  };
}

async function worktreesDelete(params: Params) {
  const machine = machineOf(params);
  const client = await connectedClient(machine);
  const wanted = required(params, "worktree");
  const found = (await scan(machine, client, text(params, "project"))).flatMap(({ scanned }) => scanned.candidates.filter((candidate) => candidate.name === wanted || candidate.path === wanted));
  if (!found.length) throw notFound(`${machine.name} has no worktree ${wanted} that can be removed.`, `List them with terminalx worktrees list --machine "${machine.name}".`);
  if (found.length > 1) throw new MachineControlError("ambiguous_selector", `More than one project on ${machine.name} has a worktree ${wanted}.`, "Name its project with --project.");
  const candidate = found[0];
  const view = worktreeView(machine, candidate);
  const expected = Array.isArray(params.sessions) ? params.sessions.filter((value): value is string => typeof value === "string") : null;
  if (expected) {
    const held = view.sessions.map((session) => [session.key, (session as { id?: string }).id].filter(Boolean) as string[]);
    const named = new Set(expected);
    const matches = held.length === expected.length && held.every((ids) => ids.some((id) => named.has(id)));
    if (!matches) throw new MachineControlError("sessions_changed", `The worktree ${candidate.name} holds other sessions than --sessions names.`, "List it again and pass the sessions it holds now.");
  }
  const safe = candidate.verdict === "eligible";
  // A preview is shown whatever the verdict: it is what --force is decided on.
  if (params.dryRun === true) return { dryRun: true, worktree: view, wouldRemove: safe || params.force === true };
  if (!safe && params.force !== true) {
    throw new MachineControlError("worktree_not_safe", `${machine.name} would not remove ${candidate.name}: ${candidate.reason ?? candidate.verdict}.`, "Pass --force only when what it holds may be lost.");
  }
  if (params.confirmed !== true) throw new MachineControlError("confirmation_required", `Deleting ${candidate.name} on ${machine.name} removes its folder and the sessions in it.`, "Pass --yes to delete it.");
  let results;
  try {
    results = await client.removeCleanup([{ projectPath: candidate.projectPath, path: candidate.path, token: candidate.token, deleteSessions: true, acceptIgnored: params.force === true }]);
  } catch (error) {
    throw fromMachine(error);
  }
  const result = results[0];
  if (!result || result.outcome === "failed" || result.outcome === "skipped") {
    throw new MachineControlError("worktree_not_removed", `${machine.name} did not remove ${candidate.name}: ${result?.reason ?? "no answer"}.`);
  }
  return { worktree: view, outcome: result.outcome, freedBytes: result.freedBytes, keptBranch: result.keptBranch, sessionsDeleted: result.sessionsDeleted, sessionsKept: result.sessionsKept };
}

// ---- dispatch ----------------------------------------------------------------

/** Run one `machine.*` command. Throws `MachineControlError` for a refusal. */
export async function handleMachineControl(action: string, params: Params = {}): Promise<unknown> {
  switch (action) {
    case "projects.list":
      return projectsList(params);
    case "sessions.list":
      return sessionsList(params);
    case "sessions.listAll":
      return sessionsListAll(params);
    case "sessions.create":
      return sessionsCreate(params);
    case "sessions.rename":
      return sessionsRename(params);
    case "sessions.archive":
      return sessionsArchive(params);
    case "tabs.list":
      return tabsList(params);
    case "send":
      return send(params);
    case "read":
      return read(params);
    case "wait":
      return waitForMachineTab(params);
    case "permissions.list":
      return permissionsList(params);
    case "permissions.allow":
      return decide(params, true);
    case "permissions.deny":
      return decide(params, false);
    case "worktrees.list":
      return worktreesList(params);
    case "worktrees.delete":
      return worktreesDelete(params);
    default:
      throw new MachineControlError("unsupported", `This TerminalX does not know the machine command ${action}.`, "Update TerminalX.");
  }
}

/** What goes back over the socket: the result, or the refusal in the CLI's own error shape. */
export async function answerMachineControl(action: string, params: Params): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string; recovery: string | null } }> {
  try {
    return { ok: true, result: await handleMachineControl(action, params ?? {}) };
  } catch (raw) {
    const error = fromMachine(raw);
    if (error instanceof MachineControlError) return { ok: false, error: { code: error.code, message: error.message, recovery: error.recovery } };
    return { ok: false, error: { code: "machine_error", message: error instanceof Error && error.message ? error.message : "The machine command failed.", recovery: null } };
  }
}

interface ControlRequest {
  id: string;
  action: string;
  params: Params;
}

let booted: Promise<void> | null = null;
export function bootMachineControl(): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen<ControlRequest>("machine_control_request", (event) => {
        const { id, action, params } = event.payload;
        void answerMachineControl(action, params).then((result) => invoke("cloud_control_reply", { id, result }).catch(() => undefined));
      });
    } catch {
      /* outside a webview */
    }
  })());
}
