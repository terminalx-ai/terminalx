import { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import { deferredTerminalFit, fitTerminal } from "./terminalFit";
import { TerminalBufferCleanup } from "./terminalBufferCleanup";
import { acknowledgeTerminalResize, coordinateTerminalResize, followTerminalOutputSize, isOutputResize, reassertTerminalResize, requestTerminalResize, stopTerminalOutput, writeTerminalOutput } from "./terminalOutput";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

// zsh 5.9's output for a long prompt and an unsubmitted command, captured
// from a clean `zsh -f` PTY at 80, 30 and 18 columns.
const prompt = "PROMPTMARK@clean-macos-vm terminalx-project ";
const command = "echo pending";
const initial = `\r\x1b[0m\x1b[27m\x1b[24m\x1b[J${prompt}\x1b[K\x1b[?2004he\becho pending`;
const redraw = `\r\r\x1b[0m\x1b[27m\x1b[24m\x1b[J${prompt}${command}`;
const finalRedraw = `\r\r\x1b[A\x1b[0m\x1b[27m\x1b[24m\x1b[J${prompt}${command}\x1b[K`;
const text = (term: Terminal) => Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true)).join("");

function fixture() {
  const term = new Terminal({ cols: 80, rows: 12, allowProposedApi: true });
  term.loadAddon(new TerminalBufferCleanup());
  // The production fitter measures the renderer's font; jsdom has no font metrics.
  (term as unknown as { _core: { _charSizeService: { width: number; height: number; measure(): void } } })._core._charSizeService = { width: 10, height: 10, measure() {} };
  const box = document.createElement("div");
  box.style.cssText = "width:194px;height:160px"; // 18 columns and 16 rows.
  document.body.appendChild(box);
  return { term, box };
}

it("parses a queued shell redraw before narrowing, without duplicating the prompt or losing input", async () => {
  vi.useFakeTimers();
  // The control demonstrates the regression against the actual xterm parser.
  for (const deferred of [false, true]) {
    const { term, box } = fixture();
    term.write(initial);
    await vi.runAllTimersAsync();
    term.resize(30, 12);
    term.write(redraw); // Received, but not yet parsed when the next size arrives.
    const fit = deferredTerminalFit(() => term, box);
    if (deferred) fit.schedule();
    else fitTerminal(term, box);
    await vi.runAllTimersAsync();
    term.write(finalRedraw);
    await vi.runAllTimersAsync();
    const drawn = text(term);
    const prompts = drawn.match(/PROMPTMARK/g)?.length ?? 0;
    if (deferred) expect(prompts).toBe(1);
    else expect(prompts).toBeGreaterThan(1);
    expect(drawn).toContain(command);
    expect(term.cols).toBe(18);
    fit.cancel();
    term.dispose();
  }
});

it("coalesces a drag into its final size and cancels work for an unmounted or replaced terminal", async () => {
  vi.useFakeTimers();
  const { term, box } = fixture();
  let current: Terminal | undefined = term;
  const resize = vi.fn();
  term.onResize(resize);
  const fit = deferredTerminalFit(() => current, box);
  fit.schedule();
  await vi.advanceTimersByTimeAsync(50);
  box.style.width = "314px";
  fit.schedule();
  await vi.advanceTimersByTimeAsync(99);
  expect(resize).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(resize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cols: 30, rows: 16 }));
  fit.schedule();
  fit.cancel();
  await vi.runAllTimersAsync();
  expect(resize).toHaveBeenCalledTimes(1);
  fit.schedule();
  current = undefined;
  await vi.runAllTimersAsync();
  expect(resize).toHaveBeenCalledTimes(1);
  term.dispose();
});

