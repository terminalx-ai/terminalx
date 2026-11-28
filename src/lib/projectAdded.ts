import { useSyncExternalStore } from "react";
import type { Project } from "@/types/session";

/**
 * "Project added": the one notice that follows adding a project, whichever of
 * the three start actions did it. It names the folder and offers the way to
 * that project's settings. Only the latest addition is kept.
 */

export interface ProjectAdded {
  path: string;
  name: string;
  /** Bumped per announcement so adding the same project again shows the notice again. */
  request: number;
}

let added: ProjectAdded | null = null;
let requests = 0;
const listeners = new Set<() => void>();
const __subscribe_listeners = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const emit = () => { for (const listener of [...listeners]) listener(); };

export function announceProjectAdded(project: Pick<Project, "path" | "name">) {
  added = { path: project.path, name: project.name, request: ++requests };
  emit();
}

export function dismissProjectAdded() {
  if (!added) return;
  added = null;
  emit();
}

export function useProjectAdded(): ProjectAdded | null {
  return useSyncExternalStore(__subscribe_listeners, () => added, () => null);
}

const settingsListeners = new Set<(projectPath: string, page: ProjectSettingsPage) => void>();

/** Which of a project's settings pages to open: its general page, or its Scripts (setup, run, actions). */
export type ProjectSettingsPage = "general" | "scripts";

/** Ask the app shell to open Settings on this project: its scripts unless another page is named. */
export function requestProjectSettings(projectPath: string, page: ProjectSettingsPage = "scripts") {
  for (const listener of [...settingsListeners]) listener(projectPath, page);
}

export function onProjectSettingsRequest(listener: (projectPath: string, page: ProjectSettingsPage) => void): () => void {
  settingsListeners.add(listener);
  return () => { settingsListeners.delete(listener); };
}
