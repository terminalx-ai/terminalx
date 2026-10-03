import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPrefs } from "./prefs";
import { HOLD_DELAY_MS, registerHeldShortcut, registerHotkey, registerShortcut, runShortcut, shortcutKeys, suspendHotkeys, useShortcutKeycaps, useShortcutKeys } from "./hotkeys";
import { saveShortcut } from "./shortcuts";

// jsdom is not a Mac: `mod` is Ctrl, and holding Right Alt is not a default.
// The macOS default is the same binding stored explicitly (and once for real, at the end).
const MAC_DICTATION = { "composer.dictate": ["hold:AltRight", "mod+shift+d"] };

const cleanups: (() => void)[] = [];
const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const release = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, ...init }));
const rightOption = { key: "Alt", code: "AltRight", altKey: true };

function terminal(): HTMLTextAreaElement {
  const host = document.createElement("div");
  host.className = "terminal-host";
  const xterm = document.createElement("div");
  xterm.className = "xterm";
  const input = document.createElement("textarea");
  xterm.append(input);
  host.append(xterm);
  document.body.append(host);
  cleanups.push(() => host.remove());
  return input;
}

function held() {
  const onStart = vi.fn();
  const onEnd = vi.fn();
  cleanups.push(registerHeldShortcut("composer.dictate", { onStart, onEnd }));
  return { onStart, onEnd };
}

