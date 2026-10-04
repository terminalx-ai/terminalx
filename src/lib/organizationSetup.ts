// The setup of an organization's cloud, from creating the organization to
// its first working workspace (PRO-16). One record per creation request,
// kept on this Mac for the signed-in user and, once the server has created
// the organization, bound to that organization's id: it is never applied to
// whichever organization happens to be active.
//
// The record holds what the server cannot tell us back: the original
// creation request id, the choice to finish without an agent, and the one
// setup workspace's create request. Everything else is read from the server
// on every resume (`reconcileSetup`); the stored `step` is only what the
// last reconciliation found, shown until the server answers.

import type { CloudWorkspaceListItem } from "@/lib/api";
import type { PendingCreate } from "@/lib/cloudCreate";

export const SETUP_VERSION = 2;

export type SetupStep = "create" | "select" | "compute" | "repository" | "workspace" | "runtime" | "agent" | "done";

export interface OrganizationSetupRecord {
  v: typeof SETUP_VERSION;
  /** The idempotency key of the organization create: a retry replays that create, never a second one. */
  requestId: string;
  name: string;
  /** Null until the server has created the organization. */
  organizationId: string | null;
  createdAt: number;
  step: SetupStep;
  /** `terminal-only`: the person chose to finish setup without an agent login. */
  agent: "required" | "terminal-only";
  /**
   * The one setup workspace: its create request (kept until the server has
   * answered, so a retry returns the same workspace and its single first
   * prompt) and its id once known.
   */
  workspace: { pending: PendingCreate | null; id: string | null } | null;
  completedAt: number | null;
}

const KEY = "terminalx.organization-setup.v2";
const LEGACY_KEY = "terminalx.organization-setup.v1";

/** The user part of a key: no `.` in it. */
function encodeUser(user: string): string {
  return encodeURIComponent(user).replace(/\./g, "%2E");
}

const storageKey = (user: string) => `${KEY}.${encodeUser(user)}`;

const STEPS: readonly SetupStep[] = ["create", "select", "compute", "repository", "workspace", "runtime", "agent", "done"];

function valid(value: unknown): value is OrganizationSetupRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === SETUP_VERSION &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    typeof record.name === "string" &&
    (record.organizationId === null || typeof record.organizationId === "string") &&
    typeof record.createdAt === "number" &&
    STEPS.includes(record.step as SetupStep) &&
    (record.agent === "required" || record.agent === "terminal-only") &&
    (record.workspace === null || typeof record.workspace === "object") &&
    (record.completedAt === null || typeof record.completedAt === "number")
  );
}

export function newSetup(name: string, requestId: string, now = Date.now()): OrganizationSetupRecord {
  return { v: SETUP_VERSION, requestId, name, organizationId: null, createdAt: now, step: "create", agent: "required", workspace: null, completedAt: null };
}

/**
 * The legacy attempt (`{ name, key, organizationId? }`, one per user, no
 * steps), read once and replaced by a record.
 */
function migrateLegacy(user: string): OrganizationSetupRecord | null {
  const key = `${LEGACY_KEY}.${user}`;
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  localStorage.removeItem(key);
  try {
    const saved = JSON.parse(raw) as { name?: unknown; key?: unknown; organizationId?: unknown } | null;
    if (!saved || typeof saved.name !== "string" || typeof saved.key !== "string") return null;
    const record = newSetup(saved.name, saved.key);
    if (typeof saved.organizationId === "string") return { ...record, organizationId: saved.organizationId, step: "select" };
    return record;
  } catch {
    return null;
  }
}

/** This user's setup records. A record of another version or shape is dropped, not guessed at. */
export function loadSetups(user: string): OrganizationSetupRecord[] {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(user)) ?? "null") as { v?: unknown; records?: unknown } | null;
    const records = stored?.v === SETUP_VERSION && Array.isArray(stored.records) ? stored.records.filter(valid) : [];
    const legacy = migrateLegacy(user);
    if (!legacy || records.some((record) => record.requestId === legacy.requestId)) return records;
    const migrated = [...records, legacy];
    localStorage.setItem(storageKey(user), JSON.stringify({ v: SETUP_VERSION, records: migrated }));
    return migrated;
  } catch {
    return [];
  }
}

