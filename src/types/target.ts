import type { CloudWorkspaceListItem } from "@/lib/api";
import type { SessionEntry } from "@/types/session";

/**
 * Where a sidebar row lives (PRO-23). Local keys keep their current values:
 * a project's folder path and a session's `SessionEntry.id`. Every cloud key
 * starts with `cloud:`, so the two can never collide: a local path is
 * absolute and a session id is a uuid.
 *
 * - Project: `cloud:<orgId>:<host/owner/repo>` (a repository identity has slashes).
 * - Workspace: `cloud:<orgId>:<workspaceId>`, the same as `workspaceTargetKey`.
 * - Session: `cloud:<orgId>:<workspaceId>:<sessionId>`.
 */
export type CloudKey = `cloud:${string}`;
export type ProjectKey = string;
export type WorkspaceKey = string;
export type SessionKey = string;

/** A path on a cloud VM. Branded so it can never be handed to a local command. */
export type RemotePath = string & { readonly __remotePath: unique symbol };

/** A guest location is always qualified; its raw /Users/… path is display-only. */
export type GuestPath = string & { readonly __guestPath: unique symbol };

export function guestTaskPath(target: import("./localVm").LocalVmTaskTarget, path: string): GuestPath {
  return `local-cua://${[target.environmentId, target.generation, target.workspaceId, target.taskId].map(encodeURIComponent).join("/")}/${encodeURIComponent(path)}` as GuestPath;
}

export function isGuestPath(value: string): value is GuestPath {
  return value.startsWith("local-cua:");
}

/**
 * The display root of a cloud workspace's files and the `cwd` a cloud
 * session carries in the UI: `cloud://<orgId>:<workspaceId>`. It starts with
 * `cloud:` like every cloud key, which is what `assertLocal` refuses.
 */
export function cloudWorkspaceRoot(orgId: string, workspaceId: string): RemotePath {
  return `cloud://${orgId}:${workspaceId}` as RemotePath;
}

/**
 * Whether a path or id belongs to another computer: a cloud workspace or a
 * paired machine (a `cloud:`/`machine:` key, a `cloud://`/`machine://` root or
 * a path under one; docs/MACHINES.md decision 8).
 */
export function isRemotePath(value: string): value is RemotePath {
  return value.startsWith("cloud:") || value.startsWith("machine:");
}

export class LocalPathLeakError extends Error {
  constructor(what: string, value: string) {
    super(`A ${isGuestPath(value) ? "guest" : value.startsWith("machine:") ? "machine" : "cloud"} path reached a local command (${what}: ${value})`);
    this.name = "LocalPathLeakError";
  }
}

/**
 * Throw before a cloud or machine path or key reaches a local command (Reveal in
 * Finder, local git, fs, pty, browser). A local path passes unchanged.
 */
export function assertLocal<T extends string | null | undefined>(value: T, what = "path"): T {
  if (typeof value === "string" && (isRemotePath(value) || isGuestPath(value))) throw new LocalPathLeakError(what, value);
  return value;
}

export function isCloudKey(key: string | null | undefined): key is CloudKey {
  return typeof key === "string" && key.startsWith("cloud:");
}

export function isLocalKey(key: string | null | undefined): key is string {
  return typeof key === "string" && !isCloudKey(key) && !isMachineKey(key) && !isGuestPath(key);
}

/**
 * A row on a paired machine (docs/MACHINES.md decision 8): the machine's
 * section `machine:<machineId>`, a project `machine:<machineId>:<projectId>`,
 * a session `machine:<machineId>:<projectId>:<sessionId>`.
 */
export type MachineKey = `machine:${string}`;

export function isMachineKey(key: string | null | undefined): key is MachineKey {
  return typeof key === "string" && key.startsWith("machine:");
}

/** A machine's sidebar section, and the key its workspace view is selected by: the same as `workspaceTargetKey`. */
export function machineSectionKey(machineId: string): MachineKey {
  return `machine:${machineId}`;
}

/** A project on a machine: `machine:<machineId>:<projectId>`. */
export function machineProjectKey(machineId: string, projectId: string): MachineKey {
  return `machine:${machineId}:${projectId}`;
}

/** A session on a machine: `machine:<machineId>:<projectId>:<sessionId>`. */
export function machineSessionKey(machineId: string, projectId: string, sessionId: string): MachineKey {
  return `machine:${machineId}:${projectId}:${sessionId}`;
}

