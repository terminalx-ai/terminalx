import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "./prefs";
import {
  SHORTCUT_ACTIONS,
  bindingKind,
  bindingProblem,
  bindingsOf,
  chordOf,
  conflictOf,
  currentKeymap,
  defaultBindings,
  isCustomized,
  isTerminalReserved,
  keycaps,
  matchesShortcut,
  readOverrides,
  resetAllShortcuts,
  resetShortcut,
  resolveKeymap,
  saveShortcut,
  sendShortcut,
} from "./shortcuts";

// jsdom is not a Mac, so `mod` is Ctrl here unless a test says otherwise.
const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

beforeEach(() => {
  localStorage.clear();
  setPrefs({ shortcuts: {} });
});

describe("the shortcut registry", () => {
  it("lists every action once, each default binding owned by one action", () => {
    const ids = SHORTCUT_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mac of [true, false]) {
      const all = SHORTCUT_ACTIONS.flatMap((action) => defaultBindings(action.id, mac));
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it("covers the three kinds of binding", () => {
    expect(bindingKind("mod+k")).toBe("chord");
    expect(bindingKind("escape")).toBe("key");
    expect(bindingKind("shift+enter")).toBe("key");
    expect(bindingKind("hold:AltRight")).toBe("hold");
  });

  it("dictates on a held Right Option by default on macOS, with ⌘⇧D kept as a second binding", () => {
    expect(defaultBindings("composer.dictate", true)).toEqual(["hold:AltRight", "mod+shift+d"]);
    expect(resolveKeymap({}, true)["composer.dictate"]).toEqual(["hold:AltRight", "mod+shift+d"]);
  });

  it("keeps Ctrl+Shift+D as the only dictation default off macOS, where Right Alt is AltGr", () => {
    expect(defaultBindings("composer.dictate", false)).toEqual(["mod+shift+d"]);
    expect(resolveKeymap({}, false)["composer.dictate"]).toEqual(["mod+shift+d"]);
    expect(SHORTCUT_ACTIONS.flatMap((action) => defaultBindings(action.id, false)).some((binding) => binding.startsWith("hold:"))).toBe(false);
  });

  it("leaves every other default as it was", () => {
    const keymap = resolveKeymap({}, true);
    expect(keymap["app.commandPalette"]).toEqual(["mod+k"]);
    expect(keymap["session.stop"]).toEqual(["escape"]);
    expect(keymap["session.previousTab"]).toEqual(["mod+shift+["]);
    expect(keymap["composer.send"]).toEqual(["enter"]);
    expect(keymap["composer.newLine"]).toEqual(["shift+enter"]);
    expect(keymap["composer.historyPrevious"]).toEqual(["up"]);
  });

  it("shows a binding as keycaps for the platform", () => {
    expect(keycaps("mod+shift+d", true)).toEqual(["⌘", "⇧", "D"]);
    expect(keycaps("mod+shift+d", false)).toEqual(["Ctrl", "Shift", "D"]);
    expect(keycaps("hold:AltRight", true)).toEqual(["Right ⌥"]);
    expect(keycaps("hold:AltRight", false)).toEqual(["Right Alt"]);
    expect(keycaps("escape", true)).toEqual(["Esc"]);
  });

  it("reads a chord from a key event, by the physical key where Shift or Option changes the glyph", () => {
    expect(chordOf(key({ key: "k", code: "KeyK", metaKey: true }), true)).toBe("mod+k");
    expect(chordOf(key({ key: "k", code: "KeyK", ctrlKey: true }), false)).toBe("mod+k");
    expect(chordOf(key({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }), true)).toBe("mod+shift+[");
    expect(chordOf(key({ key: "¡", code: "Digit1", metaKey: true, altKey: true }), true)).toBe("mod+alt+1");
    expect(chordOf(key({ key: "∫", code: "KeyB", metaKey: true, altKey: true }), true)).toBe("mod+alt+b");
    expect(chordOf(key({ key: "c", code: "KeyC", ctrlKey: true }), true)).toBe("ctrl+c");
    expect(chordOf(key({ key: "Dead", code: "KeyE", altKey: true }), true)).toBe("alt+e");
    expect(chordOf(key({ key: "!", code: "Digit1", metaKey: true, shiftKey: true }), true)).toBe("mod+shift+1");
    // A letter that came through is the layout's own: Dvorak's W sits on the comma key.
    expect(chordOf(key({ key: "w", code: "Comma", metaKey: true, altKey: true }), true)).toBe("mod+alt+w");
    expect(chordOf(key({ key: "D", code: "KeyH", metaKey: true, shiftKey: true }), true)).toBe("mod+shift+d");
    expect(chordOf(key({ key: "ArrowUp" }), true)).toBe("up");
    // A modifier on its own is not a chord.
    expect(chordOf(key({ key: "Alt", code: "AltRight", altKey: true }), true)).toBe("");
  });
});

describe("the mapping store", () => {
  it("saves a custom chord in the preferences and resolves it at once", () => {
    expect(saveShortcut("app.toggleSidebar", ["mod+shift+b"])).toEqual({ ok: true });
    expect(getPrefs().shortcuts).toEqual({ "app.toggleSidebar": ["mod+shift+b"] });
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+shift+b"]);
    expect(isCustomized("app.toggleSidebar")).toBe(true);
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).shortcuts).toEqual({ "app.toggleSidebar": ["mod+shift+b"] });
  });

  it("unbinds an action with an empty list", () => {
    expect(saveShortcut("app.issues", [])).toEqual({ ok: true });
    expect(bindingsOf("app.issues")).toEqual([]);
    expect(conflictOf("mod+i", "app.newSession")).toBeNull();
  });

  it("resets one action, and all of them", () => {
    saveShortcut("app.toggleSidebar", ["mod+shift+b"]);
    saveShortcut("app.issues", []);
    expect(resetShortcut("app.toggleSidebar")).toEqual({ ok: true });
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+b"]);
    // A default is not stored, so a later version's default reaches this action.
    expect(getPrefs().shortcuts).toEqual({ "app.issues": [] });
    resetAllShortcuts();
    expect(getPrefs().shortcuts).toEqual({});
    expect(bindingsOf("app.issues")).toEqual(["mod+i"]);
  });

  it("refuses keys another action has, naming it, and changes nothing", () => {
    const result = saveShortcut("app.toggleSidebar", ["mod+k"]);
    expect(result).toMatchObject({ ok: false, binding: "mod+k", conflict: { id: "app.commandPalette", label: "Command palette" } });
    expect(getPrefs().shortcuts).toEqual({});
    expect(conflictOf("mod+k", "app.toggleSidebar")?.id).toBe("app.commandPalette");
    expect(conflictOf("mod+k", "app.commandPalette")).toBeNull();
  });

  it("replaces on request: the keys move, and no binding belongs to two actions", () => {
    expect(saveShortcut("app.toggleSidebar", ["mod+k"], { replace: true })).toEqual({ ok: true });
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+k"]);
    expect(bindingsOf("app.commandPalette")).toEqual([]);
    const all = Object.values(currentKeymap()).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("asks before a reset takes back a default another action uses now", () => {
    saveShortcut("app.toggleSidebar", ["mod+shift+b"]);
    saveShortcut("app.issues", ["mod+b"]);
    expect(resetShortcut("app.toggleSidebar")).toMatchObject({ ok: false, binding: "mod+b", conflict: { id: "app.issues" } });
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+shift+b"]);
    expect(resetShortcut("app.toggleSidebar", { replace: true })).toEqual({ ok: true });
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+b"]);
    expect(bindingsOf("app.issues")).toEqual([]);
  });

  it("ignores an action id it does not know, and leaves it stored", () => {
    setPrefs({ shortcuts: { "app.fromALaterVersion": ["mod+k"], "app.issues": ["mod+shift+i"] } });
    expect(readOverrides(getPrefs().shortcuts)).toEqual({ "app.issues": ["mod+shift+i"] });
    // The unknown id's keys take nothing from the action that has them.
    expect(bindingsOf("app.commandPalette")).toEqual(["mod+k"]);
    expect(bindingsOf("app.issues")).toEqual(["mod+shift+i"]);
    saveShortcut("app.toggleSidebar", ["mod+shift+b"]);
    expect(getPrefs().shortcuts["app.fromALaterVersion"]).toEqual(["mod+k"]);
  });

  it("survives anything stored in its place", () => {
    for (const stored of [null, "mod+k", 7, ["mod+k"], { "app.issues": "mod+i" }, { "app.issues": [7, null, ""] }]) {
      setPrefs({ shortcuts: stored as never });
      expect(bindingsOf("app.commandPalette")).toEqual(["mod+k"]);
    }
    setPrefs({ shortcuts: { "app.issues": [7, "MOD + Shift + I", "mod+shift+i"] } as never });
    expect(bindingsOf("app.issues")).toEqual(["mod+shift+i"]);
    // The typed characters are not shortcuts that can be moved.
    setPrefs({ shortcuts: { "composer.mention": ["mod+m"] } });
    expect(bindingsOf("composer.mention")).toEqual(["@"]);
  });

  it("never gives one binding to two actions, whatever is stored", () => {
    // Two stored overrides with the same keys: the first action keeps them.
    expect(resolveKeymap({ "app.newSession": ["mod+shift+y"], "app.issues": ["mod+shift+y"] }, true)).toMatchObject({ "app.newSession": ["mod+shift+y"], "app.issues": [] });
    // The reader's keys win over a default that uses them.
    expect(resolveKeymap({ "app.issues": ["mod+k"] }, true)).toMatchObject({ "app.issues": ["mod+k"], "app.commandPalette": [] });
  });

  it("takes a change made in another window at once", async () => {
    vi.resetModules();
    const prefs = await import("./prefs");
    const shortcuts = await import("./shortcuts");
    expect(shortcuts.bindingsOf("app.toggleSidebar")).toEqual(["mod+b"]);
    localStorage.setItem("raccoon.prefs", JSON.stringify({ shortcuts: { "app.toggleSidebar": ["mod+shift+b"] } }));
    window.dispatchEvent(new StorageEvent("storage", { key: "raccoon.prefs", storageArea: localStorage }));
    expect(prefs.getPrefs().shortcuts).toEqual({ "app.toggleSidebar": ["mod+shift+b"] });
    expect(shortcuts.bindingsOf("app.toggleSidebar")).toEqual(["mod+shift+b"]);
  });
});

describe("keys that cannot be a shortcut", () => {
  it("refuses the keys a terminal needs, with the reason", () => {
    for (const chord of ["ctrl+c", "ctrl+d", "ctrl+z", "ctrl+\\", "ctrl+a", "ctrl+w"]) {
      expect(isTerminalReserved(chord, true)).toBe(true);
      expect(bindingProblem("app.toggleSidebar", chord, true)).toMatch(/terminal needs/);
    }
    // Off macOS Ctrl is `mod`: the shell's own keys are refused, the app's defaults are not.
    for (const chord of ["mod+c", "mod+d", "mod+z", "mod+\\"]) {
      expect(isTerminalReserved(chord, false)).toBe(true);
      expect(bindingProblem("app.toggleSidebar", chord, false)).toMatch(/terminal needs/);
    }
    expect(isTerminalReserved("mod+b", false)).toBe(false);
    expect(isTerminalReserved("mod+c", true)).toBe(false);
    expect(isTerminalReserved("ctrl+shift+c", true)).toBe(false);

    const result = saveShortcut("app.toggleSidebar", ["ctrl+c"], { mac: true });
    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining("⌃C is a key the terminal needs") });
    expect(getPrefs().shortcuts).toEqual({});
  });

  it("refuses copy, paste, undo and the like", () => {
    expect(bindingProblem("app.toggleSidebar", "mod+c", true)).toMatch(/editing text/);
    expect(bindingProblem("app.toggleSidebar", "mod+v", true)).toMatch(/editing text/);
  });

  it("refuses a key that types a character, and Option combinations on macOS", () => {
    expect(bindingProblem("app.toggleSidebar", "b", true)).toMatch(/types a character/);
    expect(bindingProblem("composer.send", "shift+a", true)).toMatch(/types a character/);
    expect(bindingProblem("app.toggleSidebar", "alt+b", true)).toMatch(/special character/);
    expect(bindingProblem("app.toggleSidebar", "alt+b", false)).toBeNull();
    expect(bindingProblem("app.toggleSidebar", "mod+alt+b", true)).toBeNull();
  });

  it("needs a modifier for a shortcut that works everywhere, but not for a key in its context", () => {
    expect(bindingProblem("app.toggleSidebar", "enter", true)).toMatch(/works everywhere/);
    expect(bindingProblem("app.toggleSidebar", "f5", true)).toBeNull();
    expect(bindingProblem("composer.send", "mod+enter", true)).toBeNull();
    expect(bindingProblem("composer.historyPrevious", "pageup", true)).toBeNull();
    expect(bindingProblem("session.stop", "escape", true)).toBeNull();
  });

  it("lets only dictation be a held modifier key, on either side", () => {
    expect(bindingProblem("composer.dictate", "hold:AltRight", true)).toBeNull();
    expect(bindingProblem("composer.dictate", "hold:ControlRight", false)).toBeNull();
    expect(bindingProblem("composer.dictate", "hold:KeyA", true)).toMatch(/cannot be held/);
    expect(bindingProblem("app.toggleSidebar", "hold:AltRight", true)).toMatch(/only works for dictation/);
  });

  it("does not let the typed characters be changed", () => {
    expect(bindingProblem("composer.mention", "mod+m", true)).toMatch(/cannot be changed/);
  });
});

describe("matching a key event to an action", () => {
  it("follows the reader's keys", () => {
    const enter = key({ key: "Enter" });
    const modEnter = key({ key: "Enter", ctrlKey: true });
    expect(matchesShortcut(enter, "composer.send")).toBe(true);
    expect(matchesShortcut(key({ key: "Enter", shiftKey: true }), "composer.send")).toBe(false);
    expect(matchesShortcut(key({ key: "Enter", shiftKey: true }), "composer.newLine")).toBe(true);
    saveShortcut("composer.send", ["mod+enter"]);
    expect(matchesShortcut(enter, "composer.send")).toBe(false);
    expect(matchesShortcut(modEnter, "composer.send")).toBe(true);
  });

  it("can send an action to an element whatever its keys are, even none", () => {
    saveShortcut("composer.send", []);
    const seen: boolean[] = [];
    const target = document.createElement("textarea");
    target.addEventListener("keydown", (e) => seen.push(matchesShortcut(e, "composer.send"), matchesShortcut(e, "composer.newLine")));
    sendShortcut("composer.send", target);
    expect(seen).toEqual([true, false]);
  });
});
