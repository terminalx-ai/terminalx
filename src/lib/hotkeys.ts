import { useEffect } from "react";

/**
 * One keyboard registry for the whole window.
 *
 * A chord is written the way it is shown: "mod+b", "mod+shift+[", "escape".
 * "mod" is ⌘ on macOS and Ctrl elsewhere. Handlers registered later win, so a
 * dialog can shadow the app's own bindings while it is open; return `false`
 * from a handler to let the chord fall through to the next one.
 */

export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type Handler = (e: KeyboardEvent) => void | boolean;

interface Binding {
  chord: string;
  handler: Handler;
  /** Fire even when focus is inside an editable field. */
  global?: boolean;
  /** Higher priorities win before registration order (e.g. non-modal Escape). */
  priority?: number;
}

const bindings: Binding[] = [];

function normalizeKey(key: string): string {
  const k = key.toLowerCase();
  if (k === " ") return "space";
  if (k === "arrowup") return "up";
  if (k === "arrowdown") return "down";
  if (k === "arrowleft") return "left";
  if (k === "arrowright") return "right";
  if (k === "esc") return "escape";
  return k;
}

export function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (isMac ? e.ctrlKey : e.metaKey) parts.push(isMac ? "ctrl" : "meta");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  let key = normalizeKey(e.key);
  // With shift held, punctuation reports its shifted glyph; use the physical code for brackets.
  if (e.shiftKey && e.code === "BracketLeft") key = "[";
  if (e.shiftKey && e.code === "BracketRight") key = "]";
  if (e.code.startsWith("Digit") && e.altKey) key = e.code.slice(5);
  if (!["meta", "control", "alt", "shift"].includes(key)) parts.push(key);
  return parts.join("+");
}

function normalizeChord(chord: string): string {
  const parts = chord.toLowerCase().split("+").map((p) => p.trim());
  const mods = ["mod", "ctrl", "meta", "alt", "shift"].filter((m) => parts.includes(m));
  const key = parts.filter((p) => !["mod", "ctrl", "meta", "alt", "shift"].includes(p));
  return [...mods, ...key.map(normalizeKey)].join("+");
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Escape belongs to an open surface before background tabs or reminders. */
export function hasEscapeOverlay(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
}

let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
    "keydown",
    (e) => {
      const chord = chordOf(e);
      for (let i = bindings.length - 1; i >= 0; i--) {
        const b = bindings[i];
        if (b.chord !== chord) continue;
        if (!b.global && !chord.includes("mod") && chord !== "escape" && isEditable(e.target)) continue;
        const r = b.handler(e);
        if (r !== false) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    },
    { capture: true },
  );
}

export function registerHotkey(chord: string, handler: Handler, opts?: { global?: boolean; priority?: number }) {
  install();
  const b: Binding = { chord: normalizeChord(chord), handler, global: opts?.global, priority: opts?.priority };
  bindings.push(b);
  bindings.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return () => {
    const i = bindings.indexOf(b);
    if (i >= 0) bindings.splice(i, 1);
  };
}

export function useHotkey(chord: string, handler: Handler, opts?: { global?: boolean; enabled?: boolean; priority?: number }) {
  const enabled = opts?.enabled ?? true;
  const global = opts?.global;
  const priority = opts?.priority;
  useEffect(() => {
    if (!enabled) return;
    return registerHotkey(chord, handler, { global, priority });
  }, [chord, handler, enabled, global, priority]);
}

/** Keycaps for tooltips: ["⌘", "B"] on mac, ["Ctrl", "B"] elsewhere. */
export function keycaps(chord: string): string[] {
  return normalizeChord(chord)
    .split("+")
    .map((p) => {
      switch (p) {
        case "mod":
          return isMac ? "⌘" : "Ctrl";
        case "shift":
          return isMac ? "⇧" : "Shift";
        case "alt":
          return isMac ? "⌥" : "Alt";
        case "ctrl":
          return isMac ? "⌃" : "Ctrl";
        case "meta":
          return "⊞";
        case "enter":
          return "⏎";
        case "escape":
          return "Esc";
        case "backspace":
          return "⌫";
        case "up":
          return "↑";
        case "down":
          return "↓";
        case "left":
          return "←";
        case "right":
          return "→";
        default:
          return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
      }
    });
}
