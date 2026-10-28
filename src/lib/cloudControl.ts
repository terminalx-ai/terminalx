import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, type CloudWorkspaceListItem } from "@/lib/api";
import { getAccount } from "@/lib/account";
import { getTabLog } from "@/lib/agentEvents";
import { WORKSPACE_STOPPED } from "@/lib/cloudAgentApi";
import { getCloudAgents, loadCloudAgents, refreshFromCheckpoint, relistCloudCheckpoints, syncLiveTabs, type CloudAgentTab } from "@/lib/cloudAgents";
import {
  applyCloudSnapshot,
  cloudOrgArg,
  cloudOrganizations,
  findCloudWorkspace,
  getCloudCatalog,
  liveCloudOrgIds,
  placeCloudProjects,
  refreshCloudCatalog,
  relistCloudCatalog,
  resumeCloudWorkspace,
} from "@/lib/cloudCatalog";
import { LIFECYCLE_ADMIN_REASON, NEW_SESSION_ADMIN_REASON, NOT_SHARED_REASON, effectiveYou, getCollab, listedYou, tabGate, workspaceAuthority } from "@/lib/cloudCollab";
import { cloudConnectionInfo, connectedCloudClient, retainCloudConnection, waitCloudConnected, wakeCloudConnection, type CloudLease } from "@/lib/cloudConnections";
import { failureMessage, PHASES, phaseOf, RUNTIME_NOT_PICKED_UP, runtimeNotPickedUp, settled } from "@/lib/cloudCreate";
import { getCloudDashboard, type CloudDashboardSession } from "@/lib/cloudDashboard";
import { archiving, deletion, isArchived, isOpen, lifecycleErrorMessage, machineRunning, resuming, stopping } from "@/lib/cloudLifecycle";
import { confirmCloudCreate, planCloudStart, prepareCloudCreate, startInWorkspace, type CloudIssueOutcome, type CloudSessionRequest } from "@/lib/cloudNewSession";
import { cloudPipelineSettings } from "@/lib/issuePipeline";
import { issueWorktreeName } from "@/lib/issueSession";
import { personName } from "@/lib/cloudPeople";
import { deriveCloudActivity } from "@/lib/cloudRowState";
import { mayStartCloudSessions } from "@/lib/multiOrg";
import { cloudControlNative } from "@/lib/cloudControlNative";
import { getPrefs } from "@/lib/prefs";
import { DEFAULT_PERMISSION_MODE, pickerMode } from "@/lib/models";
import { cloudAsleep, cloudSessionBackend } from "@/lib/sessionBackend";
import { cloudWorkspaceKey, isCloudKey, parseCloudWorkspaceKey, type CloudProject } from "@/types/target";
import type { RuntimeIssueRef, WorkspaceConnectionState, WorkspaceYou } from "@terminalx/portable/workspace";

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
 * - `read`, `send` and `wait` on a session this desktop holds no tab of yet
 *   (one the CLI just started) look it up as opening it in the app does: a
 *   running workspace's runtime is asked over a connection that never
 *   resumes, a stopped one's checkpoints are read.
 * - `send` goes through the same session backend as the composer
 *   (`cloudSessionBackend`): the same role and lease rules, the mailbox, and
 *   one wake of a stopped workspace, because sending is the explicit action.
 * - `sessions.create` follows the new-session form: a running workspace takes
 *   the session; a stopped one is only woken with `wake`, and a new machine is
 *   only created with `confirmSpend`.
 * - `stop` and `resume` are the workspace menu's: offered to whoever manages
 *   the workspace (its creator, or an organization owner or admin; PRO-73),
 *   and the server enforces the same.
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
 *   with it on, routine compute is authorized without another dialog.
 *   Stopping a workspace still asks the person in the window first.
 * - `"setting"`: the setting alone. Once on, the commands run as asked.
 * - `"confirm"`: the question in the window alone, with no setting.
 *
 * Both parts are enforced in native code (`cloud_control.rs`), not only here:
 * the control socket reads the switch itself and refuses `cloud.*` before
 * this window hears of it, and the question is a native dialog whose default
 * button refuses, that computer use cannot act on while it is open, and that
 * is not shown again for a while after a refusal. The policy below still
 * decides what this module asks and when.
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

