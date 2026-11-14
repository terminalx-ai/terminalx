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
    expect(screen.modes()).toEqual({ bracketedPaste: false, applicationCursorKeys: false });
    await screen.write("\x1b[?2004h\x1b[?1h");
    expect(screen.modes()).toEqual({ bracketedPaste: true, applicationCursorKeys: true });
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
});
