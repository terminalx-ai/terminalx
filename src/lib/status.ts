import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { statusBar, type StatusBarSettings } from "@/lib/api";

interface StatusState {
  settings: StatusBarSettings;
  ready: boolean;
}

const defaults: StatusBarSettings = { visible: true, usage: true, resources: true, percent: "used" };
let state: StatusState = { settings: defaults, ready: false };
const listeners = new Set<() => void>();

function set(patch: Partial<StatusState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function useStatus(): StatusState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

let booted: Promise<void> | null = null;
export function bootStatus(): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen<StatusBarSettings>("status_bar_settings", (event) => set({ settings: event.payload, ready: true }));
      set({ settings: await statusBar.settings(), ready: true });
    } catch {
      set({ ready: true });
    }
  })());
}

export async function setStatusSettings(patch: Partial<StatusBarSettings>) {
  const previous = state.settings;
  set({ settings: { ...previous, ...patch } });
  try {
    set({ settings: await statusBar.setSettings(patch), ready: true });
  } catch (error) {
    set({ settings: previous });
    throw error;
  }
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
