import { Terminal, type IBufferCell } from "@xterm/headless";

/**
 * The phone's copy of a tab's terminal. The Mac sends the pane's raw output,
 * escape sequences and all; this is the same xterm.js emulator the desktop
 * terminal runs, without a DOM, so a full-screen agent CLI draws here as it
 * does there. The Mac decides the size: the phone follows it, never resizes
 * the pane (the desktop window is what the agent is drawn for).
 */

/** A run of cells that look the same. */
export interface Span { text: string; fg?: string; bg?: string; bold?: boolean; italic?: boolean; underline?: boolean; dim?: boolean }
export interface Row { key: string; spans: Span[] }
/** What the program running in the terminal asked for, which shapes what a key or a paste sends. */
export interface ScreenModes { bracketedPaste: boolean; applicationCursorKeys: boolean }

export const FOREGROUND = "#e6e6e6";
export const BACKGROUND = "#171719";
/** The desktop terminal's dark ANSI colours (TerminalView `themeFor("dark")`). */
const ANSI = [
  "#2b2d35", "#f07178", "#8fd694", "#f0c674", "#82aaff", "#c792ea", "#89ddff", "#d6d6d6",
  "#6b6f7b", "#ff8b92", "#a6e3a1", "#f9e2af", "#9dc4ff", "#d8b4fe", "#a5f3fc", "#ffffff",
];
/** Lines of history kept above a normal screen: enough to scroll back through a reply. */
export const SCROLLBACK = 1000;

const hex = (value: number) => `#${value.toString(16).padStart(6, "0")}`;

/** xterm's 256-colour table past the 16 ANSI colours: a 6×6×6 cube, then 24 greys. */
export function paletteColor(index: number): string {
  if (index < 16) return ANSI[index];
  if (index < 232) {
    const cube = index - 16;
    const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    const [r, g, b] = [Math.floor(cube / 36), Math.floor(cube / 6) % 6, cube % 6].map(level);
    return hex((r << 16) | (g << 8) | b);
  }
  const grey = 8 + (index - 232) * 10;
  return hex((grey << 16) | (grey << 8) | grey);
}

/** How a cell looks, naming only what differs from the terminal's defaults. */
function look(cell: IBufferCell): Omit<Span, "text"> {
  let fg = cell.isFgPalette() ? paletteColor(cell.getFgColor()) : cell.isFgRGB() ? hex(cell.getFgColor()) : undefined;
  let bg = cell.isBgPalette() ? paletteColor(cell.getBgColor()) : cell.isBgRGB() ? hex(cell.getBgColor()) : undefined;
  // Inverse swaps them, with the defaults standing in for an unset side.
  if (cell.isInverse()) [fg, bg] = [bg ?? BACKGROUND, fg ?? FOREGROUND];
  const out: Omit<Span, "text"> = {};
  if (fg) out.fg = fg;
  if (bg) out.bg = bg;
  if (cell.isBold()) out.bold = true;
  if (cell.isItalic()) out.italic = true;
  if (cell.isUnderline()) out.underline = true;
  if (cell.isDim()) out.dim = true;
  return out;
}

const same = (a: Span, b: Omit<Span, "text">) =>
  a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.dim === b.dim;

export class TerminalScreen {
  private readonly term: Terminal;
  private disposed = false;

  constructor(cols: number, rows: number, scrollback = SCROLLBACK) {
    this.term = new Terminal({ cols: Math.max(1, cols), rows: Math.max(1, rows), scrollback, allowProposedApi: true });
  }

  get cols() { return this.term.cols; }
  get rows() { return this.term.rows; }

  /** Parse output; resolves once it is on the screen. */
  write(data: string): Promise<void> {
    if (this.disposed || !data) return Promise.resolve();
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number) {
    if (this.disposed || (cols === this.term.cols && rows === this.term.rows) || cols < 1 || rows < 1) return;
    this.term.resize(cols, rows);
  }

  modes(): ScreenModes {
    const modes = this.term.modes;
    return { bracketedPaste: modes.bracketedPasteMode, applicationCursorKeys: modes.applicationCursorKeysMode };
  }

  /**
   * What to draw, oldest first. A normal screen is its history and then its
   * visible rows; a full-screen program's alternate screen is only what it
   * shows. Trailing blank cells are dropped; each row keeps at least a space.
   */
  lines(): Row[] {
    const buffer = this.term.buffer.active;
    const first = buffer.type === "alternate" ? buffer.baseY : 0;
    const out: Row[] = [];
    const cell = buffer.getNullCell();
    for (let y = first; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const spans: Span[] = [];
      for (let x = 0; x < this.term.cols; x++) {
        line.getCell(x, cell);
        if (cell.getWidth() === 0) continue; // the second half of a wide character
        const chars = cell.getChars() || " ";
        const style = look(cell);
        const last = spans[spans.length - 1];
        if (last && same(last, style)) last.text += chars;
        else spans.push({ text: chars, ...style });
      }
      // Blank cells at the end go, unless something painted them.
      while (spans.length && !spans[spans.length - 1].bg) {
        const last = spans[spans.length - 1];
        last.text = last.text.trimEnd();
        if (last.text) break;
        spans.pop();
      }
      out.push({ key: `${buffer.type}:${y}`, spans: spans.length ? spans : [{ text: " " }] });
    }
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.term.dispose();
  }
}
