import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { experimental, type ExperimentalSettings } from "@/lib/api";

/**
 * Settings → Experimental as every view sees it: read once, then kept current
 * from `experimental_settings_changed` (Settings, the settings file, a paired
 * phone). Off until it is known: an experiment is never shown on a guess.
 */
let current: ExperimentalSettings | null = null;
const listeners = new Set<() => void>();
let booted: Promise<void> | null = null;

function set(next: Partial<ExperimentalSettings>) {
  current = { nativeCodex: false, orchestratorRuns: false, ...current, ...next };
  for (const listener of [...listeners]) listener();
}

function boot(): Promise<void> {
  return (booted ??= (async () => {
    try {
      await listen<Partial<ExperimentalSettings>>("experimental_settings_changed", (event) => {
        if (event.payload && typeof event.payload === "object") set(event.payload);
      });
    } catch {
      // No event bus (a test, the demo): the read below still answers.
    }
    try {
      const read = await experimental.settings();
      if (read) set(read);
    } catch {
      booted = null;
    }
  })());
}

/** Take a change made in this window at once, before its event comes back. */
export function noteExperimentalSettings(next: ExperimentalSettings) {
  set(next);
}

export function useExperimentalSettings(): ExperimentalSettings | null {
  useEffect(() => {
    void boot();
  }, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}

/** For tests: forget what was read. */
export function resetExperimentalSettingsForTests() {
  current = null;
  booted = null;
  listeners.clear();
}
