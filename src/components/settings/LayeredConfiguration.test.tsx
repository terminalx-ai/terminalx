import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LayeredConfiguration } from "./LayeredConfiguration";
import type { ConfigurationLayerValue } from "@/types/configuration";
import type { SettingsFileLayer } from "@/types/settingsSources";
const { resolve, write, review, watch, files, openPath, listeners } = vi.hoisted(() => ({ resolve: vi.fn(), write: vi.fn(), review: vi.fn(), watch: vi.fn(), files: vi.fn(), openPath: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock("@/lib/configuration", async (original) => ({ ...await original<typeof import("@/lib/configuration")>(), configuration: { resolve, write, review, watch, files } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, listener: () => void) => { listeners.set(name, listener); return () => listeners.delete(name); }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath, revealItemInDir: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: [{ path: "/repo", name: "App", kind: "git" }, { path: "cloud:o:w", name: "Remote", kind: "git" }] }) }));
const fixture = (locked = false) => ({ values: { branchPrefix: { value: "team/", source: locked ? "managed" : "repositoryShared", locked, redacted: false, layers: [{ layer: locked ? "managed" : "repositoryShared", value: "team/", redacted: false }] } }, registry: [{ key: "branchPrefix", repositoryConfigurable: true, managedLockable: true, requiresTrust: true }], warnings: [], trust: null });
afterEach(cleanup);
const userFiles: SettingsFileLayer[] = [
  { layer: "user", path: "/Users/me/.raccoon/settings.json", displayPath: "~/.raccoon/settings.json", exists: true, keys: 14, git: null, problem: null },
  { layer: "defaults", path: null, displayPath: null, exists: true, keys: 0, git: null, problem: null },
];
beforeEach(() => { vi.clearAllMocks(); listeners.clear(); watch.mockResolvedValue(vi.fn()); resolve.mockResolvedValue(fixture()); write.mockResolvedValue(undefined); review.mockResolvedValue(false); files.mockResolvedValue(userFiles); openPath.mockResolvedValue(undefined); });

