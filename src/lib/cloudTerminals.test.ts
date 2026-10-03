// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyInfo, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { TerminalInstance } from "@/lib/terminal";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const { TERMINAL_POLL_MS, cloudTerminalsOf, createCloudTerminal, followCloudTerminals, resetCloudTerminals, sessionTerminals, syncCloudTerminals, workspaceTerminals } = await import("./cloudTerminals");

const WS = "cloud:org-a:w1";

const pty = (ptyId: string, number: number, sessionId?: string): PtyInfo => ({
  ptyId,
  number,
  epoch: "e1",
  pid: number,
  cwd: "/w",
  cols: 80,
  rows: 24,
  createdAt: 1,
  offset: 0,
  exited: false,
  exitCode: null,
  control: "other",
  controllerId: "u-other",
  ...(sessionId ? { sessionId } : {}),
});

/** A runtime's terminal list behind just the calls the store makes. */
function runtime(listed: PtyInfo[]) {
  const state = { listed, lists: 0, attached: [] as string[], connected: true };
  const client = {
    get connection() {
      return state.connected ? { state: "connected" } : { state: "reconnecting" };
    },
    listPtys: vi.fn(async () => {
      state.lists++;
      return { epoch: "e1", terminals: state.listed };
    }),
    attachPty: vi.fn(async (ptyId: string) => {
      state.attached.push(ptyId);
      return { cursor: () => undefined, detach: () => undefined };
    }),
  } as unknown as WorkspaceRpcClient;
  return { state, client };
}

const xterm = (): TerminalInstance =>
  ({ el: document.createElement("div"), term: { write: vi.fn(), onData: vi.fn(), onBinary: vi.fn(), onResize: vi.fn(), dispose: vi.fn(), cols: 80, rows: 24, resize: vi.fn() }, fit: {} }) as unknown as TerminalInstance;

beforeEach(() => {
  vi.useFakeTimers();
  resetCloudTerminals();
});

afterEach(() => {
  vi.useRealTimers();
});

// PRO-84: after a resume the strip showed "Terminal 1 (ended)" next to "Terminal 1".
describe("terminals of a runtime that restarted", () => {
  it("names the new runtime's terminals apart from the ended ones still shown", async () => {
    const { state, client } = runtime([pty("p1", 1), pty("p2", 2)]);
    await syncCloudTerminals(WS, client, xterm);
    // The runtime restarted: a new process, numbering from 1 again.
    state.listed = [{ ...pty("q1", 1), epoch: "e2" }];
    (client.listPtys as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ epoch: "e2", terminals: state.listed }));
    await syncCloudTerminals(WS, client, xterm);
    const shown = cloudTerminalsOf(WS).terminals.map((terminal) => [terminal.title, terminal.gone]);
    expect(shown).toEqual([
      ["Terminal 1", "runtime-restarted"],
      ["Terminal 2", "runtime-restarted"],
      ["Terminal 3", null],
    ]);
    // The name holds through later reads of the list.
    await syncCloudTerminals(WS, client, xterm);
    expect(cloudTerminalsOf(WS).terminals.map((terminal) => terminal.title)).toEqual(["Terminal 1", "Terminal 2", "Terminal 3"]);
  });

  it("carries whether the controlling device is still attached, when the runtime says", async () => {
    const { state, client } = runtime([{ ...pty("p1", 1), controllerPresent: false }, pty("p2", 2)]);
    await syncCloudTerminals(WS, client, xterm);
    expect(cloudTerminalsOf(WS).terminals.map((terminal) => terminal.controllerPresent)).toEqual([false, null]);
    state.listed = [{ ...pty("p1", 1), controllerPresent: true }, pty("p2", 2)];
    await syncCloudTerminals(WS, client, xterm);
    expect(cloudTerminalsOf(WS).terminals[0]!.controllerPresent).toBe(true);
  });
});

