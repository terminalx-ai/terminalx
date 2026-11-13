import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyFilePreferences, connectPreferenceFile, legacyUserPreferences } from "./prefs";
import type { SettingsFileProblem } from "@/types/settingsSources";
import { applyFileTheme, connectThemeFile, legacyThemePreferences } from "./theme";

export interface SettingsFileStatus {
  path: string;
  /** PRO-140: `path` with the home directory written as "~". */
  displayPath: string;
  exists: boolean;
  error: string | null;
  /** PRO-140: the same error, structured; null when the file is valid. */
  problem: SettingsFileProblem | null;
  /** PRO-140: dotted keys the user file sets itself ("preferences.theme", "agents.idleStopMinutes", "orchestrator.projects"); never values. */
  setKeys: string[];
  preferences: Record<string, unknown>;
}
/** A save the native layer refused (PRO-140): the toast says which file and line stopped it. */
export interface SettingsSaveFailure { id: number; cause: string }
let state: { file: SettingsFileStatus | null; error: string | null; revision: number; saveFailure: SettingsSaveFailure | null } = { file: null, error: null, revision: 0, saveFailure: null };
const listeners = new Set<() => void>();
const pending: Record<string, unknown>[] = [];
let connected = false;
let queue: Promise<void> = Promise.resolve();
let boot: Promise<void> | null = null;

function publish(file: SettingsFileStatus | null, error = file?.error ?? null, saveFailure = state.saveFailure) {
  state = { file, error, revision: state.revision + 1, saveFailure };
  for (const listener of listeners) listener();
}

function apply(file: SettingsFileStatus) {
  // A newly opened window can receive the backend's last valid view while
  // an invalid edit prevents migration. Show it without changing legacy data.
  const legacy = connected ? {} : { ...legacyUserPreferences(), ...legacyThemePreferences() };
  const values = Object.assign({}, legacy, file.preferences, ...pending);
  applyFilePreferences(values, connected);
  applyFileTheme(values, connected);
  // A refused save is forgotten once the file is valid again, so a later problem raises no old toast.
  publish(file, file.error, file.problem || file.error ? state.saveFailure : null);
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
      // Read the file again so the toast can name the line that stopped the save.
      let latest = state.file;
      try { latest = await invoke<SettingsFileStatus>("settings_file_status"); } catch { /* keep the last view */ }
      if (latest) apply(latest);
      publish(state.file, state.error, { id: state.revision + 1, cause: String(error) });
      throw error;
    }
  });
}

export function dismissSaveFailure(id: number) {
  if (state.saveFailure?.id === id) publish(state.file, state.error, null);
}

/** Remove a key from the user file, so it inherits its default (PRO-140). Rejects when the file refuses. */
export function resetUserSetting(key: string): Promise<void> {
  let failure: unknown = null;
  return enqueue(async () => {
    try {
      apply(await invoke<SettingsFileStatus>("reset_user_setting", { key }));
    } catch (error) {
      failure = error ?? "Couldn’t reset the setting";
      throw error;
    }
  }).then(() => { if (failure !== null) throw failure; });
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
