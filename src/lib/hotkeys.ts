import { useEffect, useRef } from "react";
import {
  HOLD_CODES,
  chordOf,
  currentKeymap,
  firesWhileTyping,
  holdBinding,
  isMac,
  isTerminalReserved,
  keycaps,
  normalizeBinding,
  sendShortcut,
  useKeymap,
  type ShortcutId,
} from "@/lib/shortcuts";

/**
 * One keyboard binder for the whole window.
 *
 * A shortcut the reader can change is bound by its action (`useShortcut`): the
 * keys are looked up in the registry on every keydown, so a change in Settings
 * applies at once. A key that belongs to a surface (Escape closing a dialog,
 * the arrows in a list) is bound by its chord (`useHotkey`), written the way
 * it is shown: "escape", "up". Handlers registered later win, so a dialog can
 * shadow the app's own bindings while it is open; return `false` from a
 * handler to let the keys fall through to the next one.
 *
 * A terminal with the focus keeps the keys a shell needs (`isTerminalReserved`):
 * no shortcut is run for them, whatever is stored.
 */

export { chordOf, isMac, keycaps };

type Handler = (e: KeyboardEvent) => void | boolean;

interface Binding {
  /** A fixed chord, or the action whose current keys are looked up. */
  chord?: string;
  action?: ShortcutId;
  handler: Handler;
  /** Fire even when focus is inside an editable field. */
  global?: boolean;
  /** Higher priorities win before registration order (e.g. non-modal Escape). */
  priority?: number;
}

interface HeldBinding {
  action: ShortcutId;
  onStart: () => void;
  onEnd: (cancelled: boolean) => void;
}

const bindings: Binding[] = [];
const heldBindings: HeldBinding[] = [];

/**
 * How long a modifier is held on its own before it counts as held. Shorter
 * than this it is the start of a combination (Right Option + E), or a tap, and
 * nothing starts.
 */
export const HOLD_DELAY_MS = 160;

let hold: { code: string; binding: HeldBinding; started: boolean; timer: ReturnType<typeof setTimeout> | null } | null = null;
let suspended = 0;

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** The focus is in a terminal, which has first call on the keys a shell needs. */
export function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(".xterm, .terminal-host");
}

/** Escape belongs to an open surface before background tabs or reminders. */
export function hasEscapeOverlay(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
}

/** Stop binding keys while something records them (the Shortcuts tab). Returns the resume. */
export function suspendHotkeys(): () => void {
  suspended++;
  endHold(true);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    suspended--;
  };
}

function endHold(cancelled: boolean) {
  const current = hold;
  if (!current) return;
  hold = null;
  if (current.timer != null) clearTimeout(current.timer);
  if (current.started) current.binding.onEnd(cancelled);
}

/** Another modifier is already down, so this press is part of a combination. */
function withOtherModifiers(e: KeyboardEvent): boolean {
  const own = e.code.replace(/(Left|Right)$/, "");
  return (own !== "Alt" && e.altKey) || (own !== "Control" && e.ctrlKey) || (own !== "Shift" && e.shiftKey) || (own !== "Meta" && e.metaKey);
}

function holdKeyDown(e: KeyboardEvent) {
  if (hold) {
    // Any other key makes it a combination: the hold is over and the keys go through.
    if (e.code !== hold.code) endHold(true);
    return;
  }
  if (e.repeat || !(HOLD_CODES as readonly string[]).includes(e.code) || withOtherModifiers(e) || inTerminal(e.target)) return;
  const wanted = holdBinding(e.code);
  const keymap = currentKeymap();
  let binding: HeldBinding | undefined;
  for (let i = heldBindings.length - 1; i >= 0 && !binding; i--) if (keymap[heldBindings[i].action].includes(wanted)) binding = heldBindings[i];
  if (!binding) return;
  const next = {
    code: e.code,
    binding,
    started: false,
    timer: setTimeout(() => {
      next.timer = null;
      next.started = true;
      binding.onStart();
    }, HOLD_DELAY_MS) as ReturnType<typeof setTimeout> | null,
  };
  hold = next;
}

