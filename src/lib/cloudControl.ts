import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, type CloudWorkspaceListItem } from "@/lib/api";
import { getAccount } from "@/lib/account";
import { getTabLog } from "@/lib/agentEvents";
import { getCloudAgents, loadCloudAgents, refreshFromCheckpoint, type CloudAgentTab } from "@/lib/cloudAgents";
import {
  applyCloudSnapshot,
  cloudOrgArg,
  cloudOrganizations,
  findCloudWorkspace,
  getCloudCatalog,
  liveCloudOrgIds,
  placeCloudProjects,
  refreshCloudCatalog,
  resumeCloudWorkspace,
} from "@/lib/cloudCatalog";
import { LIFECYCLE_ADMIN_REASON, NEW_SESSION_ADMIN_REASON, NOT_SHARED_REASON, effectiveYou, getCollab, listedYou, tabGate, workspaceAuthority } from "@/lib/cloudCollab";
import { cloudConnectionInfo, connectedCloudClient, retainCloudConnection, wakeCloudConnection, type CloudLease } from "@/lib/cloudConnections";
import { getCloudDashboard, type CloudDashboardSession } from "@/lib/cloudDashboard";
import { archiving, deletion, isArchived, lifecycleErrorMessage, stopping } from "@/lib/cloudLifecycle";
import { confirmCloudCreate, planCloudStart, prepareCloudCreate, startInWorkspace, type CloudSessionRequest } from "@/lib/cloudNewSession";
import { personName } from "@/lib/cloudPeople";
import { deriveCloudActivity } from "@/lib/cloudRowState";
import { mayStartCloudSessions } from "@/lib/multiOrg";
import { getPrefs } from "@/lib/prefs";
import { cloudAsleep, cloudSessionBackend } from "@/lib/sessionBackend";
import { cloudWorkspaceKey, isCloudKey, parseCloudWorkspaceKey, type CloudProject } from "@/types/target";
import type { WorkspaceConnectionState, WorkspaceYou } from "@terminalx/portable/workspace";

/**
 * Cloud workspaces for the `terminalx` CLI (PRO-40). The control socket
 * hands a `cloud.*` command to this window (`cloud_control_request`), and the
 * answer goes back with `cloud_control_reply`.
 *
 * Every command runs through what the app itself uses, so the CLI can do
 * exactly what the signed-in person can do in the window and nothing more:
 *
 * - Lists come from the catalog and this desktop's caches. Nothing attaches,
 *   resumes or wakes: looking never costs money.
 * - `read` shows the transcript kept here, caught up from the encrypted
 *   checkpoint. It never wakes a stopped workspace.
 * - `send` goes through the same session backend as the composer
 *   (`cloudSessionBackend`): the same role and lease rules, the mailbox, and
 *   one wake of a stopped workspace, because sending is the explicit action.
 * - `sessions.create` follows the new-session form: a running workspace takes
 *   the session; a stopped one is only woken with `wake`, and a new machine is
 *   only created with `confirmSpend`.
 * - `stop` and `resume` are the workspace menu's: offered to owners and
 *   admins only, and the server enforces the same.
 */

export const CLOUD_CONTROL_VERSION = 1;

/**
 * Who is on the other end of the socket. The control socket is opened with
 * the app's launch token, and every agent tab the app starts is given that
 * token, so a `cloud.*` command may come from an agent and not from the
 * person. Across every organization they belong to it could list workspaces,
 * read transcripts kept here, send (which resumes and bills a stopped
 * workspace), stop, resume, and create a machine. The flags the CLI asks for
 * (`--yes`, `--wake`, `--confirm-spend`) are passed by that same caller, so
 * they are no check on it.
 *
 * Two answers to that are built, and they compose. This one constant
 * chooses what ships (the owner's decision, PRO-40):
 *
 * - `"both"` (what ships; the owner's decision of 2026-10-04): every
 *   cloud command is refused until the person turns on "Let agents in local
 *   sessions control cloud workspaces" in Settings (off by default), AND
 *   with it on, each command that would start billed compute or stop a
 *   workspace still asks the person in the window first.
 * - `"setting"`: the setting alone. Once on, the commands run as asked.
 * - `"confirm"`: the question in the window alone, with no setting.
 */