it("defaults every editor to user writes and explicitly selects repository local or shared", async () => {
  render(<LayeredConfiguration />);
  await screen.findByDisplayValue("team/");
  expect(screen.queryByText("Remote")).toBeNull();
  expect((screen.getByLabelText("Save to") as HTMLSelectElement).value).toBe("user");
  fireEvent.change(screen.getByLabelText("Branch prefix"), { target: { value: "mine/" } });
  fireEvent.click(screen.getByRole("button", { name: "Save prefix" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(null, "user", "branchPrefix", "mine/"));
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "/repo" } });
  await waitFor(() => expect(resolve).toHaveBeenCalledWith("/repo"));
  await screen.findByDisplayValue("team/");
  fireEvent.change(screen.getByLabelText("Save to"), { target: { value: "repositoryLocal" } });
  fireEvent.click(screen.getByRole("button", { name: "Save prefix" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith("/repo", "repositoryLocal", "branchPrefix", "team/"));
  await waitFor(() => expect((screen.getByRole("button", { name: "Reset selected layer" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Save to"), { target: { value: "repositoryShared" } });
  fireEvent.click(screen.getByRole("button", { name: "Reset selected layer" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith("/repo", "repositoryShared", "branchPrefix", null));
});

it("shows managed source and locks editing, saving and resetting", async () => {
  resolve.mockResolvedValue(fixture(true));
  render(<LayeredConfiguration />);
  await screen.findByText(/Locked by managed configuration/);
  for (const name of ["Save prefix", "Reset selected layer"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Branch prefix") as HTMLInputElement).disabled).toBe(true);
});

it("a declined native trust review leaves shared values blocked", async () => {
  const pending = { ...fixture(), trust: { hash: "file-hash", required: true, keys: ["environment.API_URL"] } };
  resolve.mockResolvedValueOnce(fixture()).mockResolvedValue(pending);
  render(<LayeredConfiguration />);
  await screen.findByDisplayValue("team/");
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "/repo" } });
  fireEvent.click(await screen.findByRole("button", { name: "Review repository trust" }));
  await screen.findByText("Not trusted. Nothing was started.");
  expect(review).toHaveBeenCalledWith("/repo");
  expect(write).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Review repository trust" })).toBeTruthy();
});

it("displays a failed save and never claims it succeeded", async () => {
  write.mockRejectedValue(new Error("This setting is locked by managed configuration."));
  render(<LayeredConfiguration />);
  await screen.findByDisplayValue("team/");
  fireEvent.click(screen.getByRole("button", { name: "Save prefix" }));
  expect((await screen.findByRole("alert")).textContent).toContain("locked");
  expect(screen.queryByText("Saved to User.")).toBeNull();
});


it("loads in React StrictMode after the first effect is cancelled", async () => {
  render(<StrictMode><LayeredConfiguration /></StrictMode>);
  await screen.findByDisplayValue("team/");
  await waitFor(() => expect((screen.getByRole("button", { name: "Save prefix" }) as HTMLButtonElement).disabled).toBe(false));
});

it("refreshes sources and trust after file changes without erasing an unsaved prefix", async () => {
  const stop = vi.fn();
  watch.mockResolvedValue(stop);
  const { unmount } = render(<LayeredConfiguration />);
  await screen.findByDisplayValue("team/");
  fireEvent.change(screen.getByLabelText("Branch prefix"), { target: { value: "draft/" } });
  resolve.mockResolvedValue({ ...fixture(), trust: { hash: "changed", required: true, keys: ["branchPrefix"] } });
  watch.mock.calls.at(-1)![1]();
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
  expect((screen.getByLabelText("Branch prefix") as HTMLInputElement).value).toBe("draft/");
  resolve.mockResolvedValue(fixture(true));
  watch.mock.calls.at(-1)![1]();
  await screen.findByText(/Locked by managed configuration/);
  expect((screen.getByLabelText("Branch prefix") as HTMLInputElement).value).toBe("team/");
  unmount();
  expect(stop).toHaveBeenCalledOnce();
});

it("disables stale editing when a watched policy becomes unreadable", async () => {
  render(<LayeredConfiguration />);
  await screen.findByDisplayValue("team/");
  resolve.mockRejectedValueOnce(new Error("Cannot safely read managed configuration."));
  watch.mock.calls.at(-1)![1]();
  await screen.findByRole("alert");
  expect((screen.getByRole("button", { name: "Save prefix" }) as HTMLButtonElement).disabled).toBe(true);
});

it("closes a watcher that finishes subscribing after unmount", async () => {
  let ready!: (stop: () => void) => void;
  watch.mockReturnValue(new Promise<() => void>((resolve) => { ready = resolve; }));
  const { unmount } = render(<LayeredConfiguration />);
  unmount();
  const stop = vi.fn();
  ready(stop);
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
});

const withLayers = (...layers: ConfigurationLayerValue[]) => ({ ...fixture(), values: { branchPrefix: { value: layers[0].value, source: layers[0].layer, locked: layers[0].layer === "managed", redacted: false, layers } } });
const at = (layer: ConfigurationLayerValue["layer"], value: unknown): ConfigurationLayerValue => ({ layer, value, redacted: false });
const openMenu = (element: HTMLElement) => fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });

it.each([
  ["managed", [at("managed", "corp/"), at("user", "me/")], "Managed · locked"],
  ["local over shared", [at("repositoryLocal", "tx/"), at("repositoryShared", "team/")], "Your value · overrides project"],
  ["local alone", [at("repositoryLocal", "tx/"), at("defaults", "")], "Your value"],
  ["shared", [at("repositoryShared", "team/"), at("defaults", "")], "Project value"],
  ["user", [at("user", "me/"), at("defaults", "")], "Your value"],
] as const)("shows the resolver's badge for a %s value", async (_, layers, label) => {
  resolve.mockResolvedValue(withLayers(...layers));
  render(<LayeredConfiguration />);
  const badge = await screen.findByRole("button", { name: "Branch prefix: where this value comes from" });
  expect(badge.textContent).toBe(label);
});

it("shows no badge for a default value", async () => {
  resolve.mockResolvedValue(withLayers(at("defaults", "")));
  render(<LayeredConfiguration />);
  await waitFor(() => expect(resolve).toHaveBeenCalled());
  await screen.findByText(/Source: Default/);
  expect(screen.queryByRole("button", { name: /where this value comes from/ })).toBeNull();
});

it("lists each layer in the popover and Reset to project value removes the local override", async () => {
  const local: SettingsFileLayer = { layer: "repositoryLocal", path: "/repo/.terminalx/settings.local.json", displayPath: "~/repo/.terminalx/settings.local.json", exists: true, keys: 1, git: "ignored", problem: null };
  const shared: SettingsFileLayer = { layer: "repositoryShared", path: "/repo/.terminalx/settings.json", displayPath: "~/repo/.terminalx/settings.json", exists: true, keys: 2, git: "committed", problem: null };
  files.mockResolvedValue([local, shared, ...userFiles]);
  resolve.mockResolvedValue(withLayers(at("repositoryLocal", "tx/"), at("repositoryShared", "team/"), at("user", "me/"), at("defaults", "")));
  render(<LayeredConfiguration />);
  await screen.findByDisplayValue("tx/");
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "/repo" } });
  await waitFor(() => expect(files).toHaveBeenCalledWith("/repo"));
  openMenu(await screen.findByRole("button", { name: "Branch prefix: where this value comes from" }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("Where this value comes from")).toBeTruthy();
  const rows = within(menu).getByRole("list", { name: "Layers" }).querySelectorAll("li");
  expect([...rows].map((row) => row.textContent)).toEqual(["Managednot set", "Project · local.terminalx/settings.local.jsontx/", "Project · shared.terminalx/settings.jsonteam/", "Your settingsme/", "Defaultempty"]);
  expect(rows[1].getAttribute("aria-current")).toBe("true");
  expect(within(rows[1]).getByLabelText("Applies")).toBeTruthy();
  expect(within(rows[2]).getByText("team/").className).toContain("line-through");
  expect(within(menu).getByRole("menuitem", { name: /Open .terminalx\/settings.local.json/ })).toBeTruthy();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Reset to project value" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith("/repo", "repositoryLocal", "branchPrefix", null));
});

it("Reset to default removes a user value", async () => {
  resolve.mockResolvedValue(withLayers(at("user", "me/"), at("defaults", "")));
  render(<LayeredConfiguration />);
  openMenu(await screen.findByRole("button", { name: "Branch prefix: where this value comes from" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Reset to default" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(null, "user", "branchPrefix", null));
});

it("Settings files lists each layer with its chips and an error naming file, line and key", async () => {
  files.mockResolvedValue([
    { layer: "managed", path: "/Library/Managed Preferences/ai.terminalx.plist", displayPath: "/Library/Managed Preferences/ai.terminalx.plist", exists: false, keys: 0, git: null, problem: null },
    { layer: "repositoryLocal", path: "/repo/.terminalx/settings.local.json", displayPath: "~/repo/.terminalx/settings.local.json", exists: true, keys: 2, git: "ignored", problem: { key: "scripts.teardown", line: 7, message: "isn’t a setting", effect: "ignoredKey" } },
    { layer: "repositoryShared", path: "/repo/.terminalx/settings.json", displayPath: "~/repo/.terminalx/settings.json", exists: true, keys: 5, git: "committed", problem: null },
    ...userFiles,
  ] satisfies SettingsFileLayer[]);
  render(<LayeredConfiguration />);
  const section = (await screen.findByRole("heading", { name: "Settings files" })).closest("section")!;
  expect(within(section).getByText("Where these values come from, highest first. Edits made in an editor show up here within a second.")).toBeTruthy();
  await waitFor(() => expect(section.querySelectorAll("li")).toHaveLength(5));
  const items = [...section.querySelectorAll<HTMLElement>("li[data-settings-file]")];
  expect(items.map((item) => item.dataset.settingsFile)).toEqual(["managed", "repositoryLocal", "repositoryShared", "user", "defaults"]);
  expect(within(items[0]).getByText("none on this Mac")).toBeTruthy();
  expect(within(items[1]).getByText("Project · local")).toBeTruthy();
  expect(within(items[1]).getByText("ignored by Git")).toBeTruthy();
  expect(within(items[2]).getByText("committed")).toBeTruthy();
  expect(within(items[2]).getByText("5 keys")).toBeTruthy();
  expect(within(items[3]).getByText("Your settings")).toBeTruthy();
  expect(within(items[3]).getByText("14 keys")).toBeTruthy();
  expect(within(items[4]).getByText("built into TerminalX")).toBeTruthy();
  const error = within(items[1]).getByRole("alert");
  expect(error.textContent).toBe("~/repo/.terminalx/settings.local.json line 7: scripts.teardown isn’t a setting. That key is ignored; the rest of the file applies.Open");
  fireEvent.click(within(error).getByRole("button", { name: "Open" }));
  await waitFor(() => expect(openPath).toHaveBeenCalledWith("/repo/.terminalx/settings.local.json", undefined));
});

it("refreshes Settings files when the user file changes on disk", async () => {
  render(<LayeredConfiguration />);
  await screen.findByText("14 keys");
  files.mockResolvedValue([{ ...userFiles[0], keys: 15 }, userFiles[1]]);
  listeners.get("settings_file_changed")!();
  await screen.findByText("15 keys");
});
