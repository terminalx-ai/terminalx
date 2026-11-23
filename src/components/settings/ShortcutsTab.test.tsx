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
    for (const [id, label, key] of [["git.commitPush", "Commit and push", "Y"], ["git.pull", "Pull latest", "L"], ["session.fixErrors", "Fix failing CI checks", "X"], ["git.merge", "Merge pull request", "M"], ["git.createPr", "Create pull request", "C"]]) {
      expect(within(row(id)).getByRole("button", { name: `${label}: Ctrl+Shift+${key}. Change` })).toBeTruthy();
    }
    // Ctrl+Shift+X stays with Fix failing CI checks; the Git button's step has no default of its own.
    expect(within(row("git.fixChecks")).getByRole("button", { name: "Fix checks: no shortcut. Set one" })).toBeTruthy();
    expect(within(row("app.commandPalette")).getByRole("button", { name: "Command palette: Ctrl+K. Change" })).toBeTruthy();
    expect(within(row("session.interrupt")).getByRole("button", { name: "Interrupt the running turn: Esc. Change" })).toBeTruthy();
    // Ending the agent's process has no keys until the reader gives it some (#427).
    expect(within(row("session.stop")).getByRole("button", { name: "Stop the session (ends the agent's process): no shortcut. Set one" })).toBeTruthy();
    expect(within(row("composer.sendAlternate")).getByRole("button", { name: "Send the other way (hold or interrupt): Ctrl+⏎. Change" })).toBeTruthy();
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
    fireEvent.keyDown(recorder(), { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
    // Nothing is stored until it is saved; Save has the focus, so Return saves.
    expect(getPrefs().shortcuts).toEqual({});
    const save = within(editor()).getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(save);
    fireEvent.click(save);
    expect(getPrefs().shortcuts).toEqual({ "app.toggleSidebar": ["mod+shift+v"] });
    expect(screen.queryByTestId("shortcut-editor")).toBeNull();
    expect(within(row("app.toggleSidebar")).getByRole("button", { name: "Toggle sidebar: Ctrl+Shift+V. Change" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Toggle sidebar is now Ctrl+Shift+V.");
  });

  it("applies the change to a live binding without a restart", () => {
    const handler = vi.fn();
    const unregister = registerShortcut("app.toggleSidebar", handler);
    render(<ShortcutsTab />);
    record("app.toggleSidebar", { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
    fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
    fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
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
    record("session.interrupt", { key: "Escape", code: "Escape", shiftKey: true });
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
    setPrefs({ shortcuts: { "app.toggleSidebar": ["mod+shift+v"], "app.issues": [] } });
    render(<ShortcutsTab />);
    // Reset is offered only on a row that was changed.
    expect(within(row("app.newSession")).queryByRole("button", { name: "Reset New session" })).toBeNull();
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
    setPrefs({ shortcuts: { "app.toggleSidebar": ["mod+shift+v"], "app.issues": ["mod+b"] } });
    render(<ShortcutsTab />);
    fireEvent.click(within(row("app.toggleSidebar")).getByRole("button", { name: "Reset Toggle sidebar" }));
    expect(within(row("app.toggleSidebar")).getByRole("alert").textContent).toContain("Ctrl+B is used by “Issues” now");
    expect(bindingsOf("app.toggleSidebar")).toEqual(["mod+shift+v"]);
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
    fireEvent.keyDown(recorder(), { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
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
    expect(within(editor()).getByRole("alert").textContent).toContain("Send the other way");
    fireEvent.click(within(editor()).getByRole("button", { name: "Replace" }));
    expect(bindingsOf("composer.send")).toEqual(["mod+enter"]);
    expect(bindingsOf("composer.sendAlternate")).toEqual([]);
    record("session.interrupt", { key: "Escape", code: "Escape", shiftKey: true });
    fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
    expect(bindingsOf("session.interrupt")).toEqual(["shift+escape"]);
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

describe("Settings → Shortcuts, the Phase 3 batch's rows", () => {
  it("lists a Review group between Files and Issues, with the review's keys", () => {
    render(<ShortcutsTab />);
    const groups = screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"));
    expect(groups.indexOf("Review shortcuts")).toBeGreaterThan(groups.indexOf("Files shortcuts"));
    expect(groups.indexOf("Review shortcuts")).toBeLessThan(groups.indexOf("Issues shortcuts"));
    const review = within(screen.getByRole("region", { name: "Review shortcuts" }));
    for (const label of ["Previous file in the diff", "Next file in the diff", "Previous comment", "Next comment", "Mark file as viewed", "Start a review"]) expect(review.getByText(label)).toBeTruthy();
    expect(within(row("review.previousFile")).getByRole("button", { name: "Previous file in the diff: ↑. Change" })).toBeTruthy();
    expect(within(row("review.previousComment")).getByRole("button", { name: "Previous comment: Ctrl+Alt+K. Change" })).toBeTruthy();
    // jsdom is not a Mac: Ctrl+V pastes and Ctrl+Alt+R runs the project's action, so neither has review keys here.
    expect(within(row("review.toggleViewed")).getByRole("button", { name: "Mark file as viewed: no shortcut. Set one" })).toBeTruthy();
    expect(within(row("review.start")).getByRole("button", { name: "Start a review: no shortcut. Set one" })).toBeTruthy();
  });

  it("lists the composer's new actions and the relabelled fork", () => {
    render(<ShortcutsTab />);
    expect(within(row("composer.openModelPicker")).getByRole("button", { name: "Open model picker: Ctrl+/. Change" })).toBeTruthy();
    expect(within(row("composer.cycleEffort")).getByRole("button", { name: "Cycle effort: Ctrl+Shift+/. Change" })).toBeTruthy();
    expect(within(row("composer.toggleFast")).getByRole("button", { name: "Toggle fast mode: Ctrl+Shift+E. Change" })).toBeTruthy();
    expect(within(row("composer.togglePlanMode")).getByRole("button", { name: "Toggle plan mode: Shift+Tab. Change" })).toBeTruthy();
    expect(row("session.forkTab").textContent).toContain("Fork to new tab");
    for (const id of ["chat.expandAllToolCalls", "session.copyConciseTranscript", "git.showUncommitted", "files.openInDefault", "files.openInMenu"]) expect(row(id)).toBeTruthy();
  });

  it("shows ↑ for the review and the composer at once, with no conflict", () => {
    render(<ShortcutsTab />);
    expect(within(row("composer.historyPrevious")).getByRole("button", { name: /↑\. Change$/ })).toBeTruthy();
    record("review.nextFile", { key: "ArrowUp", code: "ArrowUp" });
    expect(within(editor()).getByRole("button", { name: "Replace" })).toBeTruthy();
    expect(editor().textContent).toContain("Previous file in the diff");
    // The composer's ↑ is not named: it is another surface's key.
    expect(editor().textContent).not.toContain("Recall the previous message");
    cleanup();
    render(<ShortcutsTab />);
    record("composer.historyPrevious", { key: "ArrowDown", code: "ArrowDown" });
    expect(editor().textContent).toContain("Recall the next message, then the draft");
    expect(editor().textContent).not.toContain("Next file in the diff");
  });

  it("records Shift+Tab for the plan-mode toggle, where Tab alone still leaves the recorder", () => {
    render(<ShortcutsTab />);
    fireEvent.click(chip("composer.togglePlanMode"));
    const keys = recorder();
    expect(fireEvent.keyDown(keys, { key: "Tab", code: "Tab" })).toBe(true);
    expect(within(editor()).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(fireEvent.keyDown(keys, { key: "Tab", code: "Tab", shiftKey: true })).toBe(false);
    expect(editor().textContent).toContain("Shift+Tab");
    expect(within(editor()).queryByRole("alert")).toBeNull();
  });

  it("refuses Shift+Tab for every other action: Tab moves the focus", () => {
    render(<ShortcutsTab />);
    fireEvent.click(chip("composer.openModelPicker"));
    expect(fireEvent.keyDown(recorder(), { key: "Tab", code: "Tab", shiftKey: true })).toBe(true);
    expect(within(editor()).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });
});