function store(user: string, records: OrganizationSetupRecord[]): void {
  try {
    if (records.length) localStorage.setItem(storageKey(user), JSON.stringify({ v: SETUP_VERSION, records }));
    else localStorage.removeItem(storageKey(user));
  } catch {
    /* private window: the record lasts for this session only */
  }
}

/** Save `record` in place of the one with its request id. */
export function saveSetup(user: string, record: OrganizationSetupRecord): void {
  const records = loadSetups(user).filter((other) => other.requestId !== record.requestId);
  store(user, [...records, record]);
}

/** Forget what is left of organizations `gone` names (the user left them). */
export function forgetSetups(user: string, gone: (organizationId: string) => boolean): void {
  store(
    user,
    loadSetups(user).filter((record) => !record.organizationId || !gone(record.organizationId)),
  );
}

/**
 * Forget setup records on this Mac: everyone's, or everyone's but `keep`'s.
 * A record names an organization and holds a prepared first prompt; it is
 * not left behind for the next person who signs in here.
 */
export function forgetOtherSetups(keep: string | null): void {
  try {
    const kept = keep === null ? null : storageKey(keep);
    const doomed: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key) continue;
      if (key.startsWith(`${KEY}.`) && key !== kept) doomed.push(key);
      // The previous version's attempt and name draft, keyed by the raw email.
      else if (key.startsWith(`${LEGACY_KEY}.`) && (keep === null || !key.startsWith(`${LEGACY_KEY}.${keep}`))) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/**
 * How long the setup workspace's create request may be resent. The server
 * replays a create by its key for a day (as `loadPending` in cloudCreate
 * assumes); after that the same request would be a new workspace.
 */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** The setup workspace's unanswered create request, while resending it is still the same create. */
export function resendable(record: OrganizationSetupRecord, now = Date.now()): PendingCreate | null {
  const workspace = record.workspace;
  if (!workspace || workspace.id || !workspace.pending) return null;
  return now - workspace.pending.createdAt < PENDING_TTL_MS ? workspace.pending : null;
}

/**
 * An unanswered create request that is too old to resend and has not been
 * settled against the workspace list yet. It may have made a workspace, so
 * while it stands no new setup workspace may be prepared.
 */
export function unsettledRequest(record: OrganizationSetupRecord, now = Date.now()): boolean {
  const workspace = record.workspace;
  return Boolean(workspace && !workspace.id && workspace.pending && !resendable(record, now));
}

/**
 * An unanswered create request that is too old to resend: if the workspace
 * it asked for is in the list after all (same name, created since), that is
 * the setup workspace; otherwise the request is dropped and a new one may
 * be prepared. Decided only from a list that is known.
 */
function settleExpiredRequest(record: OrganizationSetupRecord, workspaces: readonly CloudWorkspaceListItem[] | null, now: number): OrganizationSetupRecord {
  const pending = record.workspace?.pending;
  if (!pending || record.workspace?.id || resendable(record, now) || !workspaces) return record;
  // Clocks differ a little between this Mac and the server.
  const since = pending.createdAt - 5 * 60 * 1000;
  const made = workspaces.find((item) => item.workspace.name === pending.request.name && item.workspace.createdAt >= since && item.workspace.state !== "destroyed");
  return { ...record, workspace: made ? { pending: null, id: made.workspace.id } : null };
}

/**
 * The creation to resume: one the server has not confirmed, one that was
 * created and never selected, or, while no organization is selected at all,
 * one whose setup is not complete. An organization the person switched away
 * from is not unfinished creation: its record waits for them to come back.
 */
export function unfinishedCreation(records: readonly OrganizationSetupRecord[], activeOrganizationId: string | null): OrganizationSetupRecord | null {
  return (
    records.find(
      (record) =>
        !record.organizationId ||
        (record.organizationId !== activeOrganizationId && (record.step === "select" || (activeOrganizationId === null && record.completedAt === null))),
    ) ?? null
  );
}

/** The setup of exactly this organization, by id. Never another organization's. */
export function setupFor(records: readonly OrganizationSetupRecord[], organizationId: string | null): OrganizationSetupRecord | null {
  if (!organizationId) return null;
  return records.find((record) => record.organizationId === organizationId) ?? null;
}

/**
 * What the server says now. `null` means "not known" (not loaded, offline,
 * refused): an unknown fact neither advances the setup nor sets it back.
 */
export interface SetupFacts {
  /** The organization this account has selected. */
  activeOrganizationId: string | null;
  /** A compute provider is connected and usable. */
  compute: boolean | null;
  /** At least one repository is chosen and accessible. */
  repository: boolean | null;
  /** The organization's workspaces, to find the setup workspace in. */
  workspaces: readonly CloudWorkspaceListItem[] | null;
}

/** Launch failures that leave the workspace without its repository on its branch. */
const CHECKOUT_FAILURES = new Set([
  "repository-clone-failed",
  "repository-access-denied",
  "repository-branch-not-found",
  "repository-clone-timed-out",
  "repository-path-occupied",
  "repository-empty",
  "workspace-disk-full",
  "repository-sync-failed",
  "branch-create-failed",
]);

/** The setup workspace, when the list is known and still has it. */
export function setupWorkspace(record: OrganizationSetupRecord, workspaces: readonly CloudWorkspaceListItem[] | null): CloudWorkspaceListItem | null {
  const id = record.workspace?.id;
  if (!id || !workspaces) return null;
  return workspaces.find((item) => item.workspace.id === id) ?? null;
}

function stepFrom(record: OrganizationSetupRecord, facts: SetupFacts): SetupStep {
  if (!record.organizationId) return "create";
  if (facts.activeOrganizationId !== record.organizationId) return "select";
  // A completed setup stays completed: later changes are the organization's
  // ordinary life, not setup.
  if (record.completedAt !== null) return "done";
  const at = (step: SetupStep) => STEPS.indexOf(record.step) >= STEPS.indexOf(step);
  // An unknown fact holds the setup where it was last seen.
  if (facts.compute === false || (facts.compute === null && !at("repository"))) return "compute";
  if (facts.repository === false || (facts.repository === null && !at("workspace"))) return "repository";
  if (!record.workspace?.id) return "workspace";
  if (facts.workspaces === null) return at("runtime") ? record.step : "runtime";
  const item = setupWorkspace(record, facts.workspaces);
  // No longer listed (deleted since): the setup needs a workspace again. The
  // record keeps the old id until the person asks for a new one, so a list
  // that is merely behind can never lead to a second workspace by itself.
  if (!item) return "workspace";
  const workspace = item.workspace;
  // A healthy runtime with the repository cloned: the workspace is ready and
  // its runtime reports in. A launch that failed while syncing repositories
  // never had its clone.
  const launch = workspace.launch;
  const cloneFailed = CHECKOUT_FAILURES.has(launch?.category ?? "");
  if (workspace.state !== "ready" || !workspace.runtimeActivity?.online || cloneFailed) return "runtime";
  if (record.agent === "terminal-only") return "done";
  // A usable agent login: the first prompt reached its agent.
  return launch?.sessionId ? "done" : "agent";
}

/**
 * Bring a record up to what the server says. Returns the record to store
 * (the same object when nothing changed) and never touches a record whose
 * organization is not the one the facts are about.
 */
export function reconcileSetup(given: OrganizationSetupRecord, facts: SetupFacts, now = Date.now()): OrganizationSetupRecord {
  const record = settleExpiredRequest(given, facts.workspaces, now);
  const step = stepFrom(record, facts);
  const completedAt = step === "done" ? (record.completedAt ?? now) : record.completedAt;
  if (step === record.step && completedAt === record.completedAt) return record;
  return { ...record, step, completedAt };
}

/**
 * The prompt offered for the setup workspace: it checks the environment an
 * agent will work in and changes nothing.
 */
export const ENVIRONMENT_CHECK_PROMPT = [
  "Check that this cloud workspace is ready for work. Do not change any files.",
  "1. Confirm the repository is cloned and report its current branch and latest commit.",
  "2. Report which toolchains the project needs and whether each is installed, with its version.",
  "3. Try the project's install and build steps, and its tests if they are quick. Report anything that fails.",
  "Finish with a short list of what is ready and what is missing.",
].join("\n");

export const STEP_LABELS: Record<Exclude<SetupStep, "create" | "select" | "done">, string> = {
  compute: "Connect a compute provider",
  repository: "Choose a repository",
  workspace: "Create the setup workspace",
  runtime: "Workspace running with the repository cloned",
  agent: "Agent signed in and working",
};
