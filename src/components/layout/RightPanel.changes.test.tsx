import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types/events";
import { setPrefs } from "@/lib/prefs";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/hotkeys", () => ({ useHotkey: vi.fn(), keycaps: () => [], useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
vi.mock("@/lib/dialogs", () => ({ openSettle: vi.fn(), openWorkspaceDelete: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/changes/PrPanel", () => ({ PrPanel: () => null }));
vi.mock("@/components/changes/BranchPanel", () => ({ BranchPanel: ({ active }: { active: boolean }) => (active ? <p>Branch overview</p> : null) }));
vi.mock("@/components/files/FileTree", () => ({ FileTree: () => null }));

const { RightPanel } = await import("./RightPanel");
const cwd = "/repo/dirty-workspace";
const events: AgentEvent[] = [
  { id: "prompt", sessionId: "session", tabId: "tab", harness: "codex", seq: 1, ts: "",
    payload: { type: "user_message", text: "Is the code committed and pushed?", queued: false, baseline: "snapshot" } },
  { id: "done", sessionId: "session", tabId: "tab", harness: "codex", seq: 2, ts: "",
    payload: { type: "turn_completed", status: "ok", head: "snapshot", authFailed: false } },
];

beforeEach(() => {
  setPrefs({ panelWidth: 360, diffMode: "unified", diffHideWhitespace: false, diffWrap: true, diffWrapFiles: {} });
  invoke.mockImplementation(async (command: string) => {
    const files = [
      { path: "src/modified.ts", status: "modified", additions: 2, deletions: 1 },
      { path: "fixtures/untracked.json", status: "added", additions: 1, deletions: 0 },
    ];
    if (command === "review_range") return { target: "main", base: "base", head: "live-snapshot" };
    if (command === "changes_between") return files;
    if (command === "working_changes") return ["head", files];
    if (command === "working_change_sets") return ["head", "index", [], files];
    if (command === "work_status") return { isRepo: true, dirty: true, branch: "fix/test", ahead: 0, behind: 0 };
    if (command === "log_commits") return [];
    // No merge in progress (#736).
    if (command === "unfinished_merge") return null;
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

/** The panel opens on Checks; these are about its Changes tab. */
const openChanges = () => fireEvent.click(screen.getByRole("button", { name: /^Changes(\s*\d+)?$/ }));

it("opens on Checks, with Changes a tab of its own that counts the branch's files (PRO-394)", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" />);
  expect(screen.getByText("Branch overview")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Checks" }).getAttribute("aria-pressed")).toBe("true");
  // The tab row counts the files in the branch before Changes is opened.
  expect((await screen.findByTestId("panel-changes-count")).textContent).toBe("2");
  openChanges();
  expect(screen.queryByText("Branch overview")).toBeNull();
  expect(screen.getByRole("button", { name: /^Changes(\s*\d+)?$/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  fireEvent.click(screen.getByRole("button", { name: "Checks" }));
  expect(screen.getByText("Branch overview")).toBeTruthy();
});

it("shows workspace work after a status-only turn, and commits from its Uncommitted scope", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" events={events} />);
  openChanges();

  expect(await screen.findByText("0 of 2 viewed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Comparison target" }).textContent).toBe("vs main");
  expect(invoke).not.toHaveBeenCalledWith("working_changes", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Changes scope" }));
  fireEvent.click(screen.getByRole("button", { name: /^Uncommitted changes/ }));

  await waitFor(() => expect(screen.getAllByTitle("Modified · src/modified.ts")).toHaveLength(1));
  expect(invoke).toHaveBeenCalledWith("working_change_sets", { cwd, hideWhitespace: false });

  // History and back keep a commit draft.
  fireEvent.change(screen.getByPlaceholderText("Commit message (Ctrl+⏎ to commit)"), { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Changes scope" }));
  fireEvent.click(screen.getByRole("button", { name: /^All commits/ }));
  expect(await screen.findByText("No commits yet.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Changes scope" }));
  fireEvent.click(screen.getByRole("button", { name: /^Uncommitted changes/ }));
  expect(screen.getByPlaceholderText("Commit message (Ctrl+⏎ to commit)")).toHaveProperty("value", "Keep my draft");
});

it("offers workspace changes before there is a turn snapshot", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" />);
  openChanges();
  expect(await screen.findByText("0 of 2 viewed")).toBeTruthy();
  expect(await screen.findByTitle("Added · fixtures/untracked.json")).toBeTruthy();
});

it("uses live-turn wording while an agent is running", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" events={events.slice(0, 1)} live />);
  openChanges();
  fireEvent.click(screen.getByRole("button", { name: "Changes scope" }));
  fireEvent.click(screen.getByRole("button", { name: /^(Latest turn|This turn)/ }));
  expect(await screen.findByText("0 of 2 viewed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Changes scope" }).textContent).toBe("This turn");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("changes_between", { cwd, base: "snapshot", head: "live-snapshot", hideWhitespace: false }));
});

it("keeps the working-tree view scoped to the workspace", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" workingTree />);
  openChanges();
  expect(await screen.findByText("0 of 2 viewed")).toBeTruthy();
  expect(screen.getByTitle("Added · fixtures/untracked.json")).toBeTruthy();
});

it.each(([
  ["cloud:org:workspace", "cloud:org:workspace", "app", "large.ts", "app/large.ts"],
  ["machine:m:p", "machine:m:p/trees/topic", "trees/topic", "large.ts", "large.ts"],
  ["machine:m:p", "machine:m:p/src", ".", "src/nested/large.ts", "nested/large.ts"],
  ["machine:m:p", "machine:m:p/src", ".", "src-other/large.ts", null],
  ["machine:m:p", "machine:m:p/trees/topic/src", "trees/topic", "src/large.ts", "large.ts"],
  ["machine:m:p", "machine:m:p//outside/topic/src", "/outside/topic", "src/large.ts", "large.ts"],
  ["cloud:org:workspace", "cloud:other:workspace", "app", "large.ts", null],
] as const).flatMap((row) => [false, true].flatMap((uncommitted) => [false, true].map((deleted) => [...row, uncommitted, deleted] as const))))("opens an oversized Changes file only through its matching file source (%s, %s, %s, %s → %s, uncommitted=%s, deleted=%s)", async (workspaceKey, fileKey, repo, changedPath, expectedPath, uncommitted, deleted) => {
  const { cloudGitSource } = await import("@/lib/gitSource");
  const { RemoteGit } = await import("@terminalx/portable/workspaceGit");
  const { getEditors, dropEditors } = await import("@/lib/editors");
  const call = vi.fn(async (method: string) => {
    if (method === "git.reviewRange") return { target: "main", base: "base", head: "head" };
    if (method === "git.changesBetween" || method === "git.workingChanges") return { head: "head", files: [{ path: changedPath, status: deleted ? "deleted" : "modified", additions: 0, deletions: 0 }] };
    if (method === "git.branches") return { branches: [] };
    if (method === "git.fileContents") return deleted ? { before: "<file too large to show>", beforeSize: 5 * 1024 * 1024, after: null } : { before: "old", after: "<file too large to show>", afterSize: 5 * 1024 * 1024 };
    throw new Error(method);
  });
  const gitSource = cloudGitSource({ workspaceKey, remote: new RemoteGit({ call } as never, repo), canWrite: false, author: async () => null });
  render(<RightPanel cwd="/remote" sessionId="large-panel" gitSource={gitSource} fileSource={{ key: fileKey } as never} />);
  openChanges();
  if (uncommitted) {
    fireEvent.click(screen.getByRole("button", { name: "Changes scope" }));
    fireEvent.click(screen.getByRole("button", { name: /^Uncommitted changes/ }));
  }
  fireEvent.click(await screen.findByRole("button", { name: /large.ts/ }));
  expect(await screen.findByText("5.0 MB")).toBeTruthy();
  if (expectedPath && !deleted) {
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(getEditors().editors.find((entry) => entry.sessionId === "large-panel")).toMatchObject({ rel: expectedPath, source: fileKey });
  } else expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("file_contents_at", expect.anything());
  dropEditors((entry) => entry.sessionId === "large-panel");
});

it.each(["Staged", "Unstaged"] as const)("opens oversized local %s files from Uncommitted and suppresses deleted files", async (section) => {
  const { getEditors, dropEditors } = await import("@/lib/editors");
  const original = invoke.getMockImplementation()!;
  const files = [
    { path: "large.ts", status: "modified", additions: 0, deletions: 0 },
    { path: "deleted.ts", status: "deleted", additions: 0, deletions: 0 },
  ];
  invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
    if (command === "working_change_sets") return ["head", "index", section === "Staged" ? files : [], section === "Unstaged" ? files : []];
    if (command === "file_contents_at") return args?.path === "deleted.ts"
      ? { before: "<file too large to show>", beforeSize: 6 * 1024 * 1024, after: null }
      : { before: "old", after: "<file too large to show>", afterSize: 5 * 1024 * 1024 };
    return original(command);
  });
  render(<RightPanel cwd={cwd} sessionId="local-uncommitted" branch="fix/test" />);
  openChanges();
  fireEvent.click(screen.getByRole("button", { name: "Changes scope" }));
  fireEvent.click(screen.getByRole("button", { name: /^Uncommitted changes/ }));
  const list = within(await screen.findByRole("region", { name: section }));
  fireEvent.click(await list.findByRole("button", { name: /Modified.*large.ts/ }));
  expect(await screen.findByText("5.0 MB")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("file_contents_at", { cwd, path: "large.ts", base: section === "Staged" ? "head" : "index", head: section === "Staged" ? "index" : null });
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  expect(getEditors().editors.find((entry) => entry.sessionId === "local-uncommitted")).toMatchObject({ kind: "text", root: cwd, rel: "large.ts" });
  fireEvent.click(list.getByRole("button", { name: /Deleted.*deleted.ts/ }));
  expect(await screen.findByText("6.0 MB")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
  dropEditors((entry) => entry.sessionId === "local-uncommitted");
});
