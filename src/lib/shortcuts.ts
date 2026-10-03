import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";

/**
 * Every keyboard shortcut the app has: one registry of actions, each with its
 * default keys, and the reader's own keys over them (Settings → Shortcuts).
 *
 * A binding is a string, in one of three kinds:
 *   - a chord, `mod+k`: modifiers and one key, pressed together;
 *   - a key in a context, `escape`, `up`, `shift+enter`: no command modifier,
 *     so it only means something where the action lives (the composer, a
 *     running turn);
 *   - a held modifier, `hold:AltRight`: one side-specific modifier key held on
 *     its own, which acts while it is down and stops when it is released.
 *
 * "mod" is ⌘ on macOS and Ctrl elsewhere. The reader's keys are stored per
 * machine in the preferences (`shortcuts`: action id → bindings; an empty list
 * is an action with no keys). An id this build does not know is left alone.
 */

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export type ShortcutGroup = "App" | "Session" | "Panel" | "Files" | "Composer";

interface ActionDef {
  id: string;
  label: string;
  group: ShortcutGroup;
  /** Default bindings. */
  keys: readonly string[];
  /** Default bindings on macOS, when they differ. */
  macKeys?: readonly string[];
  /**
   * `context`: handled where the action lives, so a key without a command
   * modifier is allowed. Otherwise the action works anywhere in the window and
   * needs a modifier, or it would be typed into the field that has the focus.
   */
  scope?: "context";
  /** May be bound to a held modifier key. */
  hold?: boolean;
  /** A character typed in the composer, not a key that can be moved. */
  fixed?: boolean;
}

const ACTIONS = [
  { id: "app.commandPalette", label: "Command palette", group: "App", keys: ["mod+k"] },
  { id: "app.newSession", label: "New session", group: "App", keys: ["mod+n"] },
  { id: "app.issues", label: "Issues", group: "App", keys: ["mod+i"] },
  { id: "app.agentDashboard", label: "Agent dashboard", group: "App", keys: ["mod+shift+a"] },
  { id: "app.stats", label: "Stats & Usage", group: "App", keys: ["mod+shift+u"] },
  { id: "app.automations", label: "Automations", group: "App", keys: ["mod+shift+r"] },
  { id: "app.skills", label: "Skills", group: "App", keys: ["mod+shift+k"] },
  { id: "app.settings", label: "Settings", group: "App", keys: ["mod+,"] },
  { id: "app.toggleSidebar", label: "Toggle sidebar", group: "App", keys: ["mod+b"] },
  { id: "app.togglePanel", label: "Toggle right panel", group: "App", keys: ["mod+e"] },
  { id: "session.newTab", label: "New tab", group: "Session", keys: ["mod+t"] },
  { id: "session.closeTab", label: "Close tab or file", group: "Session", keys: ["mod+w"] },
  { id: "session.nextTab", label: "Next tab", group: "Session", keys: ["mod+shift+]"] },
  { id: "session.previousTab", label: "Previous tab", group: "Session", keys: ["mod+shift+["] },
  { id: "session.latestShell", label: "Activate latest shell tab", group: "Session", keys: ["mod+j"] },
  { id: "session.toggleTerminalView", label: "Switch the tab between chat and terminal view", group: "Session", keys: ["mod+shift+t"] },
  { id: "session.stop", label: "Stop the running turn", group: "Session", keys: ["escape"], scope: "context" },
  { id: "panel.changes", label: "Changes", group: "Panel", keys: ["mod+alt+1"] },
  { id: "panel.repository", label: "Repository", group: "Panel", keys: ["mod+alt+2"] },
  { id: "panel.pullRequests", label: "Pull requests", group: "Panel", keys: ["mod+alt+3"] },
  { id: "panel.files", label: "Files", group: "Panel", keys: ["mod+alt+4"] },
  { id: "files.quickOpen", label: "Open file by name", group: "Files", keys: ["mod+p"] },
  { id: "files.search", label: "Search in project", group: "Files", keys: ["mod+shift+f"] },
  { id: "files.replace", label: "Replace in project", group: "Files", keys: ["mod+shift+h"] },
  { id: "files.find", label: "Find in the open file", group: "Files", keys: ["mod+f"] },
  { id: "files.save", label: "Save the open file", group: "Files", keys: ["mod+s"] },
  { id: "files.togglePreview", label: "Preview or source for a markdown file", group: "Files", keys: ["mod+shift+p"] },
  { id: "files.closeAll", label: "Close all open files", group: "Files", keys: ["mod+alt+w"] },
  // Right Option is AltGr on many Windows and Linux layouts, so holding it to dictate is a macOS default only.
  { id: "composer.dictate", label: "Start or stop dictation", group: "Composer", keys: ["mod+shift+d"], macKeys: ["hold:AltRight", "mod+shift+d"], hold: true },
  { id: "composer.send", label: "Send", group: "Composer", keys: ["enter"], scope: "context" },
  { id: "composer.newLine", label: "New line", group: "Composer", keys: ["shift+enter"], scope: "context" },
  { id: "composer.historyPrevious", label: "Recall the previous message", group: "Composer", keys: ["up"], scope: "context" },
  { id: "composer.historyNext", label: "Recall the next message, then the draft", group: "Composer", keys: ["down"], scope: "context" },
  { id: "composer.mention", label: "Mention a file", group: "Composer", keys: ["@"], scope: "context", fixed: true },
  { id: "composer.slashCommand", label: "Slash command", group: "Composer", keys: ["/"], scope: "context", fixed: true },
] as const satisfies readonly ActionDef[];

