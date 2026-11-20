import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload, ScreenPrompt } from "@/types/events";
import type { SessionEntry, TabStatus } from "@/types/session";

// PRO-460: the real TabView, Chat and Composer over the local backend, for a
// Claude Code tab stopped on a question it drew in its own terminal.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), enterTerminalView: vi.fn(), views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {}, waiting: {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => true, startTabAgent: vi.fn(), terminalPaneId: (id: string) => id,
  clearTabViewError: vi.fn(), forgetTabView: vi.fn(), leaveTerminalView: vi.fn(), cancelTerminalView: vi.fn(), enterTerminalView: mocks.enterTerminalView,
}));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => null }));
vi.mock("@/components/chat/Dictation", () => ({ DictationStatus: () => null, MicButton: () => null, useDictationInto: () => ({ dictating: false, toggle: vi.fn(), prepareSend: vi.fn(() => vi.fn()) }), useDictationShortcuts: vi.fn() }));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: () => null }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));

import { TabView } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { upsertSession, useSessionStore } from "@/lib/sessions";
import { applyEvent, setTabStatus } from "@/lib/agentEvents";

let session: SessionEntry;
let seq: number;
let refusal: string | null;

const OFFER: ScreenPrompt = {
  id: "0123456789abcdef",
  title: "We recommend compacting earlier",
  text: "Each message re-sends the whole conversation.\n\nWant to autocompact at 400k tokens instead?",
  options: [{ label: "Autocompact at ‹ 400k › tokens" }, { label: "Keep auto (1m tokens)" }],
  selected: 0,
  dismiss: "Not now",
  hint: "↑/↓ choose · ←/→ change size · enter confirm · esc not now",
};

function Tab() {
  const current = useSessionStore().sessions.find((s) => s.id === session.id)!;
  return <TooltipProvider><TabView session={current} tab={current.tabs[0]} active /></TooltipProvider>;
}

const tab = () => session.tabs[0].id;
const event = (payload: Payload): AgentEvent => ({ id: `e${++seq}`, seq, sessionId: session.id, tabId: tab(), harness: "claude", ts: new Date().toISOString(), payload });
const emit = (payload: Payload) => act(() => applyEvent(event(payload)));
const showStatus = (next: TabStatus) => act(() => setTabStatus(session.id, tab(), next));
const card = () => screen.queryByTestId("terminal-prompt");
const answers = () => mocks.invoke.mock.calls.filter(([command]) => command === "answer_terminal_prompt").map(([, args]) => args);

beforeEach(() => {
  const id = `terminal-prompt-${Math.random().toString(36).slice(2)}`;
  session = { id, projectPath: "/workspace", cwd: "/workspace", title: "Terminal prompt", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `${id}-tab`, harness: "claude", model: "opus", permissionMode: "default", status: "completed", created: "", modified: "" }] };
  seq = 0;
  refusal = null;
  mocks.enterTerminalView.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "answer_terminal_prompt" && refusal) throw refusal;
    return command.startsWith("list_") || command === "load_tab_events" ? [] : null;
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  upsertSession(session);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a question Claude Code drew in its own terminal (PRO-460)", () => {
  it("is a card in the chat with its title, text and options, answered from there", async () => {
    render(<Tab />);
    emit({ type: "terminal_prompt", prompt: OFFER });
    showStatus("waiting");
    const shown = await screen.findByTestId("terminal-prompt");
    expect(within(shown).getByText("We recommend compacting earlier")).toBeTruthy();
    expect(within(shown).getByText("Want to autocompact at 400k tokens instead?")).toBeTruthy();
    expect(within(shown).getByRole("radio", { name: /Autocompact at ‹ 400k › tokens/ }).getAttribute("aria-checked")).toBe("true");
    // Never the generic notice that only sends the reader to the terminal.
    expect(screen.queryByText("Check the terminal for a pending decision, or stop the session.")).toBeNull();

    fireEvent.click(within(shown).getByRole("radio", { name: /Keep auto/ }));
    fireEvent.click(within(shown).getByRole("button", { name: /Choose/ }));
    await waitFor(() => expect(answers()).toEqual([{ sessionId: session.id, tabId: tab(), promptId: OFFER.id, choice: 1 }]));

    fireEvent.click(within(shown).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(answers()).toHaveLength(2));
    expect(answers()[1]).toMatchObject({ choice: null });

    fireEvent.click(within(shown).getByRole("button", { name: "Open terminal" }));
    expect(mocks.enterTerminalView).toHaveBeenCalledTimes(1);

    // Gone from the terminal: gone from the chat.
    emit({ type: "terminal_prompt", prompt: null });
    showStatus("completed");
    await waitFor(() => expect(card()).toBeNull());
  });

  it("says plainly that the terminal waits on a decision it could not read, with a way there", async () => {
    render(<Tab />);
    emit({ type: "terminal_prompt", prompt: { id: "unread", options: [] } });
    showStatus("waiting");
    const shown = await screen.findByTestId("terminal-prompt");
    expect(within(shown).getByText("Claude Code is waiting on a decision in its terminal")).toBeTruthy();
    expect(within(shown).queryByRole("button", { name: /Choose/ })).toBeNull();
    fireEvent.click(within(shown).getByRole("button", { name: "Open terminal" }));
    expect(mocks.enterTerminalView).toHaveBeenCalledTimes(1);
  });

  it("is only shown while the tab waits on it, and a refusal is said in the runtime's words", async () => {
    render(<Tab />);
    emit({ type: "terminal_prompt", prompt: OFFER });
    expect(card()).toBeNull();
    showStatus("waiting");
    const shown = await screen.findByTestId("terminal-prompt");
    refusal = "runtime.session.terminalPrompt: That question is no longer showing in the agent's terminal.";
    fireEvent.click(within(shown).getByRole("button", { name: /Choose/ }));
    expect(await screen.findByText("That question is no longer showing in the agent's terminal.")).toBeTruthy();
  });
});
