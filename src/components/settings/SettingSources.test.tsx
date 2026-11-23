import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { SettingsFileStatus } from "@/lib/settingsFile";
import { mouseClick } from "@/test/press";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  reveal: vi.fn(),
  listeners: new Map<string, () => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, listener: () => void) => { mocks.listeners.set(name, listener); return () => mocks.listeners.delete(name); }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: vi.fn() }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: mocks.reveal }));

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

  mouseClick(screen.getByRole("button", { name: "Actions for Website links" }));
  let menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Reset to default" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  // PRO-374: one “…” per row, holding Reset to default (with the default), Copy setting link, Save for this project… and Saved in.
  expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(2);
  mouseClick(screen.getByRole("button", { name: "Actions for Link actions" }));
  menu = await screen.findByRole("menu");
  expect(menu.textContent).toContain("Saved in ~/.raccoon/settings.json");
  expect(within(menu).getByRole("menuitem", { name: "Reset to default" }).textContent).toContain("On");
  expect(within(menu).getByRole("menuitem", { name: "Copy setting link" }).textContent).toContain("general.linkActions");
  const project = within(menu).getByRole("menuitem", { name: /Save for this project/ });
  expect(project.getAttribute("aria-disabled")).toBe("true");
  expect(project.textContent).toContain("This setting is per person only");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Reset to default" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("reset_user_setting", { key: "preferences.linkActions" }));
  await waitFor(() => expect(screen.queryByText("Your value")).toBeNull());
});

it("Open personal settings.json opens the user file, names its broken line, and opens it in a chosen editor", async () => {
  await boot();
  const { OpenSettingsFileButton } = await import("./SettingSources");
  render(<OpenSettingsFileButton />);
  const button = screen.getByRole("button", { name: "Open personal settings.json" });
  fireEvent.click(button);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_settings_file", { path: "/Users/me/.raccoon/settings.json", editor: null }));

  openMenu(screen.getByRole("button", { name: "More ways to open personal settings.json" }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Your settings~/.raccoon/settings.json", "Finder1", "Cursor2", "VS Code3", "Zed4", "Copy pathCtrl+Shift+C"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "VS Code" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_settings_file", { path: "/Users/me/.raccoon/settings.json", editor: "vscode" }));

  file = { ...file, error: "preferences.linkActions, line 7: Unexpected “,” before “}”", problem };
  await act(async () => mocks.listeners.get("settings_file_changed")!());
  await waitFor(() => expect(screen.getByRole("button", { name: "Open personal settings.json · line 7" })).toBeTruthy());
  expect((screen.getByRole("button", { name: "Open personal settings.json · line 7" }).parentElement as HTMLElement).className).toContain("text-destructive");
});

