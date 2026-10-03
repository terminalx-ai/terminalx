import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let openMicrophone: () => void = () => {};
const handlers: ((e: { payload: { kind: string } }) => void)[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    calls.push(command);
    if (command === "dictation_start") return new Promise<void>((resolve) => (openMicrophone = resolve));
    return Promise.resolve();
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (e: { payload: { kind: string } }) => void) => {
    handlers.push(handler);
    return () => {};
  }),
}));
vi.mock("./transcriptionInput", () => ({ isTranscriptionInputSaving: () => false }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const commands = () => calls.filter((command) => command.startsWith("dictation_"));

describe("stopping a dictation that is still starting (a key held to talk, released early)", () => {
  beforeEach(() => {
    vi.resetModules();
    calls.length = 0;
    handlers.length = 0;
  });

  it("sends the stop only after the microphone is open, so it is never left on", async () => {
    const { startDictation, stopDictation } = await import("./dictation");
    expect(startDictation("tab-1")).toBe(1);
    await flush();
    expect(commands()).toEqual(["dictation_start"]);

    const stopped = stopDictation();
    await flush();
    // The start has not come back: a stop now would find nothing to stop.
    expect(commands()).toEqual(["dictation_start"]);

    openMicrophone();
    await stopped;
    expect(commands()).toEqual(["dictation_start", "dictation_stop"]);
  });

  it("does not show Listening again when the microphone opens after the release", async () => {
    const { startDictation, stopDictation, useDictation } = await import("./dictation");
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => useDictation());
    await act(async () => {
      startDictation("tab-1");
      await flush();
    });
    let stopped!: Promise<void>;
    act(() => {
      stopped = stopDictation();
    });
    expect(result.current.phase).toBe("finishing");
    act(() => handlers[0]({ payload: { kind: "listening" } }));
    expect(result.current.phase).toBe("finishing");
    await act(async () => {
      openMicrophone();
      await stopped;
      handlers[0]({ payload: { kind: "stopped" } });
    });
    expect(result.current.phase).toBe("idle");
    // The next dictation listens as usual.
    await act(async () => {
      startDictation("tab-1");
      await flush();
      handlers[0]({ payload: { kind: "listening" } });
    });
    expect(result.current.phase).toBe("listening");
  });
});
