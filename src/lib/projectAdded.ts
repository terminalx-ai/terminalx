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
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => added, () => null);
}

const settingsListeners = new Set<(projectPath: string) => void>();

/** Ask the app shell to open Settings on this project's scripts. */
export function requestProjectSettings(projectPath: string) {
  for (const listener of [...settingsListeners]) listener(projectPath);
}

export function onProjectSettingsRequest(listener: (projectPath: string) => void): () => void {
  settingsListeners.add(listener);
  return () => { settingsListeners.delete(listener); };
}
