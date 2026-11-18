import { useEffect, useMemo, useSyncExternalStore } from "react";
import { freeSectionName, groupSidebarItems } from "@/lib/sidebarSections";
export { freeSectionName } from "@/lib/sidebarSections";
import { getAccount, useAccount } from "@/lib/account";
import type { AccountStatus } from "@/lib/api";
import { getPrefs, setPrefs, usePrefs, type CloudSidebarSection } from "@/lib/prefs";
import { privacyEnabled } from "@/lib/dataPrivacy";
import type { CloudProject, CloudWorkspaceNode } from "@/types/target";

/** Personal workspace layout, stored per native account and organization. Legacy
 * project memberships are resolved from the complete authorized catalog only.
 * New sections remain drafts until their inline name is committed. */

/** Whose sections these are: the signed-in account; none while signed out (there are no organizations then). */
function owner(status: AccountStatus): string | null {
  return !privacyEnabled() && status.state === "signed-in" ? (status.context?.account ?? status.identity?.email ?? null) : null;
}

const draftListeners = new Set<() => void>();
let draftVersion = 0;
const drafts = new Map<string, CloudSidebarSection[]>();
const pendingMoves = new Map<string, { workspaceId: string; projects: readonly CloudProject[] }>();
const scopeOf = (who: string, orgId: string) => JSON.stringify([who, orgId]);
function changedDrafts() { draftVersion++; for (const listener of draftListeners) listener(); }
/** Incomplete inline edits never survive account, organization or privacy resets. */
export function discardCloudSectionDrafts(orgId?: string, account?: string) {
  if (!drafts.size && !pendingMoves.size) return;
  if (orgId && account) {
    const key = scopeOf(account, orgId);
    for (const section of drafts.get(key) ?? []) { pendingMoves.delete(section.id); if (renameNext === section.id) renameNext = null; }
    drafts.delete(key);
  } else { drafts.clear(); pendingMoves.clear(); renameNext = null; }
  changedDrafts();
}

const subscribeDrafts = (listener: () => void) => { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; };

/** Claim the old email-keyed layout once, then remove that legacy key. No
 * future profile sharing the email can read another native account's layout. */
export function migrateCloudSectionOwner(status: AccountStatus = getAccount().status) {
  const who = owner(status), email = status.identity?.email;
  if (!who || !email || who === email) return;
  const all = getPrefs().cloudSections;
  if (!all[email]) return;
  const migrated = Object.fromEntries(Object.entries(all[email]).map(([orgId, sections]) => [orgId, sections.map((section) => ({ ...section,
    ...(section.collapsed === undefined && getPrefs().sidebarSections[`cloud-section:${section.id}`] === "collapsed" ? { collapsed: true } : {}),
  }))]));
  const next = { ...all, [who]: { ...migrated, ...all[who] } };
  delete next[email];
  setPrefs({ cloudSections: next });
}

function read(orgId: string, status: AccountStatus = getAccount().status): CloudSidebarSection[] {
  migrateCloudSectionOwner(status);
  const who = owner(status);
  return who ? [...(getPrefs().cloudSections[who]?.[orgId] ?? []), ...(drafts.get(scopeOf(who, orgId)) ?? [])] : [];
}

function write(orgId: string, sections: CloudSidebarSection[]) {
  const who = owner(getAccount().status);
  if (!who) return;
  const key = scopeOf(who, orgId);
  const pendingIds = new Set((drafts.get(key) ?? []).map((section) => section.id));
  const pending = sections.filter((section) => pendingIds.has(section.id));
  const saved = sections.filter((section) => !pendingIds.has(section.id));
  if (pendingIds.size) { drafts.set(key, pending); changedDrafts(); }
  const all = getPrefs().cloudSections;
  const mine = { ...all[who] };
  if (saved.length) mine[orgId] = saved;
  else delete mine[orgId];
  const next = { ...all };
  if (Object.keys(mine).length) next[who] = mine;
  else delete next[who];
  setPrefs({ cloudSections: next });
}

/** This account's persisted sections plus the current inline draft. */
export function useCloudSidebarSections(orgId: string): CloudSidebarSection[] {
  const prefs = usePrefs();
  const { status } = useAccount();
  const who = owner(status);
  const version = useSyncExternalStore(subscribeDrafts, () => draftVersion, () => draftVersion);
  useEffect(() => { migrateCloudSectionOwner(status); }, [who, status]);
  return useMemo(() => who ? [...(prefs.cloudSections[who]?.[orgId] ?? []), ...(drafts.get(scopeOf(who, orgId)) ?? [])] : EMPTY, [prefs.cloudSections, who, orgId, version]);
}