describe("a connected workspace's terminals", () => {
  it("shows a terminal someone else opens without reopening anything, and attaches it once", async () => {
    const { state, client } = runtime([pty("p1", 1, "s1")]);
    await syncCloudTerminals(WS, client, xterm);
    expect(cloudTerminalsOf(WS).terminals.map((terminal) => terminal.ptyId)).toEqual(["p1"]);

    const stop = followCloudTerminals(WS, client, xterm);
    // Another person opens a terminal in the same session.
    state.listed = [...state.listed, pty("p2", 2, "s1")];
    await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS);
    expect(cloudTerminalsOf(WS).terminals.map((terminal) => terminal.title)).toEqual(["Terminal 1", "Terminal 2"]);

    // Later reads attach nothing twice: output is never printed double.
    await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS * 3);
    expect(state.attached).toEqual(["p1", "p2"]);
    stop();
  });

  it("tells nobody when a read finds nothing new", async () => {
    const { client } = runtime([pty("p1", 1, "s1")]);
    await syncCloudTerminals(WS, client, xterm);
    const before = cloudTerminalsOf(WS);
    const stop = followCloudTerminals(WS, client, xterm);
    await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS * 2);
    // The same object: no subscriber re-renders every few seconds.
    expect(cloudTerminalsOf(WS)).toBe(before);
    stop();
  });

  it("marks a terminal closed elsewhere, and stops reading once stopped or disconnected", async () => {
    const { state, client } = runtime([pty("p1", 1, "s1"), pty("p2", 2, "s1")]);
    await syncCloudTerminals(WS, client, xterm);
    const stop = followCloudTerminals(WS, client, xterm);
    state.listed = [pty("p1", 1, "s1")];
    await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS);
    expect(cloudTerminalsOf(WS).terminals.map((terminal) => terminal.gone)).toEqual([null, "closed"]);

    // A dropped connection is never read from; reading resumes when it is back.
    const lists = state.lists;
    state.connected = false;
    await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS * 2);
    expect(state.lists).toBe(lists);
    state.connected = true;
    await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS);
    expect(state.lists).toBe(lists + 1);

    stop();
    await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS * 2);
    expect(state.lists).toBe(lists + 1);
  });

  it("never calls a terminal closed on the word of a list asked for before it was opened", async () => {
    const { state, client } = runtime([pty("p1", 1, "s1")]);
    await syncCloudTerminals(WS, client, xterm);
    // A read is on its way when this window opens a terminal; its (older) answer lands afterwards.
    let answer: (value: { epoch: string; terminals: PtyInfo[] }) => void = () => undefined;
    (client.listPtys as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const reading = syncCloudTerminals(WS, client, xterm);
    (client as unknown as { createPty: unknown }).createPty = vi.fn(async () => pty("p2", 2, "s1"));
    await createCloudTerminal(WS, client, { cols: 80, rows: 24 }, xterm, { sessionId: "s1" });
    answer({ epoch: "e1", terminals: [pty("p1", 1, "s1")] });
    await reading;
    expect(cloudTerminalsOf(WS).terminals.map((terminal) => [terminal.ptyId, terminal.gone])).toEqual([["p1", null], ["p2", null]]);
    // A later list that still lacks it does mean it was closed.
    state.listed = [pty("p1", 1, "s1")];
    await syncCloudTerminals(WS, client, xterm);
    expect(cloudTerminalsOf(WS).terminals.map((terminal) => [terminal.ptyId, terminal.gone])).toEqual([["p1", null], ["p2", "closed"]]);
  });

  it("does not read while the window is hidden", async () => {
    const { state, client } = runtime([pty("p1", 1)]);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const stop = followCloudTerminals(WS, client, xterm);
    await vi.advanceTimersByTimeAsync(TERMINAL_POLL_MS * 2);
    expect(state.lists).toBe(0);
    // Back in view: read at once, not at the next interval.
    hidden.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.lists).toBe(1);
    stop();
    hidden.mockRestore();
  });
});

describe("where a terminal is listed", () => {
  it("is under its session when the runtime names one (pty/2), else with the workspace's own", async () => {
    const { client } = runtime([pty("p1", 1, "s1"), pty("p2", 2), pty("p3", 3, "s2"), pty("p4", 4, "deleted-session")]);
    await syncCloudTerminals(WS, client, xterm);
    const all = cloudTerminalsOf(WS).terminals;
    expect(sessionTerminals(all, "s1").map((terminal) => terminal.ptyId)).toEqual(["p1"]);
    expect(sessionTerminals(all, "s2").map((terminal) => terminal.ptyId)).toEqual(["p3"]);
    // No session, or one the workspace no longer lists.
    expect(workspaceTerminals(all, ["s1", "s2"]).map((terminal) => terminal.ptyId)).toEqual(["p2", "p4"]);
  });

  it("is all with the workspace on a runtime older than pty/2", async () => {
    const { client } = runtime([pty("p1", 1), pty("p2", 2)]);
    await syncCloudTerminals(WS, client, xterm);
    const all = cloudTerminalsOf(WS).terminals;
    expect(sessionTerminals(all, "s1")).toEqual([]);
    expect(workspaceTerminals(all, ["s1"]).map((terminal) => terminal.title)).toEqual(["Terminal 1", "Terminal 2"]);
  });
});
