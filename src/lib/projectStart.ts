import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { setPrefs } from "@/lib/prefs";
import { addProject, startSessionIn } from "@/lib/sessions";
import type { Project } from "@/types/session";

/**
 * The three ways to a local project: a folder already on this computer, a
 * repository cloned from GitHub (or any Git URL), and a new empty one. Each
 * ends in the same place, a project attached and its new-session view open
 * with the composer focused. The start screen, the sidebar's empty state and
 * the command palette all go through here.
 */

export interface GithubRepository {
  nameWithOwner: string;
  description?: string | null;
  isPrivate: boolean;
  pushedAt?: string | null;
}

/** The reader's repositories through `gh`, or why there is no list. */
export type GithubRepositories =
  | { status: "ready"; repositories: GithubRepository[]; truncated: boolean }
  | { status: "missing" }
  | { status: "signed-out" }
  | { status: "failed"; message: string };

export interface CloneProgress {
  id: string;
  stage: string;
  percent: number | null;
}

export interface CloneOutcome {
  path: string;
  /** The repository was already cloned there; nothing was fetched. */
  existing: boolean;
}

export interface StartDefaults {
  projectsDir: string;
  suggestedName: string;
}

export type StartFailureCode =
  | "invalid-source"
  | "invalid-name"
  | "invalid-destination"
  | "destination-exists"
  | "access-denied"
  | "network"
  | "timed-out"
  | "disk-full"
  | "canceled"
  | "failed";

export interface StartFailure {
  code: StartFailureCode;
  message: string;
}

/** What a failed start command threw, as a code the screen can act on and a message to show. */
export function startFailure(cause: unknown): StartFailure {
  if (cause && typeof cause === "object" && "code" in cause && "message" in cause) {
    const { code, message } = cause as { code: unknown; message: unknown };
    return { code: String(code) as StartFailureCode, message: String(message) };
  }
  return { code: "failed", message: typeof cause === "string" ? cause : cause instanceof Error ? cause.message : String(cause) };
}

export const projectStart = {
  githubRepositories: () => invoke<GithubRepositories>("github_repositories"),
  clone: (id: string, source: string, parent: string) => invoke<CloneOutcome>("project_clone", { id, source, parent }),
  cancelClone: (id: string) => invoke<void>("project_clone_cancel", { id }),
  defaults: (parent: string | null) => invoke<StartDefaults>("project_start_defaults", { parent }),
  create: (parent: string, name: string) => invoke<string>("project_create", { parent, name }),
  /** Progress of the clone started with `id`, until the returned function is called. */
  async onCloneProgress(id: string, onProgress: (progress: CloneProgress) => void): Promise<() => void> {
    try {
      return await listen<CloneProgress>("project_clone_progress", ({ payload }) => {
        if (payload.id === id) onProgress(payload);
      });
    } catch {
      // Outside a webview there is no event stream; the clone still resolves.
      return () => {};
    }
  },
};

function focusComposer() {
  setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea[data-new-session-prompt]")?.focus(), 0);
}

/** Attach the folder at `path` as a project and land on its new-session view, ready to type. */
export async function attachProject(path: string): Promise<Project> {
  const project = await addProject(path);
  setPrefs({ lastProject: project.path });
  startSessionIn(project.path, null);
  focusComposer();
  return project;
}

/** "Open local project": the folder picker, then `attachProject`. Null when the reader backed out. */
export async function openLocalProject(): Promise<Project | null> {
  const dir = await openDialog({ directory: true, multiple: false, title: "Open a project" });
  return typeof dir === "string" ? attachProject(dir) : null;
}

/** Ask for a folder to put a project in, starting from `current`. Null when the reader backed out. */
export async function chooseProjectsDir(current: string | null): Promise<string | null> {
  const dir = await openDialog({ directory: true, multiple: false, title: "Choose where to put the project", defaultPath: current ?? undefined, canCreateDirectories: true });
  return typeof dir === "string" ? dir : null;
}

export type ProjectStartDialog = "github" | "quick";

let dialog: ProjectStartDialog | null = null;
const listeners = new Set<() => void>();

/** Open "Open GitHub project" or "Quick start" (or close whichever is open). */
export function openProjectStart(next: ProjectStartDialog | null) {
  dialog = next;
  for (const listener of [...listeners]) listener();
}

/** Whether one of the two dialogs is open. */
export function projectStartDialogOpen(): boolean {
  return dialog !== null;
}

export function useProjectStartDialog(): ProjectStartDialog | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => dialog,
    () => null,
  );
}

export interface StartAction {
  id: "local" | ProjectStartDialog;
  label: string;
  hint: string;
  run: () => void | Promise<unknown>;
}

/** The three actions, in the order every surface lists them. */
export const START_ACTIONS: StartAction[] = [
  { id: "local", label: "Open local project", hint: "Choose a folder on this computer", run: openLocalProject },
  { id: "github", label: "Open GitHub project", hint: "Clone one of your repositories, or any Git URL", run: () => openProjectStart("github") },
  { id: "quick", label: "Quick start", hint: "Create a new empty project to try things in", run: () => openProjectStart("quick") },
];
