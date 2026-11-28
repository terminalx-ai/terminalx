import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@/lib/api";
import type { AccountStatus } from "@/lib/api";
import { phase2Ready } from "@/lib/phase2Readiness";
import { defaultOrgId } from "@/lib/cloudCatalog";
import { getDraft, setDraft } from "@/lib/drafts";

/**
 * Team artifacts (PRO-158): pages, notes and templates published for
 * everyone in an organization. The server keeps every version; the desktop
 * lists them on the overview, opens them in a viewer, and offers templates
 * in a session's Artifacts tab.
 */

export interface TeamArtifactPerson {
  id: string;
  name: string | null;
}

export type TeamArtifactContentType = "text/markdown" | "text/html" | "text/plain";

export interface TeamArtifact {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  template: boolean;
  contentType: TeamArtifactContentType;
  sizeBytes: number;
  version: number;
  author: TeamArtifactPerson | null;
  updatedBy: TeamArtifactPerson | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  canDelete: boolean;
}

export interface TeamArtifactVersion {
  version: number;
  contentType: TeamArtifactContentType;
  sizeBytes: number;
  note: string | null;
  source: string | null;
  author: TeamArtifactPerson | null;
  createdAt: string;
}

export interface TeamArtifactDetail {
  artifact: TeamArtifact;
  versions: TeamArtifactVersion[];
}

export interface TeamArtifactContent {
  artifactId: string;
  version: number;
  contentType: TeamArtifactContentType;
  content: string;
}

export interface TeamArtifactPublishInput {
  title: string;
  contentType: TeamArtifactContentType;
  content: string;
  slug?: string;
  template?: boolean;
  description?: string;
  note?: string;
  source?: string;
  /** What the publisher saw of the slug: none had it, or its current version. The server refuses with team_artifact_slug_taken when that changed. */
  expect?: TeamArtifactExpect;
}

export type TeamArtifactExpect = "new" | { version: number };

/** The file picked for Publish…: its text, or why it cannot be published. */
export interface PickedArtifactFile {
  name: string;
  content: string | null;
  refused: "unreadable" | "too_large" | "not_text" | null;
}

export const teamArtifactsApi = {
  list: (orgId: string) => invoke<{ artifacts: TeamArtifact[] }>("team_artifacts_list", { orgId }),
  get: (orgId: string, artifactId: string) => invoke<TeamArtifactDetail>("team_artifact_get", { orgId, artifactId }),
  content: (orgId: string, artifactId: string, version: number) => invoke<TeamArtifactContent>("team_artifact_content", { orgId, artifactId, version }),
  publish: (orgId: string, input: TeamArtifactPublishInput) => invoke<{ artifact: TeamArtifact; created: boolean }>("team_artifact_publish", { orgId, input }),
  remove: (orgId: string, artifactId: string) => invoke<{ deleted: boolean; id: string }>("team_artifact_delete", { orgId, artifactId }),
  removeVersion: (orgId: string, artifactId: string, version: number) =>
    invoke<{ deleted: boolean; artifactId: string; version: number }>("team_artifact_version_delete", { orgId, artifactId, version }),
  /** The native picker, for an organization that has team artifacts. */
  pickFile: (orgId: string) => invoke<PickedArtifactFile | null>("team_artifact_pick_file", { orgId }),
};

/** "Let agents publish team artifacts" (PRO-158): kept in native code, which reads it before any publish. */
export const teamArtifactsPublishSetting = {
  get: () => invoke<boolean>("team_artifacts_publish_setting"),
  set: (enabled: boolean) => invoke<{ enabled: boolean; refused: string | null }>("team_artifacts_publish_set_setting", { enabled }),
};

/** The organizations whose team artifacts this account may use, the active one first. */
export function teamArtifactOrgs(status: AccountStatus): string[] {
  if (status.state !== "signed-in") return [];
  const ids = (status.organizations ?? []).map((org) => org.id).filter((id) => phase2Ready(status, id, "teamArtifacts"));
  const active = defaultOrgId(status);
  return active && ids.includes(active) ? [active, ...ids.filter((id) => id !== active)] : ids;
}

