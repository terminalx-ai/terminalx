import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  fireEvent.change(screen.getByPlaceholderText("Commit message (⌘⏎ to commit)"), { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Changes scope" }));
  fireEvent.click(screen.getByRole("button", { name: /^All commits/ }));
  expect(await screen.findByText("No commits yet.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Changes scope" }));
  fireEvent.click(screen.getByRole("button", { name: /^Uncommitted changes/ }));
  expect(screen.getByPlaceholderText("Commit message (⌘⏎ to commit)")).toHaveProperty("value", "Keep my draft");
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
