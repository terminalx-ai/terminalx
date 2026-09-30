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

export function isCloudKey(key: string | null | undefined): key is CloudKey {
  return typeof key === "string" && key.startsWith("cloud:");
}

export function isLocalKey(key: string | null | undefined): key is string {
  return typeof key === "string" && !key.startsWith("cloud:");
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
