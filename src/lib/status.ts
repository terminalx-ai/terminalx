import { useSyncExternalStore } from "react";
import { createUsagePolling, createUsageRevalidation } from "./statusPolling";
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
  resourcesAvailable: boolean;
  resourceGeneration: number;
  resourceSample: ResourceSnapshot | null;
  resourcesRefreshing: boolean;
  ready: boolean;
}

const defaults: StatusBarSettings = { visible: true, usage: true, resources: true, percent: "used", usageMode: "detailed", usageRefreshMinutes: 1 };
let state: StatusState = {
  settings: defaults,
  usage: { windows: [] },
  usageRefreshing: false,
  usageError: null,
  resources: { agentCount: 0, orphanCount: 0, rssBytes: null, pressure: null },
  resourcesAvailable: false,
  resourceGeneration: 0,
  resourceSample: null,
  resourcesRefreshing: false,
  ready: false,
};
const listeners = new Set<() => void>();

const revalidation = createUsageRevalidation(async () => {
  await usageFlight;
  await refreshUsage();
});

// The backend reuses an answer for this same interval, so the two move together.
const polling = createUsagePolling(() => refreshUsage());

/** Nothing shows usage while its indicator is hidden, so nothing polls for it. */
function usagePollInterval(settings: StatusBarSettings): number | null {
  return settings.visible && settings.usage && settings.usageRefreshMinutes > 0 ? settings.usageRefreshMinutes * 60_000 : null;
}

function set(patch: Partial<StatusState>) {
  if (patch.usage && (patch.usage.revision ?? 0) < (state.usage.revision ?? 0)) {
    patch = { ...patch, usage: state.usage };
  }
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
  if (patch.usage) revalidation.update(state.usage.claudeAccount, state.usage.claude?.revalidateAt);
  if (patch.settings) polling.update(usagePollInterval(state.settings));
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
      await listen("local_runtime_disconnected", invalidateResources);
      await listen("local_runtime_view_disconnected", invalidateResources);
      await listen("local_runtime_reattached", () => { invalidateResources(); void refreshResourceOverview(); });
      const [settings, usage] = await Promise.all([statusBar.settings(), statusBar.usage(), refreshResourceOverview()]);
      set({ settings, usage, ready: true });
      installFocusRefresh();
      // The backend stamps this first read when it runs, not when the module
      // loaded; time the first tick from it or that tick can land too early.
      void refreshUsage().finally(() => polling.restart());
      void refreshResourceSample();
    } catch {
      set({ ready: true });
    }
  })());
}

let usageFlight: Promise<void> | null = null;
/** Process sampling is for the window being looked at. Usage keeps up in any
 * window on screen: agents spend it while another app has focus. */
async function windowCanPoll(needsFocus = true): Promise<boolean> {
  if (typeof document !== "undefined" && (document.hidden || (needsFocus && !document.hasFocus()))) return false;
  try {
    const current = getCurrentWindow();
    return (!needsFocus || (await current.isFocused())) && !(await current.isMinimized());
  } catch {
    return true;
  }
}

export function refreshUsage(manual = false): Promise<void> {
  if (usageFlight) return manual ? usageFlight.then(() => refreshUsage(true)) : usageFlight;
  return (usageFlight = (async () => {
    if (!(await windowCanPoll(false))) return;
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
  // A tick may be reading Codex right now; the backend refuses a reset over it.
  await usageFlight;
  set({ usageRefreshing: true });
  try {
    set({ usage: await statusBar.resetCodex() });
  } finally {
    set({ usageRefreshing: false });
  }
}

// A disconnected owner invalidates both reads and failures already in flight.
// Newer reads also supersede older ones, across overview and detailed samples.
let resourceRevision = 0;
function invalidateResources() {
  resourceRevision++;
  set({ resourcesAvailable: false, resourceGeneration: state.resourceGeneration + 1, resourceSample: null, resourcesRefreshing: false });
}

/** Synchronous authority check, including invalidations React has not rendered yet. */
export function resourceGenerationIsCurrent(generation: number): boolean {
  return state.resourcesAvailable && state.resourceGeneration === generation;
}

export async function refreshResourceOverview() {
  const revision = ++resourceRevision;
  try {
    const resources = await statusBar.resourceOverview();
    if (revision === resourceRevision) set({ resources, resourcesAvailable: true });
  } catch {
    if (revision === resourceRevision) invalidateResources();
  }
}

let resourceFlight: Promise<void> | null = null;
export function refreshResourceSample(): Promise<void> {
  if (resourceFlight) return resourceFlight;
  return (resourceFlight = (async () => {
    const beforeFocus = resourceRevision;
    if (!(await windowCanPoll())) return;
    if (beforeFocus !== resourceRevision) return;
    const revision = ++resourceRevision;
    set({ resourcesRefreshing: true });
    try {
      const sample = await statusBar.sampleResources();
      if (revision !== resourceRevision) return;
      const total = sample.host.totalBytes;
      const available = sample.host.availableBytes;
      const pressure = total != null && available != null && total > 0 ? Math.max(0, Math.min(1, 1 - available / total)) : null;
      set({
        resourcesAvailable: true,
        resourceSample: sample,
        resources: {
          agentCount: sample.processes.filter((process) => process.kind === "agent").length,
          orphanCount: sample.processes.filter((process) => process.orphaned && process.kind === "agent").length,
          rssBytes: sample.totalRssBytes,
          pressure,
        },
      });
    } catch {
      if (revision === resourceRevision) invalidateResources();
    } finally {
      // Sampling is single-flight; this only ends this flight's spinner,
      // never its successor's resource availability or data.
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
  // Back on the network: one catch-up, which provider backoff may still decline.
  window.addEventListener("online", () => void refreshUsage());
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
