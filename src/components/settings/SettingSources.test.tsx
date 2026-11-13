import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { SettingsFileStatus } from "@/lib/settingsFile";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openPath: vi.fn(),
  reveal: vi.fn(),
  listeners: new Map<string, () => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, listener: () => void) => { mocks.listeners.set(name, listener); return () => mocks.listeners.delete(name); }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: vi.fn() }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: mocks.openPath, revealItemInDir: mocks.reveal }));

let file: SettingsFileStatus;
const problem = { key: "preferences.linkActions", line: 7, message: "Unexpected “,” before “}”", effect: "lastGood" as const };

beforeAll(async () => {
  await import("./SettingSources");
  await import("./settingsRegistry");
}, 60_000);
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  mocks.listeners.clear();
  mocks.invoke.mockReset();
  mocks.openPath.mockReset().mockResolvedValue(undefined);
  mocks.reveal.mockReset().mockResolvedValue(undefined);
  file = { path: "/Users/me/.raccoon/settings.json", displayPath: "~/.raccoon/settings.json", exists: true, error: null, problem: null, setKeys: [], preferences: {} };
  mocks.invoke.mockImplementation(async (command: string, args?: { key?: string }) => {
    if (command === "reset_user_setting") file.setKeys = file.setKeys.filter((key) => key !== args?.key);
    return structuredClone(file);
  });
});
afterEach(cleanup);

async function boot() {
  const settings = await import("@/lib/settingsFile");
  await settings.bootSettingsFile();
  return settings;
}
const openMenu = (element: HTMLElement) => fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });

it("shows Your value beside a row's title only while the user file sets its key", async () => {
  file.setKeys = ["preferences.linkActions"];
  await boot();
  const { RegisteredSetting } = await import("./settingsRegistry");
  render(<><RegisteredSetting setting="general.linkActions" control={<span />} /><RegisteredSetting setting="general.websiteLinks" control={<span />} /></>);
  const set = screen.getByText("Link actions").closest("[data-setting-id]") as HTMLElement;
  const unset = screen.getByText("Website links").closest("[data-setting-id]") as HTMLElement;
  expect(within(set).getByText("Your value")).toBeTruthy();
  expect(within(unset).queryByText("Your value")).toBeNull();
});

it("Reset to default removes the row's key with reset_user_setting, and is disabled when the key is not set", async () => {
  file.setKeys = ["preferences.linkActions"];
  await boot();
  const { RegisteredSetting } = await import("./settingsRegistry");
  render(<><RegisteredSetting setting="general.linkActions" control={<span />} /><RegisteredSetting setting="general.websiteLinks" control={<span />} /></>);

  openMenu(screen.getByRole("button", { name: "Website links actions" }));
  let menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Reset to default" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  openMenu(screen.getByRole("button", { name: "Link actions actions" }));
  menu = await screen.findByRole("menu");
  expect(menu.textContent).toContain("Saved in ~/.raccoon/settings.json");
  expect(within(menu).queryByText(/Copy setting link/)).toBeNull();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Reset to default" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("reset_user_setting", { key: "preferences.linkActions" }));
  await waitFor(() => expect(screen.queryByText("Your value")).toBeNull());
});

it("Open settings.json opens the user file, names its broken line, and opens it in a chosen editor", async () => {
  await boot();
  const { OpenSettingsFileButton } = await import("./SettingSources");
  render(<OpenSettingsFileButton />);
  const button = screen.getByRole("button", { name: "Open settings.json" });
  fireEvent.click(button);
  await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith("/Users/me/.raccoon/settings.json", undefined));

  openMenu(screen.getByRole("button", { name: "More ways to open settings.json" }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Your settings~/.raccoon/settings.json", "Finder", "Cursor", "VS Code", "Zed", "Copy path"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "VS Code" }));
  await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith("/Users/me/.raccoon/settings.json", "Visual Studio Code"));

  file = { ...file, error: "preferences.linkActions, line 7: Unexpected “,” before “}”", problem };
  await act(async () => mocks.listeners.get("settings_file_changed")!());
  await waitFor(() => expect(screen.getByRole("button", { name: "Open settings.json · line 7" })).toBeTruthy());
  expect((screen.getByRole("button", { name: "Open settings.json · line 7" }).parentElement as HTMLElement).className).toContain("text-destructive");
});