const EMPTY: CloudSidebarSection[] = [];

let counter = 0;
function newId(): string {
  counter += 1;
  return `s${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Add a section at the end, optionally with a project moved into it; returns its id. */
export function createCloudSection(orgId: string, project?: string, workspaceIds?: string[]): string {
  const sections = read(orgId);
  const id = newId();
  const who = owner(getAccount().status);
  if (!who) return id;
  const key = scopeOf(who, orgId);
  drafts.set(key, [...(drafts.get(key) ?? []), { id, name: freeSectionName(sections), projects: project ? [project] : [], ...(workspaceIds ? { workspaces: workspaceIds } : {}) }]);
  requestRename(id);
  changedDrafts();
  return id;
}

export function isCloudSectionDraft(orgId: string, id: string): boolean {
  const who = owner(getAccount().status);
  return !!who && !!drafts.get(scopeOf(who, orgId))?.some((section) => section.id === id);
}

export function createCloudSectionForWorkspace(orgId: string, workspaceId: string, projects: readonly CloudProject[]) {
  const id = createCloudSection(orgId);
  pendingMoves.set(id, { workspaceId, projects });
  return id;
}

/** Rename; a blank name keeps the old one. */
export function renameCloudSection(orgId: string, id: string, name: string) {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed || isBuiltInSection(id)) return;
  const who = owner(getAccount().status);
  if (!who) return;
  const key = scopeOf(who, orgId);
  const pending = drafts.get(key) ?? [];
  const draft = pending.find((section) => section.id === id);
  if (draft) {
    drafts.set(key, pending.filter((section) => section.id !== id));
    const existing = read(orgId).map((section) => ({ ...section, projects: section.projects.filter((project) => !draft.projects.includes(project)), ...(section.workspaces ? { workspaces: section.workspaces.filter((id) => !draft.workspaces?.includes(id)) } : {}) }));
    write(orgId, [...existing, { ...draft, name: trimmed }]);
    const move = pendingMoves.get(id);
    if (move) moveWorkspaceToSection(orgId, move.workspaceId, id, move.projects);
    pendingMoves.delete(id);
    changedDrafts();
  } else write(orgId, read(orgId).map((section) => section.id === id ? { ...section, name: trimmed } : section));
}

/** Move a section up (-1) or down (+1) among this organization's sections. */
export function moveCloudSection(orgId: string, id: string, by: -1 | 1) {
  if (isBuiltInSection(id)) return;
  const original = read(orgId);
  const sections = original.filter((section) => !isBuiltInSection(section.id));
  const from = sections.findIndex((section) => section.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= sections.length) return;
  [sections[from], sections[to]] = [sections[to], sections[from]];
  let index = 0;
  write(orgId, original.map((section) => isBuiltInSection(section.id) ? section : sections[index++]));
}

/** Delete a section; its projects go back to the organization's ungrouped list. Nothing else changes. */
export function deleteCloudSection(orgId: string, id: string) {
  if (!isBuiltInSection(id)) { write(orgId, read(orgId).filter((section) => section.id !== id)); pendingMoves.delete(id); }
}

/** Put a project in a section, or in none (`null`); it leaves the section it was in. */
export function moveProjectToSection(orgId: string, project: string, sectionId: string | null, workspaceIds: string[] = []) {
  if (sectionId && isBuiltInSection(sectionId)) return;
  write(
    orgId,
    read(orgId).map((section) => {
      const rest = section.projects.filter((id) => id !== project);
      const workspaces = section.workspaces?.filter((id) => !workspaceIds.includes(id));
      return { ...section, projects: section.id === sectionId ? [...rest, project] : rest,
        ...(workspaces ? { workspaces: section.id === sectionId ? [...workspaces, ...workspaceIds] : workspaces } : {}),
      };
    }),
  );
}

/** The section a project is in, if any. */
export function sectionOfProject(sections: readonly CloudSidebarSection[], project: string, workspaceIds?: readonly string[]): CloudSidebarSection | null {
  return sections.find((section) => section.workspaces && workspaceIds?.length ? workspaceIds.every((id) => section.workspaces!.includes(id)) : section.projects.includes(project)) ?? null;
}

/**
 * Split an organization's shown projects into its sections, in the reader's
 * order, and the projects in none. Within a section projects keep the
 * sidebar's own order (pinned first, then by name). A project a section
 * names that is not shown now (its workspaces were deleted, say) is simply
 * not listed; it returns to its section if it comes back.
 */
export function groupIntoSections(projects: readonly CloudProject[], sections: readonly CloudSidebarSection[]): { sections: { section: CloudSidebarSection; projects: CloudProject[] }[]; ungrouped: CloudProject[] } {
  const grouped = groupSidebarItems(projects, sections, (project) => project.identity, (section) => section.projects);
  return { sections: grouped.sections.map(({ section, items }) => ({ section, projects: items })), ungrouped: grouped.ungrouped };
}

// A section just created opens with its name ready to type over.
let renameNext: string | null = null;

function requestRename(id: string) {
  renameNext = id;
  holdMenuFocus();
}

// A menu that closes puts the focus back on its button; not when what it did was open a name field.
let focusHeld = false;

/** The next menu to close leaves the focus where it is (the name field about to take it). */
export function holdMenuFocus() {
  focusHeld = true;
}

/** For a menu's `onCloseAutoFocus`: keep the focus where it is when a name field asked to. */
export function keepFocusForNameField(event: Event) {
  if (!focusHeld) return;
  focusHeld = false;
  event.preventDefault();
}

/** Whether this section was just created and should open in rename mode (asked once). */
export function takeRenameRequest(id: string): boolean {
  if (renameNext !== id) return false;
  renameNext = null;
  return true;
}


export const MY_WORKSPACES = "builtin:mine";
export const SHARED_WORKSPACES = "builtin:shared";
export const isBuiltInSection = (id: string) => id === MY_WORKSPACES || id === SHARED_WORKSPACES;
export type CloudSectionSort = NonNullable<CloudSidebarSection["sort"]>;
export const CLOUD_SECTION_SORTS: { id: CloudSectionSort; label: string }[] = [{ id: "active", label: "Last active" }, { id: "created", label: "Date created" }, { id: "name", label: "Name" }];

/** Layout only: built-in identities never acquire rename/delete capabilities. */
export function updateCloudSection(orgId: string, id: string, patch: Pick<CloudSidebarSection, "icon" | "sort" | "collapsed">) {
  const sections = read(orgId);
  const existing = sections.find((section) => section.id === id);
  if (!existing && !isBuiltInSection(id)) return;
  const next = { ...(existing ?? { id, name: id === MY_WORKSPACES ? "My workspaces" : "Shared with me", projects: [], workspaces: [] }), ...patch };
  write(orgId, existing ? sections.map((section) => section.id === id ? next : section) : [...sections, next]);
}

/** Resolve old project membership without discarding the old preference. */
export function sectionWorkspaceIds(section: CloudSidebarSection, projects: readonly CloudProject[]): string[] {
  return section.workspaces ?? projects.filter((project) => section.projects.includes(project.identity)).flatMap((project) => project.workspaces.map((node) => node.item.workspace.id));
}

export function moveWorkspaceToSection(orgId: string, workspaceId: string, sectionId: string | null, projects: readonly CloudProject[]) {
  if (!projects.some((project) => project.orgId === orgId && project.workspaces.some((node) => node.item.workspace.id === workspaceId && node.item.workspace.you?.role !== "none"))) return;
  const sections = read(orgId);
  if (sectionId !== null && !sections.some((section) => section.id === sectionId && !isBuiltInSection(section.id))) return;
  write(orgId, sections.map((section) => {
    if (isBuiltInSection(section.id)) return section;
    const rest = sectionWorkspaceIds(section, projects).filter((id) => id !== workspaceId);
    return { ...section, workspaces: section.id === sectionId ? [...rest, workspaceId] : rest };
  }));
}

export function sortSectionWorkspaces(nodes: readonly CloudWorkspaceNode[], sort: CloudSectionSort = "active"): CloudWorkspaceNode[] {
  return [...nodes].sort((a, b) => {
    const left = a.item.workspace, right = b.item.workspace;
    const order = sort === "name" ? left.name.localeCompare(right.name) : sort === "created" ? right.createdAt - left.createdAt : (right.lastActivityAt ?? right.updatedAt) - (left.lastActivityAt ?? left.updatedAt);
    return order || a.key.localeCompare(b.key);
  });
}

/** A role granting management is not ownership. Only real list ownership classifies a row. */
export function workspaceBuiltIn(node: CloudWorkspaceNode, viewerUserId: string | undefined): string | null {
  const workspace = node.item.workspace;
  if (!viewerUserId || !workspace.createdBy || workspace.you?.role === "none") return null;
  if (workspace.createdBy === viewerUserId) return MY_WORKSPACES;
  return workspace.you ? SHARED_WORKSPACES : null;
}
