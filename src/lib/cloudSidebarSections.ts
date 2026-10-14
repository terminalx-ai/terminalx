import { getAccount, useAccount } from "@/lib/account";
import type { AccountStatus } from "@/lib/api";
import { getPrefs, setPrefs, usePrefs, type CloudSidebarSection } from "@/lib/prefs";
import type { CloudProject } from "@/types/target";

/**
 * Personal named sections inside an organization's sidebar section (PRO-23):
 * the reader groups that organization's cloud projects under names of their
 * own ("Active", "Parked"), renames and reorders them, and moves projects
 * between them. They are this person's layout only, kept per account and per
 * organization in prefs, so they survive a relaunch and another account
 * signing in on this Mac never sees them. Nothing is sent to the server: a
 * layout shared by the organization can come later.
 *
 * A project belongs to at most one section, by its identity (the repository,
 * or `blank/<name>`), so it keeps its place while its workspaces come and go.
 * Projects in no section are listed after the sections, as before.
 */

/** Whose sections these are: the signed-in account; none while signed out (there are no organizations then). */
function owner(status: AccountStatus): string | null {
  return status.state === "signed-in" ? (status.identity?.email ?? null) : null;
}

function read(orgId: string, status: AccountStatus = getAccount().status): CloudSidebarSection[] {
  const who = owner(status);
  return (who && getPrefs().cloudSections[who]?.[orgId]) || [];
}

function write(orgId: string, sections: CloudSidebarSection[]) {
  const who = owner(getAccount().status);
  if (!who) return;
  const all = getPrefs().cloudSections;
  const mine = { ...all[who] };
  if (sections.length) mine[orgId] = sections;
  else delete mine[orgId];
  const next = { ...all };
  if (Object.keys(mine).length) next[who] = mine;
  else delete next[who];
  setPrefs({ cloudSections: next });
}

/** This account's sections in an organization, in their order. */
export function useCloudSidebarSections(orgId: string): CloudSidebarSection[] {
  const prefs = usePrefs();
  const { status } = useAccount();
  const who = owner(status);
  return (who && prefs.cloudSections[who]?.[orgId]) || EMPTY;
}

const EMPTY: CloudSidebarSection[] = [];

let counter = 0;
function newId(): string {
  counter += 1;
  return `s${Date.now().toString(36)}${counter.toString(36)}`;
}

/** The name a new section gets: "New section", then "New section 2", … whatever is free. */
export function freeSectionName(sections: readonly CloudSidebarSection[], base = "New section"): string {
  const taken = new Set(sections.map((section) => section.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** Add a section at the end, optionally with a project moved into it; returns its id. */
export function createCloudSection(orgId: string, project?: string): string {
  const sections = read(orgId).map((section) => (project ? { ...section, projects: section.projects.filter((id) => id !== project) } : section));
  const id = newId();
  write(orgId, [...sections, { id, name: freeSectionName(sections), projects: project ? [project] : [] }]);
  requestRename(id);
  return id;
}

/** Rename; a blank name keeps the old one. */
export function renameCloudSection(orgId: string, id: string, name: string) {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) return;
  write(orgId, read(orgId).map((section) => (section.id === id ? { ...section, name: trimmed } : section)));
}

/** Move a section up (-1) or down (+1) among this organization's sections. */
export function moveCloudSection(orgId: string, id: string, by: -1 | 1) {
  const sections = [...read(orgId)];
  const from = sections.findIndex((section) => section.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= sections.length) return;
  [sections[from], sections[to]] = [sections[to], sections[from]];
  write(orgId, sections);
}

/** Delete a section; its projects go back to the organization's ungrouped list. Nothing else changes. */
export function deleteCloudSection(orgId: string, id: string) {
  write(orgId, read(orgId).filter((section) => section.id !== id));
}

/** Put a project in a section, or in none (`null`); it leaves the section it was in. */
export function moveProjectToSection(orgId: string, project: string, sectionId: string | null) {
  write(
    orgId,
    read(orgId).map((section) => {
      const rest = section.projects.filter((id) => id !== project);
      return section.id === sectionId ? { ...section, projects: [...rest, project] } : { ...section, projects: rest };
    }),
  );
}

/** The section a project is in, if any. */
export function sectionOfProject(sections: readonly CloudSidebarSection[], project: string): CloudSidebarSection | null {
  return sections.find((section) => section.projects.includes(project)) ?? null;
}

/**
 * Split an organization's shown projects into its sections, in the reader's
 * order, and the projects in none. Within a section projects keep the
 * sidebar's own order (pinned first, then by name). A project a section
 * names that is not shown now (its workspaces were deleted, say) is simply
 * not listed; it returns to its section if it comes back.
 */
export function groupIntoSections(projects: readonly CloudProject[], sections: readonly CloudSidebarSection[]): { sections: { section: CloudSidebarSection; projects: CloudProject[] }[]; ungrouped: CloudProject[] } {
  const placed = new Map<string, string>();
  for (const section of sections) for (const id of section.projects) if (!placed.has(id)) placed.set(id, section.id);
  return {
    sections: sections.map((section) => ({ section, projects: projects.filter((project) => placed.get(project.identity) === section.id) })),
    ungrouped: projects.filter((project) => !placed.has(project.identity)),
  };
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
