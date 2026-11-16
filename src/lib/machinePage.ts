import { useSyncExternalStore } from "react";
import { invoke } from "@/lib/api";
import { openSettingRow } from "@/lib/settingsLinks";
import type { PairedMachine } from "@/types/machines";

/**
 * Opening a machine's page (Settings → Machines, 21.10) from elsewhere: the
 * new-session form's "Open its machine page" for an agent not signed in
 * there (PRO-350). Settings opens at Your machines, which takes the request
 * and shows the page.
 */
let requested: string | null = null;
const listeners = new Set<() => void>();
function publish(next: string | null) {
  requested = next;
  for (const listener of [...listeners]) listener();
}

export function openMachinePage(machineId: string) {
  publish(machineId);
  openSettingRow("machines.yours");
}

/** The machine whose page was asked for and not shown yet. */
export function useMachinePageRequest(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => requested,
    () => requested,
  );
}

/** Shown: the request is spent. */
export function takeMachinePageRequest(machineId: string) {
  if (requested === machineId) publish(null);
}

/**
 * Rename a paired machine on this Mac: the name its card, sidebar section
 * and page show. `machines_rename` keeps it with the machine's record; the
 * machine itself is not changed.
 */
export function renameMachine(machineId: string, name: string): Promise<PairedMachine> {
  return invoke<PairedMachine>("machines_rename", { machineId, name });
}