it.each([false, true])("keeps a redraw arriving after the next resize request on its original grid (fragmented: %s)", async (fragmented) => {
  vi.useFakeTimers();
  const { term, box } = fixture();
  const send = vi.fn(async (_size: { cols: number; rows: number }) => {});
  coordinateTerminalResize(term, send);
  term.onResize((size) => { if (!isOutputResize(term)) requestTerminalResize(term, size); });
  const write = (data: string, cols: number, rows: number) => writeTerminalOutput(term, new TextEncoder().encode(data), { cols, rows });
  write(initial, 80, 12);
  await vi.runAllTimersAsync();
  requestTerminalResize(term, { cols: 30, rows: 12 });
  await vi.runAllTimersAsync();
  const fit = deferredTerminalFit(() => term, box);
  fit.schedule();
  await vi.advanceTimersByTimeAsync(500); // Beyond debounce and RPC completion; no redraw has arrived.
  followTerminalOutputSize(term, { cols: 18, rows: 16 }); // A cloud size notification can also arrive ahead of output.
  expect(send.mock.calls.map(([size]) => size)).toEqual([{ cols: 30, rows: 12 }, { cols: 18, rows: 16 }]);
  expect(term.cols).toBe(80); // Requests cannot move the parser ahead of its stream.
  writeTerminalOutput(term, new Uint8Array(), { cols: 30, rows: 12 });
  if (fragmented) {
    for (const char of redraw) { write(char, 30, 12); await vi.advanceTimersByTimeAsync(150); }
  } else {
    write(redraw, 30, 12);
  }
  writeTerminalOutput(term, new Uint8Array(), { cols: 18, rows: 16 });
  write(finalRedraw, 18, 16); // Both batches may also be queued before either is parsed.
  await vi.runAllTimersAsync();
  expect(text(term).match(/PROMPTMARK/g)).toHaveLength(1);
  expect(text(term)).toContain(command);
  expect(term.cols).toBe(18);
  expect(send).toHaveBeenCalledTimes(2); // Parsing old output never resizes the PTY backwards.
  fit.cancel();
  stopTerminalOutput(term);
  term.dispose();
});

it("serializes resize RPCs, coalesces pending sizes, and drops pending work when disposed", async () => {
  vi.useFakeTimers();
  const { term } = fixture();
  let finish!: () => void;
  const send = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  coordinateTerminalResize(term, send);
  requestTerminalResize(term, { cols: 30, rows: 12 });
  requestTerminalResize(term, { cols: 22, rows: 12 });
  requestTerminalResize(term, { cols: 18, rows: 12 });
  expect(send).toHaveBeenCalledTimes(1);
  finish();
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith({ cols: 18, rows: 12 });
  requestTerminalResize(term, { cols: 40, rows: 12 });
  stopTerminalOutput(term);
  finish();
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(2);
  term.dispose();
});

it("keeps acknowledged sizing for older peers without output metadata", async () => {
  vi.useFakeTimers();
  const { term } = fixture();
  coordinateTerminalResize(term, async (size) => acknowledgeTerminalResize(term, size));
  requestTerminalResize(term, { cols: 30, rows: 12 });
  await vi.runAllTimersAsync();
  expect(term.cols).toBe(30);
  term.dispose();
});

it("adopts a silent terminal's ordered resize completion without any more program bytes", async () => {
  vi.useFakeTimers();
  const { term } = fixture();
  const send = vi.fn(async (size: { cols: number; rows: number }) => acknowledgeTerminalResize(term, size));
  coordinateTerminalResize(term, send);
  term.onResize((size) => { if (!isOutputResize(term)) requestTerminalResize(term, size); });
  writeTerminalOutput(term, new TextEncoder().encode("kept history\r\n"), { cols: 80, rows: 12 });
  await vi.runAllTimersAsync();
  requestTerminalResize(term, { cols: 30, rows: 8 });
  await vi.runAllTimersAsync();
  followTerminalOutputSize(term, { cols: 30, rows: 8 });
  expect({ cols: term.cols, rows: term.rows }).toEqual({ cols: 80, rows: 12 }); // Neither RPC channel may overtake output.
  writeTerminalOutput(term, new Uint8Array(), { cols: 30, rows: 8 });
  await vi.runAllTimersAsync();
  expect({ cols: term.cols, rows: term.rows }).toEqual({ cols: 30, rows: 8 });
  expect(text(term)).toContain("kept history");
  expect(send).toHaveBeenCalledTimes(1);
  term.dispose();
});

it.each([false, true])("retries a failed size request and reasserts after reconnecting (synchronous failure: %s)", async (synchronous) => {
  vi.useFakeTimers();
  const { term } = fixture();
  const send = vi.fn().mockResolvedValue(undefined);
  if (synchronous) send.mockImplementationOnce(() => { throw new Error("not attached"); });
  else send.mockRejectedValueOnce(new Error("disconnected"));
  coordinateTerminalResize(term, send);
  requestTerminalResize(term, { cols: 30, rows: 12 });
  await vi.runAllTimersAsync();
  requestTerminalResize(term, { cols: 30, rows: 12 });
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(2);
  reassertTerminalResize(term);
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(3);
  expect(send).toHaveBeenLastCalledWith({ cols: 30, rows: 12 });
  term.dispose();
});
