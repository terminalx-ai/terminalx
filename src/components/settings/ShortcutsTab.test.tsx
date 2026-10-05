import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerHotkey, registerShortcut } from "@/lib/hotkeys";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { bindingsOf } from "@/lib/shortcuts";
import { ShortcutsTab } from "./ShortcutsTab";

// jsdom is not a Mac: `mod` is Ctrl and keycaps read "Ctrl", "Shift".
const row = (id: string) => document.querySelector<HTMLElement>(`[data-shortcut="${id}"]`)!;
const chip = (id: string) => within(row(id)).getAllByRole("button", { name: /Change$|Set one$/ })[0];
const editor = () => screen.getByTestId("shortcut-editor");
const recorder = () => within(editor()).getByRole("button", { name: /^New keys for/ });

/** Open a row's recorder and press keys into it. */
function record(id: string, init: KeyboardEventInit) {
  fireEvent.click(chip(id));
  fireEvent.keyDown(recorder(), init);
}

beforeEach(() => {
  localStorage.clear();
  setPrefs({ shortcuts: {} });
});

afterEach(cleanup);

describe("Settings → Shortcuts", () => {
  it("lists every shortcut with its current keys", () => {
    render(<ShortcutsTab />);
    expect(row("app.commandPalette").textContent).toContain("Command palette");
    expect(within(row("app.commandPalette")).getByRole("button", { name: "Command palette: Ctrl+K. Change" })).toBeTruthy();
    expect(within(row("session.stop")).getByRole("button", { name: "Stop the running turn: Esc. Change" })).toBeTruthy();
    // The characters typed in the composer are shown, not offered for change.
    expect(row("composer.mention").textContent).toContain("@");
    expect(within(row("composer.mention")).queryByRole("button")).toBeNull();
    expect(screen.getByText(/A terminal keeps the keys a shell needs/)).toBeTruthy();
  });

  it("changes a shortcut: click it, press the keys, save", () => {
    render(<ShortcutsTab />);
    fireEvent.click(chip("app.toggleSidebar"));
    // The recorder takes the focus, so the keys can be pressed straight away.
    expect(document.activeElement).toBe(recorder());
    fireEvent.keyDown(recorder(), { key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true });
    // Nothing is stored until it is saved; Save has the focus, so Return saves.
    expect(getPrefs().shortcuts).toEqual({});
    const save = within(editor()).getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(save);
    fireEvent.click(save);
    expect(getPrefs().shortcuts).toEqual({ "app.toggleSidebar": ["mod+shift+y"] });
    expect(screen.queryByTestId("shortcut-editor")).toBeNull();
    expect(within(row("app.toggleSidebar")).getByRole("button", { name: "Toggle sidebar: Ctrl+Shift+Y. Change" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Toggle sidebar is now Ctrl+Shift+Y.");
  });

  it("applies the change to a live binding without a restart", () => {
    const handler = vi.fn();
    const unregister = registerShortcut("app.toggleSidebar", handler);
    render(<ShortcutsTab />);
    record("app.toggleSidebar", { key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true });
    fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
    fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("records the keys instead of running them, and Tab still leaves the recorder", () => {
    const palette = vi.fn();
    const unregister = registerShortcut("app.commandPalette", palette, { global: true });
    render(<ShortcutsTab />);
    fireEvent.click(chip("app.toggleSidebar"));
    act(() => recorder().focus());
    fireEvent.keyDown(recorder(), { key: "k", code: "KeyK", ctrlKey: true });
    expect(palette).not.toHaveBeenCalled();
    // Tab is never recorded: it is how the keyboard gets out.
    fireEvent.click(within(editor()).getByRole("button", { name: "Cancel" }));
    fireEvent.click(chip("app.toggleSidebar"));
    const tab = fireEvent.keyDown(recorder(), { key: "Tab" });
    expect(tab).toBe(true);
    expect(within(editor()).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    unregister();
  });

  it("Escape on the buttons cancels the change; in the recorder it is a key like any other", () => {
    const closeSettings = vi.fn();
    const unregister = registerHotkey("escape", closeSettings);
    render(<ShortcutsTab />);
    record("session.stop", { key: "Escape", code: "Escape", shiftKey: true });
    expect(screen.getByTestId("shortcut-editor")).toBeTruthy();
    // The focus is on Save now: Escape leaves the editor, and Settings stays open.
    fireEvent.keyDown(document.activeElement!, { key: "Escape", code: "Escape" });
    expect(screen.queryByTestId("shortcut-editor")).toBeNull();
    expect(closeSettings).not.toHaveBeenCalled();
    expect(getPrefs().shortcuts).toEqual({});
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(closeSettings).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("names the action that already has the keys, and Cancel changes nothing", () => {
    render(<ShortcutsTab />);
    record("app.toggleSidebar", { key: "k", code: "KeyK", ctrlKey: true });
    expect(within(editor()).getByRole("alert").textContent).toContain("Ctrl+K is already used by “Command palette”");
    expect(within(editor()).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(editor()).getByRole("button", { name: "Replace" })).toBeTruthy();
    fireEvent.click(within(editor()).getByRole("button", { name: "Cancel" }));
    expect(getPrefs().shortcuts).toEqual({});
    expect(bindingsOf("app.commandPalette")).toEqual(["mod+k"]);
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+b"]);
  });

  it("Replace moves the keys and leaves the other action without them", () => {
    render(<ShortcutsTab />);
    record("app.toggleSidebar", { key: "k", code: "KeyK", ctrlKey: true });
    fireEvent.click(within(editor()).getByRole("button", { name: "Replace" }));
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+k"]);
    expect(bindingsOf("app.commandPalette")).toEqual([]);
    expect(within(row("app.commandPalette")).getByRole("button", { name: "Command palette: no shortcut. Set one" }).textContent).toBe("Not set");
  });

  it("clears a shortcut, and sets one again from Not set", () => {
    render(<ShortcutsTab />);
    fireEvent.click(chip("app.issues"));
    fireEvent.click(within(editor()).getByRole("button", { name: "Remove" }));
    expect(getPrefs().shortcuts).toEqual({ "app.issues": [] });
    expect(chip("app.issues").textContent).toBe("Not set");
    record("app.issues", { key: "I", code: "KeyI", ctrlKey: true, shiftKey: true });
    // Nothing to remove on a row with no keys.
    expect(within(editor()).queryByRole("button", { name: "Remove" })).toBeNull();
    fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
    expect(bindingsOf("app.issues")).toEqual(["mod+shift+i"]);
  });

  it("resets one row, and all of them after asking", () => {
    setPrefs({ shortcuts: { "app.toggleSidebar": ["mod+shift+y"], "app.issues": [] } });
    render(<ShortcutsTab />);
    // Reset is offered only on a row that was changed.
    expect(within(row("app.newSession")).getByRole("button", { name: "Reset New session", hidden: true }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(row("app.toggleSidebar")).getByRole("button", { name: "Reset Toggle sidebar" }));
    expect(getPrefs().shortcuts).toEqual({ "app.issues": [] });
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+b"]);

    fireEvent.click(screen.getByRole("button", { name: "Reset all to defaults" }));
    expect(getPrefs().shortcuts).toEqual({ "app.issues": [] });
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(getPrefs().shortcuts).toEqual({});
    expect(screen.getByRole("button", { name: "Reset all to defaults" }).hasAttribute("disabled")).toBe(true);
  });

  it("asks before a reset takes keys another action uses now", () => {
    setPrefs({ shortcuts: { "app.toggleSidebar": ["mod+shift+y"], "app.issues": ["mod+b"] } });
    render(<ShortcutsTab />);
    fireEvent.click(within(row("app.toggleSidebar")).getByRole("button", { name: "Reset Toggle sidebar" }));
    expect(within(row("app.toggleSidebar")).getByRole("alert").textContent).toContain("Ctrl+B is used by “Issues” now");
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+shift+y"]);
    fireEvent.click(within(row("app.toggleSidebar")).getByRole("button", { name: "Replace" }));
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+b"]);
    expect(bindingsOf("app.issues")).toEqual([]);
  });

  it("refuses the keys a terminal needs, and says why", () => {
    render(<ShortcutsTab />);
    record("app.toggleSidebar", { key: "c", code: "KeyC", ctrlKey: true });
    expect(within(editor()).getByRole("alert").textContent).toContain("Ctrl+C is a key the terminal needs");
    const save = within(editor()).getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(save);
    expect(getPrefs().shortcuts).toEqual({});
    // The recorder is still there for other keys.
    fireEvent.keyDown(recorder(), { key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true });
    expect(within(editor()).queryByRole("alert")).toBeNull();
    expect(within(editor()).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  it("refuses a plain character, and a key without a modifier for a shortcut that works everywhere", () => {
    render(<ShortcutsTab />);
    record("app.toggleSidebar", { key: "b", code: "KeyB" });
    expect(within(editor()).getByRole("alert").textContent).toContain("types a character");
    fireEvent.keyDown(recorder(), { key: "Enter", code: "Enter" });
    expect(within(editor()).getByRole("alert").textContent).toContain("works everywhere in the app");
  });

  it("records Escape and Return for a key that lives in a context", () => {
    render(<ShortcutsTab />);
    record("composer.send", { key: "Enter", code: "Enter", ctrlKey: true });
    fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
    expect(bindingsOf("composer.send")).toEqual(["mod+enter"]);
    record("session.stop", { key: "Escape", code: "Escape", shiftKey: true });
    fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
    expect(bindingsOf("session.stop")).toEqual(["shift+escape"]);
  });

  it("makes dictation a held modifier key: press and release it on its own", () => {
    render(<ShortcutsTab />);
    fireEvent.click(chip("composer.dictate"));
    fireEvent.keyDown(recorder(), { key: "Alt", code: "AltRight", altKey: true });
    // Nothing yet: it may be the start of a chord.
    expect(within(editor()).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyUp(recorder(), { key: "Alt", code: "AltRight" });
    fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
    expect(bindingsOf("composer.dictate")).toEqual(["hold:AltRight"]);
    expect(within(row("composer.dictate")).getByRole("button", { name: "Start or stop dictation: hold Right Alt. Change" }).textContent).toBe("HoldRight Alt");
  });

  it("keeps both dictation bindings apart: each is changed or removed on its own", () => {
    setPrefs({ shortcuts: { "composer.dictate": ["hold:AltRight", "mod+shift+d"] } });
    render(<ShortcutsTab />);
    const chips = within(row("composer.dictate")).getAllByRole("button", { name: /Change$/ });
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[0]);
    fireEvent.keyDown(recorder(), { key: "Control", code: "ControlRight", ctrlKey: true });
    fireEvent.keyUp(recorder(), { key: "Control", code: "ControlRight" });
    fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
    expect(bindingsOf("composer.dictate")).toEqual(["hold:ControlRight", "mod+shift+d"]);
    fireEvent.click(within(row("composer.dictate")).getAllByRole("button", { name: /Change$/ })[1]);
    fireEvent.click(within(editor()).getByRole("button", { name: "Remove" }));
    expect(bindingsOf("composer.dictate")).toEqual(["hold:ControlRight"]);
  });

  it("does not let another action be a held key", () => {
    render(<ShortcutsTab />);
    fireEvent.click(chip("app.toggleSidebar"));
    fireEvent.keyDown(recorder(), { key: "Alt", code: "AltRight", altKey: true });
    fireEvent.keyUp(recorder(), { key: "Alt", code: "AltRight" });
    expect(within(editor()).getByRole("alert").textContent).toContain("only works for dictation");
  });
});
