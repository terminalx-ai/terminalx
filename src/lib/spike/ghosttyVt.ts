/**
 * SPIKE (issue #232, phase 3): a minimal binding to libghostty-vt compiled to
 * WebAssembly, enough to feed a terminal bytes and read back what to draw.
 * Written against Ghostty's public C API (`include/ghostty/vt/*.h`, MIT).
 * Not a terminal: no input encoding, selection, links, resize reflow or IME.
 */
const OK = 0;

// include/ghostty/vt/render.h and terminal.h
const RENDER_DATA_DIRTY = 3;
const RENDER_DATA_ROW_ITERATOR = 4;
const RENDER_OPTION_DIRTY = 0;
const ROW_DATA_DIRTY = 1;
const ROW_DATA_CELLS = 3;
const ROW_OPTION_DIRTY = 0;
const CELL_DATA_STYLE = 2;
const CELL_DATA_GRAPHEMES_LEN = 3;
const CELL_DATA_GRAPHEMES_BUF = 4;
const CELL_DATA_BG_COLOR = 5;
const CELL_DATA_FG_COLOR = 6;
const CELL_DATA_HAS_STYLING = 8;
const TERMINAL_DATA_TOTAL_ROWS = 14;
const STYLE_SIZE = 72;
const STYLE_BOLD = 56;
const STYLE_ITALIC = 57;
const STYLE_INVERSE = 60;
const MAX_GRAPHEMES = 16;

type Fn = (...args: number[]) => number;

export interface Cell {
  /** Empty for a blank cell. */
  text: string;
  /** 0xRRGGBB, or -1 for the terminal's default. */
  fg: number;
  bg: number;
  bold: boolean;
  italic: boolean;
  inverse: boolean;
}

export class GhosttyVt {
  readonly memory: WebAssembly.Memory;
  private readonly x: Record<string, Fn>;
  /** Scratch space in the module's memory: an out-pointer, a style, a few codepoints. */
  private readonly out: number;
  private readonly style: number;
  private readonly graphemes: number;
  private input = 0;
  private inputCapacity = 0;

  private constructor(instance: WebAssembly.Instance) {
    this.x = instance.exports as unknown as Record<string, Fn>;
    this.memory = instance.exports.memory as WebAssembly.Memory;
    this.out = this.x.ghostty_wasm_alloc_u8_array(16);
    this.style = this.x.ghostty_wasm_alloc_u8_array(STYLE_SIZE);
    this.graphemes = this.x.ghostty_wasm_alloc_u8_array(MAX_GRAPHEMES * 4);
  }

  static async load(wasm: BufferSource): Promise<GhosttyVt> {
    const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
    return new GhosttyVt(instance);
  }

  private view(): DataView {
    return new DataView(this.memory.buffer);
  }

  private handle(make: (out: number) => number, what: string): number {
    const out = this.x.ghostty_wasm_alloc_opaque();
    const result = make(out);
    const handle = this.view().getUint32(out, true);
    this.x.ghostty_wasm_free_opaque(out);
    if (result !== OK || !handle) throw new Error(`ghostty: ${what} failed (${result})`);
    return handle;
  }

  newTerminal(cols: number, rows: number, scrollback: number): GhosttyTerminal {
    const options = this.x.ghostty_wasm_alloc_u8_array(8);
    const view = this.view();
    view.setUint16(options, cols, true);
    view.setUint16(options + 2, rows, true);
    view.setUint32(options + 4, scrollback, true);
    const terminal = this.handle((out) => this.x.ghostty_terminal_new(0, out, options), "terminal_new");
    this.x.ghostty_wasm_free_u8_array(options, 8);
    return new GhosttyTerminal(this, terminal);
  }

  /** @internal */
  write(terminal: number, bytes: Uint8Array) {
    if (bytes.length > this.inputCapacity) {
      if (this.input) this.x.ghostty_wasm_free_u8_array(this.input, this.inputCapacity);
      this.inputCapacity = Math.max(bytes.length, 64 * 1024);
      this.input = this.x.ghostty_wasm_alloc_u8_array(this.inputCapacity);
    }
    new Uint8Array(this.memory.buffer, this.input, bytes.length).set(bytes);
    this.x.ghostty_terminal_vt_write(terminal, this.input, bytes.length);
  }

  /** @internal */
  free(terminal: number) {
    this.x.ghostty_terminal_free(terminal);
  }

  /** @internal */
  totalRows(terminal: number): number {
    this.x.ghostty_terminal_get(terminal, TERMINAL_DATA_TOTAL_ROWS, this.out);
    return this.view().getUint32(this.out, true);
  }

  /** @internal */
  newRenderState() {
    return {
      state: this.handle((out) => this.x.ghostty_render_state_new(0, out), "render_state_new"),
      rows: this.handle((out) => this.x.ghostty_render_state_row_iterator_new(0, out), "row_iterator_new"),
      cells: this.handle((out) => this.x.ghostty_render_state_row_cells_new(0, out), "row_cells_new"),
    };
  }

