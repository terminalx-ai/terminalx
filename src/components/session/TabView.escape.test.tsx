import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
import type { SessionEntry } from "@/types/session";

// #427. Escape is the agent's key: in the chat it interrupts the running turn
// and the agent's process stays; in the terminal view it is typed into the
// agent's own screen. Only the explicit stop ends the process, and only that
// shows the "Session closed" banner.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), views: { views: {} as Record<string, string>, errors: {}, info: {}, switching: {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => mocks.views, isPtyFirst: () => true, startTabAgent: vi.fn(), terminalPaneId: (id: string) => id,
  clearTabViewError: vi.fn(), leaveTerminalView: vi.fn(),
}));
// The agent's own screen: an xterm with the textarea it reads keys from.
vi.mock("@/components/terminal/TerminalView", () => ({
  TerminalView: () => (
    <div className="terminal-host">
      <div className="xterm">
        <textarea aria-label="Terminal input" />
      </div>
    </div>
  ),
}));
vi.mock("@/components/chat/Chat", () => ({ Chat: ({ footer }: { footer: React.ReactNode }) => <div>{footer}</div> }));
vi.mock("@/components/chat/Composer", () => ({
  Composer: ({ busy, onStop, stopMode }: { busy: boolean; onStop: () => void; stopMode?: string }) => (
    <div>
      <textarea aria-label="Prompt" />
      {busy && <button data-testid="composer-stop" data-stop={stopMode} onClick={onStop} />}
    </div>
  ),
}));
vi.mock("./ContinuationDialog", () => ({ ContinuationDialog: () => <div>Continue dialog</div> }));

import { TabView } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyEvent, setTabStatus } from "@/lib/agentEvents";
import { setPrefs } from "@/lib/prefs";
import { upsertSession, useSessionStore, selectSession } from "@/lib/sessions";
import type { SessionBackend } from "@/lib/sessionBackend";
import type { TabStatus } from "@/types/session";

let seq = 0;
let session: SessionEntry;
const tabId = () => session.tabs[0].id;
const event = (payload: Payload): AgentEvent => ({ id: `e${++seq}`, seq, sessionId: session.id, tabId: tabId(), harness: "claude", ts: new Date().toISOString(), payload });
const emit = (payload: Payload) => act(() => applyEvent(event(payload)));
const status = (next: TabStatus) => act(() => setTabStatus(session.id, tabId(), next));
const called = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
const escape = (target: Element | Window = screen.getByLabelText("Prompt")) => fireEvent.keyDown(target, { key: "Escape", code: "Escape" });
const banner = () => screen.queryByText(/Session closed/);
const stopControl = () => screen.getByTestId("composer-stop");
/** Let a resolved command's `then` run. */
const settle = () => act(async () => void (await Promise.resolve()));

function Harness({ backend }: { backend?: SessionBackend }) {
  const store = useSessionStore();
  const current = store.sessions.find((s) => s.id === session.id)!;
  return (
    <TooltipProvider>
      <TabView session={current} tab={current.tabs[0]} active backend={backend} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  setPrefs({ shortcuts: {} });
  session = {
    id: `session${++seq}`, projectPath: "/workspace", cwd: "/workspace", title: "Escape", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `tab${seq}`, harness: "claude", model: "", permissionMode: "default", status: "in_progress", created: "", modified: "" }],
  };
  mocks.views.views = {};
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "load_tab_events" || command === "list_workspaces" || command === "list_models") return [];
    // The hard stop ends the process: the tab is idle when it answers.
    if (command === "stop_tab") setTabStatus(session.id, tabId(), "idle");
    return undefined;
  });
  upsertSession(session);
  selectSession(session.id);
});
afterEach(cleanup);

