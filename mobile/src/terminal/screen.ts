// First: xterm reads `navigator` as soon as it loads, and React Native's has none of what it reads.
import "./xterm-platform";
import { Terminal, type IBuffer, type IBufferCell, type IDisposable } from "@xterm/headless";

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
/**
 * `mouse`: the program asked for mouse reports (a wheel is told to it, not scrolled here).
 * `alternate`: a full-screen program's own screen, which keeps no history of its own to scroll.
 */
export interface ScreenModes { bracketedPaste: boolean; applicationCursorKeys: boolean; mouse: boolean; alternate: boolean }

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

const DEFAULT_LOOK: Omit<Span, "text"> = {};

/** How a cell looks, naming only what differs from the terminal's defaults. */
function look(cell: IBufferCell): Omit<Span, "text"> {
  if (cell.isAttributeDefault()) return DEFAULT_LOOK;
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

const rowPlainText = (row: Row): string => row.spans.map((span) => span.text).join("").trimEnd();

interface CachedScrollbackRow {
  row: Row;
  text: string;
}

export class TerminalScreen {
  private readonly term: Terminal;
  private readonly scrollbackLimit: number;
  private readonly disposables: IDisposable[] = [];
  private disposed = false;
  private dirty = true;
  private scrollEvents = 0;
  private lastScrollEvents = 0;
  private lastBaseY = 0;
  private cachedScrollback: CachedScrollbackRow[] = [];
  private cachedLines: Row[] | null = null;
  private cachedViewport: Row[] | null = null;
  private cachedBufferType: "normal" | "alternate" | null = null;
  private _extractedRows = 0;

  constructor(cols: number, rows: number, scrollback = SCROLLBACK) {
    this.scrollbackLimit = Math.max(0, scrollback);
    this.term = new Terminal({ cols: Math.max(1, cols), rows: Math.max(1, rows), scrollback: this.scrollbackLimit, allowProposedApi: true });
    this.disposables.push(
      this.term.onScroll(() => {
        if (this.term.buffer.active.type === "normal") this.scrollEvents++;
      }),
      this.term.buffer.onBufferChange(() => {
        this.dirty = true;
      }),
    );
  }

  get cols() { return this.term.cols; }
  get rows() { return this.term.rows; }
  /** Total buffer rows extracted across calls; useful for verifying incremental scrollback reuse. */
  get extractedRowsCount() { return this._extractedRows; }

  /** Parse output; resolves once it is on the screen. */
  write(data: string): Promise<void> {
    if (this.disposed || !data) return Promise.resolve();
    return new Promise((resolve) => this.term.write(data, () => {
      this.dirty = true;
      resolve();
    }));
  }

  resize(cols: number, rows: number) {
    if (this.disposed || (cols === this.term.cols && rows === this.term.rows) || cols < 1 || rows < 1) return;
    this.term.resize(cols, rows);
    this.invalidateScrollback();
  }

  modes(): ScreenModes {
    const modes = this.term.modes;
    return {
      bracketedPaste: modes.bracketedPasteMode, applicationCursorKeys: modes.applicationCursorKeysMode,
      mouse: modes.mouseTrackingMode !== "none", alternate: this.term.buffer.active.type === "alternate",
    };
  }

  /**
   * What to draw, oldest first. A normal screen is its history and then its
   * visible rows; a full-screen program's alternate screen is only what it
   * shows. Trailing blank cells are dropped; each row keeps at least a space.
   *
   * Scrollback rows (`0 .. baseY - 1`) are cached incrementally so active
   * output only extracts newly-scrolled lines and the visible viewport.
   */
  lines(): Row[] {
    const buffer = this.term.buffer.active;
    if (!this.dirty && this.cachedLines && this.cachedBufferType === buffer.type) {
      return this.cachedLines;
    }
    const cell = buffer.getNullCell();
    if (buffer.type === "alternate") {
      const viewport = this.extractRange(buffer, buffer.baseY, buffer.length, cell);
      this.cachedBufferType = "alternate";
      this.cachedViewport = viewport;
      this.cachedLines = viewport;
      this.dirty = false;
      return viewport;
    }

    const baseY = buffer.baseY;
    const scrollDelta = this.scrollEvents - this.lastScrollEvents;
    if (baseY === 0) {
      this.cachedScrollback = [];
    } else if (baseY < this.lastBaseY || this.cachedScrollback.length === 0) {
      this.cachedScrollback = this.extractScrollbackRange(buffer, 0, baseY, cell);
    } else if (baseY < this.scrollbackLimit) {
      // Buffer is not full: scrollback never evicts lines (DECSTBM scroll-region
      // events may increment `scrollEvents`, so ignore `scrollDelta` here).
      if (baseY > this.cachedScrollback.length) {
        const newlyScrolled = this.extractScrollbackRange(buffer, this.cachedScrollback.length, baseY, cell);
        this.cachedScrollback = this.cachedScrollback.concat(newlyScrolled);
      }
    } else if (scrollDelta > 0 || baseY > this.cachedScrollback.length) {
      // Buffer is at the scrollback cap: grow if needed, or determine the exact
      // eviction shift (guarding against DECSTBM false positives where `onScroll`
      // fires without evicting scrollback lines).
      const shift = this.resolveScrollbackShift(buffer, baseY, scrollDelta);
      if (shift === null) {
        this.cachedScrollback = this.extractScrollbackRange(buffer, 0, baseY, cell);
      } else {
        const { evicted, added } = shift;
        if (evicted > 0 || added > 0) {
          const kept = evicted > 0 ? this.cachedScrollback.slice(evicted) : this.cachedScrollback;
          if (evicted > 0) {
            for (let i = 0; i < kept.length; i++) {
              const expectedKey = `normal:${i}`;
              if (kept[i].row.key !== expectedKey) {
                kept[i] = { ...kept[i], row: { key: expectedKey, spans: kept[i].row.spans } };
              }
            }
          }
          const newlyScrolled = added > 0 ? this.extractScrollbackRange(buffer, baseY - added, baseY, cell) : [];
          this.cachedScrollback = kept.concat(newlyScrolled);
        }
      }
    }
    this.lastBaseY = baseY;
    this.lastScrollEvents = this.scrollEvents;

    const viewport = this.extractRange(buffer, baseY, buffer.length, cell);
    const combined = this.cachedScrollback.length
      ? this.cachedScrollback.map((entry) => entry.row).concat(viewport)
      : viewport;
    this.cachedBufferType = "normal";
    this.cachedViewport = viewport;
    this.cachedLines = combined;
    this.dirty = false;
    return combined;
  }

  /**
   * Determines how many cached scrollback lines were evicted and how many new
   * scrollback lines must be extracted when `baseY >= scrollbackLimit`.
   * Returns `null` if the shift is ambiguous (e.g. identical repeated lines) or
   * exceeds cached history, triggering a full safe re-extract.
   */
  private resolveScrollbackShift(
    buffer: IBuffer,
    baseY: number,
    scrollDelta: number,
  ): { evicted: number; added: number } | null {
    const cachedLen = this.cachedScrollback.length;
    if (cachedLen === 0 || baseY < cachedLen) return null;
    const topLine = buffer.getLine(0);
    if (!topLine) return null;
    const topText = topLine.translateToString(true);

    const matchesAt = (evicted: number): boolean => {
      const keptLen = cachedLen - evicted;
      if (keptLen <= 0) return false;
      if (this.cachedScrollback[evicted].text !== topText) return false;
      const lastLine = buffer.getLine(keptLen - 1);
      if (!lastLine || this.cachedScrollback[cachedLen - 1].text !== lastLine.translateToString(true)) {
        return false;
      }
      if (keptLen >= 3) {
        const mid = keptLen >> 1;
        const midLine = buffer.getLine(mid);
        if (!midLine || this.cachedScrollback[evicted + mid].text !== midLine.translateToString(true)) {
          return false;
        }
      }
      return true;
    };

    const maxCandidate = Math.min(scrollDelta, cachedLen - 1);
    const expectedEvicted = Math.max(0, cachedLen + scrollDelta - baseY);
    const matchesZero = matchesAt(0);
    const matchesExpected = expectedEvicted > 0 && expectedEvicted < cachedLen && matchesAt(expectedEvicted);

    // Unambiguous DECSTBM no-eviction (or initial fill to cap).
    if (matchesZero && !matchesExpected) {
      return { evicted: 0, added: baseY - cachedLen };
    }
    // Unambiguous exact eviction matching `scrollDelta`.
    if (matchesExpected && !matchesZero) {
      return { evicted: expectedEvicted, added: baseY - (cachedLen - expectedEvicted) };
    }
    // Ambiguous (identical lines) -> fall back to safe full re-extract.
    if (matchesZero && matchesExpected) return null;

    // Mixed DECSTBM + real scrollback evictions: locate a unique shift in 1..maxCandidate.
    let found = -1;
    for (let evicted = 1; evicted <= maxCandidate; evicted++) {
      if (evicted === expectedEvicted) continue;
      if (matchesAt(evicted)) {
        if (found !== -1) return null; // Ambiguous shift -> full safe re-extract.
        found = evicted;
      }
    }
    if (found === -1) return null;
    return { evicted: found, added: baseY - (cachedLen - found) };
  }

  private extractScrollbackRange(buffer: IBuffer, start: number, end: number, cell: IBufferCell): CachedScrollbackRow[] {
    const rows = this.extractRange(buffer, start, end, cell);
    return rows.map((row) => ({ row, text: rowPlainText(row) }));
  }

  /** Only what the screen shows now, its history aside. */
  viewport(): Row[] {
    const buffer = this.term.buffer.active;
    if (!this.dirty && this.cachedViewport && this.cachedBufferType === buffer.type) {
      return this.cachedViewport;
    }
    const cell = buffer.getNullCell();
    return this.extractRange(buffer, buffer.baseY, buffer.length, cell);
  }

  /** Whether the terminal kept a history of its own: lines that scrolled off a normal screen. */
  hasHistory(): boolean {
    const buffer = this.term.buffer.active;
    return buffer.type === "normal" && buffer.baseY > 0;
  }

  private invalidateScrollback() {
    this.cachedScrollback = [];
    this.cachedLines = null;
    this.cachedViewport = null;
    this.cachedBufferType = null;
    this.lastBaseY = 0;
    this.scrollEvents = 0;
    this.lastScrollEvents = 0;
    this.dirty = true;
  }

  private extractRange(buffer: IBuffer, start: number, end: number, cell: IBufferCell): Row[] {
    const out: Row[] = [];
    const cols = this.term.cols;
    const prefix = `${buffer.type}:`;
    for (let y = start; y < end; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      this._extractedRows++;
      const spans: Span[] = [];
      for (let x = 0; x < cols; x++) {
        line.getCell(x, cell);
        if (cell.getWidth() === 0) continue; // the second half of a wide character
        const chars = cell.getChars() || " ";
        const style = look(cell);
        const last = spans[spans.length - 1];
        if (last && same(last, style)) last.text += chars;
        else spans.push(style === DEFAULT_LOOK ? { text: chars } : { text: chars, ...style });
      }
      // Blank cells at the end go, unless something painted them.
      while (spans.length && !spans[spans.length - 1].bg) {
        const last = spans[spans.length - 1];
        last.text = last.text.trimEnd();
        if (last.text) break;
        spans.pop();
      }
      out.push({ key: `${prefix}${y}`, spans: spans.length ? spans : [{ text: " " }] });
    }
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.cachedScrollback = [];
    this.cachedLines = null;
    this.cachedViewport = null;
    this.term.dispose();
  }
}
