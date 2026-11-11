import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types/events";
import type { SessionEntry } from "@/types/session";

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

import { TabView } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyEvent, dropTabLog, getTabLog } from "@/lib/agentEvents";
import { upsertSession } from "@/lib/sessions";

let session: SessionEntry;
let request: AgentEvent;
class QuietResizeObserver { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  const id = `approval-${Math.random().toString(36).slice(2)}`;
  session = { id, projectPath: "/workspace", cwd: "/workspace", title: "Approval", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `${id}-tab`, harness: "opencode", model: "default", permissionMode: "default", status: "waiting", created: "", modified: "" }] };
  request = { id: "asked", sessionId: id, tabId: session.tabs[0].id, harness: "opencode", seq: 1, ts: "2026-11-09T09:00:00Z",
    payload: { type: "permission_requested", requestId: "approval", toolUseId: "tool", toolName: "Bash", input: { command: "echo approved" }, options: [
      { id: "once", label: "Allow once", kind: "allow_once" }, { id: "reject", label: "Reject", kind: "deny" },
    ] } };
  mocks.invoke.mockReset();
  vi.stubGlobal("ResizeObserver", QuietResizeObserver);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  upsertSession(session);
});
afterEach(() => { cleanup(); dropTabLog(session.id, session.tabs[0].id); vi.unstubAllGlobals(); });

it.each(["HTTP 500", "transport failure"])("lets the same desktop retry after an enqueued OpenCode reply has a %s", async (failure) => {
  // Real TabView, local backend, response cache and permission card. The IPC
  // double models the native HTTP worker: enqueue succeeds before delivery.
  // The matching Rust test exercises both failures over a real HTTP connection.
  let acknowledge!: () => void;
  let delivery!: (outcome: string) => void;
  let inFlight = false;
  const answers: unknown[] = [];
  mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === "load_tab_events") return Promise.resolve([request]);
    if (command !== "respond_permission") return Promise.resolve(command.startsWith("list_") ? [] : null);
    if (inFlight) return Promise.reject(new Error("The permission answer is still being delivered"));
    inFlight = true;
    answers.push(args);
    delivery = (outcome) => {
      inFlight = false;
      if (outcome === "delivered") applyEvent({ ...request, id: "decided", seq: 2, payload: {
        type: "permission_decided", requestId: "approval", allowed: false, label: "Denied", automatic: false,
      } });
    };
    return new Promise<void>((resolve) => { acknowledge = resolve; });
  });
  render(<TooltipProvider><TabView session={session} tab={session.tabs[0]} active /></TooltipProvider>);
  const allow = await screen.findByRole("button", { name: /^Allow/ });
  fireEvent.click(allow);
  fireEvent.click(allow);
  expect(answers).toHaveLength(1);
  await act(async () => acknowledge());
  expect(screen.getByRole("button", { name: /^Allow/ })).toBeTruthy();
  expect(getTabLog(session.id, session.tabs[0].id).permissionResponses?.has("approval")).toBeFalsy();
  await act(async () => delivery(failure));
  expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(answers).toHaveLength(2);
  expect(answers[1]).toEqual(expect.objectContaining({ requestId: "approval", optionId: "reject" }));
  await act(async () => acknowledge());
  expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  await act(async () => delivery("delivered"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Deny" })).toBeNull());
  expect(getTabLog(session.id, session.tabs[0].id).events.filter(e => e.payload.type === "permission_decided")).toHaveLength(1);
});
