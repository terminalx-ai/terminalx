import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalInstance } from "./terminal";

const pty = vi.hoisted(() => ({
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
  resize: vi.fn().mockResolvedValue(undefined),
  detachAll: vi.fn().mockResolvedValue(undefined),
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
  it("mounts a visible terminal before applying the idle budget", async () => {
    const terminal = await loadTerminalStore();
    const make = () => ({ el: document.createElement("div"), term: { dispose: vi.fn() }, fit: {}, restorable: true }) as unknown as TerminalInstance;
    const idle = Array.from({ length: terminal.IDLE_TERMINAL_LIMIT }, (_, i) => terminal.getInstance(`idle-${i}`, make));
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const shown = terminal.getInstance("shown", make, host);
      expect(shown.el.parentElement).toBe(host);
      expect(idle.every((inst, i) => terminal.peekInstance(`idle-${i}`) === inst)).toBe(true);
      expect(idle.every((inst) => vi.mocked(inst.term.dispose).mock.calls.length === 0)).toBe(true);
      // Once it really leaves the document, the regular idle limit applies.
      shown.el.remove();
      terminal.trimTerminalInstances();
      expect(idle[0].term.dispose).toHaveBeenCalledOnce();
      expect(terminal.peekInstance("shown")).toBe(shown);
    } finally {
      host.remove();
    }
  });

  it("restores the pane's grid before its output replay, and forgets it when the pane closes", async () => {
    const terminal = await loadTerminalStore();
    const pane = await terminal.openTerminal("s1", "/repo");
    const resize = vi.fn();
    const make = () => ({ el: document.createElement("div"), term: { dispose: vi.fn(), resize, cols: 140, rows: 37 }, fit: {}, restorable: true }) as unknown as TerminalInstance;
    terminal.getInstance(pane.id, make);
    terminal.disposeInstance(pane.id);
    terminal.getInstance(pane.id, make);
    expect(resize).toHaveBeenLastCalledWith(140, 37);
    await terminal.closeTerminal(pane.id);
    resize.mockClear();
    terminal.getInstance(pane.id, make);
    expect(resize).not.toHaveBeenCalled();
  });

  it("bounds the idle cache, keeps recently used and visible instances, and recreates evicted views without killing a process", async () => {
    const terminal = await loadTerminalStore();
    const { setOnScreen } = await import("./terminalCounters");
    const make = () => ({ el: document.createElement("div"), term: { dispose: vi.fn() }, fit: {}, restorable: true }) as unknown as TerminalInstance;
    const visible = terminal.getInstance("visible", make);
    setOnScreen(visible.term, true);
    const first = terminal.getInstance("idle-0", make);
    for (let i = 1; i < terminal.IDLE_TERMINAL_LIMIT; i++) terminal.getInstance(`idle-${i}`, make);
    terminal.getInstance("idle-0", make); // Touch the oldest; idle-1 is next out.
    const evicted = terminal.peekInstance("idle-1")!;
    terminal.getInstance("new", make);
    expect(terminal.peekInstance("idle-1")).toBeUndefined();
    expect(evicted.term.dispose).toHaveBeenCalledOnce();
    expect(terminal.peekInstance("idle-0")).toBe(first);
    expect(terminal.peekInstance("visible")).toBe(visible);
    expect(terminal.getInstance("idle-1", make)).not.toBe(evicted);
    expect(pty.kill).not.toHaveBeenCalled();
    setOnScreen(visible.term, false);
    terminal.trimTerminalInstances();
    expect(visible.term.dispose).toHaveBeenCalledOnce();
  });

  it("releases archived hidden views but keeps their panes, cloud instances, and a view still on screen", async () => {
    const terminal = await loadTerminalStore();
    const { setOnScreen } = await import("./terminalCounters");
    const pane = await terminal.openTerminal("archived", "/repo");
    const make = () => ({ el: document.createElement("div"), term: { dispose: vi.fn() }, fit: {}, restorable: true }) as unknown as TerminalInstance;
    const inst = terminal.getInstance(pane.id, make);
    const cloud = terminal.getInstance("cloud", () => ({ ...make(), restorable: false }));
    setOnScreen(inst.term, true);
    terminal.setArchivedTerminalSessions(["archived"]);
    expect(inst.term.dispose).not.toHaveBeenCalled();
    setOnScreen(inst.term, false);
    terminal.trimTerminalInstances();
    expect(terminal.peekInstance(pane.id)).toBeUndefined();
    expect(terminal.peekInstance("cloud")).toBe(cloud);
    expect(terminal.getTerminalState().panes).toContain(pane);
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("counts live instances by renderer and where they are, and stops an instance's output when it is disposed", async () => {
    const terminal = await loadTerminalStore();
    const { setRenderer } = await import("./terminalCounters");
    expect(terminal.terminalCounters()).toMatchObject({ instances: 0, panes: 0 });

    const term = { write: vi.fn(), dispose: vi.fn(), buffer: { normal: { length: 40 }, alternate: { length: 24 } } };
    const el = document.createElement("div");
    const release = vi.fn();
    terminal.getInstance("p1", () => ({ el, term, fit: {}, release }) as never);
    expect(terminal.terminalCounters()).toMatchObject({ instances: 1, attached: 0, webgl: 0, dom: 1, bufferLines: 64 });

    setRenderer(term as never, "webgl");
    document.body.appendChild(el);
    expect(terminal.terminalCounters()).toMatchObject({ instances: 1, attached: 1, webgl: 1, dom: 0 });

    terminal.disposeInstance("p1");
    expect(release).toHaveBeenCalledTimes(1);
    expect(term.dispose).toHaveBeenCalledTimes(1);
    expect(terminal.terminalCounters()).toMatchObject({ instances: 0, webgl: 0, dom: 0 });
  });
});

describe("terminals that are gone", () => {
  it("closes every terminal of a deleted session, and only those", async () => {
    const terminal = await loadTerminalStore();
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
    const terminal = await loadTerminalStore();
    await terminal.openTerminal("s1", "/repo");
    await terminal.openTerminal("s1", "/repo");
    await terminal.adoptPane({ id: "tab:agent-1", sessionId: "s1", title: "Agent", hidden: true, owned: true });
    await terminal.closeSessionShells("s1");
    expect(terminal.getTerminalState().panes.map((pane) => pane.id)).toEqual(["tab:agent-1"]);
  });
});

describe("an agent tab that was closed", () => {
  it("lets go of its pane and its xterm, and of nothing else", async () => {
    const terminal = await loadTerminalStore();
    const shell = await terminal.openTerminal("s1", "/repo");
    await terminal.adoptPane({ id: terminal.agentPaneId("t1"), sessionId: "s1", title: "Agent", hidden: true, owned: true });
    await terminal.adoptPane({ id: terminal.agentPaneId("t2"), sessionId: "s1", title: "Agent", hidden: true, owned: true });
    const dispose = vi.fn();
    terminal.getInstance("tab:t1", () => ({ el: document.createElement("div"), term: { write: vi.fn(), dispose }, fit: {} }) as never);
    pty.kill.mockClear();

    terminal.dropTabTerminals(["t1"]);

    expect(terminal.getTerminalState().panes.map((pane) => pane.id)).toEqual([shell.id, "tab:t2"]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(terminal.peekInstance("tab:t1")).toBeUndefined();
    // The backend stopped the CLI when it removed the tab: nothing to kill from here.
    expect(pty.kill).not.toHaveBeenCalled();
    expect(terminal.getTerminalState().selected.s1).toEqual({ kind: "terminal", id: shell.id });
  });

  it("is fine for a tab whose pane this window never took over", async () => {
    const terminal = await loadTerminalStore();
    terminal.dropTabTerminals(["never-shown"]);
    expect(terminal.terminalCounters()).toMatchObject({ instances: 0, panes: 0 });
  });
});
