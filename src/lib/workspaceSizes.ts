import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";

/**
 * What each workspace takes on disk. Measuring walks the whole checkout, so
 * it is asked for one workspace at a time after the list is shown, and
 * remembered until the app restarts or `forgetWorkspaceSize` is called.
 */
let sizes: Record<string, number> = {};
const asked = new Set<string>();
const listeners = new Set<() => void>();

function publish(path: string, bytes: number) {
  sizes = { ...sizes, [path]: bytes };
  for (const listener of listeners) listener();
}

function measure(projectPath: string, path: string) {
  if (asked.has(path)) return;
  asked.add(path);
  api
    .workspaceSize(projectPath, path)
    // Anything but a number is treated as "not known".
    .then((bytes) => (typeof bytes === "number" && Number.isFinite(bytes) ? publish(path, bytes) : undefined))
    // Not knowing a size is not worth a message: the row simply shows none.
    .catch(() => asked.delete(path));
}

/** Forget a size so it is measured again the next time its row is shown. */
export function forgetWorkspaceSize(path: string) {
  asked.delete(path);
  if (path in sizes) {
    const next = { ...sizes };
    delete next[path];
    sizes = next;
    for (const listener of listeners) listener();
  }
}

/** Sizes by workspace path, measured lazily while `active`. */
export function useWorkspaceSizes(projectPath: string, paths: string[], active: boolean): Record<string, number> {
  const key = paths.join("\n");
  useEffect(() => {
    if (!active) return;
    for (const path of key ? key.split("\n") : []) measure(projectPath, path);
  }, [active, projectPath, key]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sizes,
    () => sizes,
  );
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}
