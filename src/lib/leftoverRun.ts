import { useSyncExternalStore } from "react";
import { api, errorMessage } from "@/lib/api";
import { holdQuit } from "@/lib/quitWarning";
import type { Leftover, LeftoverRemoval } from "@/types/session";

/**
 * The removal of leftovers (Settings → Storage) that is running, or the one
 * that just finished. It lives here so it carries on, and can still be
 * followed, when Settings is left while it runs.
 */

export interface LeftoverRunItem {
  id: string;
  /** What the row is called in the list. */
  label: string;
  sizeBytes: number;
}

export interface LeftoverRun {
  status: "running" | "done";
  items: LeftoverRunItem[];
  /** Everything is being scanned again, before anything is deleted. */
  checking: boolean;
  /** The leftover being deleted now. */
  current: string | null;
  /** What each came to: `error` says why one was kept. */
  finished: { id: string; freedBytes: number; error: string | null }[];
  /** The whole removal failed: nothing more is known than what `finished` holds. */
  error: string | null;
  /** The result was shown where the removal was started, so the corner need not show it. */
  seen: boolean;
}

let run: LeftoverRun | null = null;
/** The Storage tab is on screen: it shows the run itself. */
let watched = false;
const listeners = new Set<() => void>();

function set(next: LeftoverRun | null) {
  run = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useLeftoverRun(): LeftoverRun | null {
  return useSyncExternalStore(subscribe, () => run, () => run);
}

/** Whether the Storage tab is showing the run, so nothing else needs to. */
export function useLeftoverRunWatched(): boolean {
  return useSyncExternalStore(subscribe, () => watched, () => watched);
}

/** The Storage tab says it is on screen (and, from the function returned, that it left). */
export function watchLeftoverRun(): () => void {
  watched = true;
  if (run?.status === "done" && !run.seen) run = { ...run, seen: true };
  for (const listener of listeners) listener();
  return () => {
    watched = false;
    for (const listener of listeners) listener();
    // A result that was read there is done with: the tab opens clean the next time. Not at once:
    // in development React leaves and comes straight back, and that is not the tab being left.
    queueMicrotask(() => {
      if (!watched && run?.status === "done" && run.seen) set(null);
    });
  };
}

export interface LeftoverTotals {
  deleted: number;
  kept: number;
  freedBytes: number;
}

export function leftoverTotals(current: LeftoverRun): LeftoverTotals {
  return {
    deleted: current.finished.filter((item) => !item.error).length,
    kept: current.finished.filter((item) => item.error).length,
    freedBytes: current.finished.reduce((sum, item) => sum + item.freedBytes, 0),
  };
}

/**
 * Delete the confirmed leftovers; the backend checks each again first.
 * Resolves when it is over, with null when one was already running.
 */
export async function startLeftoverRun(chosen: { item: Leftover; label: string }[]): Promise<LeftoverRun | null> {
  if (run?.status === "running" || !chosen.length) return null;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let mine: LeftoverRun = { status: "running", items: chosen.map(({ item, label }) => ({ id: item.id, label, sizeBytes: item.sizeBytes })), checking: true, current: null, finished: [], error: null, seen: false };
  const update = (patch: Partial<LeftoverRun>) => {
    mine = { ...mine, ...patch };
    set(mine);
  };
  set(mine);
  const release = holdQuit("Leftovers are still being deleted. If you quit now, the one being deleted may be left half removed, and the ones after it are not deleted.");
  const unlisten = await api.onLeftoverProgress(id, (progress) => {
    if (progress.kind === "checking") update({ checking: true, current: null });
    else if (progress.kind === "started") update({ checking: false, current: progress.id });
    else update({ checking: false, current: null, finished: [...mine.finished.filter((item) => item.id !== progress.id), { id: progress.id, freedBytes: progress.freedBytes, error: progress.error }] });
  });
  try {
    const removal: LeftoverRemoval = await api.removeLeftovers(
      chosen.map(({ item }) => item.id),
      id,
    );
    // The answer is what happened. What each one freed is only in its progress; without it the total stands alone.
    const freed = new Map(mine.finished.map((item) => [item.id, item.freedBytes]));
    const exact = removal.removed.every((removed) => freed.has(removed));
    const finished = [
      ...removal.removed.map((removed, index) => ({ id: removed, freedBytes: exact ? freed.get(removed)! : index === 0 ? removal.freedBytes : 0, error: null })),
      ...removal.failed.map((failed) => ({ id: failed.id, freedBytes: 0, error: failed.error })),
    ];
    update({ status: "done", checking: false, current: null, finished, seen: watched });
  } catch (error) {
    update({ status: "done", checking: false, current: null, error: errorMessage(error), seen: watched });
  } finally {
    unlisten();
    release();
  }
  return mine;
}

/** Forget a finished run. A running one is never forgotten. */
export function clearLeftoverRun() {
  if (run?.status === "done") set(null);
}

/** For tests: forget whatever run there is, and that anything was watching. */
export function resetLeftoverRun() {
  watched = false;
  set(null);
}
