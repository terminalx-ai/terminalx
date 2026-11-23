import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "./prefs";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUPS,
  ariaKeyShortcut,
  bindingKind,
  bindingProblem,
  bindingsOf,
  chordOf,
  conflictOf,
  currentKeymap,
  defaultBindings,
  isCustomized,
  isTerminalReserved,
  bindingText,
  keycaps,
  matchesShortcut,
  readOverrides,
  resetAllShortcuts,
  resetShortcut,
  resolveKeymap,
  saveShortcut,
  sendShortcut,
  shortcutAction,
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
    // A key may be on two actions only when they are on different surfaces of the window (↑ in the composer and in the review).
    for (const mac of [true, false]) {
      const owners = new Map<string, string[]>();
      for (const action of SHORTCUT_ACTIONS) for (const binding of defaultBindings(action.id, mac)) owners.set(binding, [...(owners.get(binding) ?? []), action.id]);
      for (const [binding, ids] of owners) {
        const surfaces = ids.map((id) => SHORTCUT_ACTIONS.find((action) => action.id === id)!.surface);
        if (ids.length > 1) expect(surfaces.every(Boolean) && new Set(surfaces).size === ids.length, `${binding}: ${ids.join(", ")}`).toBe(true);
      }
    }
  });

  // PRO-362: the drafts drew ⇧⌘R for the Run view, which Automations has. Its own keys are free on every platform,
  // and are none of the menu keys the system itself puts in the native menus (Edit, Hide, Minimize, Quit).
  it("gives the Run view keys no other action has, in the Go menu, and leaves Automations its own", () => {
    const action = SHORTCUT_ACTIONS.find((entry) => entry.id === "app.runView")!;
    expect(action).toMatchObject({ label: "Run view", group: "App", menu: { section: "go", label: "Run View" } });
    const system = ["mod+z", "mod+shift+z", "mod+x", "mod+c", "mod+v", "mod+a", "mod+q", "mod+h", "mod+alt+h", "mod+m", "alt+shift+space"];
    for (const mac of [true, false]) {
      const keymap = resolveKeymap({}, mac);
      expect(keymap["app.runView"]).toEqual(["mod+shift+o"]);
      expect(keymap["app.automations"]).toEqual(["mod+shift+r"]);
      const owners = SHORTCUT_ACTIONS.filter((entry) => keymap[entry.id].includes("mod+shift+o")).map((entry) => entry.id);
      expect(owners).toEqual(["app.runView"]);
      expect(system).not.toContain("mod+shift+o");
      expect(bindingProblem("app.runView", "mod+shift+o", mac)).toBeNull();
      expect(isTerminalReserved("mod+shift+o", mac)).toBe(false);
    }
    expect(keycaps("mod+shift+o", true)).toEqual(["⇧", "⌘", "O"]);
    expect(keycaps("mod+shift+o", false)).toEqual(["Ctrl", "Shift", "O"]);
  });

  // PRO-363: ⌘R runs the project's action. Off macOS Ctrl+R is the shell's history search, which a terminal keeps,
  // so the default there adds Alt; neither is another action's, a terminal's or an editing key.
  it("runs the project's action on ⌘R on macOS and Ctrl+Alt+R elsewhere, keys no other action or terminal has", () => {
    expect(SHORTCUT_ACTIONS.find((entry) => entry.id === "session.runAction")).toMatchObject({ label: "Run the project's action", group: "Session" });
    for (const [mac, chord] of [[true, "mod+r"], [false, "mod+alt+r"]] as const) {
      const keymap = resolveKeymap({}, mac);
      expect(keymap["session.runAction"]).toEqual([chord]);
      expect(SHORTCUT_ACTIONS.filter((entry) => keymap[entry.id].includes(chord)).map((entry) => entry.id)).toEqual(["session.runAction"]);
      expect(bindingProblem("session.runAction", chord, mac)).toBeNull();
      expect(isTerminalReserved(chord, mac)).toBe(false);
    }
    expect(isTerminalReserved("mod+r", false)).toBe(true);
    expect(keycaps("mod+r", true)).toEqual(["⌘", "R"]);
  });

  it("gives Home a default on both platforms while respecting custom or disabled bindings", () => {
    for (const mac of [true, false]) {
      expect(resolveKeymap({}, mac)["app.home"]).toEqual(["mod+alt+0"]);
      expect(bindingProblem("app.home", "mod+alt+0", mac)).toBeNull();
      expect(isTerminalReserved("mod+alt+0", mac)).toBe(false);
      expect(resolveKeymap({ "app.home": [] }, mac)["app.home"]).toEqual([]);
      expect(resolveKeymap({ "app.home": ["mod+alt+g"] }, mac)["app.home"]).toEqual(["mod+alt+g"]);
    }
  });

  it("gives the session menu's rows actions of their own, with no keys taken from another action", () => {
    for (const mac of [true, false]) {
      const keymap = resolveKeymap({}, mac);
      for (const id of ["session.linkIssue", "session.copyLink", "session.archive"] as const) expect(keymap[id], id).toEqual([]);
      expect(keymap["session.toggleTerminalView"]).toEqual(["mod+shift+t"]);
      const owner = (chord: string) => SHORTCUT_ACTIONS.filter((entry) => keymap[entry.id].includes(chord)).map((entry) => entry.id);
      expect(owner("mod+i")).toEqual(["app.issues"]);
      expect(owner("mod+shift+c")).toEqual(["git.createPr"]);
    }
    expect(SHORTCUT_ACTIONS.find((entry) => entry.id === "session.linkIssue")).toMatchObject({ group: "Session", label: "Link an issue to the session" });
    expect(SHORTCUT_ACTIONS.find((entry) => entry.id === "session.copyLink")).toMatchObject({ group: "Session", label: "Copy a link to the session" });
  });

  // #1131: the design's theme chord belongs to reopen on macOS.
  it.each([true, false])("keeps light/dark and reopen distinct, including Option-modified key events (mac=%s)", (mac) => {
    const keymap = resolveKeymap({}, mac);
    const toggle = "mod+alt+shift+l";
    const reopen = mac ? "mod+alt+t" : "mod+alt+shift+t";
    expect(keymap["app.toggleMode"]).toEqual([toggle]);
    expect(keymap["session.reopenTab"]).toEqual([reopen]);
    const modifiers = mac ? { metaKey: true } : { ctrlKey: true };
    for (const [event, owner] of [
      [key({ ...modifiers, altKey: true, shiftKey: true, key: "Ò", code: "KeyL" }), "app.toggleMode"],
      [key({ ...modifiers, altKey: true, shiftKey: !mac, key: "†", code: "KeyT" }), "session.reopenTab"],
    ] as const) {
      const chord = chordOf(event, mac);
      expect(SHORTCUT_ACTIONS.filter((action) => keymap[action.id].includes(chord)).map((action) => action.id)).toEqual([owner]);
      expect(bindingProblem(owner, chord, mac)).toBeNull();
    }
    expect(keycaps(toggle, mac)).toEqual(mac ? ["⌥", "⇧", "⌘", "L"] : ["Ctrl", "Alt", "Shift", "L"]);
    expect(keycaps(reopen, mac)).toEqual(mac ? ["⌥", "⌘", "T"] : ["Ctrl", "Alt", "Shift", "T"]);
  });

  it("requires an explicit replacement to give the macOS reopen chord to light/dark", () => {
    expect(saveShortcut("app.toggleMode", ["mod+alt+t"], { mac: true })).toMatchObject({
      ok: false, conflict: { id: "session.reopenTab" },
    });
    expect(getPrefs().shortcuts).toEqual({});
  });

  it("covers the three kinds of binding", () => {
    expect(bindingKind("mod+k")).toBe("chord");
    expect(bindingKind("escape")).toBe("key");
    expect(bindingKind("shift+enter")).toBe("key");
    expect(bindingKind("hold:AltRight")).toBe("hold");
  });

  it("dictates on a held Right Option by default on macOS, with ⇧⌘D kept as a second binding", () => {
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
    expect(keymap["session.previousTab"]).toEqual(["mod+shift+["]);
    expect(keymap["composer.send"]).toEqual(["enter"]);
    expect(keymap["composer.newLine"]).toEqual(["shift+enter"]);
    expect(keymap["composer.historyPrevious"]).toEqual(["up"]);
  });

  // #427: Escape is the agent's key. It interrupts; ending the process is a separate action with no keys.
  it("puts Escape on the interrupt, and gives the hard stop no keys of its own", () => {
    for (const mac of [true, false]) {
      const keymap = resolveKeymap({}, mac);
      expect(keymap["session.interrupt"]).toEqual(["escape"]);
      expect(keymap["session.stop"]).toEqual([]);
    }
  });

  it("shows a binding as keycaps for the platform", () => {
    // macOS writes modifiers ⌃⌥⇧⌘ (PRO-400), whatever order the binding is stored in; elsewhere it is Ctrl+Alt+Shift.
    expect(keycaps("mod+shift+d", true)).toEqual(["⇧", "⌘", "D"]);
    expect(keycaps("mod+ctrl+alt+shift+k", true)).toEqual(["⌃", "⌥", "⇧", "⌘", "K"]);
    expect(bindingText("mod+shift+d", true)).toBe("⇧⌘D");
    expect(bindingText("mod+shift+d", false)).toBe("Ctrl+Shift+D");
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
  it("keeps a saved Send binding when the alternate action introduces the same default", () => {
    for (const mac of [true, false]) {
      const keymap = resolveKeymap({ "composer.send": ["mod+enter"] }, mac);
      expect(keymap["composer.send"]).toEqual(["mod+enter"]);
      expect(keymap["composer.sendAlternate"]).toEqual([]);
      expect(conflictOf("mod+enter", "composer.sendAlternate", keymap)?.id).toBe("composer.send");
    }
  });

  it("detects alternate Send conflicts and saves a replacement binding", () => {
    expect(saveShortcut("composer.send", ["mod+enter"])).toMatchObject({ ok: false, conflict: { id: "composer.sendAlternate" } });
    expect(saveShortcut("composer.sendAlternate", ["mod+shift+enter"])).toEqual({ ok: true });
    expect(bindingsOf("composer.sendAlternate")).toEqual(["mod+shift+enter"]);
    expect(saveShortcut("composer.send", ["mod+enter"])).toEqual({ ok: true });
  });

  it("saves a custom chord in the preferences and resolves it at once", () => {
    expect(saveShortcut("app.toggleSidebar", ["mod+alt+b"])).toEqual({ ok: true });
    expect(getPrefs().shortcuts).toEqual({ "app.toggleSidebar": ["mod+alt+b"] });
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+alt+b"]);
    expect(isCustomized("app.toggleSidebar")).toBe(true);
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).shortcuts).toEqual({ "app.toggleSidebar": ["mod+alt+b"] });
  });

  it("unbinds an action with an empty list", () => {
    expect(saveShortcut("app.issues", [])).toEqual({ ok: true });
    expect(bindingsOf("app.issues")).toEqual([]);
    expect(conflictOf("mod+i", "app.newSession")).toBeNull();
  });

  it("resets one action, and all of them", () => {
    saveShortcut("app.toggleSidebar", ["mod+alt+b"]);
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
    // ↑ and ↓ are the composer's and the review's; every other key has one owner.
    const all = Object.entries(currentKeymap()).filter(([id]) => !shortcutAction(id as never).surface).flatMap(([, bindings]) => bindings);
    expect(new Set(all).size).toBe(all.length);
  });

  it("asks before a reset takes back a default another action uses now", () => {
    saveShortcut("app.toggleSidebar", ["mod+alt+b"]);
    saveShortcut("app.issues", ["mod+b"]);
    expect(resetShortcut("app.toggleSidebar")).toMatchObject({ ok: false, binding: "mod+b", conflict: { id: "app.issues" } });
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+alt+b"]);
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
    expect(bindingProblem("session.interrupt", "escape", true)).toBeNull();
    expect(bindingProblem("session.interrupt", "shift+escape", true)).toBeNull();
  });

  it("never lets a bare key, Escape least of all, end the agent's process", () => {
    expect(bindingProblem("session.stop", "escape", true)).toMatch(/goes to the agent/);
    expect(bindingProblem("session.stop", "escape", false)).toMatch(/goes to the agent/);
    expect(bindingProblem("session.stop", "enter", true)).toMatch(/works everywhere/);
    expect(saveShortcut("session.stop", ["escape"], { replace: true })).toMatchObject({ ok: false });
    expect(bindingsOf("session.interrupt")).toEqual(["escape"]);
    // With a modifier it is a deliberate chord, and it is the reader's to set.
    expect(bindingProblem("session.stop", "mod+.", true)).toBeNull();
    expect(bindingProblem("session.stop", "mod+shift+escape", true)).toBeNull();
    expect(saveShortcut("session.stop", ["mod+."])).toEqual({ ok: true });
    expect(bindingsOf("session.stop")).toEqual(["mod+."]);
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
    expect(saveShortcut("composer.send", ["mod+enter"], { replace: true })).toEqual({ ok: true });
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


describe("Overview navigation defaults", () => {
  it.each([true, false])("reserves mod+1 for Overview and preserves explicit choices (mac=%s)", (mac) => {
    const defaults = resolveKeymap({}, mac);
    expect(defaults["app.agentDashboard"]).toEqual(["mod+1"]);
    expect(defaults["session.tab1"]).toEqual(["mod+shift+1"]);
    expect(conflictOf("mod+1", "session.tab1", defaults)?.id).toBe("app.agentDashboard");
    expect(ariaKeyShortcut("mod+1", mac)).toBe(mac ? "Meta+1" : "Control+1");
    expect(resolveKeymap({ "session.tab1": ["mod+1"] }, mac)["app.agentDashboard"]).toEqual([]);
    const custom = resolveKeymap({ "app.agentDashboard": ["mod+shift+a"], "session.tab1": ["mod+1"] }, mac);
    expect(custom["app.agentDashboard"]).toEqual(["mod+shift+a"]);
    expect(custom["session.tab1"]).toEqual(["mod+1"]);
    expect(resolveKeymap({ "app.agentDashboard": [] }, mac)["app.agentDashboard"]).toEqual([]);
  });
});

// PRO-208, 216, 232, 236, 242, 247: the actions the batch's screens draw. The later pieces bind handlers by these ids.
describe("the Phase 3 batch's shortcut actions", () => {
  const ids = [
    "composer.openModelPicker", "composer.cycleEffort", "composer.togglePlanMode", "composer.toggleFast",
    "chat.expandAllToolCalls", "session.copyConciseTranscript",
    "review.previousFile", "review.nextFile", "review.previousComment", "review.nextComment", "review.toggleViewed", "review.start",
    "git.showUncommitted", "files.openInDefault", "files.openInMenu",
  ] as const;

  it("lists every one, in a group the Shortcuts tab shows", () => {
    for (const id of ids) {
      const action = SHORTCUT_ACTIONS.find((candidate) => candidate.id === id);
      expect(action, id).toBeDefined();
      expect(SHORTCUT_GROUPS).toContain(action!.group);
      expect(action!.label.trim()).not.toBe("");
    }
    expect(SHORTCUT_GROUPS).toEqual(["App", "Session", "Panel", "Files", "Review", "Issues", "Composer"]);
    expect(SHORTCUT_ACTIONS.filter((action) => action.group === "Review").map((action) => action.id)).toEqual([
      "review.previousFile", "review.nextFile", "review.previousComment", "review.nextComment", "review.toggleViewed", "review.start",
    ]);
  });

  it("keeps the screens' keys on macOS", () => {
    const keymap = resolveKeymap({}, true);
    expect(keymap["composer.openModelPicker"]).toEqual(["mod+/"]);
    expect(keymap["composer.cycleEffort"]).toEqual(["mod+shift+/"]);
    expect(keymap["composer.togglePlanMode"]).toEqual(["shift+tab"]);
    expect(keymap["composer.toggleFast"]).toEqual(["mod+shift+e"]);
    expect(keymap["review.previousFile"]).toEqual(["up"]);
    expect(keymap["review.nextFile"]).toEqual(["down"]);
    expect(keymap["review.previousComment"]).toEqual(["mod+alt+k"]);
    expect(keymap["review.nextComment"]).toEqual(["mod+alt+j"]);
    expect(keymap["review.toggleViewed"]).toEqual(["ctrl+v"]);
    expect(keymap["review.start"]).toEqual(["mod+alt+r"]);
    expect(keymap["git.showUncommitted"]).toEqual(["mod+alt+u"]);
    expect(keymap["session.forkTab"]).toEqual(["mod+alt+enter"]);
    expect(shortcutAction("session.forkTab").label).toBe("Fork to new tab");
  });

  it("gives ⌃V and ⌥⌘R to the review on macOS only, where Ctrl+V pastes and Ctrl+Alt+R runs the project's action", () => {
    const keymap = resolveKeymap({}, false);
    expect(keymap["review.toggleViewed"]).toEqual([]);
    expect(keymap["review.start"]).toEqual([]);
    expect(keymap["session.runAction"]).toEqual(["mod+alt+r"]);
    expect(resolveKeymap({}, true)["session.runAction"]).toEqual(["mod+r"]);
    // Paste stays paste: no default of any action is ⌘V or Ctrl+V.
    for (const mac of [true, false]) expect(Object.values(resolveKeymap({}, mac)).flat()).not.toContain(mac ? "mod+v" : "ctrl+v");
  });

  it("takes none of the keys main already uses", () => {
    for (const mac of [true, false]) {
      const keymap = resolveKeymap({}, mac);
      expect(keymap["session.focusOtherPane"]).toEqual(["mod+alt+o"]);
      expect(keymap["app.addProject"]).toEqual(["mod+o"]);
      expect(keymap["app.runView"]).toEqual(["mod+shift+o"]);
      expect(keymap["files.copyContents"]).toEqual(["mod+alt+c"]);
      expect(keymap["app.bots"]).toEqual(["mod+shift+j"]);
      expect(keymap["composer.historyPrevious"]).toEqual(["up"]);
      expect(keymap["composer.historyNext"]).toEqual(["down"]);
      expect(keymap["composer.dictate"]).toContain("mod+shift+d");
    }
  });

  it("lets ↑ and ↓ be the composer's and the review's at once, but nothing else's", () => {
    expect(conflictOf("up", "review.previousFile")).toBeNull();
    expect(conflictOf("down", "composer.historyNext")).toBeNull();
    // A window-wide action cannot take a key a surface has.
    expect(conflictOf("up", "app.toggleSidebar")?.surface).toBeDefined();
    // Two actions of the same surface still conflict.
    expect(conflictOf("up", "review.nextFile")?.id).toBe("review.previousFile");
    // The reader's own keys keep the same rule: a custom ↑ for a window-wide action wins it from both surfaces.
    const keymap = resolveKeymap({ "app.toggleSidebar": ["up"] }, true);
    expect(keymap["app.toggleSidebar"]).toEqual(["up"]);
    expect(keymap["composer.historyPrevious"]).toEqual([]);
    expect(keymap["review.previousFile"]).toEqual([]);
  });

  it("lets the review's keys be recorded, and moved apart from the composer's", () => {
    expect(saveShortcut("review.previousFile", ["pageup"], { mac: true })).toEqual({ ok: true });
    expect(bindingsOf("review.previousFile")).toEqual(["pageup"]);
    expect(bindingsOf("composer.historyPrevious")).toEqual(["up"]);
    expect(saveShortcut("review.toggleViewed", ["mod+alt+v"], { mac: true })).toEqual({ ok: true });
    expect(saveShortcut("review.start", ["mod+alt+s"], { mac: false })).toEqual({ ok: true });
    expect(bindingsOf("review.start")).toEqual(["mod+alt+s"]);
  });

  it("allows Shift+Tab for the plan-mode toggle in the composer only, and Tab nowhere", () => {
    for (const mac of [true, false]) {
      expect(bindingProblem("composer.togglePlanMode", "shift+tab", mac)).toBeNull();
      expect(bindingProblem("composer.togglePlanMode", "tab", mac)).toMatch(/Tab moves the focus/);
      for (const other of ["composer.send", "composer.openModelPicker", "app.toggleSidebar", "review.nextFile", "session.interrupt"] as const) {
        expect(bindingProblem(other, "shift+tab", mac), other).toMatch(/Tab moves the focus/);
        expect(bindingProblem(other, "tab", mac), other).toMatch(/Tab moves the focus/);
      }
    }
    expect(saveShortcut("composer.togglePlanMode", ["shift+tab"])).toEqual({ ok: true });
    expect(saveShortcut("composer.send", ["shift+tab"])).toMatchObject({ ok: false });
    expect(chordOf(key({ key: "Tab", code: "Tab", shiftKey: true }))).toBe("shift+tab");
    expect(matchesShortcut(key({ key: "Tab", code: "Tab", shiftKey: true }), "composer.togglePlanMode")).toBe(true);
    expect(matchesShortcut(key({ key: "Tab", code: "Tab" }), "composer.togglePlanMode")).toBe(false);
  });

  it("reads ⌘/ and ⇧⌘/ off the physical slash key", () => {
    expect(chordOf(key({ key: "?", code: "Slash", metaKey: true, shiftKey: true }), true)).toBe("mod+shift+/");
    expect(chordOf(key({ key: "/", code: "Slash", metaKey: true }), true)).toBe("mod+/");
    expect(keycaps("mod+shift+/", true)).toEqual(["⇧", "⌘", "/"]);
    expect(keycaps("shift+tab", true)).toEqual(["⇧", "Tab"]);
    expect(keycaps("ctrl+v", true)).toEqual(["⌃", "V"]);
  });

  it("leaves the keys of the actions with no screen key empty, or free", () => {
    for (const mac of [true, false]) {
      const keymap = resolveKeymap({}, mac);
      expect(keymap["session.copyConciseTranscript"]).toEqual([]);
      expect(keymap["files.openInDefault"]).toEqual([]);
      expect(keymap["files.openInMenu"]).toEqual([]);
      expect(keymap["chat.expandAllToolCalls"]).toEqual(["mod+alt+e"]);
    }
  });
});