let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
    "keydown",
    (e) => {
      if (suspended) return;
      holdKeyDown(e);
      const chord = chordOf(e);
      if (!chord) return;
      // The shell's keys are the terminal's, whatever is bound to them.
      if (isTerminalReserved(chord) && inTerminal(e.target)) return;
      const keymap = currentKeymap();
      for (let i = bindings.length - 1; i >= 0; i--) {
        const b = bindings[i];
        if (b.action ? !keymap[b.action].includes(chord) : b.chord !== chord) continue;
        if (!b.global && !firesWhileTyping(chord) && isEditable(e.target)) continue;
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
  window.addEventListener(
    "keyup",
    (e) => {
      if (hold && e.code === hold.code) endHold(false);
    },
    { capture: true },
  );
  // The release of a key held while the window lost the focus never arrives.
  window.addEventListener("blur", () => endHold(false));
}

function register(b: Binding) {
  install();
  bindings.push(b);
  bindings.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return () => {
    const i = bindings.indexOf(b);
    if (i >= 0) bindings.splice(i, 1);
  };
}

interface Options {
  global?: boolean;
  priority?: number;
}

/** Bind a fixed chord: a key that belongs to a surface, not one the reader can move. */
export function registerHotkey(chord: string, handler: Handler, opts?: Options) {
  return register({ chord: normalizeBinding(chord), handler, global: opts?.global, priority: opts?.priority });
}

/** Bind an action from the registry: whatever chords and keys it has now. */
export function registerShortcut(action: ShortcutId, handler: Handler, opts?: Options) {
  return register({ action, handler, global: opts?.global, priority: opts?.priority });
}

/**
 * Bind an action's held modifier key (`hold:AltRight`): `onStart` once it has
 * been held on its own for `HOLD_DELAY_MS`, `onEnd` when it is released, or
 * with `cancelled` when another key is pressed first.
 */
export function registerHeldShortcut(action: ShortcutId, handlers: { onStart: () => void; onEnd: (cancelled: boolean) => void }) {
  install();
  const b: HeldBinding = { action, ...handlers };
  heldBindings.push(b);
  return () => {
    if (hold?.binding === b) endHold(true);
    const i = heldBindings.indexOf(b);
    if (i >= 0) heldBindings.splice(i, 1);
  };
}

export function useHotkey(chord: string, handler: Handler, opts?: Options & { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const global = opts?.global;
  const priority = opts?.priority;
  useEffect(() => {
    if (!enabled) return;
    return registerHotkey(chord, handler, { global, priority });
  }, [chord, handler, enabled, global, priority]);
}

export function useShortcut(action: ShortcutId, handler: Handler, opts?: Options & { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const global = opts?.global;
  const priority = opts?.priority;
  useEffect(() => {
    if (!enabled) return;
    return registerShortcut(action, handler, { global, priority });
  }, [action, handler, enabled, global, priority]);
}

export function useHeldShortcut(action: ShortcutId, handlers: { onStart: () => void; onEnd: (cancelled: boolean) => void }, opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  // The latest handlers without registering again: a new registration would end a hold in progress.
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    return registerHeldShortcut(action, { onStart: () => latest.current.onStart(), onEnd: (cancelled) => latest.current.onEnd(cancelled) });
  }, [action, enabled]);
}

/**
 * Run an action as its keys would, whether or not it has any (the command
 * palette). The newest handler that takes it wins; an action nothing in the
 * window has bound is handled where the focus is (the composer's own keys).
 */
export function runShortcut(action: ShortcutId): void {
  const event = new KeyboardEvent("keydown", { key: "Unidentified", bubbles: true, cancelable: true });
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i];
    if (b.action === action && b.handler(event) !== false) return;
  }
  sendShortcut(action, document.activeElement instanceof HTMLElement ? document.activeElement : window);
}

/** Keycaps for an action's first binding, for a tooltip or a menu: [] when it has no keys. */
export function shortcutKeys(action: ShortcutId): string[] {
  const first = currentKeymap()[action][0];
  return first ? keycaps(first) : [];
}

/** `shortcutKeys`, kept up to date when the reader changes their shortcuts. */
export function useShortcutKeys(action: ShortcutId): string[] {
  const first = useKeymap()[action][0];
  return first ? keycaps(first) : [];
}

/** `shortcutKeys` for a component that shows several, kept up to date the same way. */
export function useShortcutKeycaps(): (action: ShortcutId) => string[] {
  const keymap = useKeymap();
  return (action) => {
    const first = keymap[action][0];
    return first ? keycaps(first) : [];
  };
}
