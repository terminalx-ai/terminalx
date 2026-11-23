import { useState } from "react";
import { SettingsPage } from "./SettingsPage";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, SessionEntry } from "@/types/session";
import type { Configuration, ConfigurationLayer } from "@/types/configuration";
const state = vi.hoisted(() => ({
  projects: [] as Project[], sessions: [] as SessionEntry[], selectedSessionId: null as string | null,
  update: vi.fn(), rerun: vi.fn(), resolve: vi.fn(), write: vi.fn(), review: vi.fn(), open: vi.fn(),
}));
vi.mock("@/lib/sessions", async (original) => ({ ...await original<typeof import("@/lib/sessions")>(), useSessionStore: () => state, updateProject: state.update }));
vi.mock("@/lib/workspaceSetup", () => ({ useWorkspaceSetups: () => ({ runs: [] }), rerunSetup: state.rerun }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: state.open }));
vi.mock("./EnvironmentSettings", () => ({ EnvironmentTable: ({ project }: { project: string }) => <p>Variables for {project}</p> }));
vi.mock("@/lib/configuration", () => ({
  configuration: { files: async () => [], watch: async () => () => {}, resolve: state.resolve, write: state.write, review: state.review },
}));
import { RepositoryScriptsTab } from "./RepositoryScriptsTab";

type Value = { value: unknown; source: ConfigurationLayer; locked?: boolean };
function resolved(values: Record<string, Value>, trust: Configuration["trust"] = null): Configuration {
  const all: Record<string, Value> = { setupScript: { value: "", source: "defaults" }, archiveScript: { value: "", source: "defaults" }, archiveTimeoutMinutes: { value: 5, source: "defaults" }, ...values };
  return { values: Object.fromEntries(Object.entries(all).map(([key, v]) => [key, { locked: false, redacted: false, ...v, layers: [{ layer: v.source, value: v.value, redacted: false }] }])), registry: [], warnings: [], trust };
}
const textarea = (label: string) => screen.getByLabelText(label) as HTMLTextAreaElement;
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

afterEach(cleanup);
beforeEach(() => {
  state.projects = [{ path: "/a", name: "a", scripts: { setup: "npm ci", archive: "" } }, { path: "/b", name: "b" }];
  state.sessions = [];
  state.selectedSessionId = null;
  state.rerun.mockReset().mockResolvedValue(undefined);
  state.update.mockReset().mockResolvedValue(undefined);
  state.write.mockReset().mockResolvedValue(undefined);
  state.review.mockReset().mockResolvedValue(true);
  state.open.mockReset().mockResolvedValue(undefined);
  state.resolve.mockReset().mockImplementation(async (path: string) => resolved(path === "/a" ? { setupScript: { value: "npm ci", source: "user" } } : {}));
});

