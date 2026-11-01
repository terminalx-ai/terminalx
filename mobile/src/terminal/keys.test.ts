import { describe, expect, it } from "vitest";
import { controlSequence, keySequence, pasteSequence } from "./keys";

describe("what the phone's terminal keys send", () => {
  it("sends the cursor keys a program in application cursor mode reads, as xterm.js does", () => {
    expect(keySequence("up", { applicationCursorKeys: false })).toBe("\x1b[A");
    expect(keySequence("left", { applicationCursorKeys: false })).toBe("\x1b[D");
    expect(keySequence("up", { applicationCursorKeys: true })).toBe("\x1bOA");
    expect(keySequence("right", { applicationCursorKeys: true })).toBe("\x1bOC");
  });

  it("sends Escape, Tab, Shift-Tab, Enter and Backspace as a terminal does", () => {
    const modes = { applicationCursorKeys: false };
    expect(["escape", "tab", "shiftTab", "enter", "backspace"].map((key) => keySequence(key as never, modes))).toEqual(["\x1b", "\t", "\x1b[Z", "\r", "\x7f"]);
  });

  it("turns Ctrl plus a character into its control code", () => {
    expect(controlSequence("c")).toBe("\x03");
    expect(controlSequence("C")).toBe("\x03");
    expect(controlSequence("d")).toBe("\x04");
    expect(controlSequence("[")).toBe("\x1b");
    expect(controlSequence(" ")).toBe("\x00");
    expect(controlSequence("é")).toBeNull();
    expect(controlSequence("ab")).toBeNull();
  });

  it("pastes as xterm.js does: lines end in Enter, bracketed when the program asked", () => {
    expect(pasteSequence("one\ntwo\r\nthree", { bracketedPaste: false })).toBe("one\rtwo\rthree");
    expect(pasteSequence("one\ntwo", { bracketedPaste: true })).toBe("\x1b[200~one\rtwo\x1b[201~");
  });
});
