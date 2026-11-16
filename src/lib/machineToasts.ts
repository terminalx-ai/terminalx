import { useSyncExternalStore } from "react";
import type { MachineRouteUsed } from "@/types/machines";

/**
 * The machine toasts of screen 21.09 that are not a session's: "Connected to
 * Mac mini" when a machine comes back, and "Couldn't pair with dev-server"
 * when a pairing fails while the person is away from this window (at the
 * other computer, choosing Allow). A machine session that needs the person is
 * a session notice (`raiseMachineAttention` in `notify.ts`).
 */
export type MachineToast =
  | { id: string; kind: "connected"; machineId: string; name: string; route: MachineRouteUsed; at: number }
  | { id: string; kind: "pairFailed"; name: string; detail: string; retry: (() => void) | null; at: number };

/** A connected toast goes after this long; a pairing failure stays until it is closed or tried again. */
export const CONNECTED_TOAST_MS = 6000;

let toasts: MachineToast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let next = 0;

function emit() {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const read = () => toasts;

export function useMachineToasts(): MachineToast[] {
  return useSyncExternalStore(subscribe, read, read);
}

export function getMachineToasts(): MachineToast[] {
  return toasts;
}

export function dismissMachineToast(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

/** "Connected to Mac mini": one per machine, the newest replacing an older one. */
export function noteMachineConnected(machineId: string, name: string, route: MachineRouteUsed) {
  for (const toast of toasts) if (toast.kind === "connected" && toast.machineId === machineId) dismissMachineToast(toast.id);
  const id = `connected:${machineId}:${++next}`;
  toasts = [...toasts, { id, kind: "connected", machineId, name, route, at: Date.now() }];
  timers.set(id, setTimeout(() => dismissMachineToast(id), CONNECTED_TOAST_MS));
  emit();
}

/** A machine that is not connected any more takes its "Connected" toast with it. */
export function dropMachineConnected(machineId: string) {
  for (const toast of toasts) if (toast.kind === "connected" && toast.machineId === machineId) dismissMachineToast(toast.id);
}

/** "Couldn't pair with dev-server"; returns its id, so the pairing that raised it can take it back. */
export function noteMachinePairFailed(name: string, detail: string, retry: (() => void) | null): string {
  const id = `pair:${++next}`;
  toasts = [...toasts.filter((toast) => toast.kind !== "pairFailed"), { id, kind: "pairFailed", name, detail, retry, at: Date.now() }];
  emit();
  return id;
}

/** For tests. */
export function resetMachineToastsForTests() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  toasts = [];
  next = 0;
  listeners.clear();
}