/** The display root of a machine project's files (decision 8): not a key, and refused by `assertLocal`. */
export function machineProjectRoot(machineId: string, projectId: string): RemotePath {
  return `machine://${machineId}:${projectId}` as RemotePath;
}

/** Which row a machine key names, by its part count (2, 3 or 4); null for anything else. */
export function machineKeyKind(key: string | null | undefined): "machine" | "project" | "session" | null {
  if (typeof key !== "string") return null;
  const parsed = parseMachineKey(key);
  if (!parsed) return null;
  return parsed.sessionId ? "session" : parsed.projectId ? "project" : "machine";
}

/** The machine a machine key belongs to; null for a display root (`machine://…`) or any other key. */
export function parseMachineKey(key: string): { machineId: string; projectId: string | null; sessionId: string | null } | null {
  if (!isMachineKey(key) || key.startsWith("machine://")) return null;
  const [machineId, projectId, sessionId, ...extra] = key.slice("machine:".length).split(":");
  if (!machineId || machineId.includes("/") || extra.length) return null;
  // Every part present is filled: `machine:m::s` (a session with no project) is no key.
  if (projectId === "" || sessionId === "" || projectId?.includes("/") || sessionId?.includes("/")) return null;
  return { machineId, projectId: projectId || null, sessionId: sessionId || null };
}

export function orgSectionKey(orgId: string): string {
  return `org:${orgId}`;
}

export function cloudProjectKey(orgId: string, identity: string): CloudKey {
  return `cloud:${orgId}:${identity}`;
}

export function cloudWorkspaceKey(orgId: string, workspaceId: string): CloudKey {
  return `cloud:${orgId}:${workspaceId}`;
}

export function cloudSessionKey(orgId: string, workspaceId: string, sessionId: string): CloudKey {
  return `cloud:${orgId}:${workspaceId}:${sessionId}`;
}

/** The organization and workspace of a cloud workspace or session key; null for a project key or a local key. */
export function parseCloudWorkspaceKey(key: string): { orgId: string; workspaceId: string; sessionId: string | null } | null {
  if (!isCloudKey(key)) return null;
  const rest = key.slice("cloud:".length);
  // Repository identities contain "/", workspace and session ids never do.
  if (rest.includes("/")) return null;
  const [orgId, workspaceId, sessionId, ...extra] = rest.split(":");
  if (!orgId || !workspaceId || extra.length) return null;
  return { orgId, workspaceId, sessionId: sessionId || null };
}

/**
 * A cloud project: one organization repository, derived from the pair
 * (organization, repository identity). It is not a server table.
 */
export interface CloudProject {
  key: CloudKey;
  orgId: string;
  /** `host/owner/name`, lower case (`normalizeRepositoryIdentity`). */
  identity: string;
  /** `owner/name` as the organization's repository list spells it. */
  fullName: string;
  /** Selected for cloud workspaces by an admin. A deselected one still listed has workspaces here and reads "not accessible". */
  selected: boolean;
  pinned: boolean;
  /**
   * A project with no repository: workspaces built from nothing (a folder
   * the runtime `git init`s), known by name. Identity `blank/<name>`.
   */
  blank: boolean;
  /** Non-archived workspaces placed here, most recent activity first. */
  workspaces: CloudWorkspaceNode[];
}

/** One VM on its own branch, with where it was placed from. */
export interface CloudWorkspaceNode {
  key: CloudKey;
  item: CloudWorkspaceListItem;
  /** How its repository was known: the server's list, what this desktop recorded at create, or not at all. */
  placedBy: "server" | "createMemory" | null;
}

export type SessionRecord = { kind: "local"; key: SessionKey; session: SessionEntry } | { kind: "cloud"; key: CloudKey; orgId: string; workspaceId: string; sessionId: string };

export type ProjectRecord = { kind: "local"; key: ProjectKey; path: string } | { kind: "cloud"; key: CloudKey; project: CloudProject };

export function isLocal<T extends { kind: "local" | "cloud" }>(record: T): record is Extract<T, { kind: "local" }> {
  return record.kind === "local";
}

export function isCloud<T extends { kind: "local" | "cloud" }>(record: T): record is Extract<T, { kind: "cloud" }> {
  return record.kind === "cloud";
}
