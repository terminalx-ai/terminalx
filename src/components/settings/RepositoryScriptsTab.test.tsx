import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, SessionEntry } from "@/types/session";
import type { Configuration, ConfigurationLayer } from "@/types/configuration";
const state = vi.hoisted(() => ({
  projects: [] as Project[], sessions: [] as SessionEntry[], selectedSessionId: null as string | null,
  update: vi.fn(), rerun: vi.fn(), resolve: vi.fn(), write: vi.fn(), review: vi.fn(), open: vi.fn(),
}));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => state, updateProject: state.update }));
vi.mock("@/lib/workspaceSetup", () => ({ useWorkspaceSetups: () => ({ runs: [] }), rerunSetup: state.rerun }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: state.open }));
vi.mock("@/lib/configuration", () => ({
  configuration: { watch: async () => () => {}, resolve: state.resolve, write: state.write, review: state.review },
}));
import { RepositoryScriptsTab } from "./RepositoryScriptsTab";

type Value = { value: unknown; source: ConfigurationLayer; locked?: boolean };
function resolved(values: Record<string, Value>, trust: Configuration["trust"] = null): Configuration {
  const all: Record<string, Value> = { setupScript: { value: "", source: "defaults" }, archiveScript: { value: "", source: "defaults" }, archiveTimeoutMinutes: { value: 5, source: "defaults" }, ...values };
  return { values: Object.fromEntries(Object.entries(all).map(([key, v]) => [key, { locked: false, redacted: false, ...v }])), registry: [], warnings: [], trust };
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

it("shows the page's heading and saves each script on this computer, with the archive timeout", async () => {
  render(<RepositoryScriptsTab projectPath="/a" />);
  expect(screen.getByRole("heading", { name: "Scripts" })).toBeTruthy();
  expect(screen.getByText("Commands that run when a workspace is set up or removed. The run command lives in Actions.")).toBeTruthy();
  await waitFor(() => expect(textarea("Setup script").value).toBe("npm ci"));
  expect(screen.queryByText(/· locked/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Open settings\.json/ })).toBeNull();
  fireEvent.change(textarea("Archive script"), { target: { value: "docker compose down\nexit 0" } });
  fireEvent.change(screen.getByLabelText("Archive timeout"), { target: { value: "2" } });
  const saves = screen.getAllByRole("button", { name: "Save" });
  expect(saves[0].hasAttribute("disabled")).toBe(true);
  fireEvent.click(saves[1]);
  await screen.findByText("Archive script saved.");
  expect(state.update).toHaveBeenCalledWith("/a", { scripts: { setup: "npm ci", archive: "docker compose down\nexit 0", archiveTimeoutMinutes: 2 } });
  expect(state.write).not.toHaveBeenCalled();
});

it("keeps the draft and lets the person retry when saving fails", async () => {
  state.update.mockRejectedValueOnce(new Error("Disk unavailable"));
  render(<RepositoryScriptsTab projectPath="/a" />);
  await waitFor(() => expect(textarea("Setup script").value).toBe("npm ci"));
  fireEvent.change(textarea("Setup script"), { target: { value: "pnpm install" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
  expect((await screen.findByRole("alert")).textContent).toContain("Disk unavailable");
  expect(textarea("Setup script").value).toBe("pnpm install");
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
  await screen.findByText("Setup script saved.");
  expect(state.update).toHaveBeenLastCalledWith("/a", { scripts: { setup: "pnpm install", archive: "" } });
});

it("locks a committed script, says where it comes from, and overrides it in the local file", async () => {
  state.resolve.mockResolvedValue(resolved({ setupScript: { value: "pnpm install --frozen-lockfile", source: "repositoryShared" } }, { hash: "h", required: false, keys: [] }));
  render(<RepositoryScriptsTab projectPath="/a" />);
  await screen.findByText("From settings.json · locked");
  expect(textarea("Setup script").value).toBe("pnpm install --frozen-lockfile");
  expect(textarea("Setup script").readOnly).toBe(true);
  expect(screen.getByLabelText("Locked")).toBeTruthy();
  expect(screen.getByText(/Edits go in your own/).textContent).toContain("settings.local.json, which git ignores.");
  // Only the archive card can save; the locked setup offers its override instead.
  expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
  fireEvent.click(button("Open settings.json"));
  expect(state.open).toHaveBeenCalledWith("/a/.terminalx/settings.json");

  fireEvent.click(button("Override locally"));
  expect(textarea("Setup script").readOnly).toBe(false);
  fireEvent.change(textarea("Setup script"), { target: { value: "pnpm install" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
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
  await screen.findByText("From settings.local.json · local override");
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
  expect(screen.getByText(/does not run until you choose Review and trust/)).toBeTruthy();
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
  expect(info.textContent).toContain("Agent-only credentials are not passed on.");
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
  await screen.findByText("From settings.local.json · local override");
  expect(screen.queryByRole("region", { name: "Repository trust" })).toBeNull();
  expect(screen.queryByText(/not trusted yet/)).toBeNull();
  expect(button("Run setup now").disabled).toBe(false);
});