it("a failed Open in reports the failure in an error toast", async () => {
  await boot();
  const { OpenSettingsFileButton } = await import("./SettingSources");
  const toasts = await import("@/lib/errorToasts");
  mocks.openPath.mockRejectedValue("Zed is not installed");
  render(<OpenSettingsFileButton />);
  openMenu(screen.getByRole("button", { name: "More ways to open settings.json" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Zed" }));
  await waitFor(() => expect(toasts.getErrorToasts().map(toasts.errorToastText)).toEqual(["Couldn’t open ~/.raccoon/settings.json in Zed: Zed is not installed"]));
});

it("a save refused by an invalid file raises Can’t save with the line, the parser's words and Copy error", async () => {
  const settings = await boot();
  const prefs = await import("@/lib/prefs");
  const { CantSaveToast } = await import("./SettingSources");
  const { SettingsFileError } = await import("./SettingsFile");
  render(<><SettingsFileError /><CantSaveToast /></>);
  expect(screen.queryByRole("alert")).toBeNull();
  // The file was broken in an editor; the save is refused and the toast reads the file again for its line.
  file = { ...file, error: "preferences.linkActions, line 7: Unexpected “,” before “}”", problem };
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "update_user_preferences" && !args.migrate
    ? Promise.reject("Fix settings.json before saving: preferences.linkActions, line 7: Unexpected “,” before “}”")
    : original(command, args));
  await act(async () => prefs.setPrefs({ sounds: false }));
  const toast = await screen.findByRole("alert", { name: "Can’t save: ~/.raccoon/settings.json has an error on line 7" });
  expect(toast.textContent).toContain("preferences.linkActions: Unexpected “,” before “}”");
  expect(toast.textContent).toContain("This change wasn’t saved; your other settings keep their last good values until the file is fixed.");

  // The banner reads as one error naming file, line and key.
  const banner = screen.getAllByRole("alert").find((element) => element !== toast)!;
  expect(banner.textContent).toBe("~/.raccoon/settings.json line 7: preferences.linkActions Unexpected “,” before “}”. The last good values stay in effect.Open");

  fireEvent.click(within(toast).getByRole("button", { name: "Copy error" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("copy_text", {
    text: "Can’t save: ~/.raccoon/settings.json has an error on line 7\npreferences.linkActions: Unexpected “,” before “}”\nThis change wasn’t saved; your other settings keep their last good values until the file is fixed.",
  }));
  await within(toast).findByRole("button", { name: "Copied" });
  fireEvent.click(within(toast).getByRole("button", { name: "Open file" }));
  await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith("/Users/me/.raccoon/settings.json", undefined));

  // Fixed in the editor: the toast goes, and a later problem raises no old toast.
  file = { ...file, error: null, problem: null };
  await act(async () => mocks.listeners.get("settings_file_changed")!());
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  file = { ...file, error: "x", problem };
  await act(async () => mocks.listeners.get("settings_file_changed")!());
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
  expect(settings.useSettingsFile).toBeTypeOf("function");
});

it("Close dismisses the Can’t save toast", async () => {
  await boot();
  const prefs = await import("@/lib/prefs");
  const { CantSaveToast } = await import("./SettingSources");
  render(<CantSaveToast />);
  file = { ...file, error: "e", problem };
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "update_user_preferences" && !args.migrate ? Promise.reject("Fix settings.json before saving") : original(command, args));
  await act(async () => prefs.setPrefs({ sounds: false }));
  const toast = await screen.findByRole("alert");
  fireEvent.click(within(toast).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("the badges legend lists only the badges it is given", async () => {
  const { BadgeLegend } = await import("./SettingSources");
  render(<BadgeLegend kinds={["yours"]} />);
  const legend = screen.getByRole("region", { name: "Badges" });
  expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Your valueyour own settings"]);
});