export type ShortcutId = (typeof ACTIONS)[number]["id"];
export interface ShortcutAction extends ActionDef {
  id: ShortcutId;
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ACTIONS;
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ["App", "Session", "Panel", "Files", "Composer"];
const BY_ID = new Map<string, ShortcutAction>(SHORTCUT_ACTIONS.map((action) => [action.id, action]));

export function shortcutAction(id: ShortcutId): ShortcutAction {
  return BY_ID.get(id)!;
}

export function isShortcutId(id: string): id is ShortcutId {
  return BY_ID.has(id);
}

export function defaultBindings(id: ShortcutId, mac = isMac): string[] {
  const action = shortcutAction(id);
  return [...((mac && action.macKeys) || action.keys)];
}

// ---------------------------------------------------------------- bindings

const MODIFIERS = ["mod", "ctrl", "meta", "alt", "shift"] as const;
type Modifier = (typeof MODIFIERS)[number];
const HOLD = "hold:";
/** The modifier keys that can be held on their own, by `KeyboardEvent.code`. */
export const HOLD_CODES = ["AltRight", "AltLeft", "ControlRight", "ControlLeft", "ShiftRight", "ShiftLeft", "MetaRight", "MetaLeft"] as const;
const MODIFIER_KEYS = new Set(["meta", "control", "alt", "shift", "altgraph", "capslock", "fn", "os", "hyper", "super"]);
/** Punctuation by physical key, for when Shift or Option changes the glyph the key reports. */
const CODE_KEYS: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

function normalizeKey(key: string): string {
  const k = key.toLowerCase();
  if (k === " ") return "space";
  if (k === "+") return "plus";
  if (k === "arrowup") return "up";
  if (k === "arrowdown") return "down";
  if (k === "arrowleft") return "left";
  if (k === "arrowright") return "right";
  if (k === "esc") return "escape";
  return k;
}

/** The code of a held-modifier binding, or null for a chord or a key. */
export function holdCode(binding: string): string | null {
  return binding.startsWith(HOLD) ? binding.slice(HOLD.length) : null;
}

export function holdBinding(code: string): string {
  return HOLD + code;
}

function parse(chord: string): { mods: Modifier[]; key: string } {
  const parts = chord.toLowerCase().split("+").map((part) => part.trim());
  const mods = MODIFIERS.filter((mod) => parts.includes(mod));
  const key = parts.filter((part) => !(MODIFIERS as readonly string[]).includes(part)).map(normalizeKey).join("+");
  return { mods, key };
}

/** One spelling per binding: modifiers in a fixed order, then the key. */
export function normalizeBinding(binding: string): string {
  const code = holdCode(binding);
  if (code != null) return HOLD + code;
  const { mods, key } = parse(binding);
  return [...mods, key].filter(Boolean).join("+");
}

export function bindingKind(binding: string): "hold" | "chord" | "key" {
  if (holdCode(binding) != null) return "hold";
  return parse(binding).mods.some((mod) => mod !== "shift") ? "chord" : "key";
}

/** True for a keydown of a modifier key itself, which is not a chord yet. */
export function isModifierKey(e: KeyboardEvent): boolean {
  return MODIFIER_KEYS.has(e.key.toLowerCase());
}

/** The chord a keydown spells: "mod+shift+[", "escape". Empty for a modifier pressed on its own. */
export function chordOf(e: KeyboardEvent, mac = isMac): string {
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (mac ? e.ctrlKey : e.metaKey) parts.push(mac ? "ctrl" : "meta");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (isModifierKey(e)) return "";
  let key = normalizeKey(e.key);
  const code = e.code ?? "";
  // Shift and Option change the glyph a key reports ("{" for "[", "∫" for "b", a dead key for Option+E).
  // Then the physical key is what the reader pressed; a letter or digit that came through is kept, so
  // a keyboard layout's own letters still count.
  if ((e.shiftKey || e.altKey) && (key === "dead" || (key.length === 1 && !/^[a-z0-9]$/.test(key)))) {
    if (CODE_KEYS[code]) key = CODE_KEYS[code];
    else if (code.startsWith("Digit")) key = code.slice(5);
    else if (code.startsWith("Key")) key = code.slice(3).toLowerCase();
  }
  parts.push(key);
  return parts.join("+");
}

function holdCap(code: string, mac: boolean): string {
  const side = code.endsWith("Right") ? "Right" : "Left";
  const base = code.replace(/(Left|Right)$/, "");
  const name = base === "Alt" ? (mac ? "⌥" : "Alt") : base === "Control" ? (mac ? "⌃" : "Ctrl") : base === "Shift" ? (mac ? "⇧" : "Shift") : mac ? "⌘" : "⊞";
  return `${side} ${name}`;
}

/** Keycaps for a binding: ["⌘", "B"] on mac, ["Ctrl", "B"] elsewhere, ["Right ⌥"] for a held key. */
export function keycaps(binding: string, mac = isMac): string[] {
  const code = holdCode(binding);
  if (code != null) return [holdCap(code, mac)];
  return normalizeBinding(binding)
    .split("+")
    .map((p) => {
      switch (p) {
        case "mod":
          return mac ? "⌘" : "Ctrl";
        case "shift":
          return mac ? "⇧" : "Shift";
        case "alt":
          return mac ? "⌥" : "Alt";
        case "ctrl":
          return mac ? "⌃" : "Ctrl";
        case "meta":
          return "⊞";
        case "enter":
          return "⏎";
        case "escape":
          return "Esc";
        case "backspace":
          return "⌫";
        case "plus":
          return "+";
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

/** A binding in a sentence: "⌘⇧D", "Ctrl+Shift+D", "Right ⌥". */
export function bindingText(binding: string, mac = isMac): string {
  return keycaps(binding, mac).join(mac ? "" : "+");
}

// ---------------------------------------------------------------- what a binding may be

/** Control characters the shell reads on Windows and Linux, where Ctrl is also the app's modifier. */
const TERMINAL_KEYS_ELSEWHERE = new Set(["c", "d", "z", "\\", "a", "l", "r", "u", "q"]);

/**
 * Keys a terminal needs: Ctrl with a letter is a control character to the
 * shell (interrupt, end of input, suspend…). On macOS that is every ⌃-letter,
 * because the app's own shortcuts use ⌘. Elsewhere Ctrl is the app's modifier
 * too, so the list is the ones a shell cannot do without.
 */
export function isTerminalReserved(binding: string, mac = isMac): boolean {
  if (holdCode(binding) != null) return false;
  const { mods, key } = parse(binding);
  if (mods.length !== 1 || mods[0] !== (mac ? "ctrl" : "mod")) return false;
  return mac ? /^[a-z[\]\\]$/.test(key) : TERMINAL_KEYS_ELSEWHERE.has(key);
}

/** Copy, paste, cut, select all, undo, redo and quit stay what they are. */
function isEditingKey(binding: string, mac: boolean): boolean {
  const chord = normalizeBinding(binding);
  return ["mod+c", "mod+v", "mod+x", "mod+a", "mod+z", "mod+shift+z", mac ? "mod+q" : "mod+y"].includes(chord);
}

/** Named keys that do something without a modifier (and do not type a character). */
const NAMED_KEYS = new Set(["enter", "escape", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);
const isFunctionKey = (key: string) => /^f\d{1,2}$/.test(key);

/**
 * True when the chord is taken even while a text field has the focus: it
 * carries a command modifier, so it cannot be something being typed. Option
 * on macOS types special characters, so it does not count there.
 */
export function firesWhileTyping(chord: string, mac = isMac): boolean {
  const { mods, key } = parse(chord);
  if (mods.includes("mod") || mods.includes("ctrl") || mods.includes("meta")) return true;
  if (mods.includes("alt") && !mac) return true;
  return key === "escape" || isFunctionKey(key);
}

/** Why `binding` cannot be the keys for `id`, as a sentence for the reader; null when it can. */
export function bindingProblem(id: ShortcutId, binding: string, mac = isMac): string | null {
  const action = shortcutAction(id);
  if (action.fixed) return "This one is a character typed in the composer; it cannot be changed.";
  const code = holdCode(binding);
  if (code != null) {
    if (!(HOLD_CODES as readonly string[]).includes(code)) return "That key cannot be held as a shortcut.";
    return action.hold ? null : "A modifier key on its own only works for dictation. Press it together with another key.";
  }
  const text = bindingText(binding, mac);
  const { mods, key } = parse(binding);
  if (!key || key.includes("+")) return "Press one key, with or without modifiers.";
  if (isTerminalReserved(binding, mac)) return `${text} is a key the terminal needs (Ctrl with a letter goes to the shell), so it cannot be an app shortcut.`;
  if (isEditingKey(binding, mac)) return `${text} is used for editing text (copy, paste, select all, undo) or quitting, so it cannot be an app shortcut.`;
  const command = mods.includes("mod") || mods.includes("ctrl") || mods.includes("meta");
  const plain = !command && !mods.includes("alt");
  if (key === "tab" && plain) return "Tab moves the focus, so it cannot be a shortcut on its own.";
  const named = NAMED_KEYS.has(key) || isFunctionKey(key);
  if (!named && plain) return `${text} types a character, so it cannot be a shortcut on its own. Add ${mac ? "⌘ or ⌃" : "Ctrl or Alt"}.`;
  if (!named && !command && mac) return `${text} types a special character on macOS. Add ⌘ or ⌃.`;
  if (action.scope !== "context" && !firesWhileTyping(binding, mac)) return `This shortcut works everywhere in the app, so it needs ${mac ? "⌘ or ⌃" : "Ctrl or Alt"} (or a function key).`;
  return null;
}

// ---------------------------------------------------------------- the reader's keys

export type Keymap = Record<ShortcutId, string[]>;
export type ShortcutOverrides = Partial<Record<ShortcutId, string[]>>;

/** The overrides worth trusting in what was stored: known actions, lists of strings. */
export function readOverrides(raw: unknown): ShortcutOverrides {
  const out: ShortcutOverrides = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!isShortcutId(id) || shortcutAction(id).fixed || !Array.isArray(value)) continue;
    const bindings = value.filter((binding): binding is string => typeof binding === "string" && !!binding.trim()).map(normalizeBinding);
    out[id] = [...new Set(bindings)];
  }
  return out;
}

/**
 * The keys in force: the reader's where they set them, the defaults elsewhere.
 * No binding ever belongs to two actions. The reader's choice wins over a
 * default (a later version can add a default that someone already uses for
 * something else), and between two stored overrides the first action keeps it.
 */
export function resolveKeymap(raw: unknown, mac = isMac): Keymap {
  const overrides = readOverrides(raw);
  const keymap = {} as Keymap;
  const taken = new Set<string>();
  const claim = (bindings: string[]) =>
    bindings.filter((binding) => {
      if (taken.has(binding)) return false;
      taken.add(binding);
      return true;
    });
  for (const action of SHORTCUT_ACTIONS) if (action.fixed) keymap[action.id] = claim(defaultBindings(action.id, mac));
  for (const action of SHORTCUT_ACTIONS) if (overrides[action.id]) keymap[action.id] = claim(overrides[action.id]!);
  for (const action of SHORTCUT_ACTIONS) if (!keymap[action.id]) keymap[action.id] = claim(defaultBindings(action.id, mac).map(normalizeBinding));
  return keymap;
}

let cached: { raw: unknown; keymap: Keymap } | null = null;

/** The keys in force now. Read on every keydown, so it is kept until the preference changes. */
export function currentKeymap(): Keymap {
  const raw = getPrefs().shortcuts;
  if (!cached || cached.raw !== raw) cached = { raw, keymap: resolveKeymap(raw) };
  return cached.keymap;
}

/** The keymap, re-read when the preference changes (in this window or another). */
export function useKeymap(): Keymap {
  const raw = usePrefs().shortcuts;
  if (!cached || cached.raw !== raw) cached = { raw, keymap: resolveKeymap(raw) };
  return cached.keymap;
}

export function bindingsOf(id: ShortcutId): string[] {
  return currentKeymap()[id];
}

/** The other action that has `binding`, if any. */
export function conflictOf(binding: string, id: ShortcutId, keymap: Keymap = currentKeymap()): ShortcutAction | null {
  const wanted = normalizeBinding(binding);
  return SHORTCUT_ACTIONS.find((action) => action.id !== id && keymap[action.id].includes(wanted)) ?? null;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((binding, i) => binding === b[i]);

/** True when the action's keys are not its defaults. */
export function isCustomized(id: ShortcutId, keymap: Keymap = currentKeymap(), mac = isMac): boolean {
  return !sameList(keymap[id], defaultBindings(id, mac).map(normalizeBinding));
}

export type SaveResult = { ok: true } | { ok: false; problem: string } | { ok: false; conflict: ShortcutAction; binding: string };

function stored(): Record<string, unknown> {
  const raw = getPrefs().shortcuts as unknown;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

function write(id: ShortcutId, bindings: string[], replace: boolean, mac: boolean): SaveResult {
  const keymap = resolveKeymap(getPrefs().shortcuts, mac);
  const next = stored();
  for (const binding of bindings) {
    const owner = conflictOf(binding, id, keymap);
    if (!owner) continue;
    if (!replace) return { ok: false, conflict: owner, binding };
    keymap[owner.id] = keymap[owner.id].filter((other) => other !== binding);
    next[owner.id] = keymap[owner.id];
  }
  // Defaults are not stored, so a later version's defaults reach whoever never changed them.
  if (sameList(bindings, defaultBindings(id, mac).map(normalizeBinding))) delete next[id];
  else next[id] = bindings;
  setPrefs({ shortcuts: next as Record<string, string[]> });
  return { ok: true };
}

/**
 * Give an action these keys (none unbinds it). Refused with the reason when a
 * binding is not allowed, and with the owner when another action has it: pass
 * `replace` to take it from that action.
 */
export function saveShortcut(id: ShortcutId, bindings: string[], opts: { replace?: boolean; mac?: boolean } = {}): SaveResult {
  const mac = opts.mac ?? isMac;
  const wanted = [...new Set(bindings.map(normalizeBinding))];
  for (const binding of wanted) {
    const problem = bindingProblem(id, binding, mac);
    if (problem) return { ok: false, problem };
  }
  return write(id, wanted, !!opts.replace, mac);
}

/** Put an action back on its default keys; a default another action now uses is a conflict like any other. */
export function resetShortcut(id: ShortcutId, opts: { replace?: boolean; mac?: boolean } = {}): SaveResult {
  const mac = opts.mac ?? isMac;
  return write(id, defaultBindings(id, mac).map(normalizeBinding), !!opts.replace, mac);
}

export function resetAllShortcuts() {
  setPrefs({ shortcuts: {} });
}

// ---------------------------------------------------------------- matching a key event

let forced: { event: Event; id: ShortcutId } | null = null;

/** True when this keydown is the keys for `id` (a chord or a key; a held modifier is the binder's). */
export function matchesShortcut(e: KeyboardEvent, id: ShortcutId): boolean {
  if (forced?.event === e) return forced.id === id;
  const chord = chordOf(e);
  return !!chord && currentKeymap()[id].includes(chord);
}

/**
 * Run an action that is handled where the focus is (the composer's keys), by
 * sending that element a keydown which matches the action whatever its keys
 * are, even none. Used by the command palette.
 */
export function sendShortcut(id: ShortcutId, target: EventTarget): void {
  const event = new KeyboardEvent("keydown", { key: "Unidentified", bubbles: true, cancelable: true });
  forced = { event, id };
  try {
    target.dispatchEvent(event);
  } finally {
    forced = null;
  }
}