it("shows the page's heading and saves each script on this computer as it is left, with the archive timeout", async () => {
  state.update.mockImplementation(async (_path, { scripts }) => {
    state.resolve.mockResolvedValue(resolved({
      setupScript: { value: scripts.setup, source: "user" },
      archiveScript: { value: scripts.archive, source: "user" },
      archiveTimeoutMinutes: { value: scripts.archiveTimeoutMinutes ?? 5, source: "user" },
    }));
  });
  render(<RepositoryScriptsTab projectPath="/a" />);
  expect(screen.getByRole("heading", { name: "Scripts" })).toBeTruthy();
  expect(screen.getByText("Commands that run when a workspace is set up, run or removed.")).toBeTruthy();
  await waitFor(() => expect(textarea("Setup script").value).toBe("npm ci"));
  expect(screen.queryByText(/· locked/)).toBeNull();
  // The project file opens from the title bar; unchanged scripts need no Save button.
  expect(screen.queryByRole("button", { name: /Open .*settings\.json/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["Setup", "Run", "Archive"]);
  expect(screen.getByText(/Saved on this computer for this project as you leave each script/)).toBeTruthy();
  expect(screen.getByText("Variables for /a")).toBeTruthy();
  fireEvent.blur(textarea("Setup script"));
  expect(state.update).not.toHaveBeenCalled();
  fireEvent.change(textarea("Archive script"), { target: { value: "docker compose down\nexit 0" } });
  fireEvent.blur(textarea("Archive script"));
  await screen.findByText("Archive script saved.");
  expect(state.update).toHaveBeenLastCalledWith("/a", { scripts: { setup: "npm ci", archive: "docker compose down\nexit 0" } });
  fireEvent.change(screen.getByLabelText("Archive timeout"), { target: { value: "2" } });
  await waitFor(() => expect(state.update).toHaveBeenLastCalledWith("/a", { scripts: { setup: "npm ci", archive: "docker compose down\nexit 0", archiveTimeoutMinutes: 2 } }));
  expect(state.write).not.toHaveBeenCalled();
});

it("keeps the draft and lets the person retry when saving fails", async () => {
  state.update.mockRejectedValueOnce(new Error("Disk unavailable"));
  render(<RepositoryScriptsTab projectPath="/a" />);
  await waitFor(() => expect(textarea("Setup script").value).toBe("npm ci"));
  fireEvent.change(textarea("Setup script"), { target: { value: "pnpm install" } });
  fireEvent.blur(textarea("Setup script"));
  expect((await screen.findByRole("alert")).textContent).toContain("Disk unavailable");
  expect(textarea("Setup script").value).toBe("pnpm install");
  fireEvent.keyDown(textarea("Setup script"), { key: "s", metaKey: true });
  await screen.findByText("Setup script saved.");
  expect(state.update).toHaveBeenLastCalledWith("/a", { scripts: { setup: "pnpm install", archive: "" } });
});

it("edits the first visible action as Run, and makes a Run action when there is none", async () => {
  state.projects = [{ path: "/a", name: "a", actions: [
    { id: "h", name: "Hidden", icon: "play", command: "echo hidden", hidden: true, runAfterSetup: false, concurrent: false },
    { id: "d", name: "Dev app", icon: "play", command: "pnpm dev", hidden: false, runAfterSetup: false, concurrent: false },
  ] }];
  const view = render(<RepositoryScriptsTab projectPath="/a" />);
  await screen.findByLabelText("Run script");
  expect(textarea("Run script").value).toBe("pnpm dev");
  fireEvent.change(textarea("Run script"), { target: { value: "" } });
  fireEvent.blur(textarea("Run script"));
  expect((await screen.findByRole("alert")).textContent).toContain("Dev app");
  expect(state.update).not.toHaveBeenCalled();
  fireEvent.change(textarea("Run script"), { target: { value: "pnpm dev --host" } });
  fireEvent.blur(textarea("Run script"));
  await screen.findByText("Run command saved.");
  expect(state.update).toHaveBeenCalledWith("/a", { actions: [state.projects[0].actions![0], { ...state.projects[0].actions![1], command: "pnpm dev --host" }] });
  view.unmount();

  state.update.mockClear();
  state.projects = [{ path: "/a", name: "a" }];
  render(<RepositoryScriptsTab projectPath="/a" />);
  await screen.findByLabelText("Run script");
  fireEvent.change(textarea("Run script"), { target: { value: "bun run dev" } });
  fireEvent.blur(textarea("Run script"));
  await waitFor(() => expect(state.update).toHaveBeenCalledWith("/a", { actions: [{ id: expect.any(String), name: "Run", icon: "play", command: "bun run dev", hidden: false, runAfterSetup: false, concurrent: false }] }));
});

it("locks a committed script, says where it comes from, and overrides it in the local file", async () => {
  state.resolve.mockResolvedValue(resolved({ setupScript: { value: "pnpm install --frozen-lockfile", source: "repositoryShared" } }, { hash: "h", required: false, keys: [] }));
  render(<RepositoryScriptsTab projectPath="/a" />);
  await screen.findByText("From .terminalx/settings.json · locked");
  expect(textarea("Setup script").value).toBe("pnpm install --frozen-lockfile");
  expect(textarea("Setup script").readOnly).toBe(true);
  expect(screen.getByLabelText("Locked")).toBeTruthy();
  expect(screen.getByText(/Edits go in your own/).textContent).toContain("settings.local.json, which git ignores.");
  expect(screen.getByText(/are committed in the repository, so everyone on the project gets the same ones/)).toBeTruthy();

  fireEvent.click(button("Override locally"));
  expect(textarea("Setup script").readOnly).toBe(false);
  fireEvent.change(textarea("Setup script"), { target: { value: "pnpm install" } });
  fireEvent.blur(textarea("Setup script"));
  await screen.findByText("Setup script saved.");
  expect(state.write).toHaveBeenCalledWith("/a", "repositoryLocal", "setupScript", "pnpm install");
  expect(state.update).not.toHaveBeenCalled();
});

it("removes a local override, and leaves managed scripts read-only with no override", async () => {
  state.resolve.mockResolvedValue(resolved({
    setupScript: { value: "make setup", source: "repositoryLocal" },
    archiveScript: { value: "make clean", source: "managed", locked: true },
    archiveTimeoutMinutes: { value: 10, source: "managed", locked: true },
  }));
  render(<RepositoryScriptsTab projectPath="/a" />);
  await screen.findByText("From .terminalx/settings.local.json · local override");
  expect(screen.getByText("Managed policy · locked")).toBeTruthy();
  expect(textarea("Archive script").readOnly).toBe(true);
  expect((screen.getByLabelText("Archive timeout") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText("Archive timeout") as HTMLSelectElement).value).toBe("10");
  expect(screen.getByText(/managed policy\. It cannot be changed here/)).toBeTruthy();
  expect(screen.queryByText("Override locally")).toBeNull();
  fireEvent.click(button("Remove local override"));
  await screen.findByText("Local override removed.");
  expect(state.write).toHaveBeenCalledWith("/a", "repositoryLocal", "setupScript", null);
});

it("asks to trust committed scripts, runs nothing until then, and Not now only hides the banner", async () => {
  state.resolve.mockResolvedValue(resolved({ archiveScript: { value: "docker compose down", source: "repositoryShared" } }, { hash: "h", required: true, keys: ["archiveScript"] }));
  state.sessions = [{ id: "s1", projectPath: "/a", cwd: "/a/w", worktreeName: "feature", tabs: [] }] as unknown as SessionEntry[];
  render(<RepositoryScriptsTab projectPath="/a" />);
  const banner = await screen.findByRole("region", { name: "Repository trust" });
  expect(banner.textContent).toContain("in this repository wants to run commands when a workspace is created or removed. Nothing runs until you trust it.");
  // The banner is the one trust warning: no second line under the script.
  expect(screen.queryByText(/does not run until you choose Review and trust/)).toBeNull();
  fireEvent.click(within(banner).getByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("region", { name: "Repository trust" })).toBeNull();
  cleanup();

  render(<RepositoryScriptsTab projectPath="/a" />);
  const again = await screen.findByRole("region", { name: "Repository trust" });
  state.resolve.mockResolvedValue(resolved({ archiveScript: { value: "docker compose down", source: "repositoryShared" } }, { hash: "h", required: false, keys: ["archiveScript"] }));
  fireEvent.click(within(again).getByRole("button", { name: "Review and trust" }));
  await screen.findByText(/Repository scripts trusted/);
  expect(state.review).toHaveBeenCalledWith("/a");
  expect(screen.queryByRole("region", { name: "Repository trust" })).toBeNull();
});

it("runs the saved setup now in the current workspace, and only once edits are saved and trusted", async () => {
  state.sessions = [
    { id: "archived", projectPath: "/a", cwd: "/a/old", worktreeName: "old", archived: true, tabs: [] },
    { id: "s1", projectPath: "/a", cwd: "/a/one", worktreeName: "one", tabs: [] },
    { id: "s2", projectPath: "/a", cwd: "/a/two", worktreeName: "two", tabs: [] },
  ] as unknown as SessionEntry[];
  state.selectedSessionId = "s2";
  render(<RepositoryScriptsTab projectPath="/a" />);
  await waitFor(() => expect(button("Run setup now").disabled).toBe(false));
  expect(button("Run setup now").title).toBe("Runs in two");
  fireEvent.click(button("Run setup now"));
  await screen.findByText(/Setup queued in two/);
  expect(state.rerun).toHaveBeenCalledWith("s2");
  fireEvent.change(textarea("Setup script"), { target: { value: "npm install" } });
  expect(button("Run setup now").disabled).toBe(true);
});

it("explains the environment a script runs with", async () => {
  render(<RepositoryScriptsTab projectPath="/a" />);
  await waitFor(() => expect(textarea("Setup script").value).toBe("npm ci"));
  await act(async () => { fireEvent.click(button("Environment info")); });
  const info = await screen.findByRole("dialog", { name: "Environment info" });
  expect(info.textContent).toContain("in a visible Setup tab");
  expect(info.textContent).toContain("$TERMINALX_REPO_ROOT is the project root");
  expect(within(info).getAllByRole("listitem")).toHaveLength(3);
  expect(within(info).getByRole("button", { name: "your and the project’s variables" })).toBeTruthy();
});

it("shows an unreadable configuration as an error without editable fields", async () => {
  state.resolve.mockRejectedValue(new Error("Invalid managed configuration; refusing to bypass policy."));
  render(<RepositoryScriptsTab projectPath="/a" />);
  expect((await screen.findByRole("alert")).textContent).toContain("refusing to bypass policy");
  expect(screen.queryByLabelText("Setup script")).toBeNull();
});

it("does not offer scripts for folders or unavailable projects", () => {
  state.projects = [{ path: "/folder", name: "folder", kind: "folder" }, { path: "/gone", name: "gone", archived: true }];
  const view = render(<RepositoryScriptsTab projectPath="/folder" />);
  expect(screen.getByText("Open a repository to configure its scripts.")).toBeTruthy();
  view.rerender(<RepositoryScriptsTab projectPath="/gone" />);
  expect(screen.queryByLabelText("Archive script")).toBeNull();
  view.rerender(<RepositoryScriptsTab projectPath="/missing" />);
  expect(screen.queryByLabelText("Archive script")).toBeNull();
});

it("does not ask to trust a committed script that a local override replaces", async () => {
  state.resolve.mockResolvedValue(resolved({ setupScript: { value: "make setup", source: "repositoryLocal" } }, { hash: "h", required: true, keys: ["setupScript"] }));
  state.sessions = [{ id: "s1", projectPath: "/a", cwd: "/a/w", worktreeName: "feature", tabs: [] }] as unknown as SessionEntry[];
  render(<RepositoryScriptsTab projectPath="/a" />);
  await screen.findByText("From .terminalx/settings.local.json · local override");
  expect(screen.queryByRole("region", { name: "Repository trust" })).toBeNull();
  expect(screen.queryByText(/not trusted yet/)).toBeNull();
  expect(button("Run setup now").disabled).toBe(false);
});

function SettingsHarness() {
  const [open, setOpen] = useState(true);
  return open
    ? <SettingsPage initialTab="repositories.scripts" initialProjectPath="/a" onBack={() => setOpen(false)} />
    : <button onClick={() => setOpen(true)}>Reopen Settings</button>;
}

it.each([
  { kind: "setup", source: "user" }, { kind: "archive", source: "user" },
  { kind: "setup", source: "repositoryLocal" }, { kind: "archive", source: "repositoryLocal" },
] as const)("keeps a focused $kind draft from $source on Escape, then reopens with saved content", async ({ kind, source }) => {
  state.resolve.mockImplementation(async () => resolved({
    setupScript: { value: state.projects[0].scripts?.setup ?? "", source },
    archiveScript: { value: state.projects[0].scripts?.archive ?? "", source },
  }));
  let finishSave: (() => void) | undefined;
  state.update.mockImplementation(async (_path, patch) => {
    await new Promise<void>((resolve) => { finishSave = resolve; });
    state.projects[0] = { ...state.projects[0], ...patch };
  });
  state.write.mockImplementation(async (_path, _layer, _key, script) => {
    await new Promise<void>((resolve) => { finishSave = resolve; });
    state.projects[0].scripts = { ...state.projects[0].scripts!, [kind]: script };
  });
  render(<SettingsHarness />);
  const label = kind === "setup" ? "Setup script" : "Archive script";
  const editor = await screen.findByLabelText(label);
  act(() => editor.focus());
  fireEvent.change(editor, { target: { value: "echo changed" } });
  expect(document.activeElement).toBe(editor);
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.queryByText("Reopen Settings")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Save your changes");
  expect(state.update).not.toHaveBeenCalled();
  expect(state.write).not.toHaveBeenCalled();
  fireEvent.click(button(`Save ${kind} script`));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByText("Reopen Settings")).toBeNull();
  await act(async () => { finishSave!(); });
  await screen.findByText(`${kind === "setup" ? "Setup" : "Archive"} script saved.`);
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(button("Reopen Settings"));
  await waitFor(() => expect(textarea(label).value).toBe("echo changed"));
});

it("keeps Settings and the draft open after a failed save, with an explicit retry", async () => {
  state.update.mockRejectedValueOnce(new Error("Disk unavailable"));
  render(<SettingsHarness />);
  const editor = await screen.findByLabelText("Setup script");
  act(() => editor.focus());
  fireEvent.change(editor, { target: { value: "echo retry" } });
  fireEvent.keyDown(editor, { key: "Escape" });
  fireEvent.click(button("Save setup script"));
  await screen.findByText("Disk unavailable");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(textarea("Setup script").value).toBe("echo retry");
  expect(screen.queryByText("Reopen Settings")).toBeNull();
  state.resolve.mockResolvedValue(resolved({ setupScript: { value: "echo retry", source: "user" } }));
  fireEvent.click(button("Save setup script"));
  await screen.findByText("Setup script saved.");
  fireEvent.click(button("Back to app"));
  expect(button("Reopen Settings")).toBeTruthy();
});


it.each((["setup", "archive"] as const).flatMap((kind) =>
  [false, true].map((edited) => ({ kind, edited })),
))("shows the inherited $kind script after removing its local override (edited: $edited) and lets Settings close", async ({ kind, edited }) => {
  const key = kind === "setup" ? "setupScript" : "archiveScript";
  const label = kind === "setup" ? "Setup script" : "Archive script";
  let removed = false;
  state.resolve.mockImplementation(async () => resolved({
    [key]: { value: removed ? "echo committed" : "echo local", source: removed ? "repositoryShared" : "repositoryLocal" },
    archiveTimeoutMinutes: { value: removed ? 10 : 2, source: removed ? "repositoryShared" : "repositoryLocal" },
  }));
  state.write.mockImplementation(async (_path, _layer, writtenKey, value) => {
    if (writtenKey === key && value === null) removed = true;
  });
  render(<SettingsHarness />);
  await waitFor(() => expect(textarea(label).value).toBe("echo local"));
  // Removing an override also discards any draft in that override, after the write succeeds.
  if (edited) fireEvent.change(textarea(label), { target: { value: "echo unsaved local" } });
  fireEvent.click(button("Remove local override"));
  await screen.findByText("Local override removed.");
  expect(state.write).toHaveBeenCalledWith("/a", "repositoryLocal", key, null);
  await waitFor(() => expect(textarea(label).value).toBe("echo committed"));
  expect(textarea(label).readOnly).toBe(true);
  expect(screen.queryByRole("button", { name: `Save ${kind} script` })).toBeNull();
  if (kind === "archive") {
    expect(state.write).toHaveBeenCalledWith("/a", "repositoryLocal", "archiveTimeoutMinutes", null);
    expect((screen.getByLabelText("Archive timeout") as HTMLSelectElement).value).toBe("10");
  }
  act(() => textarea(label).focus());
  fireEvent.keyDown(textarea(label), { key: "Escape" });
  expect(button("Reopen Settings")).toBeTruthy();
  fireEvent.click(button("Reopen Settings"));
  await waitFor(() => expect(textarea(label).value).toBe("echo committed"));
});


it("keeps the local draft and close guard when removing an override fails", async () => {
  state.resolve.mockResolvedValue(resolved({ setupScript: { value: "echo local", source: "repositoryLocal" } }));
  state.write.mockRejectedValueOnce(new Error("Cannot remove override"));
  render(<SettingsHarness />);
  await screen.findByLabelText("Setup script");
  fireEvent.change(textarea("Setup script"), { target: { value: "echo unsaved" } });
  fireEvent.click(button("Remove local override"));
  await screen.findByText("Cannot remove override");
  expect(textarea("Setup script").value).toBe("echo unsaved");
  expect(textarea("Setup script").readOnly).toBe(false);
  expect(button("Save setup script").disabled).toBe(false);
  fireEvent.keyDown(textarea("Setup script"), { key: "Escape" });
  expect(screen.queryByText("Reopen Settings")).toBeNull();
  expect(screen.getByText(/Save your changes before leaving Settings/)).toBeTruthy();
});
