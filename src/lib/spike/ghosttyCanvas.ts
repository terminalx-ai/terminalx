import type { GhosttyTerminal } from "./ghosttyVt";

/**
 * SPIKE (issue #232, phase 3): the least renderer that draws a libghostty-vt
 * terminal honestly: a 2D canvas, only the rows that changed, text in runs
 * of one style. No cursor, selection, links, ligatures or wide-glyph care.
 */
const hex = (colour: number) => `#${colour.toString(16).padStart(6, "0")}`;

export class GhosttyCanvas {
  readonly canvas = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D;
  private readonly cellWidth: number;
  private readonly cellHeight: number;
  private readonly font: string;

  constructor(
    private readonly terminal: GhosttyTerminal,
    cols: number,
    rows: number,
    private readonly colours: { foreground: string; background: string },
    fontFamily: string,
    fontSize = 12.5,
    lineHeight = 1.25,
  ) {
    const dpr = window.devicePixelRatio || 1;
    this.font = `${fontSize * dpr}px ${fontFamily}`;
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("no 2D canvas");
    this.context = context;
    context.font = this.font;
    // As xterm's WebGL renderer sizes a cell: whole device pixels.
    this.cellWidth = Math.floor(context.measureText("W").width);
    this.cellHeight = Math.floor(Math.ceil(fontSize * dpr * 1.2) * lineHeight);
    this.canvas.width = this.cellWidth * cols;
    this.canvas.height = this.cellHeight * rows;
    this.canvas.style.width = `${this.canvas.width / dpr}px`;
    this.canvas.style.height = `${this.canvas.height / dpr}px`;
    context.font = this.font;
    context.textBaseline = "middle";
    context.fillStyle = colours.background;
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Draw what changed; returns the number of rows drawn. */
  draw(all = false): number {
    const { context, cellWidth, cellHeight, colours } = this;
    let run = "";
    let runX = 0;
    let runY = 0;
    let runStyle = "";
    let nextX = -1;
    const flush = () => {
      if (!run) return;
      const [fill, bold, italic] = runStyle.split("|");
      const font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${this.font}`;
      if (context.font !== font) context.font = font;
      context.fillStyle = fill;
      context.fillText(run, runX * cellWidth, runY * cellHeight + cellHeight / 2);
      run = "";
    };
    const drawn = this.terminal.draw(
      all,
      (y) => {
        flush();
        context.fillStyle = colours.background;
        context.fillRect(0, y * cellHeight, this.canvas.width, cellHeight);
        nextX = -1;
      },
      (y, x, cell) => {
        const fg = cell.fg === -1 ? colours.foreground : hex(cell.fg);
        const bg = cell.bg === -1 ? null : hex(cell.bg);
        const ink = cell.inverse ? (bg ?? colours.background) : fg;
        const paper = cell.inverse ? fg : bg;
        if (paper) {
          flush();
          context.fillStyle = paper;
          context.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
        }
        if (!cell.text) return;
        const style = `${ink}|${cell.bold ? 1 : ""}|${cell.italic ? 1 : ""}`;
        // A run is cells side by side in one style; anything outside ASCII is drawn on its own cell.
        const plain = cell.text.length === 1 && cell.text.charCodeAt(0) < 128;
        if (!run || style !== runStyle || x !== nextX || y !== runY || !plain) {
          flush();
          runX = x;
          runY = y;
          runStyle = style;
        }
        run += cell.text;
        nextX = plain ? x + 1 : -1;
      },
    );
    flush();
    return drawn;
  }
}
