import { useSyncExternalStore } from "react";
import type { CleanupStep } from "@terminalx/portable/workspace";
import { holdQuit } from "@/lib/quitWarning";
import { forgetWorkspaceSize } from "@/lib/workspaceSizes";
import { LOCAL_HOST, candidateKey, runCleanup, totals, type CleanupHost, type CleanupOutcome, type CleanupSelection, type CleanupTotals } from "@/lib/worktreeCleanup";

/**
 * The worktree clean-up that is running, or the one that just finished.
 *
 * It lives here, not in the dialog: the dialog and the corner indicator are
 * two views of it, and it carries on when neither is on screen. There is
 * only ever one. Hiding the dialog, or stopping the run, changes nothing
 * about what a host removes: each still checks every worktree again itself.
 */

/** One worktree that was confirmed for removal, as the views name it. */
export interface CleanupRunItem {
  /** `candidateKey(hostId, path)`. */
  key: string;
  hostId: string;
  hostName: string;
  hostKind: CleanupHost["kind"];
  name: string;
  path: string;
  /** What the review measured it at; null when it never did. */
  estimatedBytes: number | null;
}

export interface CleanupRun {
  status: "running" | "done";
  /** Asked to stop: the worktree under way is finished and the rest are left. */
  stopping: boolean;
  /** Everything that was confirmed, in the order it is removed. */
  items: CleanupRunItem[];
  /** What each came to, as far as it is known. */
  outcomes: CleanupOutcome[];
  /** The worktree being handled now, and the step when its host says. */
  current: { key: string; step: CleanupStep | null } | null;
}

let run: CleanupRun | null = null;
let abort: AbortController | null = null;
const listeners = new Set<() => void>();

function set(next: CleanupRun | null) {
  run = next;
  for (const listener of listeners) listener();
}

export function getCleanupRun(): CleanupRun | null {
  return run;
}

export function useCleanupRun(): CleanupRun | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => run,
    () => run,
  );
}

/**
 * Remove what was confirmed. `hosts` are the ones the review scanned: every
 * selection belongs to one of them. Returns false, and starts nothing, while
 * a run is under way.
 */
export function startCleanupRun(hosts: CleanupHost[], selections: CleanupSelection[]): boolean {
  if (run?.status === "running" || !selections.length) return false;
  const host = (id: string) => hosts.find((entry) => entry.id === id);
  // In the order the hosts are asked, which is the order the outcomes arrive in.
  const ordered = hosts.flatMap((entry) => selections.filter((selection) => selection.hostId === entry.id));
  const items: CleanupRunItem[] = ordered.map(({ hostId, candidate, estimatedBytes }) => ({
    key: candidateKey(hostId, candidate.path),
    hostId,
    hostName: host(hostId)?.name ?? hostId,
    hostKind: host(hostId)?.kind ?? "local",
    name: candidate.name,
    path: candidate.path,
    estimatedBytes: typeof estimatedBytes === "number" ? estimatedBytes : null,
  }));
  const started: CleanupRun = { status: "running", stopping: false, items, outcomes: [], current: null };
  const controller = new AbortController();
  abort = controller;
  set(started);
  const release = holdQuit("A worktree clean-up is still running. If you quit now, the worktree it is on may be left half removed, and the ones after it are not removed.");
  // Only this run's own progress is written: a later run has its own.
  const mine = () => abort === controller;
  void runCleanup(
    hosts,
    ordered,
    ({ outcomes, current }) => {
      if (mine() && run) set({ ...run, outcomes, current: current && { key: candidateKey(current.hostId, current.path), step: current.step } });
    },
    controller.signal,
  )
    .then(
      (outcomes) => outcomes,
      // `runCleanup` answers for every worktree itself; should it ever throw, what it reported so far stands.
      () => (mine() && run ? run.outcomes : []),
    )
    .then((outcomes) => {
      release();
      if (!mine() || !run) return;
      for (const outcome of outcomes) {
        if (outcome.hostId === LOCAL_HOST && outcome.outcome === "removed") forgetWorkspaceSize(outcome.path);
      }
      set({ ...run, status: "done", stopping: false, outcomes, current: null });
    });
  return true;
}

/** Leave the worktrees that were not started. The one being removed is finished first, never interrupted. */
export function stopCleanupRun() {
  if (run?.status !== "running" || run.stopping) return;
  set({ ...run, stopping: true });
  abort?.abort();
}

/** Forget a finished run: its results were read, or dismissed. A running one is never forgotten. */
export function clearCleanupRun() {
  if (run?.status !== "done") return;
  abort = null;
  set(null);
}

/** For tests: forget whatever run there is, and stop hearing from it. */
export function resetCleanupRun() {
  abort = null;
  set(null);
}

/** A run in numbers, for either view. */
export interface CleanupRunSummary extends CleanupTotals {
  total: number;
  /** How many have an outcome. */
  done: number;
  /** What the review measured for everything that was confirmed. */
  expectedBytes: number;
  /** How many were never measured: `expectedBytes` is then a lower bound. */
  unsized: number;
  /** Skipped, failed or not known: what is worth a look, and is never dismissed for the person. */
  problems: number;
}

export function summarize(current: CleanupRun): CleanupRunSummary {
  const sum = totals(current.outcomes);
  return {
    ...sum,
    total: current.items.length,
    done: Math.min(current.outcomes.length, current.items.length),
    expectedBytes: current.items.reduce((bytes, item) => bytes + (item.estimatedBytes ?? 0), 0),
    unsized: current.items.filter((item) => item.estimatedBytes === null).length,
    problems: sum.skipped + sum.failed,
  };
}
