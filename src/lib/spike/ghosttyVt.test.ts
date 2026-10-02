// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GhosttyVt } from "./ghosttyVt";

const wasm = readFileSync(resolve(process.cwd(), "spike/terminal-ghostty/ghostty-vt.wasm"));

function screen(terminal: ReturnType<GhosttyVt["newTerminal"]>, all = true) {
  const rows: string[][] = [];
  const styled: string[] = [];
  const drawn = terminal.draw(all, (y) => (rows[y] = []), (y, x, cell) => {
    rows[y][x] = cell.text || " ";
    if (cell.fg !== -1 || cell.bold) styled.push(`${y},${x}:${cell.text}:${cell.fg.toString(16)}:${cell.bold ? "b" : ""}`);
  });
  return { drawn, lines: rows.map((row) => Array.from(row, (text) => text ?? " ").join("").trimEnd()), styled };
}

describe("the libghostty-vt binding (spike)", () => {
  it("parses output and reports what to draw, row by row", async () => {
    const vt = await GhosttyVt.load(wasm);
    const terminal = vt.newTerminal(40, 5, 100);
    terminal.write(new TextEncoder().encode("hello\r\n\x1b[1;38;2;255;128;0mwörld\x1b[0m 🙂"));
    const first = screen(terminal);
    expect(first.lines.slice(0, 2)).toEqual(["hello", "wörld 🙂"]);
    expect(first.styled).toContain("1,0:w:ff8000:b");

    // Nothing changed: nothing to draw. Then one row is written, and the cursor leaves another: two to draw.
    expect(screen(terminal, false).drawn).toBe(0);
    terminal.write(new TextEncoder().encode("\x1b[1;1HHELLO"));
    const second = screen(terminal, false);
    expect(second.drawn).toBe(2);
    expect(second.lines[0]).toBe("HELLO");

    // Lines that scroll off the screen are kept.
    terminal.write(new TextEncoder().encode("line\r\n".repeat(500)));
    expect(terminal.totalRows).toBeGreaterThan(50);
    terminal.dispose();
  });
});
