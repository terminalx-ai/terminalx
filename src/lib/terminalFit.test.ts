import { afterEach, describe, expect, it, vi } from "vitest";
import { fitTerminal, terminalSize } from "./terminalFit";
import { setWebglRefused } from "./terminalCounters";

/** A terminal whose characters measure `width` by `height` CSS pixels. */
function terminal(width: number, height: number, cols = 80, rows = 24) {
  const clear = vi.fn();
  const term = {
    cols,
    rows,
    options: { letterSpacing: 0, lineHeight: 1.25, scrollback: 10_000 },
    resize: vi.fn(),
    _core: { _charSizeService: { width, height }, _renderService: { clear } },
  };
  return { term: term as never, resize: term.resize, clear };
}

function box(width: number, height: number) {
  const el = document.createElement("div");
  el.style.cssText = `width:${width}px;height:${height}px;padding:4px 8px 0 8px;box-sizing:border-box`;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
  setWebglRefused(false);
  vi.unstubAllGlobals();
});

describe("a terminal's size in its box", () => {
  it("is computed from the character size as WebGL draws it, with no renderer and no document needed", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    // 7.53 px wide: WebGL floors 15.06 device px to 15, so a cell is 7.5 px.
    const { term } = terminal(7.53, 15);
    // (1000 - 16 padding - 14 scroll bar) / 7.5 = 129.3; (504 - 4) / (floor(30 * 1.25) / 2 = 18.5) = 27.02
    expect(terminalSize(term, box(1000, 504))).toEqual({ cols: 129, rows: 27 });
  });

  it("uses the DOM renderer's wider cell only where there is no WebGL at all", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { term } = terminal(7.53, 15);
    setWebglRefused(true);
    // 970 / 7.53 = 128.8
    expect(terminalSize(term, box(1000, 504))?.cols).toBe(128);
  });

  it("resizes only when the size changes", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { term, resize, clear } = terminal(7.5, 15, 129, 27);
    fitTerminal(term, box(1000, 504));
    expect(resize).not.toHaveBeenCalled();
    fitTerminal(term, box(800, 504));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(102, 27);
  });

  it("says nothing before the font is measured or the box is laid out", () => {
    expect(terminalSize(terminal(0, 0).term, box(1000, 500))).toBeNull();
    expect(terminalSize(terminal(7.5, 15).term, box(0, 0))).toBeNull();
  });
});
