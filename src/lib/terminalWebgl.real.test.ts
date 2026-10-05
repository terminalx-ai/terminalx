import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

/**
 * The real xterm and the real WebGL addon, with only the canvas contexts
 * stubbed (jsdom has none). What matters here is which canvas the addon
 * creates and in what order, and which timers it leaves behind: a mock of the
 * addon cannot get either wrong.
 */
vi.mock("@/lib/api", () => ({ pty: {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const loseContext = vi.fn();

/** A context that accepts every call: enough for the addon to set itself up. */
function context(canvas: HTMLCanvasElement, overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get(target, key) {
      if (key in target) return target[key as string];
      if (key === "canvas") return canvas;
      return () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2, data: new Uint8ClampedArray(4) });
    },
    set: () => true,
  });
}

const contexts = new WeakMap<HTMLCanvasElement, Map<string, unknown>>();
let webgl2 = true;

beforeEach(() => {
  vi.resetModules();
  loseContext.mockClear();
  webgl2 = true;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind === "webgl2" && !webgl2) return null;
    const mine = contexts.get(this) ?? new Map<string, unknown>();
    contexts.set(this, mine);
    // As in a browser: a canvas has one kind of context, and asking for another gives none.
    if (mine.size && !mine.has(kind)) return null;
    if (!mine.has(kind)) {
      mine.set(
        kind,
        kind === "webgl2"
          ? context(this, {
              getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext } : {}),
              getParameter: () => 4096,
              getShaderParameter: () => true,
              getProgramParameter: () => true,
            })
          : context(this, {}),
      );
    }
    return mine.get(kind) as never;
  } as never);
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function shown() {
  const webgl = await import("./terminalWebgl");
  const counters = await import("./terminalCounters");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new Terminal({ allowProposedApi: true, cursorBlink: true });
  term.open(host);
  webgl.showWebgl(term);
  return { webgl, counters, term };
}

describe("WebGL contexts, with the real addon", () => {
  it("finds the addon's WebGL canvas, which is not the first one it adds", async () => {
    const { counters, term } = await shown();
    expect(counters.rendererOf(term)).toBe("webgl");
    const canvases = [...term.element!.querySelectorAll("canvas")];
    // The 2D link layer comes first; the WebGL canvas after it.
    expect(canvases.map((canvas) => canvas.classList.contains("xterm-link-layer"))).toEqual([true, false]);
  });

  it("releases the context when the terminal goes", async () => {
    const { webgl, term } = await shown();
    webgl.dropWebgl(term);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("replaces a context the moment the browser takes it", async () => {
    vi.useFakeTimers();
    const { counters, term } = await shown();
    const gl = [...term.element!.querySelectorAll("canvas")].find((canvas) => !canvas.classList.contains("xterm-link-layer"))!;
    gl.dispatchEvent(new Event("webglcontextlost"));
    expect(counters.webglContexts.lost).toBe(1);
    expect(counters.rendererOf(term)).toBe("dom");
    vi.advanceTimersByTime(1);
    expect(counters.rendererOf(term)).toBe("webgl");
    expect(counters.webglContexts.created).toBe(2);
  });

  it("leaves no timer running after a focused, blinking terminal is closed", async () => {
    vi.useFakeTimers();
    const { webgl, term } = await shown();
    // What focus does to the renderer: the cursor starts to blink on an interval.
    (term as unknown as { _core: { _renderService: { handleFocus(): void } } })._core._renderService.handleFocus();
    vi.advanceTimersByTime(2000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    term.dispose();
    webgl.dropWebgl(term);
    // Without stopping the addon's blink timer one interval stays, and with it the whole terminal.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks once, not on every show, where there is no WebGL2", async () => {
    webgl2 = false;
    const { webgl, counters, term } = await shown();
    expect(counters.rendererOf(term)).toBe("dom");
    expect(counters.webglRefused()).toBe(true);
    for (let round = 0; round < 5; round++) {
      webgl.hideWebgl(term);
      webgl.showWebgl(term);
    }
    expect(counters.webglContexts).toEqual({ created: 0, lost: 0, failed: 1 });
  });
});

it("preserves scrollback, alternate-screen content and pending terminal input across recovery", async () => {
  const { webgl, term } = await shown();
  const write = (text: string) => new Promise<void>((resolve) => term.write(text, resolve));
  await write("synthetic history\r\nsynthetic draft");
  const normal = term.buffer.normal.getLine(0)!.translateToString(true);
  await write("\x1b[?1049hsynthetic full-screen view");
  const alternate = term.buffer.active.getLine(0)!.translateToString(true);
  const input = vi.fn();
  const listener = term.onData(input);
  webgl.recoverWebgl(term);
  expect(term.buffer.normal.getLine(0)!.translateToString(true)).toBe(normal);
  expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe(alternate);
  expect(input).not.toHaveBeenCalled();
  await write("\x1b[?1049l");
  expect(term.buffer.active.getLine(1)!.translateToString(true)).toContain("synthetic draft");
  listener.dispose();
  webgl.dropWebgl(term);
  term.dispose();
});