  /** @internal */
  freeRenderState(render: { state: number; rows: number; cells: number }) {
    this.x.ghostty_render_state_row_cells_free(render.cells);
    this.x.ghostty_render_state_row_iterator_free(render.rows);
    this.x.ghostty_render_state_free(render.state);
  }

  /**
   * Bring the render state up to date and visit every row that changed
   * (every row when `all`), then mark them clean. `cell` is reused.
   * @internal
   */
  render(terminal: number, render: { state: number; rows: number; cells: number }, all: boolean, row: (y: number) => void, cell: (y: number, x: number, cell: Cell) => void): number {
    const x = this.x;
    x.ghostty_render_state_update(render.state, terminal);
    x.ghostty_render_state_get(render.state, RENDER_DATA_DIRTY, this.out);
    const dirty = this.view().getUint32(this.out, true);
    if (!dirty && !all) return 0;
    // The out-pointer holds the iterator handle: the getter fills the iterator it points at.
    this.view().setUint32(this.out, render.rows, true);
    x.ghostty_render_state_get(render.state, RENDER_DATA_ROW_ITERATOR, this.out);
    const current: Cell = { text: "", fg: -1, bg: -1, bold: false, italic: false, inverse: false };
    let drawn = 0;
    let y = -1;
    while (x.ghostty_render_state_row_iterator_next(render.rows)) {
      y++;
      x.ghostty_render_state_row_get(render.rows, ROW_DATA_DIRTY, this.out);
      if (!all && dirty !== 2 && !new Uint8Array(this.memory.buffer)[this.out]) continue;
      drawn++;
      row(y);
      this.view().setUint32(this.out, render.cells, true);
      x.ghostty_render_state_row_get(render.rows, ROW_DATA_CELLS, this.out);
      let column = -1;
      while (x.ghostty_render_state_row_cells_next(render.cells)) {
        column++;
        x.ghostty_render_state_row_cells_get(render.cells, CELL_DATA_GRAPHEMES_LEN, this.out);
        const length = Math.min(this.view().getUint32(this.out, true), MAX_GRAPHEMES);
        const memory = new Uint8Array(this.memory.buffer);
        const hasBg = x.ghostty_render_state_row_cells_get(render.cells, CELL_DATA_BG_COLOR, this.out) === OK;
        current.bg = hasBg ? (memory[this.out] << 16) | (memory[this.out + 1] << 8) | memory[this.out + 2] : -1;
        if (!length && !hasBg) continue;
        if (length) {
          x.ghostty_render_state_row_cells_get(render.cells, CELL_DATA_GRAPHEMES_BUF, this.graphemes);
          const points = new Uint32Array(this.memory.buffer, this.graphemes, length);
          current.text = length === 1 ? String.fromCodePoint(points[0]) : String.fromCodePoint(...points);
        } else {
          current.text = "";
        }
        const hasFg = x.ghostty_render_state_row_cells_get(render.cells, CELL_DATA_FG_COLOR, this.out) === OK;
        current.fg = hasFg ? (memory[this.out] << 16) | (memory[this.out + 1] << 8) | memory[this.out + 2] : -1;
        x.ghostty_render_state_row_cells_get(render.cells, CELL_DATA_HAS_STYLING, this.out);
        if (memory[this.out]) {
          this.view().setUint32(this.style, STYLE_SIZE, true);
          x.ghostty_render_state_row_cells_get(render.cells, CELL_DATA_STYLE, this.style);
          current.bold = memory[this.style + STYLE_BOLD] !== 0;
          current.italic = memory[this.style + STYLE_ITALIC] !== 0;
          current.inverse = memory[this.style + STYLE_INVERSE] !== 0;
        } else {
          current.bold = current.italic = current.inverse = false;
        }
        cell(y, column, current);
      }
      new Uint8Array(this.memory.buffer)[this.out] = 0;
      x.ghostty_render_state_row_set(render.rows, ROW_OPTION_DIRTY, this.out);
    }
    this.view().setUint32(this.out, 0, true);
    x.ghostty_render_state_set(render.state, RENDER_OPTION_DIRTY, this.out);
    return drawn;
  }
}

export class GhosttyTerminal {
  private render: { state: number; rows: number; cells: number } | null = null;

  constructor(
    private readonly vt: GhosttyVt,
    private readonly handle: number,
  ) {}

  write(bytes: Uint8Array) {
    this.vt.write(this.handle, bytes);
  }

  /** Lines held, scrollback included. */
  get totalRows(): number {
    return this.vt.totalRows(this.handle);
  }

  /** Visit the rows that changed since the last call; returns how many. */
  draw(all: boolean, row: (y: number) => void, cell: (y: number, x: number, cell: Cell) => void): number {
    this.render ??= this.vt.newRenderState();
    return this.vt.render(this.handle, this.render, all, row, cell);
  }

  dispose() {
    if (this.render) this.vt.freeRenderState(this.render);
    this.vt.free(this.handle);
  }
}