it("on a project page the one Open button names and opens the project's own file (PRO-388)", async () => {
  await boot();
  const answer = mocks.invoke.getMockImplementation()!;
  const layers = [
    { layer: "repositoryLocal", path: "/repo/.terminalx/settings.local.json", displayPath: "/repo/.terminalx/settings.local.json", exists: true, keys: 1, git: "ignored", problem: null },
    { layer: "repositoryShared", path: "/repo/.terminalx/settings.json", displayPath: "/repo/.terminalx/settings.json", exists: true, keys: 2, git: "committed", problem: null },
    { layer: "user", path: file.path, displayPath: file.displayPath, exists: true, keys: 0, git: null, problem: null },
  ];
  mocks.invoke.mockImplementation(async (command: string, args?: { key?: string }) => command === "settings_files_list" ? layers : answer(command, args));
  const { OpenSettingsFileButton } = await import("./SettingSources");
  render(<OpenSettingsFileButton projectPath="/repo" />);
  fireEvent.click(await screen.findByRole("button", { name: "Open .terminalx/settings.json" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_settings_file", { path: "/repo/.terminalx/settings.json", editor: null }));
  expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(1);
  openMenu(screen.getByRole("button", { name: "More ways to open .terminalx/settings.json" }));
  const menu = await screen.findByRole("menu");
  // The menu as design 11.10 draws it (PRO-387): yours, then the project's shared and local files.
  expect(within(menu).getAllByRole("menuitem").slice(0, 3).map((item) => item.textContent)).toEqual([
    "Your settings~/.raccoon/settings.json", "Project · shared.terminalx/settings.json · committed", "Project · local.terminalx/settings.local.json · ignored by git",
  ]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Your settings/ }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_settings_file", { path: "/Users/me/.raccoon/settings.json", editor: null }));
});

it("a failed Open in reports the failure in an error toast", async () => {
  await boot();
  const { OpenSettingsFileButton } = await import("./SettingSources");
  const toasts = await import("@/lib/errorToasts");
  const answer = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args?: { key?: string }) => command === "open_settings_file" ? Promise.reject("Zed is not installed") : answer(command, args));
  render(<OpenSettingsFileButton />);
  openMenu(screen.getByRole("button", { name: "More ways to open personal settings.json" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Zed" }));
  await waitFor(() => expect(toasts.getErrorToasts().map(toasts.errorToastText)).toEqual(["Couldn’t open ~/.raccoon/settings.json in Zed: Zed is not installed"]));
});

it("a save refused by an invalid file raises Can’t save with the line, the parser's words and Copy error", async () => {
  const settings = await boot();
  const prefs = await import("@/lib/prefs");
  const { CantSaveToast } = await import("./SettingSources");
  const { SettingsFileError } = await import("./SettingsFile");
  render(<><SettingsFileError /><CantSaveToast settingTitle={(key) => key === "preferences.sounds" ? "Sounds" : undefined} /></>);
  expect(screen.queryByRole("alert")).toBeNull();
  // The file was broken in an editor; the save is refused and the toast reads the file again for its line.
  file = { ...file, error: "preferences.linkActions, line 7: Unexpected “,” before “}”", problem };
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "update_user_preferences" && !args.migrate
    ? Promise.reject("Fix settings.json before saving: preferences.linkActions, line 7: Unexpected “,” before “}”")
    : original(command, args));
  await act(async () => prefs.setPrefs({ sounds: false }));
  const toast = await screen.findByRole("alert", { name: "Can’t save: ~/.raccoon/settings.json has an error on line 7" });
  // PRO-374 (09.43): the toast names the setting that stayed, and no banner sits above the page.
  expect(toast.textContent).toContain("Sounds stays on until the file is fixed; nothing else changed.");
  expect(screen.getAllByRole("alert")).toEqual([toast]);

  fireEvent.click(within(toast).getByRole("button", { name: "Copy error" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("copy_text", {
    text: "Can’t save: ~/.raccoon/settings.json has an error on line 7\npreferences.linkActions: Unexpected “,” before “}”\nThis change wasn’t saved; your other settings keep their last good values until the file is fixed.",
  }));
  await within(toast).findByRole("button", { name: "Copied" });
  fireEvent.click(within(toast).getByRole("button", { name: "Open file" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_settings_file", { path: "/Users/me/.raccoon/settings.json", editor: null }));

  // Fixed in the editor: the toast goes, and a later problem raises no old toast.
  file = { ...file, error: null, problem: null };
  await act(async () => mocks.listeners.get("settings_file_changed")!());
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  file = { ...file, error: "x", problem };
  await act(async () => mocks.listeners.get("settings_file_changed")!());
  // A later problem raises neither the old toast nor a banner: the red Open settings.json names it.
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
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

it("on a project's pages opens the project's shared file and lists its two files, with 1–4 opening in an app (PRO-387)", async () => {
  await boot();
  const { OpenSettingsFileButton } = await import("./SettingSources");
  const answer = mocks.invoke.getMockImplementation()!;
  const layer = (layer: string, name: string, git: string, exists = true) => ({ layer, path: `/repo/.terminalx/${name}`, displayPath: `~/repo/.terminalx/${name}`, exists, keys: 2, git, problem: null });
  mocks.invoke.mockImplementation(async (command: string, args?: { key?: string }) => {
    if (command === "settings_files_list") return [layer("repositoryLocal", "settings.local.json", "ignored"), layer("repositoryShared", "settings.json", "committed")];
    if (command === "configuration_watch") return 1;
    return answer(command, args);
  });
  render(<OpenSettingsFileButton projectPath="/repo" />);
  const button = await screen.findByRole("button", { name: "Open .terminalx/settings.json" });
  fireEvent.click(button);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_settings_file", { path: "/repo/.terminalx/settings.json", editor: null }));
  openMenu(screen.getByRole("button", { name: "More ways to open .terminalx/settings.json" }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").slice(0, 3).map((item) => item.textContent)).toEqual([
    "Your settings~/.raccoon/settings.json",
    "Project · shared.terminalx/settings.json · committed",
    "Project · local.terminalx/settings.local.json · ignored by git",
  ]);
  expect(within(menu).getAllByRole("menuitem")[1].hasAttribute("data-current")).toBe(true);
  fireEvent.keyDown(menu, { key: "4" });
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_settings_file", { path: "/repo/.terminalx/settings.json", editor: "zed" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});
