import { useSyncExternalStore } from "react";
import { selectCloudWorkspace } from "@/lib/sessions";
import { machineSectionKey } from "@/types/target";

/**
 * "New session in this project" on a paired machine (PRO-346). The sidebar's
 * + chooses a project; the machine's view opens with its agent view's
 * new-agent form open for that project, since `session.create` on a machine
 * needs a `projectId`. The request is kept here until the view takes it.
 */
export interface MachineNewSessionRequest {
  machineId: string;
  projectId: string;
  /** Changes on every request, so asking twice for the same project opens the form again. */
  nonce: number;
}

let request: MachineNewSessionRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function publish() {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Open the machine's view with the new-agent form open for one of its projects. */
export function startMachineSession(machineId: string, projectId: string) {
  request = { machineId, projectId, nonce: ++nonce };
  publish();
  selectCloudWorkspace(machineSectionKey(machineId));
}

/** The request for one machine, if one is waiting. */
export function useMachineNewSession(machineId: string): MachineNewSessionRequest | null {
  const current = useSyncExternalStore(subscribe, () => request, () => request);
  return current?.machineId === machineId ? current : null;
}

/** The form has opened (or was dismissed): the request is spent. */
export function takeMachineNewSession(spent: MachineNewSessionRequest) {
  if (request?.nonce !== spent.nonce) return;
  request = null;
  publish();
}

/** For tests. */
export function resetMachineNewSessionForTests() {
  request = null;
  listeners.clear();
}