export type CloudControlPolicy = "both" | "setting" | "confirm";
export const CLOUD_CONTROL_POLICY: CloudControlPolicy = "both";
let policy: CloudControlPolicy = CLOUD_CONTROL_POLICY;
/** For tests: run under another option. */
export function setCloudControlPolicy(next: CloudControlPolicy = CLOUD_CONTROL_POLICY) {
  policy = next;
}

/** Whether the shipped policy has the Settings switch. */
export const CLOUD_CONTROL_HAS_SETTING = (CLOUD_CONTROL_POLICY as CloudControlPolicy) !== "confirm";

export const CLOUD_CONTROL_SETTING = "Let agents in local sessions control cloud workspaces";

/** With the setting: nothing of the cloud is reachable from the command line until the person allows it. */
function allowed(): boolean {
  return policy === "confirm" || getPrefs().cloudControlFromAgents === true;
}

function assertAllowed() {
  if (!allowed()) {
    throw new CloudControlError("cloud_control_disabled", "Cloud workspaces cannot be used from the command line until that is turned on in TerminalX.", `In TerminalX, open Settings and turn on "${CLOUD_CONTROL_SETTING}".`);
  }
}

/**
 * Ask the person, in the window, before something that starts billed
 * compute or stops a workspace. The question says it came from the command
 * line. Having turned the setting on is not an answer to it: the setting
 * lets agents ask, the person still decides each time. Only under
 * `"setting"` alone is nothing asked.
 */
async function confirmInWindow(what: string, okLabel: string): Promise<void> {
  if (policy === "setting") return;
  const yes = await ask(`A terminalx command (run by you or by an agent in a local session) asks to ${what}`, { title: "Cloud workspace request", kind: "warning", okLabel, cancelLabel: "Refuse" }).catch(() => false);
  if (!yes) throw new CloudControlError("declined", "The request was refused in the TerminalX window.");
}
export const CLOUD_CONTROL_CAPABILITIES = ["projects.list", "sessions.list", "sessions.create", "send", "read", "wait", "stop", "resume"] as const;

/** A refusal the CLI prints as `code: message`, with what to do about it. */
export class CloudControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery: string | null = null,
  ) {
    super(message);
    this.name = "CloudControlError";
  }
}

const invalid = (message: string) => new CloudControlError("invalid_arguments", message, "Run terminalx --help and correct the named argument.");
const notFound = (message: string, recovery: string | null = null) => new CloudControlError("not_found", message, recovery);
const forbidden = (message: string) => new CloudControlError("forbidden", message);

type Params = Record<string, unknown>;

