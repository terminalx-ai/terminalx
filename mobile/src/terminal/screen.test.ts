import { describe, expect, it } from "vitest";
import { paletteColor, TerminalScreen } from "./screen";

const text = (screen: TerminalScreen) => screen.lines().map((row) => row.spans.map((span) => span.text).join("").trimEnd());

describe("the phone's terminal screen", () => {
  it("draws escape sequences instead of showing them, with the desktop's colours", async () => {
    const screen = new TerminalScreen(20, 3);
    await screen.write("\x1b[1;31merror\x1b[0m: \x1b[38;5;46mok\x1b[0m\r\nnext");
    expect(text(screen)).toEqual(["error: ok", "next", ""]);
    const [error, plain, ok] = screen.lines()[0].spans;
    expect(error).toEqual({ text: "error", fg: "#f07178", bold: true });
    expect(plain).toEqual({ text: ": " });
    expect(ok).toEqual({ text: "ok", fg: paletteColor(46) });
    screen.dispose();
  });

  it("places what a full-screen program draws where it puts it, and shows only its screen", async () => {
    const screen = new TerminalScreen(12, 4);
    await screen.write("history 1\r\nhistory 2\r\n");
    // An agent CLI switches to the alternate screen and addresses the cursor.
    await screen.write("\x1b[?1049h\x1b[2J\x1b[2;3Hmiddle\x1b[4;1H> prompt");
    expect(text(screen)).toEqual(["", "  middle", "", "> prompt"]);
    // Leaving it shows the shell's history again.
    await screen.write("\x1b[?1049l");
    expect(text(screen).slice(0, 2)).toEqual(["history 1", "history 2"]);
    screen.dispose();
  });

  it("follows the pane's size and keeps history above a normal screen", async () => {
    const screen = new TerminalScreen(10, 2);
    await screen.write("one\r\ntwo\r\nthree\r\nfour");
    expect(text(screen)).toEqual(["one", "two", "three", "four"]);
    screen.resize(30, 5);
    expect([screen.cols, screen.rows]).toEqual([30, 5]);
    await screen.write("\r\na line wider than ten columns");
    expect(text(screen)).toContain("a line wider than ten columns");
    screen.dispose();
  });

  it("reports what the program asked for, which decides what keys and pastes send", async () => {
    const screen = new TerminalScreen(10, 2);
    expect(screen.modes()).toEqual({ bracketedPaste: false, applicationCursorKeys: false, mouse: false, alternate: false });
    await screen.write("\x1b[?2004h\x1b[?1h");
    expect(screen.modes()).toMatchObject({ bracketedPaste: true, applicationCursorKeys: true });
    // A full-screen program that takes the wheel: its swipes go to it.
    await screen.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
    expect(screen.modes()).toMatchObject({ mouse: true, alternate: true });
    screen.dispose();
  });

  it("keeps a wide character to one cell pair and inverse video readable", async () => {
    const screen = new TerminalScreen(10, 1);
    await screen.write("界x\x1b[7minv\x1b[0m");
    expect(text(screen)).toEqual(["界xinv"]);
    expect(screen.lines()[0].spans.at(-1)).toEqual({ text: "inv", fg: "#171719", bg: "#e6e6e6" });
    screen.dispose();
  });

  it("maps the 256-colour table as xterm does", () => {
    expect(paletteColor(1)).toBe("#f07178");
    expect(paletteColor(16)).toBe("#000000");
    expect(paletteColor(231)).toBe("#ffffff");
    expect(paletteColor(196)).toBe("#ff0000");
    expect(paletteColor(232)).toBe("#080808");
    expect(paletteColor(255)).toBe("#eeeeee");
  });

  it("extracts only newly scrolled and viewport rows instead of re-reading full scrollback (P-45)", async () => {
    const screen = new TerminalScreen(40, 4, 200);
    // Push 80 lines into scrollback.
    const bulk = Array.from({ length: 80 }, (_, i) => `line-${i}`).join("\r\n") + "\r\nactive-0";
    await screen.write(bulk);
    const initial = screen.lines();
    expect(initial.length).toBeGreaterThan(75);
    expect(text(screen).at(0)).toBe("line-0");

    // Repeated lines() with no new write does zero extraction.
    const countAfterFirst = screen.extractedRowsCount;
    expect(screen.lines()).toBe(initial);
    expect(screen.extractedRowsCount).toBe(countAfterFirst);

    // 10 viewport-only redraws (spinner / progress updates): only 4 viewport rows extracted per draw.
    for (let i = 1; i <= 10; i++) {
      await screen.write(`\ractive-${i}   `);
      const rows = screen.lines();
      expect(rows.slice(0, 5)).toEqual(initial.slice(0, 5));
      expect(rows.at(-1)?.spans.map((s) => s.text).join("").trimEnd()).toBe(`active-${i}`);
    }
    const extractedDuringRedraws = screen.extractedRowsCount - countAfterFirst;
    expect(extractedDuringRedraws).toBe(10 * 4);

    // Scrolling 2 more lines extracts only those 2 newly scrolled lines + 4 viewport rows.
    const beforeScroll = screen.extractedRowsCount;
    await screen.write("\r\nnew-a\r\nnew-b");
    const afterScroll = text(screen);
    expect(afterScroll).toContain("new-a");
    expect(afterScroll).toContain("new-b");
    expect(screen.extractedRowsCount - beforeScroll).toBeLessThanOrEqual(8);

    // Wrapping past scrollback capacity keeps exact buffer contents.
    const overflow = Array.from({ length: 250 }, (_, i) => `wrap-${i}`).join("\r\n");
    await screen.write(`\r\n${overflow}`);
    const wrapped = text(screen);
    expect(wrapped).toContain("wrap-249");
    expect(wrapped).not.toContain("line-0");
    screen.dispose();
  });

  it("preserves exact scrollback contents during DECSTBM scroll-region scrolls both below and at the scrollback cap (P-45)", async () => {
    // 1. Below scrollback cap (rows=4, scrollback=10): 6 lines push 3 lines into scrollback.
    const belowCap = new TerminalScreen(20, 4, 10);
    await belowCap.write("L0\r\nL1\r\nL2\r\nL3\r\nL4\r\nL5\r\nL6");
    expect(text(belowCap).slice(0, 3)).toEqual(["L0", "L1", "L2"]);
    const beforeDecstbmBelow = belowCap.extractedRowsCount;

    // DECSTBM scroll region (rows 2..4) triggers xterm onScroll without evicting scrollback.
    await belowCap.write("\x1b[2;4r\x1b[4;1Hx\r\ny\r\nz\r\n");
    const afterBelow = text(belowCap);
    // Top scrollback lines must stay intact (not sliced or duplicated).
    expect(afterBelow.slice(0, 3)).toEqual(["L0", "L1", "L2"]);
    // Only the 4 viewport rows were extracted (zero scrollback re-extraction).
    expect(belowCap.extractedRowsCount - beforeDecstbmBelow).toBe(4);
    belowCap.dispose();

    // 2. At scrollback cap (rows=4, scrollback=5): fill scrollback completely to cap=5.
    const atCap = new TerminalScreen(20, 4, 5);
    await atCap.write(Array.from({ length: 12 }, (_, i) => `S${i}`).join("\r\n"));
    const initialAtCap = text(atCap);
    expect(initialAtCap).toHaveLength(9); // 5 scrollback + 4 viewport
    expect(initialAtCap.slice(0, 5)).toEqual(["S3", "S4", "S5", "S6", "S7"]);
    const beforeDecstbmAtCap = atCap.extractedRowsCount;

    // DECSTBM scroll region at cap must NOT evict or duplicate scrollback lines.
    await atCap.write("\x1b[2;4r\x1b[4;1Ha\r\nb\r\nc\r\n");
    const afterDecstbmAtCap = text(atCap);
    expect(afterDecstbmAtCap.slice(0, 5)).toEqual(["S3", "S4", "S5", "S6", "S7"]);
    expect(atCap.extractedRowsCount - beforeDecstbmAtCap).toBe(4);

    // 3. Mixed DECSTBM scroll + real full-screen scroll in the same batch at cap.
    await atCap.write("\x1b[2;4r\x1b[4;1Hd\r\ne\r\n\x1b[r\x1b[4;1H\r\nM1\r\nM2");
    const afterMixed = text(atCap);
    // Resetting scroll region and scrolling 2 real lines evicts S3, S4 and keeps S5, S6, S7 + 2 newly scrolled lines.
    expect(afterMixed.slice(0, 3)).toEqual(["S5", "S6", "S7"]);
    expect(afterMixed.at(-2)).toBe("M1");
    expect(afterMixed.at(-1)).toBe("M2");
    atCap.dispose();
  });
});
