import { useSyncExternalStore } from "react";
import { PreparationError, runPreparation, type PreparationPhase, type PreparationRequest, type PreparationResult } from "@/lib/environmentPreparation";

// The one "Configure with an agent" run this app has going (PRO-20). It lives
// outside the Settings screen, so closing Settings does not cancel a run that
// takes many minutes: the run carries on, verifies and stops its machine, and
// its result is there when the screen is opened again. It belongs to the
// account context it was started under; under any other it is canceled.

export type EnvironmentRun =
  | { kind: "none" }
  | { kind: "running"; provider: string; contextRevision: string; phase: PreparationPhase }
  | { kind: "review"; provider: string; contextRevision: string; result: PreparationResult; baseRevision: number }
  /** `retry`: the start got no answer, so the same request (same key) may be sent again without making a second machine. */
  | { kind: "ended"; provider: string; contextRevision: string; message: string; retry: { request: PreparationRequest; baseRevision: number } | null };

let run: EnvironmentRun = { kind: "none" };
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

function set(next: EnvironmentRun) {
  run = next;
  for (const listener of listeners) listener();
}

export const getEnvironmentRun = () => run;

export function useEnvironmentRun(): EnvironmentRun {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getEnvironmentRun,
  );
}

/** Starts the run. Refused while another is going: one preparation machine at a time from this app. */
export function startEnvironmentRun(request: PreparationRequest, options: { baseRevision: number; onChange?: () => void }): boolean {
  if (run.kind === "running") return false;
  const { provider, contextRevision } = request.offer;
  const own = new AbortController();
  controller = own;
  set({ kind: "running", provider, contextRevision, phase: { step: "creating" } });
  void runPreparation(request, {
    signal: own.signal,
    onPhase: (phase) => {
      if (controller === own && run.kind === "running") set({ ...run, phase });
    },
    onWorkspace: () => options.onChange?.(),
  })
    .then((result) => {
      if (controller !== own) return;
      set({ kind: "review", provider, contextRevision, result, baseRevision: options.baseRevision });
    })
    .catch((failure) => {
      if (controller !== own) return;
      const unknown = failure instanceof PreparationError && failure.code === "create-outcome-unknown";
      set({
        kind: "ended",
        provider,
        contextRevision,
        // The run's own words: they say what became of the machine, and claim no more than the server answered.
        message: failure instanceof Error && failure.message ? failure.message : "The preparation run failed.",
        retry: unknown ? { request, baseRevision: options.baseRevision } : null,
      });
    })
    .finally(() => {
      if (controller === own) controller = null;
      options.onChange?.();
    });
  return true;
}

/** Sends a start that got no answer again, unchanged: the server answers with the machine it already made, if it made one. */
export function retryEnvironmentRun(onChange?: () => void): boolean {
  if (run.kind !== "ended" || !run.retry) return false;
  return startEnvironmentRun(run.retry.request, { baseRevision: run.retry.baseRevision, onChange });
}

/** Cancels a run in progress: the run then stops its machine and ends. */
export function cancelEnvironmentRun() {
  controller?.abort();
}

/** Forgets a finished run (a reviewed, saved or failed one). A run in progress is left alone. */
export function clearEnvironmentRun() {
  if (run.kind !== "running") set({ kind: "none" });
}

/**
 * Called with the account context the screen is showing. A run started under
 * another account or organization is canceled, and a finished one from there
 * is forgotten: its recipe would be saved into the wrong organization.
 */
export function keepEnvironmentRunFor(contextRevision: string) {
  if (run.kind === "none" || run.contextRevision === contextRevision) return;
  if (run.kind === "running") cancelEnvironmentRun();
  else set({ kind: "none" });
}

export function resetEnvironmentRunForTest() {
  controller = null;
  run = { kind: "none" };
}