describe("Escape in the chat", () => {
  it("interrupts the running turn and stops nothing: no kill, no banner", async () => {
    render(<Harness />);
    emit({ type: "user_message", text: "Refactor the parser", queued: false });

    // The app takes the key, from the composer too.
    expect(escape()).toBe(false);
    await settle();

    expect(called("interrupt_turn")).toEqual([{ sessionId: session.id, tabId: tabId() }]);
    expect(called("stop_tab")).toEqual([]);
    expect(banner()).toBeNull();

    // The agent answers through its transcript: the turn is stopped, the tab idle, and still nothing was closed.
    emit({ type: "turn_completed", status: "aborted", authFailed: false });
    status("idle");
    expect(banner()).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume safely" })).toBeNull();
    expect(called("stop_tab")).toEqual([]);
  });

  it("interrupts while the agent waits on an answer too", async () => {
    render(<Harness />);
    emit({ type: "user_message", text: "Run the migration", queued: false });
    status("waiting");
    expect(escape()).toBe(false);
    await settle();
    expect(called("interrupt_turn")).toHaveLength(1);
    expect(called("stop_tab")).toEqual([]);
  });

  it("does nothing with nothing running, and leaves the key alone", () => {
    render(<Harness />);
    status("idle");
    expect(escape()).toBe(true);
    status("completed");
    expect(escape()).toBe(true);
    expect(called("interrupt_turn")).toEqual([]);
    expect(called("stop_tab")).toEqual([]);
  });

  it.each(["dialog", "alertdialog", "menu", "listbox"])("leaves Escape to an open %s", (role) => {
    render(
      <>
        <div role={role} />
        <Harness />
      </>,
    );
    expect(escape()).toBe(true);
    expect(called("interrupt_turn")).toEqual([]);
  });

  it("leaves Escape to an editor pane that has the focus", () => {
    render(
      <>
        <div className="editor-pane">
          <input aria-label="Find" />
        </div>
        <Harness />
      </>,
    );
    const find = screen.getByLabelText("Find");
    find.focus();
    expect(escape(find)).toBe(true);
    expect(called("interrupt_turn")).toEqual([]);
  });

  it("follows the reader's own key for the interrupt, and then Escape is nobody's", async () => {
    setPrefs({ shortcuts: { "session.interrupt": ["shift+escape"] } });
    render(<Harness />);
    expect(escape()).toBe(true);
    expect(called("interrupt_turn")).toEqual([]);
    expect(fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Escape", code: "Escape", shiftKey: true })).toBe(false);
    await settle();
    expect(called("interrupt_turn")).toHaveLength(1);
    expect(called("stop_tab")).toEqual([]);
  });
});

describe("Escape in the terminal view", () => {
  beforeEach(() => {
    mocks.views.views = { [tabId()]: "terminal" };
  });

  it("is typed into the agent's own screen: the app neither takes it nor stops anything", async () => {
    render(<Harness />);
    const terminal = screen.getByLabelText("Terminal input");
    const typed = vi.fn();
    terminal.addEventListener("keydown", typed);
    terminal.focus();

    expect(escape(terminal)).toBe(true);
    await settle();

    expect(typed).toHaveBeenCalledTimes(1);
    expect(called("interrupt_turn")).toEqual([]);
    expect(called("stop_tab")).toEqual([]);
    expect(banner()).toBeNull();
    expect(screen.getByText("Terminal view · Working")).toBeTruthy();
  });

  it("is not the app's from anywhere else in the window either", async () => {
    render(<Harness />);
    expect(escape(window)).toBe(true);
    await settle();
    expect(called("interrupt_turn")).toEqual([]);
    expect(called("stop_tab")).toEqual([]);
  });

  it("is still the terminal's when the interrupt is bound to something else", async () => {
    setPrefs({ shortcuts: { "session.interrupt": ["shift+escape"] } });
    render(<Harness />);
    const terminal = screen.getByLabelText("Terminal input");
    expect(escape(terminal)).toBe(true);
    // The remapped key is not bound in the terminal view either: every key there is the agent's.
    expect(fireEvent.keyDown(terminal, { key: "Escape", code: "Escape", shiftKey: true })).toBe(true);
    await settle();
    expect(called("interrupt_turn")).toEqual([]);
  });

  it("keeps the explicit Stop session control, which is the hard stop", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await waitFor(() => expect(called("stop_tab")).toHaveLength(1));
    expect(await screen.findByText(/Session closed/)).toBeTruthy();
    expect(called("interrupt_turn")).toEqual([]);
  });
});

