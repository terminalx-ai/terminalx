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

function save(patch: Record<string, unknown>) {
  pending.push(patch);
  void enqueue(async () => {
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
    file = await invoke<SettingsFileStatus>("update_user_preferences", {
      patch: { ...legacyUserPreferences(), ...legacyThemePreferences() }, migrate: true,
    });
    connected = true;
    connectPreferenceFile(save);
    connectThemeFile(save);
  }
  apply(file);
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
