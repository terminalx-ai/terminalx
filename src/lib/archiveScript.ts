import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ArchiveFailure } from "@terminalx/portable/workspace";

export function archiveFailure(error: string): ArchiveFailure | null {
  // The local runtime's Refused display includes the control error code.
  const message = error.startsWith("internal: ") ? error.slice("internal: ".length) : error;
  if (!message.startsWith("ARCHIVE_SCRIPT_FAILED:")) return null;
  try {
    const value = JSON.parse(message.slice("ARCHIVE_SCRIPT_FAILED:".length));
    return typeof value.token === "string" && typeof value.pane === "string" && (typeof value.code === "number" || value.code === null) && typeof value.timedOut === "boolean" && (value.log == null || typeof value.log === "string") && (value.sessionsStopped === undefined || typeof value.sessionsStopped === "boolean")
      && (value.detail == null || typeof value.detail === "string") && (value.timeoutMinutes == null || typeof value.timeoutMinutes === "number") ? value : null;
  } catch { return null; }
}

/** The dialog's question: "Archive script failed (exit 1). Remove anyway?" */
export function archiveFailureTitle(failure: ArchiveFailure): string {
  return `Archive script failed (exit ${failure.code ?? "unknown"}). Remove anyway?`;
}

/** The line under the question: what the script said last, or that it timed out, and that nothing was removed. */
export function archiveFailureDetail(failure: ArchiveFailure): string {
  const minutes = failure.timeoutMinutes ?? 5;
  const what = failure.timedOut ? `The script timed out after ${minutes} minute${minutes === 1 ? "" : "s"}.` : failure.detail ? `It printed “${failure.detail}”.` : "";
  return [what, failure.sessionsStopped ? "Its sessions are stopped." : "", "The workspace is still there."].filter(Boolean).join(" ");
}

export function archiveFailureMessage(failure: ArchiveFailure): string {
  return `${archiveFailureTitle(failure)} ${archiveFailureDetail(failure)}`;
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