/**
 * The person's switch, as native code last said it. It lives in a file the
 * control socket reads itself (it refuses `cloud.*` while off, before this
 * window is asked anything); this copy is for `status` and for the same
 * refusal here, should a request arrive by another way.
 */
let settingOn = false;
let settingRevision = 0;
const settingListeners = new Set<() => void>();

export function cloudControlEnabled(): boolean {
  return settingOn;
}

export function subscribeCloudControlSetting(listener: () => void): () => void {
  settingListeners.add(listener);
  return () => settingListeners.delete(listener);
}

/** What native code says the switch is (read at boot, and after it was changed). Also how tests set it. */
export function setCloudControlEnabled(enabled: boolean) {
  // Even a repeated disable invalidates reads started before this update.
  settingRevision++;
  if (settingOn === enabled) return;
  settingOn = enabled;
  for (const listener of [...settingListeners]) listener();
}

/** Read the switch from native code. Off when it cannot be read. */
export async function loadCloudControlSetting(): Promise<boolean> {
  const revision = ++settingRevision;
  const enabled = (await cloudControlNative.setting().catch(() => false)) === true;
  // A newer refresh or local update owns the cache. This stale read grants nothing.
  if (revision !== settingRevision) return false;
  setCloudControlEnabled(enabled);
  return enabled;
}

