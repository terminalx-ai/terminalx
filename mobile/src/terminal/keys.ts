import type { ScreenModes } from "./screen";

/**
 * What the phone's terminal keys send, byte for byte what the desktop
 * terminal (xterm.js) sends for the same key in the same mode, so an agent
 * CLI cannot tell which of the two is typing.
 */

export type TerminalKey = "escape" | "tab" | "shiftTab" | "enter" | "backspace" | "up" | "down" | "left" | "right";

const CURSOR: Record<"up" | "down" | "right" | "left", string> = { up: "A", down: "B", right: "C", left: "D" };

export function keySequence(key: TerminalKey, modes: Pick<ScreenModes, "applicationCursorKeys">): string {
  switch (key) {
    case "escape": return "\x1b";
    case "tab": return "\t";
    case "shiftTab": return "\x1b[Z";
    case "enter": return "\r";
    case "backspace": return "\x7f";
    // A program in application cursor mode (most full-screen ones) reads SS3.
    default: return `${modes.applicationCursorKeys ? "\x1bO" : "\x1b["}${CURSOR[key]}`;
  }
}

/** Control plus a character, as a terminal sends it: Ctrl-C is ETX. Nothing for a character with no control form. */
export function controlSequence(char: string): string | null {
  if (char.length !== 1) return null;
  if (char === " " || char === "@" || char === "2") return "\x00";
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  if (char === "?" || char === "8") return "\x7f";
  return null;
}

/**
 * Text pasted or sent whole, as xterm.js pastes: line breaks become Enter
 * (CR), and a program that asked for bracketed paste gets it bracketed, so a
 * multi-line paste is not run line by line.
 */
export function pasteSequence(text: string, modes: Pick<ScreenModes, "bracketedPaste">): string {
  const normalized = text.replace(/\r?\n/g, "\r");
  return modes.bracketedPaste ? `\x1b[200~${normalized}\x1b[201~` : normalized;
}
