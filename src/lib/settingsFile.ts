import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyFilePreferences, connectPreferenceFile, legacyUserPreferences } from "./prefs";
import { applyFileTheme, connectThemeFile, legacyThemePreferences } from "./theme";

export interface SettingsFileStatus {
  path: string;
  exists: boolean;
  error: string | null;
  preferences: Record<string, unknown>;
}
let state: { file: SettingsFileStatus | null; error: string | null; revision: number } = { file: null, error: null, revision: 0 };
const listeners = new Set<() => void>();
const pending: Record<string, unknown>[] = [];
let connected = false;
let queue: Promise<void> = Promise.resolve();
let boot: Promise<void> | null = null;

function publish(file: SettingsFileStatus | null, error = file?.error ?? null) {
  state = { file, error, revision: state.revision + 1 };
  for (const listener of listeners) listener();
}

function apply(file: SettingsFileStatus) {
  // A newly opened window can receive the backend's last valid view while
  // an invalid edit prevents migration. Show it without changing legacy data.
  const legacy = connected ? {} : { ...legacyUserPreferences(), ...legacyThemePreferences() };
  const values = Object.assign({}, legacy, file.preferences, ...pending);
  applyFilePreferences(values, connected);
  applyFileTheme(values, connected);
  publish(file);
}

function enqueue(work: () => Promise<void>) {
  queue = queue.then(work).catch((error: unknown) => {
    publish(state.file, String(error));
  });
  return queue;
}

function save(patch: Record<string, unknown>): Promise<void> {
  pending.push(patch);
  return enqueue(async () => {
    try {
      const file = await invoke<SettingsFileStatus>("update_user_preferences", { patch, migrate: false });
      pending.splice(pending.indexOf(patch), 1);
      apply(file);
    } catch (error) {
      pending.splice(pending.indexOf(patch), 1);
      if (state.file) apply(state.file);
      throw error;
    }
  });
}

async function refresh() {
  let file = await invoke<SettingsFileStatus>("settings_file_status");
  if (!connected && !file.error) {
    try {
      file = await invoke<SettingsFileStatus>("update_user_preferences", {
        patch: { ...legacyUserPreferences(), ...legacyThemePreferences() }, migrate: true,
      });
    } catch (error) {
      // A rejected legacy choice is not a corrupt settings file. Still show
      // its valid values and path, and keep legacy storage available to retry.
      apply(file);
      throw error;
    }
    connected = true;
    connectPreferenceFile(save);
    connectThemeFile(save);
  }
  apply(file);
  unfoldToolCallsOnce(file);
}

/**
 * Fold tool calls turned off by default (steps stay in view, in order), but moving preferences into the settings
 * file wrote every value of the time into it, defaults included, so for most people `true` there is the old default,
 * not a choice. Once per computer, a `true` becomes the new default; turned back on after that, it stays on.
 */
const UNFOLDED = "raccoon.migrated.foldToolCallsOff";
function unfoldToolCallsOnce(file: SettingsFileStatus) {
  if (!connected || file.error) return;
  try {
    if (localStorage.getItem(UNFOLDED)) return;
  } catch {
    return;
  }
  const done = () => { try { localStorage.setItem(UNFOLDED, "1"); } catch { /* storage unavailable */ } };
  if (file.preferences?.foldToolCalls !== true) return done();
  // Marked done only once the file says so: a save that failed is tried again at the next start.
  void save({ foldToolCalls: false }).then(() => { if (state.file?.preferences?.foldToolCalls === false) done(); });
}

/** Subscribe before reading so edits during startup cannot be missed. */
export function bootSettingsFile(): Promise<void> {
  return boot ??= (async () => {
    await listen("settings_file_changed", () => { void enqueue(refresh); });
    await listen("local_runtime_reattached", () => { void enqueue(refresh); });
    await enqueue(refresh);
  })().catch((error: unknown) => { publish(state.file, String(error)); });
}

export function createSettingsFile(): Promise<void> {
  return enqueue(async () => { apply(await invoke<SettingsFileStatus>("create_settings_file")); });
}

export function useSettingsFile() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => state, () => state);
}