function text(params: Params, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function required(params: Params, key: string): string {
  const value = text(params, key);
  if (!value) throw invalid(`Missing ${key}.`);
  return value;
}

function signedIn() {
  const { status } = getAccount();
  if (status.state !== "signed-in") throw new CloudControlError("account_signed_out", "Sign in to TerminalX to use cloud workspaces.", "Open TerminalX and sign in.");
  return status;
}

/** The live organizations, or the one named (by id or name). */
function organizations(named: string | null) {
  const status = signedIn();
  const live = new Set(liveCloudOrgIds(status));
  const orgs = cloudOrganizations(status).filter((org) => live.has(org.id));
  if (!named) return orgs;
  const wanted = orgs.filter((org) => org.id === named || org.name.toLowerCase() === named.toLowerCase());
  // Not a member, no cloud there, or not reachable from this desktop: all read the same.
  if (!wanted.length) throw notFound(`No cloud organization ${named}.`, "List them with terminalx cloud status.");
  return wanted;
}

function projectsOf(orgId: string): CloudProject[] {
  const catalog = getCloudCatalog();
  const prefs = getPrefs();
  return placeCloudProjects(catalog.orgs[orgId] ?? { orgId, workspaces: [], repositories: null }, catalog.createMemory, {
    pinned: prefs.cloudPinned[orgId],
    added: prefs.cloudProjects[orgId],
    blank: prefs.cloudBlankProjects[orgId],
  }).projects;
}

function workspaceView(item: CloudWorkspaceListItem) {
  const { workspace } = item;
  return {
    key: cloudWorkspaceKey(workspace.orgId, workspace.id),
    id: workspace.id,
    name: workspace.name,
    state: workspace.state,
    // The words the sidebar shows for it.
    status: deriveCloudActivity(item).label,
    branch: workspace.launch?.workBranch ?? null,
    accessMode: workspace.accessMode,
    role: workspace.you?.role ?? null,
    authority: workspace.authority ?? null,
  };
}

function status() {
  // Off: say so, and nothing about the account or its organizations.
  if (!allowed()) return { version: CLOUD_CONTROL_VERSION, policy, enabled: false, capabilities: [] as string[], organizations: [] as never[], enable: `In TerminalX, open Settings and turn on "${CLOUD_CONTROL_SETTING}".` };
  const account = signedIn();
  const live = new Set(liveCloudOrgIds(account));
  return {
    version: CLOUD_CONTROL_VERSION,
    // Which of the two answers this app ships, and whether cloud commands run at all.
    policy,
    enabled: true,
    capabilities: [...CLOUD_CONTROL_CAPABILITIES],
    organizations: cloudOrganizations(account).map((org) => ({ id: org.id, name: org.name, role: org.role, live: live.has(org.id), mayStartSessions: mayStartCloudSessions(account, org.id) === true })),
  };
}

function projectsList(params: Params) {
  const account = signedIn();
  const projects = organizations(text(params, "org")).flatMap((org) =>
    projectsOf(org.id).map((project) => ({
      key: project.key,
      orgId: org.id,
      orgName: org.name,
      name: project.fullName,
      repository: project.blank ? null : project.identity,
      accessible: project.selected,
      mayStartSessions: mayStartCloudSessions(account, org.id) === true && project.selected,
      workspaces: project.workspaces.map((node) => workspaceView(node.item)),
    })),
  );
  return { projects };
}

function sessionView(session: CloudDashboardSession) {
  return {
    key: session.key,
    title: session.title,
    orgId: session.orgId,
    orgName: session.orgName,
    projectKey: session.projectKey,
    projectName: session.projectName,
    workspaceKey: cloudWorkspaceKey(session.orgId, session.workspaceId),
    workspaceName: session.workspaceName,
    branch: session.branch ?? null,
    modified: session.modified,
    stopped: session.stopped,
    connected: session.connected,
    // False: only what this desktop saved earlier is known of it.
    fresh: session.fresh,
    tabs: session.tabs.map((tab) => ({ id: tab.tabId, agent: tab.harness, title: tab.title, status: tab.status })),
  };
}

async function sessionsList(params: Params) {
  const orgs = new Set(organizations(text(params, "org")).map((org) => org.id));
  const project = text(params, "project");
  if (project && !isCloudKey(project)) throw invalid("--project must be a cloud project key (cloud:<org>:<repository>), as terminalx projects list --cloud prints it.");
  // The same projection the Agent Dashboard and the palette read; it settles a microtask after it is first asked for.
  getCloudDashboard();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const sessions = getCloudDashboard()
    .filter((session) => orgs.has(session.orgId) && (!project || session.projectKey === project))
    .map(sessionView);
  // Titles and tabs are end-to-end encrypted: a workspace this desktop never opened has none to show until it is opened in the app.
  const known = new Set(sessions.map((session) => session.workspaceKey));
  const notLoaded = [...orgs].flatMap((orgId) =>
    projectsOf(orgId)
      .filter((candidate) => !project || candidate.key === project)
      .flatMap((candidate) => candidate.workspaces.filter((node) => !known.has(node.key) && node.item.workspace.you?.role !== "none").map((node) => ({ key: node.key, name: node.item.workspace.name, projectKey: candidate.key }))),
  );
  return { sessions, workspacesNotLoaded: notLoaded };
}

interface Target {
  key: string;
  orgId: string;
  workspaceId: string;
  sessionId: string;
  workspaceKey: string;
  item: CloudWorkspaceListItem;
}

/** A session by its key. One of a workspace this person cannot see reads exactly like one that does not exist. */
function resolveSession(selector: string): Target {
  signedIn();
  const parsed = parseCloudWorkspaceKey(selector);
  if (!parsed?.sessionId) throw invalid("A cloud session is named by its key (cloud:<org>:<workspace>:<session>), as terminalx sessions list --cloud prints it.");
  if (!liveCloudOrgIds(getAccount().status).includes(parsed.orgId)) throw notFound(`No cloud session ${selector}.`);
  const item = findCloudWorkspace(getCloudCatalog(), parsed.orgId, parsed.workspaceId);
  if (!item) throw notFound(`No cloud session ${selector}.`, "List them with terminalx sessions list --cloud.");
  return { key: selector, orgId: parsed.orgId, workspaceId: parsed.workspaceId, sessionId: parsed.sessionId, workspaceKey: cloudWorkspaceKey(parsed.orgId, parsed.workspaceId), item };
}

function resolveWorkspace(selector: string): { orgId: string; workspaceId: string; key: string; item: CloudWorkspaceListItem } {
  signedIn();
  const parsed = parseCloudWorkspaceKey(selector);
  if (!parsed) throw invalid("A cloud workspace is named by its key (cloud:<org>:<workspace>), as terminalx projects list --cloud prints it.");
  const item = liveCloudOrgIds(getAccount().status).includes(parsed.orgId) ? findCloudWorkspace(getCloudCatalog(), parsed.orgId, parsed.workspaceId) : null;
  if (!item) throw notFound(`No cloud workspace ${selector}.`, "List them with terminalx projects list --cloud.");
  return { orgId: parsed.orgId, workspaceId: parsed.workspaceId, key: cloudWorkspaceKey(parsed.orgId, parsed.workspaceId), item };
}

/** Who this person is in the workspace: the runtime's word while connected, else the list's, else the last this desktop saw. */
function youIn(target: Target, state: WorkspaceConnectionState): WorkspaceYou | null {
  const collab = getCollab(target.workspaceKey);
  if (state.state === "connected") return effectiveYou(state, collab);
  return listedYou(target.item.workspace.you) ?? collab.lastYou;
}

/** The session's agent tabs this desktop knows, from its cache (a disk read, never a connection). */
async function tabsOf(target: Target): Promise<CloudAgentTab[]> {
  const scope = { organizationId: target.orgId, workspaceId: target.workspaceId };
  await loadCloudAgents(scope);
  return getCloudAgents(scope).tabs.filter((tab) => tab.info.sessionId === target.sessionId);
}

async function resolveTab(target: Target, wanted: string | null): Promise<CloudAgentTab> {
  const tabs = await tabsOf(target);
  if (wanted) {
    const tab = tabs.find((candidate) => candidate.tabId === wanted);
    if (!tab) throw notFound(`Session ${target.key} has no tab ${wanted}.`, "List its tabs with terminalx sessions list --cloud --json.");
    return tab;
  }
  if (!tabs.length) throw notFound(`Nothing of session ${target.key} is on this desktop yet.`, "Open the session once in TerminalX to load it.");
  // The tab worked in last.
  return [...tabs].sort((a, b) => b.info.modified.localeCompare(a.info.modified))[0];
}

/** Reading needs a role, as in the app: someone the workspace is not shared with is shown nothing of it. */
function assertReadable(you: WorkspaceYou | null) {
  if (you?.role === "none" && you.listed !== false) throw forbidden(NOT_SHARED_REASON);
}

/** `send --idempotency-key`: the answer a key already got, for this run of the app. A retry gets it instead of sending again. */
const sent = new Map<string, Promise<unknown>>();
const SENT_KEYS = 500;

function send(params: Params): Promise<unknown> {
  const key = text(params, "idempotencyKey");
  if (!key) return sendOnce(params);
  const scoped = `${text(params, "target") ?? ""}\0${key}`;
  const earlier = sent.get(scoped);
  if (earlier) return earlier;
  const attempt = sendOnce(params);
  sent.set(scoped, attempt);
  if (sent.size > SENT_KEYS) sent.delete(sent.keys().next().value!);
  // A send that was refused may be asked for again with the same key.
  attempt.catch(() => sent.get(scoped) === attempt && sent.delete(scoped));
  return attempt;
}

async function sendOnce(params: Params) {
  const target = resolveSession(required(params, "target"));
  const message = required(params, "text");
  const tab = await resolveTab(target, text(params, "tab"));
  const scope = { organizationId: target.orgId, workspaceId: target.workspaceId };
  const client = connectedCloudClient(target.workspaceKey);
  const state: WorkspaceConnectionState = client ? client.connection : { state: "idle" };
  const you = youIn(target, state);
  const info = cloudConnectionInfo(target.workspaceKey);
  // The composer's backend: the same refusals, the mailbox, and one wake of a stopped workspace.
  const backend = cloudSessionBackend({
    key: target.key,
    workspaceKey: target.workspaceKey,
    scope,
    sessionId: target.sessionId,
    state,
    client,
    workspaceState: target.item.workspace.state,
    authority: (state.state === "connected" ? state.authority : null) ?? info.authority ?? target.item.workspace.authority ?? null,
    outbox: getCloudAgents(scope).outbox,
    followUps: () => [],
    wake: async () => {
      const lease = await wakeCloudConnection({ orgId: target.orgId, workspaceId: target.workspaceId });
      lease.release();
    },
    you,
  });
  if (backend.readOnlyReason) throw forbidden(backend.readOnlyReason);
  // The composer is closed while someone else drives the tab. As there, a lease is the live runtime's word only.
  const collab = getCollab(target.workspaceKey);
  const lease = client && collab.available && you ? (collab.leases[tab.tabId] ?? null) : null;
  const gate = tabGate(you, lease, Date.now(), tab.info.status === "in_progress" || tab.info.status === "waiting", personName);
  if (gate.blocked) throw forbidden(gate.blocked);
  // The message resumes a stopped workspace, which starts billing its compute.
  if (cloudAsleep(state, target.item.workspace.state)) await confirmInWindow(`send a message to the stopped cloud workspace ${target.item.workspace.name}. Sending resumes it, which starts billing its compute.`, "Resume and send");
  const before = new Set(getCloudAgents(scope).outbox.map((entry) => entry.clientCommandId));
  await backend.send(tab.tabId, message, []);
  const entry = getCloudAgents(scope).outbox.find((candidate) => !before.has(candidate.clientCommandId) && candidate.tabId === tab.tabId);
  return {
    session: target.key,
    tabId: tab.tabId,
    commandId: entry?.clientCommandId ?? null,
    // queued: the workspace takes it when its runtime is up (a stopped one is resumed for it).
    state: entry?.state ?? "queued",
    wake: entry?.wake ?? null,
  };
}

async function read(params: Params) {
  const target = resolveSession(required(params, "target"));
  const client = connectedCloudClient(target.workspaceKey);
  assertReadable(youIn(target, client ? client.connection : { state: "idle" }));
  const tab = await resolveTab(target, text(params, "tab"));
  const scope = { organizationId: target.orgId, workspaceId: target.workspaceId };
  // The encrypted checkpoint, when it is newer than what is kept here: a read of the API, never a wake.
  await refreshFromCheckpoint(scope, tab.tabId).catch(() => undefined);
  let events = getTabLog(target.sessionId, tab.tabId).events.filter((event) => event.payload.type !== "delta");
  const since = typeof params.since === "number" ? params.since : null;
  const tail = typeof params.tail === "number" ? params.tail : null;
  if (since !== null) events = events.filter((event) => event.seq > since);
  if (tail !== null) events = events.slice(Math.max(0, events.length - tail));
  const current = getCloudAgents(scope).tabs.find((candidate) => candidate.tabId === tab.tabId) ?? tab;
  return { session: target.key, tabId: tab.tabId, status: current.info.status, source: current.source, events };
}

/** While connected the runtime's own events say when the tab settles; this only re-reads them. */
const WAIT_LIVE_MS = 1_000;
/** Not connected (a stopped workspace): the saved checkpoint is asked for, at a gentle pace. */
const WAIT_CHECKPOINT_MS = 5_000;
/**
 * One call waits at most this long. The CLI asks again until its own timeout,
 * so a caller that goes away (Ctrl-C, a killed agent) leaves at most one
 * short wait, and its connection lease, behind in the window.
 */
export const WAIT_CHUNK_SECONDS = 30;

function settledReason(tab: CloudAgentTab, pending: boolean): "permission" | "stop" | "stopped" | null {
  if (tab.info.status === "waiting" || tab.info.pendingPermissions.length > 0) return "permission";
  // A message still on its way is work to wait for.
  if (pending) return null;
  if (tab.info.status === "completed") return "stop";
  if (tab.info.status === "idle") return "stopped";
  return null;
}

const OUTBOX_PENDING = new Set(["unsent", "queued", "leased"]);

/** Until the tab needs someone or its turn ends. It follows the runtime while it runs and never wakes a stopped one. */
async function wait(params: Params, sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => number = Date.now) {
  const target = resolveSession(required(params, "target"));
  const first = connectedCloudClient(target.workspaceKey);
  assertReadable(youIn(target, first ? first.connection : { state: "idle" }));
  const tab = await resolveTab(target, text(params, "tab"));
  const scope = { organizationId: target.orgId, workspaceId: target.workspaceId };
  const seconds = typeof params.timeoutSeconds === "number" ? Math.min(Math.max(params.timeoutSeconds, 0), WAIT_CHUNK_SECONDS) : WAIT_CHUNK_SECONDS;
  const deadline = now() + seconds * 1000;
  // A running workspace is followed live; `connect` attaches and never resumes.
  let lease: CloudLease | null = null;
  if (target.item.workspace.state === "ready") lease = await retainCloudConnection({ orgId: target.orgId, workspaceId: target.workspaceId }, "connect").catch(() => null);
  try {
    for (;;) {
      const live = !!connectedCloudClient(target.workspaceKey);
      // Connected, the runtime feeds the tab; only otherwise is the checkpoint read.
      if (!live) await refreshFromCheckpoint(scope, tab.tabId).catch(() => undefined);
      const snapshot = getCloudAgents(scope);
      const current = snapshot.tabs.find((candidate) => candidate.tabId === tab.tabId) ?? tab;
      const pending = snapshot.outbox.some((entry) => entry.tabId === tab.tabId && OUTBOX_PENDING.has(entry.state));
      const reason = settledReason(current, pending);
      if (reason) return { session: target.key, tabId: tab.tabId, reason, status: current.info.status };
      if (now() >= deadline) return { session: target.key, tabId: tab.tabId, reason: "timeout", status: current.info.status };
      await sleep(Math.min(live ? WAIT_LIVE_MS : WAIT_CHECKPOINT_MS, Math.max(0, deadline - now())));
    }
  } finally {
    lease?.release();
  }
}

function resolveProject(selector: string): CloudProject {
  signedIn();
  if (!isCloudKey(selector)) throw invalid("--project must be a cloud project key (cloud:<org>:<repository>), as terminalx projects list --cloud prints it.");
  for (const orgId of liveCloudOrgIds(getAccount().status)) {
    const project = projectsOf(orgId).find((candidate) => candidate.key === selector);
    if (project) return project;
  }
  throw notFound(`No cloud project ${selector}.`, "List them with terminalx projects list --cloud.");
}

async function sessionsCreate(params: Params) {
  const project = resolveProject(required(params, "project"));
  const prompt = required(params, "prompt");
  // The same rule as the project's "+": creating, resuming and adding a session are an owner's or admin's.
  if (mayStartCloudSessions(getAccount().status, project.orgId) !== true) throw forbidden(NEW_SESSION_ADMIN_REASON);
  if (!project.selected) throw forbidden("This repository is no longer selected for cloud workspaces in its organization.");
  const prefs = getPrefs();
  const agent = text(params, "agent") ?? "claude";
  const request: CloudSessionRequest = {
    agent,
    model: text(params, "model") ?? prefs.lastModel[agent] ?? "",
    effort: text(params, "effort") ?? prefs.lastEffort[agent] ?? null,
    mode: text(params, "mode") ?? prefs.lastMode,
    prompt,
    useWorktree: params.useWorktree !== false,
  };
  const plan = planCloudStart(project);
  if (plan.kind === "reuse" || plan.kind === "wake") {
    const { workspace } = plan.node.item;
    // Waiting on a machine that is already starting costs nothing more; resuming a stopped one is said out loud.
    // One that is on its way down counts as stopped: connecting to it now would bring it back up.
    const down = workspace.state === "suspended" || stopping(plan.node.item);
    if (plan.kind === "wake" && down && params.wake !== true) {
      throw new CloudControlError("cloud_workspace_stopped", `The project's workspace ${workspace.name} is stopped. A new session there resumes it, which starts billing its compute.`, "Pass --wake to resume it for this session, or resume it first with terminalx cloud resume.");
    }
    const resumes = plan.kind === "wake" && down;
    if (resumes) await confirmInWindow(`start a session in the stopped cloud workspace ${workspace.name}. That resumes it, which starts billing its compute.`, "Resume and start");
    let woke = resumes;
    let key: string;
    try {
      // The CLI does not move the window's selection. The list can say running while the runtime has
      // stopped by itself: that too is only woken when the caller said --wake (and, under "confirm", the person agrees).
      key = await startInWorkspace(plan, request, {
        select: false,
        wakeIfStopped: async () => {
          if (params.wake !== true) return false;
          await confirmInWindow(`start a session in the cloud workspace ${workspace.name}, which has stopped. That resumes it, which starts billing its compute.`, "Resume and start");
          woke = true;
          return true;
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "cloud_workspace_stopped") {
        throw new CloudControlError("cloud_workspace_stopped", `The project's workspace ${workspace.name} has stopped. A new session there resumes it, which starts billing its compute.`, "Pass --wake to resume it for this session, or resume it first with terminalx cloud resume.");
      }
      throw error;
    }
    return { created: "session", session: key, workspace: plan.node.key, resumed: woke };
  }
  // No usable workspace: a new machine, which is always an explicit, priced step.
  const prepared = await prepareCloudCreate(project, request);
  const quote = { provider: prepared.providerLabel, currency: prepared.quote.currency, activeHourlyMicros: prepared.quote.activeHourlyMicros };
  if (params.confirmSpend !== true) {
    throw new CloudControlError(
      "spend_confirmation_required",
      `This project has no workspace to run in. A new one on ${prepared.providerLabel} would be created, and its compute is billed while it runs.`,
      "Pass --confirm-spend to create it.",
    );
  }
  await confirmInWindow(`create a new cloud workspace for ${project.fullName} on ${prepared.providerLabel}. Its compute is billed while it runs.`, "Create workspace");
  const idempotencyKey = text(params, "idempotencyKey");
  if (idempotencyKey) {
    prepared.pending.idempotencyKey = idempotencyKey;
    prepared.pending.request.idempotencyKey = idempotencyKey;
  }
  const snapshot = await confirmCloudCreate(prepared, { follow: false });
  return {
    created: "workspace",
    workspace: cloudWorkspaceKey(snapshot.workspace.orgId, snapshot.workspace.id),
    // The first session is the workspace's launch: it appears in sessions list once the runtime has started it.
    operationId: snapshot.operation.id,
    state: snapshot.workspace.state,
    quote,
  };
}

/** Stop, resume: the workspace menu's actions, for the people the menu offers them to. */
function assertLifecycle(item: CloudWorkspaceListItem) {
  if (!workspaceAuthority(item.workspace).lifecycle) throw forbidden(`${LIFECYCLE_ADMIN_REASON}.`);
  if (deletion(item)) throw new CloudControlError("cloud_workspace_deleting", "This workspace is being deleted.");
  if (archiving(item) || isArchived(item.workspace)) throw new CloudControlError("cloud_workspace_archived", "This workspace is archived.", "Unarchive it in TerminalX first.");
}

async function stop(params: Params) {
  const target = resolveWorkspace(required(params, "workspace"));
  assertLifecycle(target.item);
  if (target.item.workspace.state === "suspended") return { workspace: target.key, state: "suspended", changed: false };
  if (target.item.workspace.state !== "ready") throw new CloudControlError("cloud_workspace_not_running", `This workspace is ${deriveCloudActivity(target.item).label.toLowerCase()}; only a running one can be stopped.`);
  // The app asks before stopping: running agent turns end with the machine.
  if (params.confirmed !== true) throw new CloudControlError("confirmation_required", `Stopping ${target.item.workspace.name} ends any agent turn running in it. Everything is kept, and it can be resumed.`, "Pass --yes to stop it.");
  await confirmInWindow(`stop the cloud workspace ${target.item.workspace.name}. Any agent turn running in it ends.`, "Stop workspace");
  const requestedAt = Date.now();
  const snapshot = await api.cloudWorkspaceSuspend(target.workspaceId, cloudOrgArg(target.orgId));
  if (snapshot?.workspace) applyCloudSnapshot(snapshot, requestedAt);
  void refreshCloudCatalog(target.orgId);
  return { workspace: target.key, state: snapshot?.workspace.state ?? null, operationId: snapshot?.operation.id ?? null, changed: true };
}

async function resume(params: Params) {
  const target = resolveWorkspace(required(params, "workspace"));
  assertLifecycle(target.item);
  if (target.item.workspace.state === "ready") return { workspace: target.key, state: "ready", changed: false };
  if (target.item.workspace.state !== "suspended") throw new CloudControlError("cloud_workspace_not_stopped", `This workspace is ${deriveCloudActivity(target.item).label.toLowerCase()}; only a stopped one can be resumed.`);
  await confirmInWindow(`resume the cloud workspace ${target.item.workspace.name}, which starts billing its compute.`, "Resume workspace");
  // The one explicit wake: the same call as the menu's Resume.
  await resumeCloudWorkspace(target.item);
  void refreshCloudCatalog(target.orgId);
  const after = findCloudWorkspace(getCloudCatalog(), target.orgId, target.workspaceId);
  return { workspace: target.key, state: after?.workspace.state ?? null, operationId: after?.latestOperation?.id ?? null, changed: true };
}

/** Run one `cloud.*` control command. Throws `CloudControlError` for a refusal. */
export async function handleCloudControl(action: string, params: Params = {}): Promise<unknown> {
  if (action === "status") return status();
  assertAllowed();
  switch (action) {
    case "projects.list":
      return projectsList(params);
    case "sessions.list":
      return sessionsList(params);
    case "sessions.create":
      return sessionsCreate(params);
    case "send":
      return send(params);
    case "read":
      return read(params);
    case "wait":
      return wait(params);
    case "stop":
      return stop(params);
    case "resume":
      return resume(params);
    default:
      throw new CloudControlError("unsupported", `This TerminalX does not know the cloud command ${action}.`, "Update TerminalX, or see terminalx cloud status for what it supports.");
  }
}

/** For tests: `wait` with its clock and sleep replaced. */
export const waitForCloudTab = wait;

interface ControlRequest {
  id: string;
  action: string;
  params: Params;
}

/** What goes back over the socket: the result, or the refusal in the CLI's own error shape. */
export async function answerCloudControl(action: string, params: Params): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string; recovery: string | null } }> {
  try {
    return { ok: true, result: await handleCloudControl(action, params ?? {}) };
  } catch (error) {
    if (error instanceof CloudControlError) return { ok: false, error: { code: error.code, message: error.message, recovery: error.recovery } };
    // The API's and the runtime's own refusals keep their codes (a role, a limit, a network failure).
    const code = error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "cloud_error";
    // In words where the app has them (the running limit, a lost role, an unreachable service); the code stays for scripts.
    const said = error instanceof Error && error.message && error.message !== code ? error.message : null;
    return { ok: false, error: { code, message: said ?? (code === "cloud_error" ? "The cloud command failed." : lifecycleErrorMessage(code)), recovery: null } };
  }
}

let booted: Promise<void> | null = null;
export function bootCloudControl(): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen<ControlRequest>("cloud_control_request", (event) => {
        const { id, action, params } = event.payload;
        void answerCloudControl(action, params).then((result) => invoke("cloud_control_reply", { id, result }).catch(() => undefined));
      });
    } catch {
      /* outside a webview */
    }
  })());
}
