import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry, TabEntry } from "@/types/session";

// PRO-261: after a reset the chat says which turn it went back to and how many files were restored, with Undo reset.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), views: { views: {}, errors: {}, info: {}, switching: {}, waiting: {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => false, startTabAgent: vi.fn(), terminalPaneId: (id: string) => id,
  clearTabViewError: vi.fn(), forgetTabView: vi.fn(), leaveTerminalView: vi.fn(),
}));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => null }));
vi.mock("@/components/chat/Dictation", () => ({ DictationStatus: () => null, MicButton: () => null, useDictationInto: () => ({ dictating: false, toggle: vi.fn(), prepareSend: vi.fn(() => vi.fn()) }), useDictationShortcuts: vi.fn() }));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: () => null }));
// The empty chat's canvas animation needs a 2D context jsdom does not have.
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonScene: () => null, RaccoonRunner: () => null }));

import { TabView, resetNotice } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dropTabLog } from "@/lib/agentEvents";
import { upsertSession } from "@/lib/sessions";

let session: SessionEntry;
class QuietResizeObserver { observe() {} unobserve() {} disconnect() {} }
function open(extra: Record<string, unknown>) {
  const id = `reset-${Math.random().toString(36).slice(2)}`;
  session = { id, projectPath: "/workspace", cwd: "/workspace", title: "Reset", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `${id}-tab`, harness: "claude", model: "default", permissionMode: "default", status: "idle", created: "", modified: "", resetBackupId: "backup", ...extra } as TabEntry] };
  upsertSession(session);
  render(<TooltipProvider><TabView session={session} tab={session.tabs[0]} active /></TooltipProvider>);
}
beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((command: string) => Promise.resolve(command.startsWith("list_") || command === "load_tab_events" ? [] : null));
  vi.stubGlobal("ResizeObserver", QuietResizeObserver);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); dropTabLog(session.id, session.tabs[0].id); vi.unstubAllGlobals(); });

it("shows the turn and the restored files, and Undo reset restores them too", async () => {
  open({ resetTurn: 2, resetFilesRestored: 3 });
  const notice = await screen.findByText("Reset to turn 2 · 3 files restored");
  fireEvent.click(within(notice.parentElement!).getByRole("button", { name: "Undo reset" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("The 3 files it restored go back to how they were before the reset.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Undo reset" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("reset_chat", { sessionId: session.id, tabId: session.tabs[0].id, endSeq: null, resetFiles: false, confirm: null }));
});

it("names the turn of a chat-only reset without a file count", async () => {
  open({ resetTurn: 1 });
  expect(await screen.findByText("Reset to turn 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo reset" }));
  expect((await screen.findByRole("dialog")).textContent).not.toContain("files it restored");
});

it("words the notice for one file and for a reset saved by an older version", () => {
  const tab = { id: "t", harness: "claude", status: "idle", created: "", modified: "" } as TabEntry;
  expect(resetNotice({ ...tab, resetTurn: 4, resetFilesRestored: 1 } as TabEntry)).toBe("Reset to turn 4 · 1 file restored");
  expect(resetNotice({ ...tab, resetTurn: 4, resetFilesRestored: 0 } as TabEntry)).toBe("Reset to turn 4 · 0 files restored");
  expect(resetNotice(tab)).toBe("Chat reset");
});
