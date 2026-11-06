import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import defaults from "./userPreferenceDefaults.json";
import type { SettingsFileStatus } from "./settingsFile";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, () => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, listener: () => void) => { mocks.listeners.set(name, listener); return () => mocks.listeners.delete(name); }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: vi.fn() }) }));

let file: SettingsFileStatus;
let migrated: boolean;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  mocks.listeners.clear();
  mocks.invoke.mockReset();
  migrated = false;
  file = { path: "/fixture/settings.json", exists: false, error: null, preferences: {} };
  mocks.invoke.mockImplementation(async (command: string, args?: { patch: Record<string, unknown>; migrate: boolean }) => {
    if (command === "settings_file_status") return structuredClone(file);
    if (command === "create_settings_file") file.exists = true;
    if (command === "update_user_preferences" && args) {
      if (args.migrate) {
        if (!migrated) file.preferences = { ...args.patch, ...file.preferences };
        migrated = true;
      } else file.preferences = { ...file.preferences, ...args.patch };
    }
    return structuredClone(file);
  });
});
afterEach(cleanup);

describe("user preference files", () => {
  it("migrates old choices once, keeps file overrides, and leaves transient state local", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ sounds: false, fontScale: "lg", sidebarWidth: 310, shortcuts: { "session.stop": ["mod+."] } }));
    localStorage.setItem("raccoon.theme", "moss");
    file.preferences = { sounds: true };
    const prefs = await import("./prefs");
    const settings = await import("./settingsFile");
    await settings.bootSettingsFile();
    expect(file.preferences).toMatchObject({ sounds: true, fontScale: "lg", theme: "moss", shortcuts: { "session.interrupt": ["mod+."] }, shortcutsVersion: 2 });
    expect(prefs.getPrefs()).toMatchObject({ sounds: true, fontScale: "lg", sidebarWidth: 310 });
    const local = JSON.parse(localStorage.getItem("raccoon.prefs")!);
    expect(local.sidebarWidth).toBe(310);
    expect(local).not.toHaveProperty("sounds");
    expect(local).not.toHaveProperty("shortcuts");
    expect(localStorage.getItem("raccoon.theme")).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("moss");
    await settings.bootSettingsFile();
    expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "update_user_preferences" && args.migrate)).toHaveLength(1);
  });

  it("keeps every bundled default consistent with the existing preference defaults", async () => {
    const { getPrefs } = await import("./prefs");
    for (const [key, value] of Object.entries(defaults)) {
      if (key === "theme" || key === "mode") continue;
      expect(getPrefs()[key as keyof ReturnType<typeof getPrefs>], key).toEqual(value);
    }
  });

  it("updates an open page on a file event and restores defaults when keys are removed", async () => {
    const settings = await import("./settingsFile");
    const prefs = await import("./prefs");
    function Row() { return <span>{prefs.usePrefs().sounds ? "Sounds on" : "Sounds off"}</span>; }
    await settings.bootSettingsFile();
    render(<Row />);
    expect(screen.getByText("Sounds on")).toBeTruthy();
    file.preferences = { sounds: false, theme: "ember" };
    await act(async () => mocks.listeners.get("settings_file_changed")!());
    await waitFor(() => expect(screen.getByText("Sounds off")).toBeTruthy());
    expect(document.documentElement.dataset.theme).toBe("ember");
    file.preferences = {};
    await act(async () => mocks.listeners.get("settings_file_changed")!());
    await waitFor(() => expect(screen.getByText("Sounds on")).toBeTruthy());
    expect(document.documentElement.dataset.theme).toBe("den");
  });

  it("serializes changes and retains a newer optimistic choice while an earlier save completes", async () => {
    const settings = await import("./settingsFile");
    const prefs = await import("./prefs");
    await settings.bootSettingsFile();
    let finish!: (value: SettingsFileStatus) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    prefs.setPrefs({ sounds: false });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    prefs.setPrefs({ fontScale: "lg" });
    file.preferences.sounds = false;
    finish(structuredClone(file));
    await waitFor(() => expect(file.preferences.fontScale).toBe("lg"));
    expect(prefs.getPrefs()).toMatchObject({ sounds: false, fontScale: "lg" });
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).not.toHaveProperty("fontScale");
  });

  it("reloads an already open native setting row after a file edit", async () => {
    const settings = await import("./settingsFile");
    await settings.bootSettingsFile();
    const original = mocks.invoke.getMockImplementation()!;
    let minutes = 60;
    mocks.invoke.mockImplementation((command, args) => command === "agent_settings"
      ? Promise.resolve({ idleStopMinutes: minutes, readOnlyCommands: true })
      : original(command, args));
    const { AgentIdleSettings } = await import("../components/settings/AgentIdleSettings");
    render(<AgentIdleSettings />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "1 hour" }).getAttribute("aria-checked")).toBe("true"));
    minutes = 30;
    await act(async () => mocks.listeners.get("settings_file_changed")!());
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 min" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("retains legacy storage when migration fails, retries after repair, and shows one file error", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ sounds: false }));
    file.error = "preferences.sounds, line 3: expected true or false";
    const settings = await import("./settingsFile");
    const { SettingsFileError } = await import("../components/settings/SettingsFile");
    await settings.bootSettingsFile();
    render(<SettingsFileError />);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("preferences.sounds, line 3");
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).sounds).toBe(false);
    file.error = null;
    await act(async () => mocks.listeners.get("settings_file_changed")!());
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(file.preferences.sounds).toBe(false);
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).not.toHaveProperty("sounds");
  });

  it("rolls back a refused save and exposes its error", async () => {
    const settings = await import("./settingsFile");
    const prefs = await import("./prefs");
    const { SettingsFileError } = await import("../components/settings/SettingsFile");
    await settings.bootSettingsFile();
    render(<SettingsFileError />);
    mocks.invoke.mockRejectedValueOnce("Disk full");
    await act(async () => prefs.setPrefs({ sounds: false }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Disk full"));
    expect(prefs.getPrefs().sounds).toBe(true);
  });

  it("offers Create only for a missing file and displays its actual path", async () => {
    const settings = await import("./settingsFile");
    const { SettingsFileRow } = await import("../components/settings/SettingsFile");
    await settings.bootSettingsFile();
    render(<SettingsFileRow />);
    expect(screen.getByText(file.path)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create settings file" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Create settings file" })).toBeNull());
    expect(screen.getByText("Reloads when edited")).toBeTruthy();
  });
});
