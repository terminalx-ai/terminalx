import { useSyncExternalStore } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorMessage } from "@/lib/api";
import { getPrefs } from "@/lib/prefs";

/**
 * The app's own update, shared by every place that shows it: the sidebar's
 * Update button, the card in the corner, and Settings → About. Checked a
 * little after launch and then every few hours, so an update is seen without
 * going to look for it; nothing installs until the reader says so.
 */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; update: Update }
  | { kind: "installing"; version: string; pct: number }
  | { kind: "error"; message: string };

const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 4 * 60 * 60 * 1000;
const DISMISSED_KEY = "raccoon.update.dismissed";

let state = { kind: "idle" } as UpdateState;
let dismissed: string | null = readDismissed();
const listeners = new Set<() => void>();
/** What React reads: replaced on every change, the corner card's dismissal included. */
let snapshot: { state: UpdateState; dismissed: string | null } = { state, dismissed };

function publish() {
  snapshot = { state, dismissed };
  for (const listener of listeners) listener();
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function emit(next: UpdateState) {
  state = next;
  publish();
}

export function getUpdateState(): UpdateState {
  return state;
}

/**
 * Ask the update server. `quiet` is the background check: it never replaces
 * an update already found, or one installing, with "checking", and a failure
 * leaves what was known (the reader did not ask, so it is not theirs to read).
 */
export async function checkForUpdate({ quiet = false }: { quiet?: boolean } = {}): Promise<UpdateState> {
  if (state.kind === "installing" || state.kind === "checking") return state;
  if (quiet && state.kind === "available") return state;
  const before = state;
  if (!quiet) emit({ kind: "checking" });
  try {
    const update = await check({ headers: { "X-Raccoon-Channel": getPrefs().updateChannel } });
    emit(update ? { kind: "available", update } : { kind: "none" });
  } catch (error) {
    emit(quiet ? before : { kind: "error", message: errorMessage(error) });
  }
  return state;
}

/** Download, install and relaunch into the update found. */
export async function installUpdate(): Promise<void> {
  if (state.kind !== "available") return;
  const update = state.update;
  emit({ kind: "installing", version: update.version, pct: 0 });
  try {
    let total = 0;
    let got = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        got += event.data.chunkLength;
        if (total) emit({ kind: "installing", version: update.version, pct: Math.round((got / total) * 100) });
      }
    });
    await relaunch();
  } catch (error) {
    emit({ kind: "error", message: errorMessage(error) });
  }
}

/** "Later" on the corner card: it stays away for this version; the sidebar button stays. */
export function dismissUpdateNotice(version: string) {
  dismissed = version;
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    /* the card simply comes back next launch */
  }
  publish();
}

export function useUpdate(): { state: UpdateState; noticeDismissed: boolean } {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
  return { state: current.state, noticeDismissed: current.state.kind === "available" && current.dismissed === current.state.update.version };
}

let started = false;

/** Start the background checks, once per window. Development builds have no updates to find. */
export function startUpdateChecks() {
  if (started || import.meta.env.DEV) return;
  started = true;
  window.setTimeout(() => void checkForUpdate({ quiet: true }), FIRST_CHECK_MS);
  window.setInterval(() => void checkForUpdate({ quiet: true }), EVERY_MS);
}
