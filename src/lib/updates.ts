import { privacyEnabled, subscribeDataPrivacy } from "@/lib/dataPrivacy";
import { useSyncExternalStore } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorMessage, localRuntime, type LocalRuntimeWorkItem } from "@/lib/api";
import { getPrefs } from "@/lib/prefs";

/**
 * The app's own update, shared by every place that shows it: the sidebar's
 * Update button, the card in the corner, and Settings → About. Checked a
 * little after launch and then every few hours, so an update is seen without
 * going to look for it; nothing installs until the reader says so.
 *
 * The update brings the runtime with it (#766). The runtime outlives the app,
 * so the relaunched app replaces it with the one it came with; what that
 * would cut short is asked about here, before installing, once, and the
 * relaunched app follows the answer (`update_plan.rs`).
 */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; update: Update }
  /** Moving to the update's runtime would stop `work` in runtime `epoch`: Update now, or when they're done. `unkept`: the same, as the runtime names it, when it is handed over (#765). */
  | { kind: "choosing"; update: Update; epoch: string; work: string[]; unkept: LocalRuntimeWorkItem[] }
  | { kind: "installing"; version: string; pct: number }
  | { kind: "error"; message: string };

/** Update now stops what was listed; Update when they're done waits for it, by itself. */
export type UpdateChoice = "now" | "whenDone";

const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 4 * 60 * 60 * 1000;
const DISMISSED_KEY = "raccoon.update.dismissed";

let state = { kind: "idle" } as UpdateState;
let dismissed: string | null = readDismissed();
const listeners = new Set<() => void>();
/** What React reads: replaced on every change, the corner card's dismissal included. */
let snapshot: { state: UpdateState; dismissed: string | null } = { state, dismissed };

// Retire discovered updates and deferred choices on activation. An off/on
// round trip cannot resume an earlier check or installation decision.
let privacyGeneration = 0;
subscribeDataPrivacy(() => {
  if (privacyEnabled()) {
    ++privacyGeneration;
    emit({ kind: "idle" });
  }
});
const admitted = (generation: number) => !privacyEnabled() && generation === privacyGeneration;

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
  if (privacyEnabled()) return state;
  if (state.kind === "installing" || state.kind === "checking" || state.kind === "choosing") return state;
  if (quiet && state.kind === "available") return state;
  const before = state;
  const generation = privacyGeneration;
  if (!quiet) emit({ kind: "checking" });
  try {
    const update = await check({ headers: { "X-Raccoon-Channel": getPrefs().updateChannel } });
    if (!admitted(generation)) return state;
    emit(update?.version ? { kind: "available", update } : { kind: "none" });
  } catch (error) {
    if (!admitted(generation)) return state;
    emit(quiet ? before : { kind: "error", message: errorMessage(error) });
  }
  return state;
}

/** What the relaunched app is to do with the runtime attached now. */
interface RuntimePlan { epoch: string; forced: boolean; quietSince: number | null; stop: LocalRuntimeWorkItem[] }

/**
 * Install the update found and relaunch into it, with its runtime. When
 * moving to that runtime would cut nothing short it just installs, and the
 * relaunched app moves as it attaches. Otherwise nothing installs yet: the
 * card lists what would stop, for {@link chooseUpdate}. A runtime that cannot
 * be read is not asked about: the relaunched app waits until nothing it runs
 * would be cut short, and says so.
 */
export async function installUpdate(): Promise<void> {
  if (privacyEnabled() || state.kind !== "available") return;
  const generation = privacyGeneration;
  const update = state.update;
  emit({ kind: "installing", version: update.version, pct: 0 });
  const reading = await localRuntime.work().catch((error: unknown) => {
    console.warn(`TerminalX update: ${errorMessage(error)}`);
    return null;
  });
  if (!admitted(generation)) return;
  if (reading && reading.work.length > 0) {
    emit({ kind: "choosing", update, epoch: reading.epoch, work: reading.work, unkept: reading.unkept ?? [] });
    return;
  }
  await install(update, reading && { epoch: reading.epoch, forced: false, quietSince: reading.readAt, stop: [] }, generation);
}

/** The answer to what installing would cut short, or `null` to not update now. */
export async function chooseUpdate(choice: UpdateChoice | null): Promise<void> {
  if (privacyEnabled() || state.kind !== "choosing") return;
  const { update, epoch, unkept } = state;
  if (!choice) {
    emit({ kind: "available", update });
    return;
  }
  emit({ kind: "installing", version: update.version, pct: 0 });
  // Update now stops what the card listed, and, handed over, nothing else.
  await install(update, { epoch, forced: choice === "now", quietSince: null, stop: choice === "now" ? unkept : [] }, privacyGeneration);
}

async function install(update: Update, plan: RuntimePlan | null, generation: number): Promise<void> {
  if (!admitted(generation)) return;
  try {
    let total = 0;
    let got = 0;
    await update.downloadAndInstall((event) => {
      if (!admitted(generation)) return;
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        got += event.data.chunkLength;
        if (total) emit({ kind: "installing", version: update.version, pct: Math.round((got / total) * 100) });
      }
    });
    if (!admitted(generation)) return;
    // Left for the relaunched app. Without it, that app waits by itself
    // until nothing would be cut short, and says so: the app is installed
    // either way, and is relaunched into.
    if (plan) await localRuntime.planUpdate(plan.epoch, plan.forced, plan.quietSince, plan.stop).catch((error: unknown) => console.warn(`TerminalX update: ${errorMessage(error)}`));
    if (admitted(generation)) await relaunch();
  } catch (error) {
    if (admitted(generation)) emit({ kind: "error", message: errorMessage(error) });
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
