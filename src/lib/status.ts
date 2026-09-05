import { useSyncExternalStore } from "react";
import { createUsageRevalidation } from "./statusPolling";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  statusBar,
  type ResourceOverview,
  type ResourceSnapshot,
  type StatusBarSettings,
  type UsageSnapshot,
} from "@/lib/api";

interface StatusState {
  settings: StatusBarSettings;
  usage: UsageSnapshot;
  usageRefreshing: boolean;
  usageError: string | null;
  resources: ResourceOverview;
  resourceSample: ResourceSnapshot | null;
  resourcesRefreshing: boolean;
  ready: boolean;
}

const defaults: StatusBarSettings = { visible: true, usage: true, resources: true, percent: "used", usageMode: "detailed" };
let state: StatusState = {
  settings: defaults,
  usage: { windows: [] },
  usageRefreshing: false,
  usageError: null,
  resources: { agentCount: 0, orphanCount: 0, rssBytes: null, pressure: null },
  resourceSample: null,
  resourcesRefreshing: false,
  ready: false,
};
const listeners = new Set<() => void>();

const revalidation = createUsageRevalidation(async () => {
  await usageFlight;
  await refreshUsage();
});

function set(patch: Partial<StatusState>) {
  if (patch.usage && (patch.usage.revision ?? 0) < (state.usage.revision ?? 0)) {
    patch = { ...patch, usage: state.usage };
  }
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
  if (patch.usage) revalidation.update(state.usage.claudeAccount, state.usage.claude?.revalidateAt);
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
      await listen("status_resources_changed", () => void refreshResourceOverview());
      const [settings, usage, resources] = await Promise.all([statusBar.settings(), statusBar.usage(), statusBar.resourceOverview()]);
      set({ settings, usage, resources, ready: true });
      installFocusRefresh();
      void refreshUsage();
      void refreshResourceSample();
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
  if (usageFlight) return manual ? usageFlight.then(() => refreshUsage(true)) : usageFlight;
  return (usageFlight = (async () => {
    if (!(await windowCanPoll())) return;
    set({ usageRefreshing: true, usageError: null });
    try {
      set({ usage: await statusBar.refreshUsage(manual) });
    } catch {
      set({ usageError: "Usage refresh failed. Showing last known usage; try Refresh again." });
    } finally {
      set({ usageRefreshing: false });
    }
  })().finally(() => {
    usageFlight = null;
  }));
}

export async function resetCodexUsage(): Promise<void> {
  set({ usageRefreshing: true });
  try {
    set({ usage: await statusBar.resetCodex() });
  } finally {
    set({ usageRefreshing: false });
  }
}

export async function refreshResourceOverview() {
  try {
    set({ resources: await statusBar.resourceOverview() });
  } catch {
    /* the next pane event or focus will try again */
  }
}

let resourceFlight: Promise<void> | null = null;
export function refreshResourceSample(): Promise<void> {
  if (resourceFlight) return resourceFlight;
  return (resourceFlight = (async () => {
    if (!(await windowCanPoll())) return;
    set({ resourcesRefreshing: true });
    try {
      const sample = await statusBar.sampleResources();
      const total = sample.host.totalBytes;
      const available = sample.host.availableBytes;
      const pressure = total != null && available != null && total > 0 ? Math.max(0, Math.min(1, 1 - available / total)) : null;
      set({
        resourceSample: sample,
        resources: {
          agentCount: sample.processes.filter((process) => process.kind === "agent").length,
          orphanCount: sample.processes.filter((process) => process.orphaned && process.kind === "agent").length,
          rssBytes: sample.totalRssBytes,
          pressure,
        },
      });
    } catch {
      // Keep the last sample: the badge is a focus snapshot, not a heartbeat.
    } finally {
      set({ resourcesRefreshing: false });
    }
  })().finally(() => {
    resourceFlight = null;
  }));
}

export function removeResourceOptimistically(paneId: string) {
  if (!state.resourceSample) return;
  set({ resourceSample: { ...state.resourceSample, processes: state.resourceSample.processes.filter((process) => process.paneId !== paneId) } });
}

let focusRefreshInstalled = false;
function installFocusRefresh() {
  if (focusRefreshInstalled || typeof window === "undefined") return;
  focusRefreshInstalled = true;
  const onFocus = () => {
    void refreshUsage();
    void refreshResourceSample();
  };
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
