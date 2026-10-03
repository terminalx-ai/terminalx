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
    if (command === "changes_between") return [];
    if (command === "working_changes") return ["head", [
      { path: "src/modified.ts", status: "modified", additions: 2, deletions: 1 },
      { path: "fixtures/untracked.json", status: "added", additions: 1, deletions: 0 },
    ]];
    if (command === "work_status") return { isRepo: true, dirty: true, branch: "fix/test", ahead: 0, behind: 0 };
    if (command === "log_commits") return [];
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("explains an empty status-only turn and opens all uncommitted files in Repo", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" events={events} />);

  expect(await screen.findByText("No files changed during the last turn.")).toBeTruthy();
  expect(screen.getByText(/including untracked files/)).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith("working_changes", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "View all uncommitted changes" }));

  expect(await screen.findByRole("button", { name: /modified.ts/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /untracked.json/ })).toBeTruthy();
  expect(screen.getByRole("radio", { name: /Uncommitted/ }).getAttribute("aria-checked")).toBe("true");
  expect(invoke).toHaveBeenCalledWith("working_changes", { cwd });

  // The shortcut must also return from History without losing a commit draft.
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("radio", { name: "History" }));
  fireEvent.click(screen.getByRole("button", { name: "Changes" }));
  fireEvent.click(screen.getByRole("button", { name: "View all uncommitted changes" }));
  expect(await screen.findByRole("button", { name: /untracked.json/ })).toBeTruthy();
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Keep my draft");
});

it("offers workspace changes before there is a turn snapshot", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" />);
  expect(screen.getByText("Send a prompt to see what a turn changes.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View all uncommitted changes" }));
  expect(await screen.findByRole("button", { name: /untracked.json/ })).toBeTruthy();
});

it("uses live-turn wording while an agent is running", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" events={events.slice(0, 1)} live />);
  expect(await screen.findByText("No files changed during this turn yet.")).toBeTruthy();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("changes_between", { cwd, base: "snapshot", head: null }));
});

it("keeps the working-tree view scoped to the workspace", async () => {
  render(<RightPanel cwd={cwd} branch="fix/test" workingTree />);
  expect(await screen.findByText("Working tree")).toBeTruthy();
  expect(screen.getByRole("button", { name: /untracked.json/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "View all uncommitted changes" })).toBeNull();
});
