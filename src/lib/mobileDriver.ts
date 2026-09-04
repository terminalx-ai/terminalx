import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

let driven = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

function publish(next: Set<string>) {
  driven = next;
  for (const listener of listeners) listener();
}

async function subscribeBackend() {
  try {
    const unlisten = await listen<{ tabId: string; active: boolean }>("mobile_terminal_driver", ({ payload }) => {
      version++;
      const next = new Set(driven);
      if (payload.active) next.add(payload.tabId);
      else next.delete(payload.tabId);
      publish(next);
    });
    const before = version;
    const current = await invoke<string[]>("mobile_terminal_drivers");
    if (version === before) publish(new Set(current));
    return unlisten;
  } catch {
    return () => undefined;
  }
}

void subscribeBackend();

export function useMobileDrivenTabs(): Set<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => driven,
    () => driven,
  );
}
