import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { statusBar, type StatusBarSettings, type UsageSnapshot } from "@/lib/api";

interface StatusState {
  settings: StatusBarSettings;
  usage: UsageSnapshot;
  usageRefreshing: boolean;
  ready: boolean;
}

const defaults: StatusBarSettings = { visible: true, usage: true, resources: true, percent: "used" };
let state: StatusState = { settings: defaults, usage: { windows: [] }, usageRefreshing: false, ready: false };
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
      await listen<UsageSnapshot>("status_usage", (event) => set({ usage: event.payload }));
      const [settings, usage] = await Promise.all([statusBar.settings(), statusBar.usage()]);
      set({ settings, usage, ready: true });
      installFocusRefresh();
      void refreshUsage();
    } catch {
      set({ ready: true });
    }
  })());
}

let usageFlight: Promise<void> | null = null;
async function windowCanPoll(): Promise<boolean> {
  if (typeof document !== "undefined" && (document.hidden || !document.hasFocus())) return false;
  try {
    const current = getCurrentWindow();
    return (await current.isFocused()) && !(await current.isMinimized());
  } catch {
    return true;
  }
}

export function refreshUsage(manual = false): Promise<void> {
  if (usageFlight) return usageFlight;
  return (usageFlight = (async () => {
    if (!(await windowCanPoll())) return;
    set({ usageRefreshing: true });
    try {
      set({ usage: await statusBar.refreshUsage(manual) });
    } catch {
      // The last snapshot is deliberately better than clearing the pill.
    } finally {
      set({ usageRefreshing: false });
    }
  })().finally(() => {
    usageFlight = null;
  }));
}

let focusRefreshInstalled = false;
function installFocusRefresh() {
  if (focusRefreshInstalled || typeof window === "undefined") return;
  focusRefreshInstalled = true;
  const onFocus = () => void refreshUsage();
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onFocus();
  });
  const schedule = () => {
    window.setTimeout(() => {
      void refreshUsage().finally(schedule);
    }, 15 * 60_000);
  };
  schedule();
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
