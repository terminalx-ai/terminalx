import { normalizeRepositoryIdentity } from "@terminalx/portable/repositoryIdentity";
import type { CloudWorkspace } from "./api";
import { workspaceTitle, type CatalogSnapshot } from "./catalog";
import type { CloudPinRow } from "../data/session-list";

/**
 * The cloud project a workspace belongs to, named as the Mac's sidebar names
 * it (`repositoryOf` and `blankIdentity` in the desktop's cloud catalog): its
 * primary repository's identity, else a blank project known by the
 * workspace's name. The Mac may also place a workspace it created by what it
 * remembers of that, which the phone does not know; the server's list is
 * what both read first.
 */
export function workspaceProject(workspace: Pick<CloudWorkspace, "name" | "repositories">): string {
  const listed = workspace.repositories;
  const primary = Array.isArray(listed) ? listed.find((repository) => repository.primary) ?? listed[0] : undefined;
  const identity = primary ? normalizeRepositoryIdentity(primary.identity) ?? normalizeRepositoryIdentity((primary as { cloneUrl?: unknown }).cloneUrl) : null;
  return identity ?? `blank/${workspace.name.trim().toLowerCase()}`;
}

/**
 * The phone's cloud workspaces whose project the Mac pinned (#1403), as rows
 * of the Pinned section. Only organizations this phone's account can read
 * are listed: the Mac's pins of any other stay on the Mac.
 */
export function pinnedCloudRows(snapshot: Pick<CatalogSnapshot, "organizations" | "titles">, pins: Readonly<Record<string, readonly string[]>>): CloudPinRow[] {
  const rows: CloudPinRow[] = [];
  for (const entry of snapshot.organizations) {
    const orgId = entry.organization.orgId;
    const pinned = new Set(pins[orgId] ?? []);
    if (!pinned.size) continue;
    for (const item of entry.workspaces) {
      const identity = workspaceProject(item.workspace);
      if (!pinned.has(identity)) continue;
      const { workspace } = item;
      rows.push({
        kind: "cloud",
        key: `cloud:${orgId}:${workspace.id}`,
        orgId,
        identity,
        item,
        title: workspaceTitle(snapshot, workspace),
        time: workspace.lastActivityAt ?? 0,
      });
    }
  }
  return rows;
}
