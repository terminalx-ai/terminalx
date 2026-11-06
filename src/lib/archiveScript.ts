import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ArchiveFailure } from "@terminalx/portable/workspace";

export function archiveFailure(error: string): ArchiveFailure | null {
  if (!error.startsWith("ARCHIVE_SCRIPT_FAILED:")) return null;
  try {
    const value = JSON.parse(error.slice("ARCHIVE_SCRIPT_FAILED:".length));
    return typeof value.token === "string" && typeof value.pane === "string" && (typeof value.code === "number" || value.code === null) && typeof value.timedOut === "boolean" ? value : null;
  } catch { return null; }
}

export function archiveFailureMessage(failure: ArchiveFailure): string {
  return `Archive script failed (exit ${failure.code ?? "unknown"}). Remove anyway?${failure.timedOut ? " The script timed out after 5 minutes." : ""}`;
}

const panes = new Map<string, string>();
const subscribers = new Set<() => void>();
let listening: Promise<void> | null = null;
/** Armed before the removal RPC; also retains the current pane when a dialog is hidden. */
export function listenForArchiveScripts(): Promise<void> {
  if (!listening) listening = Promise.resolve(listen<{ path: string; pane: string }>("archive_script_started", ({ payload }) => {
    panes.delete(payload.path);
    panes.set(payload.path, payload.pane);
    if (panes.size > 100) panes.delete(panes.keys().next().value!);
    for (const changed of subscribers) changed();
  })).then(() => undefined).catch(() => { listening = null; });
  return listening;
}
const subscribe = (changed: () => void) => {
  subscribers.add(changed);
  return () => { subscribers.delete(changed); };
};
export function useArchiveTerminal(path: string | null) {
  useEffect(() => { void listenForArchiveScripts(); }, []);
  return useSyncExternalStore(subscribe, () => path ? panes.get(path) ?? null : null);
}