/** The organization the overview's Team panel and the template picker show. */
export function teamArtifactOrg(status: AccountStatus): string | null {
  return teamArtifactOrgs(status)[0] ?? null;
}

export function contentTypeForName(name: string): TeamArtifactContentType | null {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  if (extension === "md" || extension === "markdown") return "text/markdown";
  if (extension === "html" || extension === "htm") return "text/html";
  if (extension === "txt" || extension === "text") return "text/plain";
  return null;
}

export function slugify(title: string): string {
  const slug = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return slug || "artifact";
}

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function kindLabel(type: TeamArtifactContentType): string {
  return type === "text/html" ? "HTML page" : type === "text/markdown" ? "Markdown" : "Text";
}

/** "Inserts the @slug in the composer": at the caret's end of the tab's draft, with a space either side. */
export function insertTemplateSlug(tabId: string, slug: string) {
  const current = getDraft(tabId);
  setDraft(tabId, `${current}${current && !/\s$/.test(current) ? " " : ""}@${slug} `);
}

// ---- The list, shared by the overview and the picker ------------------------

/** How often an open list asks again: a teammate's publish shows within a minute. */
export const TEAM_ARTIFACTS_POLL_MS = 30_000;

interface ListState {
  artifacts: TeamArtifact[] | null;
  error: string | null;
  loading: boolean;
}

const EMPTY: ListState = { artifacts: null, error: null, loading: false };
const lists = new Map<string, ListState>();
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();
const generation = new Map<string, number>();

function emit() {
  for (const listener of [...listeners]) listener();
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") return (error as { code: string }).code;
  return "team_artifacts_unavailable";
}

/** Read the organization's list again; concurrent asks share one call. */
export function refreshTeamArtifacts(orgId: string): Promise<void> {
  const running = inFlight.get(orgId);
  if (running) return running;
  const ticket = (generation.get(orgId) ?? 0) + 1;
  generation.set(orgId, ticket);
  lists.set(orgId, { ...(lists.get(orgId) ?? EMPTY), loading: true });
  emit();
  const work = teamArtifactsApi.list(orgId)
    .then(({ artifacts }) => {
      if (generation.get(orgId) === ticket) lists.set(orgId, { artifacts, error: null, loading: false });
    })
    .catch((error: unknown) => {
      // A failed refresh keeps what was shown, and says so.
      if (generation.get(orgId) === ticket) lists.set(orgId, { ...(lists.get(orgId) ?? EMPTY), error: errorCode(error), loading: false });
    })
    .finally(() => {
      inFlight.delete(orgId);
      emit();
    });
  inFlight.set(orgId, work);
  return work;
}

/** Put a publish or delete in the list at once, ahead of the next read. */
export function noteTeamArtifact(orgId: string, change: { saved: TeamArtifact } | { removed: string }) {
  const state = lists.get(orgId) ?? EMPTY;
  const rest = (state.artifacts ?? []).filter((item) => item.id !== ("saved" in change ? change.saved.id : change.removed));
  lists.set(orgId, { ...state, artifacts: "saved" in change ? [change.saved, ...rest] : rest });
  emit();
}

/** For tests. */
export function resetTeamArtifacts() {
  lists.clear();
  inFlight.clear();
  generation.clear();
  emit();
}

/** The organization's artifacts, newest first, read now and every 30 s while shown. */
export function useTeamArtifacts(orgId: string | null): ListState {
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (orgId ? lists.get(orgId) ?? EMPTY : EMPTY),
  );
  useEffect(() => {
    if (!orgId) return;
    void refreshTeamArtifacts(orgId);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refreshTeamArtifacts(orgId);
    }, TEAM_ARTIFACTS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [orgId]);
  return state;
}

// ---- Which artifact the overview shows ---------------------------------------

export interface OpenArtifact {
  orgId: string;
  id: string;
  /** A version other than the current one; null for the current. */
  version: number | null;
}

let opened: OpenArtifact | null = null;
const openListeners = new Set<() => void>();

export function openTeamArtifact(next: OpenArtifact | null) {
  opened = next;
  for (const listener of [...openListeners]) listener();
}

export function useOpenTeamArtifact(): OpenArtifact | null {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    () => opened,
  );
}
