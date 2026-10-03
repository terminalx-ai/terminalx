import type { Terminal } from "@xterm/xterm";
import { webglRefused } from "@/lib/terminalCounters";

/**
 * The size a terminal should have in its view's box, the same whichever
 * renderer is drawing it and whether or not it is in the document.
 *
 * xterm's fit addon asks the active renderer for its cell size, and the two
 * renderers disagree: WebGL floors the character width to whole device
 * pixels, the DOM renderer does not. A terminal moves between them (it draws
 * with WebGL while on screen, `terminalWebgl.ts`), and a different cell width
 * can mean a different column count, which resizes the PTY and makes the
 * program redraw. So the cell is computed here, always as WebGL would,
 * from the measured character size. The addon also needs the terminal in the
 * document; this needs only the view's box, so a terminal that is not shown
 * can stay out of the document and still follow its box.
 */
const SCROLL_BAR_WIDTH = 14;
const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;

interface Core {
  _charSizeService?: { width: number; height: number };
  _renderService?: { clear?: () => void };
}

export function terminalSize(term: Terminal, box: HTMLElement): { cols: number; rows: number } | null {
  const size = (term as unknown as { _core?: Core })._core?._charSizeService;
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  const dpr = window.devicePixelRatio || 1;
  const spacing = Math.round(term.options.letterSpacing ?? 0);
  // Only where WebGL cannot be had at all is the DOM renderer's own cell used, so its text is not clipped.
  const charWidth = webglRefused() ? size.width * dpr : Math.floor(size.width * dpr);
  const cellWidth = (charWidth + spacing) / dpr;
  const cellHeight = Math.floor(Math.ceil(size.height * dpr) * (term.options.lineHeight ?? 1)) / dpr;
  const style = getComputedStyle(box);
  const px = (property: string) => parseInt(style.getPropertyValue(property)) || 0;
  const width = px("width") - px("padding-left") - px("padding-right");
  const height = px("height") - px("padding-top") - px("padding-bottom");
  if (!(width > 0) || !(height > 0) || !(cellWidth > 0) || !(cellHeight > 0)) return null;
  const scrollBar = term.options.scrollback === 0 ? 0 : term.options.overviewRuler?.width || SCROLL_BAR_WIDTH;
  return {
    cols: Math.max(MINIMUM_COLS, Math.floor((width - scrollBar) / cellWidth)),
    rows: Math.max(MINIMUM_ROWS, Math.floor(height / cellHeight)),
  };
}

/** Resize the terminal to its view's box, if that changes anything. */
export function fitTerminal(term: Terminal, box: HTMLElement) {
  const size = terminalSize(term, box);
  if (!size || (size.cols === term.cols && size.rows === term.rows)) return;
  // As the fit addon does: what is drawn at the old size must not linger.
  (term as unknown as { _core?: Core })._core?._renderService?.clear?.();
  term.resize(size.cols, size.rows);
}
