import { beforeEach, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("@/lib/api", () => ({ pty }));
import { terminalInput } from "./terminalInput";

beforeEach(() => pty.write.mockReset());

function pendingWrite() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it("sends the first key immediately and preserves input order across asynchronous writes", async () => {
  const first = pendingWrite();
  const second = pendingWrite();
  pty.write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(undefined);
  const input = terminalInput("pane");
  input.write("a");
  expect(pty.write.mock.calls).toEqual([["pane", "a"]]);
  input.write("b");
  input.write("\u001b[A");
  expect(pty.write).toHaveBeenCalledTimes(1);
  first.resolve();
  await first.promise;
  expect(pty.write.mock.calls).toEqual([["pane", "a"], ["pane", "b\u001b[A"]]);
  input.write("c");
  second.resolve();
  await second.promise;
  expect(pty.write).toHaveBeenLastCalledWith("pane", "c");
});

it("does not make another pane wait for a blocked paste", async () => {
  const blocked = pendingWrite();
  pty.write.mockReturnValueOnce(blocked.promise).mockResolvedValue(undefined);
  terminalInput("busy").write("paste");
  terminalInput("other").write("x");
  expect(pty.write.mock.calls).toEqual([["busy", "paste"], ["other", "x"]]);
  blocked.resolve();
  await blocked.promise;
});

it("discards queued input on disposal, even if an old write completes after a replacement is created", async () => {
  const first = pendingWrite();
  pty.write.mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const old = terminalInput("pane");
  old.write("a");
  old.write("stale");
  old.stop();
  old.write("also stale");
  terminalInput("pane").write("new");
  first.resolve();
  await first.promise;
  expect(pty.write.mock.calls).toEqual([["pane", "a"], ["pane", "new"]]);
});

it("recovers after a write fails and ignores empty input", async () => {
  const first = pendingWrite();
  pty.write.mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const input = terminalInput("pane");
  input.write("");
  input.write("a");
  input.write("b");
  first.reject(new Error("process exited"));
  await first.promise.catch(() => {});
  expect(pty.write.mock.calls).toEqual([["pane", "a"], ["pane", "b"]]);
});
