import { beforeEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
  resize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api", () => ({ pty }));
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({ listen }));

async function loadTerminalStore() {
  vi.resetModules();
  return import("./terminal");
}

beforeEach(() => {
  vi.clearAllMocks();
  listen.mockResolvedValue(() => {});
});

describe("session shell tabs", () => {
  it("activates the most recently used shell and creates one only when absent", async () => {
    const terminal = await loadTerminalStore();

    const first = await terminal.activateLatestTerminal("s1", "/repo");
    const second = await terminal.openTerminal("s1", "/repo");
    terminal.setActiveTerminal("s1", first.id);
    const activated = await terminal.activateLatestTerminal("s1", "/repo");

    expect(first.title).toBe("Terminal 1");
    expect(second.title).toBe("Terminal 2");
    expect(activated.id).toBe(first.id);
    expect(pty.spawn).toHaveBeenCalledTimes(2);
    expect(terminal.getTerminalState().selected.s1).toEqual({ kind: "terminal", id: first.id });
  });

  it("keeps agent-owned panes out of shell selection and closing behavior", async () => {
    const terminal = await loadTerminalStore();
    const shell = await terminal.openTerminal("s1", "/repo");
    await terminal.adoptPane({ id: "tab:agent-1", sessionId: "s1", title: "Agent", hidden: true, owned: true });

    await terminal.closeTerminal("tab:agent-1");

    const state = terminal.getTerminalState();
    expect(state.panes.map((pane) => pane.id)).toEqual([shell.id]);
    expect(state.active.s1).toBe(shell.id);
    expect(state.selected.s1).toEqual({ kind: "terminal", id: shell.id });
  });

  it("uses stable distinct titles and selects an adjacent shell after close", async () => {
    const terminal = await loadTerminalStore();
    const first = await terminal.openTerminal("s1", "/repo");
    const second = await terminal.openTerminal("s1", "/repo");
    terminal.setActiveTerminal("s1", first.id);

    await terminal.closeTerminal(first.id);
    const third = await terminal.openTerminal("s1", "/repo");

    expect(terminal.getTerminalState().panes.map((pane) => pane.title)).toEqual([second.title, third.title]);
    expect(third.title).toBe("Terminal 3");
    expect(new Set(terminal.getTerminalState().panes.map((pane) => pane.title)).size).toBe(2);
  });

  it("leaves an empty workspace unselected after its last shell is closed", async () => {
    const terminal = await loadTerminalStore();
    const shell = await terminal.openTerminal("s1", "/repo");

    await terminal.closeTerminal(shell.id);

    expect(terminal.getTerminalState().panes).toEqual([]);
    expect(terminal.getTerminalState().selected.s1).toBeUndefined();
  });
});

describe("terminal counters", () => {
  it("counts output, the replay buffers it waits in, and live instances by renderer", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return () => {};
    });
    const terminal = await loadTerminalStore();
    const { setRenderer } = await import("./terminalCounters");
    await terminal.subscribeTerminals();

    // No view has asked for this pane yet: its output waits in a replay buffer.
    handlers.get("pty_data")!({ payload: { id: "p1", data: btoa("hello") } });
    expect(terminal.terminalCounters()).toMatchObject({ instances: 0, replayBuffers: 1, replayBytes: 5, data: { local: { events: 1, bytes: 5 }, cloud: { events: 0, bytes: 0 } } });

    const term = { write: vi.fn(), dispose: vi.fn(), buffer: { normal: { length: 40 }, alternate: { length: 24 } } };
    const el = document.createElement("div");
    terminal.getInstance("p1", () => ({ el, term, fit: {} }) as never);
    expect(term.write).toHaveBeenCalledTimes(1);
    expect(terminal.terminalCounters()).toMatchObject({ instances: 1, attached: 0, webgl: 0, dom: 1, bufferLines: 64, replayBuffers: 0, replayBytes: 0 });

    setRenderer(term as never, "webgl");
    document.body.appendChild(el);
    handlers.get("pty_data")!({ payload: { id: "p1", data: btoa("more") } });
    expect(terminal.terminalCounters()).toMatchObject({ instances: 1, attached: 1, webgl: 1, dom: 0, data: { local: { events: 2, bytes: 9 } } });

    terminal.disposeInstance("p1");
    expect(terminal.terminalCounters()).toMatchObject({ instances: 0, webgl: 0, dom: 0 });
  });
});

describe("terminals that are gone", () => {
  async function loadWithEvents() {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return () => {};
    });
    const terminal = await loadTerminalStore();
    await terminal.subscribeTerminals();
    const output = (id: string, text: string) => handlers.get("pty_data")!({ payload: { id, data: btoa(text) } });
    return { terminal, output };
  }

  it("drops output that arrives after a pane was closed, and keeps it again once the id is reopened", async () => {
    vi.useFakeTimers();
    try {
      const { terminal, output } = await loadWithEvents();
      const pane = await terminal.openTerminal("s1", "/repo", 100, 24, { id: "tab:t1", hidden: true });
      await terminal.closeTerminal(pane.id);
      // The killed process's last bytes: nobody will ever read them.
      output("tab:t1", "bye");
      expect(terminal.terminalCounters()).toMatchObject({ replayBuffers: 0, replayBytes: 0 });

      // The same tab's terminal view is entered again: output before its view mounts is kept.
      await terminal.openTerminal("s1", "/repo", 100, 24, { id: "tab:t1", hidden: true });
      output("tab:t1", "hello");
      expect(terminal.terminalCounters()).toMatchObject({ replayBuffers: 1, replayBytes: 5 });

      // And a pane the backend opens later under a closed id is not ignored for good.
      await terminal.closeTerminal("tab:t1");
      vi.advanceTimersByTime(5_000);
      output("tab:t1", "again");
      expect(terminal.terminalCounters()).toMatchObject({ replayBuffers: 1, replayBytes: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes every terminal of a deleted session, and only those", async () => {
    const { terminal } = await loadWithEvents();
    const shell = await terminal.openTerminal("s1", "/repo");
    await terminal.adoptPane({ id: "tab:agent-1", sessionId: "s1", title: "Agent", hidden: true, owned: true });
    const dispose = vi.fn();
    terminal.getInstance(shell.id, () => ({ el: document.createElement("div"), term: { write: vi.fn(), dispose }, fit: {} }) as never);
    const other = await terminal.openTerminal("s2", "/repo");
    pty.kill.mockClear();

    terminal.dropSessionTerminals(["s1"]);

    const state = terminal.getTerminalState();
    expect(state.panes.map((pane) => pane.id)).toEqual([other.id]);
    expect(Object.keys(state.active)).toEqual(["s2"]);
    expect(Object.keys(state.selected)).toEqual(["s2"]);
    expect(pty.kill.mock.calls.map(([id]) => id).sort()).toEqual([shell.id, "tab:agent-1"].sort());
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(terminal.terminalCounters()).toMatchObject({ instances: 0, panes: 1 });
    // A fresh session reusing nothing: numbering starts over.
    expect((await terminal.openTerminal("s1", "/repo")).title).toBe("Terminal 1");
  });

  it("closes a session's shells and leaves its agent pane when its checkout is removed", async () => {
    const { terminal } = await loadWithEvents();
    await terminal.openTerminal("s1", "/repo");
    await terminal.openTerminal("s1", "/repo");
    await terminal.adoptPane({ id: "tab:agent-1", sessionId: "s1", title: "Agent", hidden: true, owned: true });
    await terminal.closeSessionShells("s1");
    expect(terminal.getTerminalState().panes.map((pane) => pane.id)).toEqual(["tab:agent-1"]);
  });
});
