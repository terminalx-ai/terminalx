import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types/events";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/prefs", () => ({ usePrefs: () => ({ panelWidth: 360 }), setPrefs: vi.fn() }));
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
  invoke.mockImplementation(async (command: string) => {
    const files = [
      { path: "src/modified.ts", status: "modified", additions: 2, deletions: 1 },
      { path: "fixtures/untracked.json", status: "added", additions: 1, deletions: 0 },
    ];
    if (command === "review_range") return { target: "main", base: "base", head: "live-snapshot" };
    if (command === "changes_between") return files;
    if (command === "working_changes") return ["head", files];
    if (command === "work_status") return { isRepo: true, dirty: true, branch: "fix/test", ahead: 0, behind: 0 };
    if (command === "log_commits") return [];
    // No merge in progress (#736).
    if (command === "unfinished_merge") return null;
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

/** The panel opens on Branch's Overview; these are about its Changes view. */
const openChanges = () => fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

it("opens on the Branch tab's Overview, and reopens Branch on the view last shown", () => {
  render(<RightPanel cwd={cwd} branch="fix/test" />);
  expect(screen.getByText("Branch overview")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
  openChanges();
  expect(screen.queryByText("Branch overview")).toBeNull();
  // Away to Files and back to Branch: Changes again.
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  expect(screen.queryByRole("tab", { name: "Changes" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Branch" }));
  expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true");
});

it("shows workspace work after a status-only turn, and commits from its Uncommitted scope", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" events={events} />);
  openChanges();

  expect(await screen.findByText("All changes · 2 files")).toBeTruthy();
  expect(screen.getByText(/Against main/)).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith("working_changes", expect.anything());
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });

  await waitFor(() => expect(screen.getAllByTitle("Modified · src/modified.ts")).toHaveLength(1));
  expect(invoke).toHaveBeenCalledWith("working_changes", { cwd });

  // History and back keep a commit draft.
  fireEvent.change(screen.getByPlaceholderText("Commit message (⌘⏎ to commit)"), { target: { value: "Keep my draft" } });
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "history" } });
  expect(await screen.findByText("No commits yet.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "uncommitted" } });
  expect(screen.getByPlaceholderText("Commit message (⌘⏎ to commit)")).toHaveProperty("value", "Keep my draft");
});

it("offers workspace changes before there is a turn snapshot", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" />);
  openChanges();
  expect(await screen.findByText("All changes · 2 files")).toBeTruthy();
  expect(await screen.findByTitle("Added · fixtures/untracked.json")).toBeTruthy();
});

it("uses live-turn wording while an agent is running", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" events={events.slice(0, 1)} live />);
  openChanges();
  fireEvent.change(screen.getByLabelText("Changes scope"), { target: { value: "turn" } });
  expect(await screen.findByText("This turn · 2 files")).toBeTruthy();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("changes_between", { cwd, base: "snapshot", head: "live-snapshot" }));
});

it("keeps the working-tree view scoped to the workspace", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" workingTree />);
  openChanges();
  expect(await screen.findByText("All changes · 2 files")).toBeTruthy();
  expect(screen.getByTitle("Added · fixtures/untracked.json")).toBeTruthy();
});
