import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { experimental, type ExperimentalSettings } from "@/lib/api";

/** Settings → Experimental, for the parts of the app a switch there shows or hides.
 * Off until read: a feature behind a switch never flashes on for someone who left it off. */
const OFF: ExperimentalSettings = { nativeCodex: false, orchestratorRuns: false, sessionCost: false };

let state: ExperimentalSettings = OFF;
const listeners = new Set<() => void>();
let booted = false;

function set(next: Partial<ExperimentalSettings> | null | undefined) {
  const merged = { ...OFF, ...state, ...(next ?? {}) };
  if (merged.nativeCodex === state.nativeCodex && merged.orchestratorRuns === state.orchestratorRuns && merged.sessionCost === state.sessionCost) return;
  state = merged;
  listeners.forEach((listener) => listener());
}

async function read() {
  try {
    set(await experimental.settings());
  } catch {
    /* outside a webview, or the file cannot be read: everything stays off */
  }
}

function boot() {
  if (booted) return;
  booted = true;
  // The settings watcher sends the whole section on every change to the file,
  // whoever made it: this window, another one, an editor, a paired phone.
  void listen<Partial<ExperimentalSettings>>("experimental_settings_changed", (event) => set(event.payload)).catch(() => null);
  void read();
}

/** What a save returned: shown at once, without waiting for the file watcher. */
export function noteExperimental(settings: Partial<ExperimentalSettings> | null | undefined) {
  set(settings);
}

/** `wanted: false` reads nothing and answers "all off": for a view no switch could change (a cloud session, a quick chat). */
export function useExperimental(wanted = true): ExperimentalSettings {
  const current = useSyncExternalStore(
    (listener) => {
      if (wanted) boot();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
  return wanted ? current : OFF;
}

/** The switches as last read, outside a component. The first call starts reading them. */
export function getExperimental(): ExperimentalSettings {
  boot();
  return state;
}

/** Tests start from a store that has read nothing. */
export function resetExperimentalForTests() {
  state = OFF;
  booted = false;
  listeners.clear();
}
