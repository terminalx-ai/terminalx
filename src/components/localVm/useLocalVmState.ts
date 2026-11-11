import { useSyncExternalStore } from "react";
import { errorMessage } from "@/lib/api";
import { localVmRequest } from "@/lib/localVm";
import type { LocalVmState } from "@/types/localVm";

const EMPTY = { state: null, error: null, refreshing: false };
let snapshot: { state: LocalVmState | null; error: string | null; refreshing: boolean } = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let reading: Promise<void> | null = null;

function publish(next: typeof snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** All visible cards/settings share one serial read loop. This never calls task.submit. */
export function refreshLocalVmState(): Promise<void> {
  if (reading) return reading;
  clearTimeout(timer);
  publish({ ...snapshot, refreshing: true });
  reading = localVmRequest("state", {}).then(
    (state) => publish({ state, error: null, refreshing: false }),
    (error) => publish({ ...snapshot, error: errorMessage(error), refreshing: false }),
  ).finally(() => {
    reading = null;
    if (listeners.size) timer = setTimeout(() => void refreshLocalVmState(), 3000);
  });
  return reading;
}

/** Read after any in-flight poll, so a pre-mutation response cannot hide its result. */
export async function reconcileLocalVmState(): Promise<void> {
  if (reading) await reading;
  await refreshLocalVmState();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) void refreshLocalVmState();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) clearTimeout(timer);
  };
}
const noopSubscribe = () => () => {};
const getSnapshot = () => snapshot;
const getEmpty = () => EMPTY;

export function useLocalVmState(enabled = true) {
  return useSyncExternalStore(enabled ? subscribe : noopSubscribe, enabled ? getSnapshot : getEmpty, getEmpty);
}