/** Why a question was not answered with "yes", in words the person or a caller can act on. */
export function refusalWords(answer: string): { message: string; recovery: string } {
  if (answer.startsWith("backoff:")) {
    const minutes = Math.max(1, Math.ceil(Number(answer.slice("backoff:".length)) / 60));
    return {
      message: "A request like this was refused or left unanswered in the TerminalX window a moment ago, so the person is not asked again yet.",
      recovery: `Do not retry now. Ask the person, or try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    };
  }
  if (answer === "busy") return { message: "Another request is waiting for the person's answer in the TerminalX window.", recovery: "Do not retry now: ask the person to answer the question on their screen." };
  if (answer === "expired") return { message: "The person did not answer in the TerminalX window in time, so the request was dropped. Answering it later does nothing.", recovery: "Do not retry in a loop: ask the person, then run the command again." };
  return { message: "The request was refused in the TerminalX window.", recovery: "Do not retry: ask the person instead." };
}

/**
 * The Settings switch. Turning it on is confirmed by the person in a native
 * dialog, which this window cannot answer; the result is what it then is,
 * and when it did not turn on, the reason to show beside the switch.
 */
export async function requestCloudControlSetting(enabled: boolean): Promise<{ enabled: boolean; reason: string | null }> {
  const change = await cloudControlNative.setSetting(enabled).catch(() => null);
  if (!change) return { enabled: settingOn, reason: "The setting could not be changed. Try again." };
  setCloudControlEnabled(change.enabled);
  if (!enabled || change.enabled || !change.refused) return { enabled: settingOn, reason: null };
  const words =
    change.refused === "declined"
      ? "Not turned on: you refused the confirmation."
      : change.refused === "expired"
        ? "Not turned on: the confirmation was not answered in time."
        : change.refused === "busy"
          ? "Not turned on: another TerminalX question is waiting for your answer. Answer it first."
          : `Not turned on: a confirmation was refused or left unanswered a moment ago. ${refusalWords(change.refused).recovery.replace("Do not retry now. Ask the person, or try", "Try")}`;
  return { enabled: settingOn, reason: words };
}

/** With the setting: nothing of the cloud is reachable from the command line until the person allows it. */
function allowed(): boolean {
  return policy === "confirm" || settingOn;
}

function assertAllowed(granted = allowed()) {
  if (!granted) {
    throw new CloudControlError("cloud_control_disabled", "Cloud workspaces cannot be used from the command line until that is turned on in TerminalX.", `In TerminalX, open Settings and turn on "${CLOUD_CONTROL_SETTING}".`);
  }
}

/**
 * Confirm a disruptive stop, or a request under the legacy confirm-only
 * policy. Routine compute under the shipped policy uses the Settings grant.
 * Only under `"setting"` alone is nothing asked.
 *
 * The question is a native dialog (`cloud_control_confirm`): only its agree
 * button agrees (Refuse, a dismissal and no answer within 40 seconds all
 * decline), its default button refuses, one is shown at a time, the app's
 * computer use is paused while it is open, and after a refusal or an
 * unanswered question the app does not ask again for a while. That stops
 * mistakes and nagging. Computer use never operates this app's own windows
 * and this version's helper serves only the app (PRO-90). A hostile agent
 * with a shell can still press the button by other means: a helper from an
 * older version while it holds Accessibility (the app tries to remove that
 * grant at every launch and warns when it could not), the system's own
 * scripting,
 * or anything at all when TerminalX itself was granted Accessibility (see
 * skill-guides/terminalx-cli.md and docs/COMPUTER-USE.md, Security).
 */
async function confirmInWindow(what: string, okLabel: string): Promise<void> {
  if (policy === "setting") return;
  const answer = await cloudControlNative.confirm(what, okLabel).catch(() => "declined" as const);
  // Only "accepted" is agreement: a refusal, no answer in time, a question already on screen, and anything unexpected all decline.
  if (answer === "accepted") return;
  const { message, recovery } = refusalWords(answer);
  throw new CloudControlError("declined", message, recovery);
}

/** The Settings grant authorizes routine compute, including billed wake/create. */
async function authorizeRoutineCompute(what: string, okLabel: string): Promise<void> {
  assertAllowed();
  if (policy === "confirm") {
    await confirmInWindow(what, okLabel);
    return;
  }
  // Native dispatch precedes catalog/quote I/O; recheck the grant at admission.
  assertAllowed((await loadCloudControlSetting()) && allowed());
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

/** CLI lists and explicit lookup include every live organization: sidebar visibility is a desktop display preference. */
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

/** How long a lookup may take in all, catalog read and tab list included: well inside the 50 s the socket waits. */
export const LOOKUP_WITHIN_MS = 15_000;
/**
 * A send's lookup is shorter: a send to a workspace that is not running may
 * still ask the person (up to 40 s, the native question's limit), and their
 * answer has to reach the CLI inside the same 50 s.
 */
export const SEND_LOOKUP_WITHIN_MS = 8_000;
/** Tabs known only from checkpoint metadata that one lookup reads, as opening a session does. */
const LOOKUP_CHECKPOINTS = 20;

/** What `work` gives, or null once `deadline` (ms) has passed: what is still on its way is not waited for. */
async function by<T>(deadline: number, work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Learn the session's tabs as opening it in the app does, for one this
 * desktop has no tab of yet: the first session of a workspace the CLI just
 * created, or one started elsewhere (PRO-109). A running workspace's runtime
 * is asked for its tab list over a `connect` lease, which attaches and never
 * resumes. Otherwise the workspace's checkpoints are listed again and each
 * tab known only from one reads it to learn its session: reads of the API,
 * never a wake. Nothing is asked of a workspace this person has no role in,
 * by the list's word first and then the runtime's. All of it within
 * `withinMs`. Says what was found out, for the answer when the tab is still
 * not known.
 */
async function lookUpTabs(target: Target, withinMs: number): Promise<"listed" | "unreachable" | "starting" | "stopped"> {
  const deadline = Date.now() + withinMs;
  const scope = { organizationId: target.orgId, workspaceId: target.workspaceId };
  const held = connectedCloudClient(target.workspaceKey);
  assertReadable(youIn(target, held ? held.connection : { state: "idle" }));
  if (!machineRunning(target.item)) {
    // The list held here can be behind a workspace that has just started: ask it again.
    await by(deadline, refreshCloudCatalog(target.orgId).catch(() => undefined));
    const item = findCloudWorkspace(getCloudCatalog(), target.orgId, target.workspaceId);
    if (!item) throw notFound(`No cloud session ${target.key}.`, "List them with terminalx sessions list --cloud.");
    // What follows (a send's wake rules, a wait's live follow) goes by the list of now.
    target.item = item;
    assertReadable(youIn(target, held ? held.connection : { state: "idle" }));
  }
  if (machineRunning(target.item)) {
    const leasing = retainCloudConnection({ orgId: target.orgId, workspaceId: target.workspaceId }, "connect").catch(() => null);
    const lease = await by(deadline, leasing);
    // A lease that comes after the deadline is given straight back.
    if (!lease) void leasing.then((late) => late?.release());
    if (lease) {
      try {
        const client = await waitCloudConnected(lease, Math.max(0, deadline - Date.now()), { stoppedIsError: true });
        // The runtime's own word on access decides before anything of the workspace is read.
        assertReadable(youIn(target, client.connection));
        if (await by(deadline, syncLiveTabs(scope, client).then(() => true))) return "listed";
      } catch (error) {
        if (error instanceof CloudControlError) throw error;
      } finally {
        lease.release();
      }
    }
  }
  await by(deadline, relistCloudCheckpoints(scope).catch(() => undefined));
  const placeholders = getCloudAgents(scope).tabs.filter((tab) => tab.placeholder).slice(0, LOOKUP_CHECKPOINTS);
  await by(deadline, Promise.all(placeholders.map((tab) => refreshFromCheckpoint(scope, tab.tabId).catch(() => false))));
  if (machineRunning(target.item)) return "unreachable";
  return target.item.workspace.state === "provisioning" || resuming(target.item) ? "starting" : "stopped";
}

const STARTING_RECOVERY = "Run the command again in a moment: terminalx projects list --cloud shows how far the workspace has got.";

/**
 * The session the workspace's launch names is listed (`sessions list`)
 * before its agent has a tab. Until the launch has settled, that session is
 * starting, not missing; once it failed, the answer says why. Null for any
 * other session, or a launch that is running.
 */
function launchRefusal(target: Target, wanted: string | null): CloudControlError | null {
  const { item } = target;
  const launch = item.workspace.launch;
  if (!launch || launch.sessionId !== target.sessionId || (wanted && launch.tabId !== wanted)) return null;
  const phase = phaseOf(item);
  if (phase === "failed") return notFound(`Session ${target.key} has no agent tab: its first prompt did not start one. ${failureMessage(item)}`);
  if (settled(phase)) return null;
  if (runtimeNotPickedUp(item, Date.now()) !== null) return notFound(`Session ${target.key} has no agent tab yet. ${RUNTIME_NOT_PICKED_UP}`);
  const label = PHASES.find((known) => known.id === phase)?.label ?? phase;
  return new CloudControlError("cloud_workspace_starting", `Session ${target.key} has no agent tab yet: its workspace is still starting it (${label.toLowerCase()}).`, STARTING_RECOVERY);
}

async function resolveTab(target: Target, wanted: string | null, withinMs = LOOKUP_WITHIN_MS): Promise<CloudAgentTab> {
  let tabs = await tabsOf(target);
  const found = () => (wanted ? tabs.some((candidate) => candidate.tabId === wanted) : tabs.length > 0);
  let lookedUp: Awaited<ReturnType<typeof lookUpTabs>> | null = null;
  if (!found()) {
    lookedUp = await lookUpTabs(target, withinMs);
    tabs = await tabsOf(target);
  }
  if (!found()) {
    const starting = launchRefusal(target, wanted);
    if (starting) throw starting;
  }
  if (wanted) {
    const tab = tabs.find((candidate) => candidate.tabId === wanted);
    if (!tab) throw notFound(`Session ${target.key} has no tab ${wanted}.`, "List its tabs with terminalx sessions list --cloud --json.");
    return tab;
  }
  if (!tabs.length) {
    if (lookedUp === "listed") throw notFound(`No cloud session ${target.key} with an agent tab is in its workspace.`, "List them with terminalx sessions list --cloud.");
    if (lookedUp === "unreachable") throw new CloudControlError("cloud_workspace_unreachable", `Nothing of session ${target.key} is on this desktop yet, and its workspace did not answer in time.`, "Run the command again in a moment.");
    if (lookedUp === "starting") throw new CloudControlError("cloud_workspace_starting", `Session ${target.key} has no agent tab yet: its workspace is still starting.`, STARTING_RECOVERY);
    throw notFound(`Nothing of session ${target.key} is on this desktop yet, and its workspace is not running: no saved checkpoint names it.`, "Run the command again once the workspace is running (terminalx cloud resume resumes a stopped one).");
  }
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

/**
 * Whether a message to this workspace may start it. The server resumes a
 * stopped workspace for any message, so this must not go by what the list
 * said a while ago:
 *
 * - connected to it: it is running;
 * - otherwise the list is read again now. Stopped, on its way down (a stop
 *   still running), or a list that could not be read: it may be stopped.
 */
async function mayBeStopped(target: Target, state: WorkspaceConnectionState): Promise<boolean> {
  if (state.state === "connected") return false;
  const asked = Date.now();
  await refreshCloudCatalog(target.orgId).catch(() => undefined);
  const catalog = getCloudCatalog();
  const org = catalog.orgs[target.orgId];
  const fresh = !!org && org.source === "live" && org.error === null && (org.fetchedAt ?? 0) >= asked;
  const item = findCloudWorkspace(catalog, target.orgId, target.workspaceId);
  if (!item) throw notFound(`No cloud session ${target.key}.`, "List them with terminalx sessions list --cloud.");
  if (!fresh) return true;
  return cloudAsleep(state, item.workspace.state) || stopping(item) || item.workspace.state !== "ready";
}

/** The server refused a `wake: false` message: the workspace is not running, and nothing was stored. */
const workspaceStopped = (error: unknown) => (error instanceof Error ? error.message : String(error)) === WORKSPACE_STOPPED;

async function sendOnce(params: Params) {
  const target = resolveSession(required(params, "target"));
  const message = required(params, "text");
  const tab = await resolveTab(target, text(params, "tab"), SEND_LOOKUP_WITHIN_MS);
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
  const before = new Set(getCloudAgents(scope).outbox.map((entry) => entry.clientCommandId));
  // The message resumes a stopped workspace, which starts billing its compute.
  const confirmResume = () => authorizeRoutineCompute(`send a message to the stopped cloud workspace ${target.item.workspace.name}. Sending resumes it, which starts billing its compute.`, "Resume and send");
  if (getAccount().status.agentCommandWake === true) {
    // The server decides (PRO-89): posted so that it starts nothing, a workspace that is not running refuses it
    // and keeps nothing. No list read a moment ago can be stale. Then the Settings grant authorizes the wake.
    try {
      await backend.send(tab.tabId, message, [], { wake: false });
    } catch (error) {
      if (!workspaceStopped(error)) throw error;
      void refreshCloudCatalog(target.orgId).catch(() => undefined);
      await confirmResume();
      // The same message again: native code posts the envelope that was refused, under its one command id.
      await backend.send(tab.tabId, message, []);
    }
  } else {
    // A server that does not know the option: go by the list, read again now.
    if (await mayBeStopped(target, state)) await confirmResume();
    await backend.send(tab.tabId, message, []);
  }
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
  const seconds = typeof params.timeoutSeconds === "number" ? Math.min(Math.max(params.timeoutSeconds, 0), WAIT_CHUNK_SECONDS) : WAIT_CHUNK_SECONDS;
  // Counted from here: looking up a tab this desktop did not know yet comes out of the same chunk.
  const deadline = now() + seconds * 1000;
  const tab = await resolveTab(target, text(params, "tab"));
  const scope = { organizationId: target.orgId, workspaceId: target.workspaceId };
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

/** The issue a CLI start names, as the native side read it (`cloud_issue_start`); null for a session without one. */
function issueOf(params: Params): RuntimeIssueRef | null {
  const issue = params.issue;
  if (!issue || typeof issue !== "object") return null;
  const { provider, id, identifier, title, url } = issue as Record<string, unknown>;
  if ((provider !== "github" && provider !== "linear") || typeof id !== "string" || typeof identifier !== "string" || typeof title !== "string" || typeof url !== "string") {
    throw invalid("The issue could not be read.");
  }
  return { provider, id, identifier, title, url };
}

async function sessionsCreate(params: Params) {
  const project = resolveProject(required(params, "project"));
  const prompt = required(params, "prompt");
  const issue = issueOf(params);
  // The same rule as the project's "+": creating, resuming and adding a session are an owner's or admin's.
  if (mayStartCloudSessions(getAccount().status, project.orgId) !== true) throw forbidden(NEW_SESSION_ADMIN_REASON);
  if (!project.selected) throw forbidden("This repository is no longer selected for cloud workspaces in its organization.");
  const prefs = getPrefs();
  const agent = text(params, "agent") ?? "claude";
  const explicitMode = typeof params.mode === "string";
  const mode = pickerMode(explicitMode ? (text(params, "mode") ?? "") : prefs.lastMode)?.id;
  if (explicitMode && !mode) throw invalid(`Unknown permission mode ${params.mode}.`);
  const request: CloudSessionRequest = {
    agent,
    model: text(params, "model") ?? prefs.lastModel[agent] ?? "",
    effort: text(params, "effort") ?? prefs.lastEffort[agent] ?? null,
    mode: mode ?? DEFAULT_PERMISSION_MODE,
    prompt,
    useWorktree: params.useWorktree !== false,
  };
  if (issue) {
    const settings = cloudPipelineSettings(project.key, prefs);
    request.title = `${issue.identifier} ${issue.title}`.slice(0, 80);
    request.issue = { ref: issue, body: text(params, "issueBody"), worktreeName: issueWorktreeName(issue.identifier, issue.title), pipeline: params.noPipeline !== true && settings.enabled, settings };
  }
  let outcome: CloudIssueOutcome | null = null;
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
    if (resumes) await authorizeRoutineCompute(`start a session in the stopped cloud workspace ${workspace.name}. That resumes it, which starts billing its compute.`, "Resume and start");
    let woke = resumes;
    let key: string;
    try {
      // The CLI does not move the window's selection. The list can say running while the runtime has
      // stopped by itself: that too is only woken when the caller said --wake (and, under "confirm", the person agrees).
      key = await startInWorkspace(plan, request, {
        select: false,
        onIssue: (said) => {
          outcome = said;
        },
        wakeIfStopped: async () => {
          if (params.wake !== true) return false;
          await authorizeRoutineCompute(`start a session in the cloud workspace ${workspace.name}, which has stopped. That resumes it, which starts billing its compute.`, "Resume and start");
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
    const issueOutcome = outcome as CloudIssueOutcome | null;
    if (!issueOutcome) return { created: "session", session: key, workspace: plan.node.key, resumed: woke };
    // What the issue page would show beside it: the pipeline, or why there is none.
    const pipelineNote = !issueOutcome.supported ? "The workspace runs an older TerminalX, which does not carry issues on to a pull request." : issueOutcome.note;
    return { created: "session", session: key, workspace: plan.node.key, resumed: woke, pipeline: issueOutcome.pipeline, pipelineNote };
  }
  // An issue starts in one of the project's workspaces, where its pipeline runs; a new machine starts with a plain prompt.
  if (issue) {
    throw new CloudControlError("cloud_workspace_required", `${project.fullName} has no workspace to start ${issue.identifier} in.`, "Start a workspace for the project first (terminalx sessions create with --confirm-spend), then start the issue in it.");
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
  await authorizeRoutineCompute(`create a new cloud workspace for ${project.fullName} on ${prepared.providerLabel}. Its compute is billed while it runs.`, "Create workspace");
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

/**
 * How long stop and resume follow the other one, still running, before they
 * answer that the workspace is not where they start from. It comes before the
 * person is asked (up to 40 s), inside the 50 s the socket waits.
 */
export const LIFECYCLE_SETTLE_MS = 5_000;
const LIFECYCLE_POLL_MS = 1_000;

type Sleep = (ms: number) => Promise<void>;
const pause: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The workspace as the server lists it now. When the list cannot be read, the
 * row held is used: the server still refuses what the workspace's own state
 * does not allow.
 */
async function listedNow(target: { orgId: string; workspaceId: string; key: string }): Promise<CloudWorkspaceListItem> {
  await relistCloudCatalog(target.orgId).catch(() => undefined);
  const item = findCloudWorkspace(getCloudCatalog(), target.orgId, target.workspaceId);
  if (!item) throw notFound(`No cloud workspace ${target.key}.`, "List them with terminalx projects list --cloud.");
  return item;
}

/**
 * The workspace a stop or resume acts on, by the server's word and not the
 * list this window last read, which can be seconds old: a resume straight
 * after a stop was refused as "stopping" when the stop had already finished
 * (PRO-113). The opposite action, still running (`settling`), is followed for
 * a moment before the caller decides.
 */
async function lifecycleTarget(params: Params, settling: (item: CloudWorkspaceListItem) => boolean, sleep: Sleep, now: () => number) {
  const target = resolveWorkspace(required(params, "workspace"));
  let item = await listedNow(target);
  assertLifecycle(item);
  const deadline = now() + LIFECYCLE_SETTLE_MS;
  while (settling(item) && now() < deadline) {
    await sleep(LIFECYCLE_POLL_MS);
    item = await listedNow(target);
  }
  return { ...target, item };
}

/**
 * Where a stop or resume has got to, in the words `cloud stop` and `cloud
 * resume` answer with. The server says "provisioning" while either runs, so
 * its state is not passed on.
 */
function lifecycleState(item: CloudWorkspaceListItem | null, action: "suspend" | "resume"): "stopping" | "stopped" | "resuming" | "running" {
  if (action === "suspend") return item?.workspace.state === "suspended" && !stopping(item) ? "stopped" : "stopping";
  return item?.workspace.state === "ready" && !resuming(item) ? "running" : "resuming";
}

async function stop(params: Params, sleep: Sleep = pause, now: () => number = Date.now) {
  const target = await lifecycleTarget(params, resuming, sleep, now);
  const { item } = target;
  // Already stopped, or on its way: nothing more to ask for.
  if (stopping(item)) return { workspace: target.key, state: lifecycleState(item, "suspend"), operationId: item.latestOperation?.id ?? null, changed: false };
  if (item.workspace.state === "suspended") return { workspace: target.key, state: lifecycleState(item, "suspend"), changed: false };
  if (item.workspace.state !== "ready") {
    const activity = deriveCloudActivity(item);
    throw new CloudControlError("cloud_workspace_not_running", `This workspace is ${activity.label.toLowerCase()}; only a running one can be stopped.`, activity.tone === "changing" ? "Run the command again once it is running." : null);
  }
  // The app asks before stopping: running agent turns end with the machine.
  if (params.confirmed !== true) throw new CloudControlError("confirmation_required", `Stopping ${item.workspace.name} ends any agent turn running in it. Everything is kept, and it can be resumed.`, "Pass --yes to stop it.");
  await confirmInWindow(`stop the cloud workspace ${item.workspace.name}. Any agent turn running in it ends.`, "Stop workspace");
  const requestedAt = Date.now();
  const snapshot = await api.cloudWorkspaceSuspend(target.workspaceId, cloudOrgArg(target.orgId));
  if (snapshot?.workspace) applyCloudSnapshot(snapshot, requestedAt);
  void refreshCloudCatalog(target.orgId);
  const after = snapshot?.workspace ? { workspace: snapshot.workspace, latestOperation: snapshot.operation } : null;
  return { workspace: target.key, state: lifecycleState(after, "suspend"), operationId: snapshot?.operation.id ?? null, changed: true };
}

async function resume(params: Params, sleep: Sleep = pause, now: () => number = Date.now) {
  const target = await lifecycleTarget(params, stopping, sleep, now);
  const { item } = target;
  // Already running, or on its way: nothing is resumed twice.
  if (resuming(item)) return { workspace: target.key, state: lifecycleState(item, "resume"), operationId: item.latestOperation?.id ?? null, changed: false };
  if (machineRunning(item)) return { workspace: target.key, state: lifecycleState(item, "resume"), changed: false };
  if (item.workspace.state !== "suspended" || isOpen(item.latestOperation)) {
    throw new CloudControlError("cloud_workspace_not_stopped", `This workspace is ${deriveCloudActivity(item).label.toLowerCase()}; only a stopped one can be resumed.`, stopping(item) ? "Run the command again once it has stopped." : null);
  }
  await authorizeRoutineCompute(`resume the cloud workspace ${item.workspace.name}, which starts billing its compute.`, "Resume workspace");
  // The one explicit wake: the same call as the menu's Resume.
  await resumeCloudWorkspace(item);
  void refreshCloudCatalog(target.orgId);
  const after = findCloudWorkspace(getCloudCatalog(), target.orgId, target.workspaceId);
  return { workspace: target.key, state: lifecycleState(after, "resume"), operationId: after?.latestOperation?.id ?? null, changed: true };
}

/** For tests: `stop` and `resume` with their clock and sleep replaced. */
export const cloudLifecycleCommands = { stop, resume };

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
      void loadCloudControlSetting();
      await listen<ControlRequest>("cloud_control_request", (event) => {
        const { id, action, params } = event.payload;
        void answerCloudControl(action, params).then((result) => invoke("cloud_control_reply", { id, result }).catch(() => undefined));
      });
    } catch {
      /* outside a webview */
    }
  })());
}