describe("the hard stop", () => {
  it("has no key until the reader gives it one, and then ends the process and shows the banner", async () => {
    render(<Harness />);
    // Nothing is bound to it by default.
    expect(fireEvent.keyDown(window, { key: ".", code: "Period", ctrlKey: true })).toBe(true);
    expect(called("stop_tab")).toEqual([]);

    act(() => setPrefs({ shortcuts: { "session.stop": ["mod+."] } }));
    expect(fireEvent.keyDown(window, { key: ".", code: "Period", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(called("stop_tab")).toEqual([{ sessionId: session.id, tabId: tabId() }]));
    expect(await screen.findByText(/Session closed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume safely" })).toBeTruthy();
    expect(called("interrupt_turn")).toEqual([]);
  });

  it("is what the composer's Stop becomes once an interrupt went unanswered", async () => {
    render(<Harness />);
    emit({ type: "user_message", text: "Refactor the parser", queued: false });
    expect(stopControl().dataset.stop).toBe("interrupt");

    // First press: Escape for the agent.
    fireEvent.click(stopControl());
    await settle();
    expect(called("interrupt_turn")).toHaveLength(1);
    expect(called("stop_tab")).toEqual([]);
    expect(banner()).toBeNull();

    // The same turn is still running: the control now ends the process.
    expect(stopControl().dataset.stop).toBe("force");
    fireEvent.click(stopControl());
    await waitFor(() => expect(called("stop_tab")).toHaveLength(1));
    expect(called("interrupt_turn")).toHaveLength(1);
    expect(await screen.findByText(/Session closed/)).toBeTruthy();
  });

  it("is not armed by an interrupt the agent answered: the next turn's Stop is an interrupt again", async () => {
    render(<Harness />);
    emit({ type: "user_message", text: "First", queued: false });
    expect(escape()).toBe(false);
    await settle();
    expect(stopControl().dataset.stop).toBe("force");

    // The agent stopped that turn and went straight on to the next message.
    emit({ type: "turn_completed", status: "aborted", authFailed: false });
    emit({ type: "user_message", text: "Second", queued: false });
    expect(stopControl().dataset.stop).toBe("interrupt");

    fireEvent.click(stopControl());
    await settle();
    expect(called("interrupt_turn")).toHaveLength(2);
    expect(called("stop_tab")).toEqual([]);
    expect(banner()).toBeNull();
  });
});

describe("a cloud tab", () => {
  function cloud(interrupt: boolean) {
    const calls = { interrupt: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const backend = {
      kind: "cloud", key: `cloud:org-1:ws-1:${session.id}`, generation: "g1", logSessionId: session.id, readOnlyReason: null,
      caps: { local: false, write: true, steer: true, images: false, recovery: false, interrupt },
      openTab: () => undefined, markRead: async () => undefined, patchTab: () => undefined, setTabStatus: () => undefined,
      interrupt: calls.interrupt, stop: calls.stop,
    } as unknown as SessionBackend;
    return { backend, calls };
  }

  it("interrupts over the live connection, and never queues a stop for Escape", async () => {
    const { backend, calls } = cloud(true);
    render(<Harness backend={backend} />);
    expect(escape()).toBe(false);
    await settle();
    expect(calls.interrupt).toHaveBeenCalledWith(tabId());
    expect(calls.stop).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it("leaves Escape alone on a runtime that cannot take an interrupt, where Stop stays the stop", async () => {
    const { backend, calls } = cloud(false);
    render(<Harness backend={backend} />);
    expect(escape()).toBe(true);
    expect(calls.interrupt).not.toHaveBeenCalled();
    expect(calls.stop).not.toHaveBeenCalled();

    expect(stopControl().dataset.stop).toBe("stop");
    fireEvent.click(stopControl());
    await waitFor(() => expect(calls.stop).toHaveBeenCalledWith(tabId()));
    expect(calls.interrupt).not.toHaveBeenCalled();
  });
});