beforeEach(() => {
  vi.useFakeTimers();
  setPrefs({ shortcuts: {} });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("the binder and the reader's keys", () => {
  it("runs an action on its default chord", () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut("app.toggleSidebar", handler));
    const event = press({ key: "b", code: "KeyB", ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("honours a custom chord at once, with no new registration, and drops the old one", () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut("app.toggleSidebar", handler));
    saveShortcut("app.toggleSidebar", ["mod+shift+y"]);
    press({ key: "b", code: "KeyB", ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    press({ key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(shortcutKeys("app.toggleSidebar")).toEqual(["Ctrl", "Shift", "Y"]);
  });

  it("does not run an unbound action, and lets its old keys through", () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut("app.toggleSidebar", handler));
    saveShortcut("app.toggleSidebar", []);
    const event = press({ key: "b", code: "KeyB", ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(shortcutKeys("app.toggleSidebar")).toEqual([]);
  });

  it("gives keys taken from one action to the other", () => {
    const palette = vi.fn();
    const sidebar = vi.fn();
    cleanups.push(registerShortcut("app.commandPalette", palette), registerShortcut("app.toggleSidebar", sidebar));
    saveShortcut("app.toggleSidebar", ["mod+k"], { replace: true });
    press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(sidebar).toHaveBeenCalledTimes(1);
    expect(palette).not.toHaveBeenCalled();
  });

  it("still runs an unbound action from the command palette", () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut("app.toggleSidebar", handler));
    saveShortcut("app.toggleSidebar", []);
    runShortcut("app.toggleSidebar");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps a key in a context out of text fields, and a fixed chord working beside the registry", () => {
    const stop = vi.fn();
    const arrows = vi.fn();
    cleanups.push(registerShortcut("composer.historyPrevious", stop), registerHotkey("down", arrows));
    const field = document.createElement("textarea");
    document.body.append(field);
    cleanups.push(() => field.remove());
    press({ key: "ArrowUp" }, field);
    press({ key: "ArrowDown" }, field);
    expect(stop).not.toHaveBeenCalled();
    expect(arrows).not.toHaveBeenCalled();
    press({ key: "ArrowUp" });
    press({ key: "ArrowDown" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(arrows).toHaveBeenCalledTimes(1);
  });

  it("binds nothing while the Shortcuts tab records keys", () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut("app.toggleSidebar", handler));
    const resume = suspendHotkeys();
    press({ key: "b", code: "KeyB", ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    resume();
    press({ key: "b", code: "KeyB", ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("what shows a shortcut", () => {
  it("reads the current keys and follows a change", async () => {
    vi.useRealTimers();
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => ({ one: useShortcutKeys("app.toggleSidebar"), many: useShortcutKeycaps() }));
    expect(result.current.one).toEqual(["Ctrl", "B"]);
    expect(result.current.many("app.commandPalette")).toEqual(["Ctrl", "K"]);
    act(() => void saveShortcut("app.toggleSidebar", ["mod+k"], { replace: true }));
    expect(result.current.one).toEqual(["Ctrl", "K"]);
    // An action with no keys shows none.
    expect(result.current.many("app.commandPalette")).toEqual([]);
  });
});

describe("a terminal with the focus", () => {
  it("keeps the keys a shell needs, even when a shortcut is stored on them", () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut("app.toggleSidebar", handler));
    // Stored by hand: Settings refuses it.
    setPrefs({ shortcuts: { "app.toggleSidebar": ["mod+c"] } });
    const input = terminal();
    const inTerminal = press({ key: "c", code: "KeyC", ctrlKey: true }, input);
    expect(handler).not.toHaveBeenCalled();
    expect(inTerminal.defaultPrevented).toBe(false);
    // The same keys outside the terminal are the stored shortcut.
    press({ key: "c", code: "KeyC", ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still runs the app's own shortcuts", () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut("session.newTab", handler));
    press({ key: "t", code: "KeyT", ctrlKey: true }, terminal());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not start dictation on a held key: Option is Meta there", () => {
    setPrefs({ shortcuts: MAC_DICTATION });
    const { onStart } = held();
    press(rightOption, terminal());
    vi.advanceTimersByTime(HOLD_DELAY_MS * 4);
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("holding Right Option to dictate", () => {
  beforeEach(() => setPrefs({ shortcuts: MAC_DICTATION }));

  it("starts once the key has been held on its own, and stops on release", () => {
    const { onStart, onEnd } = held();
    press(rightOption);
    expect(onStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(onStart).toHaveBeenCalledTimes(1);
    // Auto-repeat of the held key changes nothing.
    press({ ...rightOption, repeat: true });
    vi.advanceTimersByTime(1000);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    release({ key: "Alt", code: "AltRight" });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(false);
  });

  it("is a combination, not dictation, when another key follows: nothing starts and the keys go through", () => {
    const { onStart, onEnd } = held();
    press(rightOption);
    vi.advanceTimersByTime(HOLD_DELAY_MS / 2);
    const typed = press({ key: "´", code: "KeyE", altKey: true });
    vi.advanceTimersByTime(HOLD_DELAY_MS * 4);
    release({ key: "Alt", code: "AltRight" });
    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(typed.defaultPrevented).toBe(false);
  });

  it("cancels a dictation it started when another key is pressed, and the release then does nothing", () => {
    const { onStart, onEnd } = held();
    press(rightOption);
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    const typed = press({ key: "∫", code: "KeyB", altKey: true });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(true);
    expect(typed.defaultPrevented).toBe(false);
    release({ key: "Alt", code: "AltRight" });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("lets an Option combination run a shortcut while the key is down", () => {
    const { onStart } = held();
    const panel = vi.fn();
    cleanups.push(registerShortcut("panel.changes", panel));
    press(rightOption);
    press({ key: "¡", code: "Digit1", altKey: true, ctrlKey: true });
    vi.advanceTimersByTime(HOLD_DELAY_MS * 4);
    expect(panel).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("does nothing for a tap", () => {
    const { onStart, onEnd } = held();
    press(rightOption);
    vi.advanceTimersByTime(HOLD_DELAY_MS / 2);
    release({ key: "Alt", code: "AltRight" });
    vi.advanceTimersByTime(HOLD_DELAY_MS * 4);
    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("leaves Left Option alone", () => {
    const { onStart } = held();
    press({ key: "Alt", code: "AltLeft", altKey: true });
    vi.advanceTimersByTime(HOLD_DELAY_MS * 4);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("does not start when another modifier is already down (AltGr sends Ctrl first)", () => {
    const { onStart } = held();
    press({ ...rightOption, ctrlKey: true });
    press({ ...rightOption, shiftKey: true });
    press({ ...rightOption, metaKey: true });
    vi.advanceTimersByTime(HOLD_DELAY_MS * 4);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("stops when the window loses the focus, since the release will never arrive", () => {
    const { onEnd } = held();
    press(rightOption);
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    window.dispatchEvent(new Event("blur"));
    expect(onEnd).toHaveBeenCalledWith(false);
  });

  it("follows the key when the reader moves it to another modifier, or takes it away", () => {
    const { onStart } = held();
    saveShortcut("composer.dictate", ["hold:ControlRight"]);
    press(rightOption);
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(onStart).not.toHaveBeenCalled();
    release({ key: "Alt", code: "AltRight" });
    press({ key: "Control", code: "ControlRight", ctrlKey: true });
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(onStart).toHaveBeenCalledTimes(1);
    release({ key: "Control", code: "ControlRight" });
    saveShortcut("composer.dictate", []);
    press({ key: "Control", code: "ControlRight", ctrlKey: true });
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

describe("the default dictation key by platform", () => {
  it("is not a held key off macOS: Right Alt on its own does nothing", () => {
    setPrefs({ shortcuts: {} });
    const { onStart } = held();
    const toggle = vi.fn();
    cleanups.push(registerShortcut("composer.dictate", toggle));
    press(rightOption);
    vi.advanceTimersByTime(HOLD_DELAY_MS * 4);
    expect(onStart).not.toHaveBeenCalled();
    press({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("is a held Right Option on macOS with nothing stored, and ⌘⇧D still toggles", async () => {
    const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform")!;
    Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "MacIntel" });
    vi.resetModules();
    try {
      localStorage.clear();
      const mac = await import("./hotkeys");
      expect(mac.isMac).toBe(true);
      expect(mac.shortcutKeys("composer.dictate")).toEqual(["Right ⌥"]);
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const toggle = vi.fn();
      cleanups.push(mac.registerHeldShortcut("composer.dictate", { onStart, onEnd }), mac.registerShortcut("composer.dictate", toggle));
      press(rightOption);
      vi.advanceTimersByTime(mac.HOLD_DELAY_MS);
      expect(onStart).toHaveBeenCalledTimes(1);
      release({ key: "Alt", code: "AltRight" });
      expect(onEnd).toHaveBeenCalledWith(false);
      press({ key: "D", code: "KeyD", metaKey: true, shiftKey: true });
      expect(toggle).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(Navigator.prototype, "platform", platform);
      vi.resetModules();
    }
  });
});
