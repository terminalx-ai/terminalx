import { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import { deferredTerminalFit, fitTerminal } from "./terminalFit";
import { TerminalBufferCleanup } from "./terminalBufferCleanup";

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
