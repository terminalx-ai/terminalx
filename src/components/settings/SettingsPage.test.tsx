import { AppearanceTab, AgentsTab } from "./SettingsSections";
import { SETTINGS_SECTIONS } from "./settingsRegistry";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DEFAULT_SETTINGS_TAB, SETTING_HIGHLIGHT_FADE_MS, SETTING_HIGHLIGHT_HOLD_MS, SettingsPage, type SettingsTab } from "./SettingsPage";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { bindingText, resetShortcut, saveShortcut } from "@/lib/shortcuts";
import { setTheme } from "@/lib/theme";
import { ShortcutsTab } from "./ShortcutsTab";
import { movePaletteSelection } from "@/lib/commandPalette";
import { groupSettingsByPage, searchSettings, SETTINGS_SEARCH_LIMIT, settingsSearchSummary } from "@/lib/settingsSearch";
import { isMac } from "@/lib/hotkeys";
import { api, experimental } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";

const settingsFile = vi.hoisted(() => ({ error: null as string | null }));
vi.mock("@/lib/settingsFile", () => ({
  useSettingsFile: () => ({ error: settingsFile.error, file: null, revision: 0 }),
  createSettingsFile: vi.fn(async () => {}),
}));

beforeEach(() => {
  settingsFile.error = null;
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Settings search", () => {
  const search = () => screen.getByRole("combobox", { name: "Search settings" }) as HTMLInputElement;
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`);

  it("keeps one invalid-file diagnostic visible while searching rows", () => {
    settingsFile.error = "preferences.sounds, line 3: expected true or false";
    render(<SettingsPage initialTab="appearance" onBack={vi.fn()} />);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.change(search(), { target: { value: "text size" } });
    expect(screen.getByRole("option", { name: /Text size/ })).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("preferences.sounds, line 3");
  });

  // PRO-374 (design 09.01): a result row carries the row's live control, which changes the setting in place.
  it("puts each row's live control on its result, and using it does not open the page", async () => {
    render(<SettingsPage initialTab="appearance" onBack={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "link actions" } });
    const option = screen.getByRole("option", { name: /Link actions/ });
    const control = await within(option).findByRole("switch");
    const before = control.getAttribute("aria-checked");
    fireEvent.click(control);
    await waitFor(() => expect(control.getAttribute("aria-checked")).not.toBe(before));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Results for “link actions”");
    // The description is one line; the full text is its tooltip.
    expect(option.querySelector("[title]")?.className).toContain("truncate");
  });

  // Review of PRO-374: typing a query must not start a page's disk or network work.
  it("does not mount Storage, with its leftover scan, to search it", async () => {
    const scan = vi.spyOn(api, "scanLeftovers").mockResolvedValue([] as never);
    render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "leftovers" } });
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    await act(async () => {});
    expect(scan).not.toHaveBeenCalled();
  });

  it("lends the open page's controls to its results instead of mounting it again", async () => {
    const settings = vi.spyOn(experimental, "settings").mockResolvedValue({ nativeCodex: false, sessionCost: false } as never);
    render(<SettingsPage initialTab="experimental" onBack={vi.fn()} />);
    // The page has read its switches (the app's shared store reads them too).
    await waitFor(() => expect(screen.getByRole("switch", { name: "Session cost" }).hasAttribute("disabled")).toBe(false));
    await act(async () => {});
    const before = settings.mock.calls.length;
    fireEvent.change(search(), { target: { value: "session cost" } });
    await within(screen.getByRole("option", { name: /Session cost/ })).findByRole("switch");
    await act(async () => {});
    expect(settings.mock.calls.length).toBe(before);
  });

  it("says, above the results, when a change made from a result is refused", async () => {
    vi.spyOn(experimental, "settings").mockResolvedValue({ nativeCodex: false, sessionCost: false } as never);
    vi.spyOn(experimental, "setSessionCost").mockRejectedValue(new Error("refused by the runtime"));
    render(<SettingsPage initialTab="appearance" onBack={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "session cost" } });
    const control = await within(screen.getByRole("option", { name: /Session cost/ })).findByRole("switch");
    await waitFor(() => expect(control.hasAttribute("disabled")).toBe(false));
    fireEvent.click(control);
    // The page's own alert is hidden with the page; the results say it.
    await waitFor(() => expect(screen.getAllByRole("alert").map((element) => element.textContent)).toContain("Experimental: refused by the runtime"));
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("lists matching rows grouped by page under the query, a count and the keys (design 09.31)", () => {
    render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "text size" } });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Results for “text size”");
    const expected = groupSettingsByPage(searchSettings("text size"));
    expect(screen.getByText(`${settingsSearchSummary(searchSettings("text size"))} · ↑↓ to move · ↵ opens the setting · esc clears`)).toBeTruthy();
    const listbox = screen.getByRole("listbox", { name: "Settings search results" });
    const pages = within(listbox).getAllByRole("group");
    expect(pages.map((page) => document.getElementById(page.getAttribute("aria-labelledby")!)?.textContent)).toEqual(expected.map((page) => page.title));
    expect(pages[0].textContent).toContain("General");
    pages.forEach((page, index) => expect(within(page).getAllByRole("option")).toHaveLength(expected[index].matches.length));
    const first = within(pages[0]).getByRole("option");
    expect(first.textContent).toContain("Text size");
    expect(first.textContent).toContain("Scales the transcript and composer.");
    expect(first.querySelector("mark")?.textContent).toBe("Text");
    // Rows, not sections: the old section results are gone.
    expect(within(listbox).queryByRole("option", { name: /^General/ })).toBeNull();
  });

  it("lists what 'font' finds by page with its count, marks the matched text, and Enter opens and highlights the first row", () => {
    render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
    const input = search();
    fireEvent.change(input, { target: { value: "font" } });
    const found = searchSettings("font");
    const expected = groupSettingsByPage(found);
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(SETTINGS_SEARCH_LIMIT);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Results for “font”");
    // The app's font setting is General › Text size (PRO-377); it is listed under its page.
    expect(within(screen.getByRole("group", { name: "General" })).getByRole("option", { name: /Text size/ })).toBeTruthy();
    expect(screen.getByText(/^\d+ settings? on \d+ pages? · /)).toBeTruthy();
    expect(screen.getByText(`${settingsSearchSummary(found)} · ↑↓ to move · ↵ opens the setting · esc clears`)).toBeTruthy();
    const listbox = screen.getByRole("listbox", { name: "Settings search results" });
    const pages = within(listbox).getAllByRole("group");
    expect(pages.map((page) => page.getAttribute("aria-labelledby") && document.getElementById(page.getAttribute("aria-labelledby")!)?.textContent)).toEqual(expected.map((page) => page.title));
    // Each page lists its rows in ranked order, the matched characters marked.
    pages.forEach((page, index) => {
      const options = within(page).getAllByRole("option");
      expect(options.map((option) => option.id)).toEqual(expected[index].matches.map((match) => `settings-result-${match.id}`));
      options.forEach((option, row) => {
        const match = expected[index].matches[row];
        const ranges = [...match.titleRanges.map((range) => match.row.title.slice(range.start, range.end)), ...match.descriptionRanges.map((range) => match.row.description.slice(range.start, range.end))];
        expect([...option.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(ranges);
      });
    });
    // ↓ then ↑ comes back to the first; Enter opens it on its page and highlights it.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const first = expected[0].matches[0];
    expect(input.getAttribute("aria-activedescendant")).toBe(`settings-result-${first.id}`);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(first.sectionTitle);
    const target = row(first.id)!;
    expect(document.activeElement).toBe(target);
    expect(target.dataset.settingHighlight).toBe("on");
  });

  it("focuses with the find shortcut and opens the row with Enter: its section, scrolled to, focused and highlighted briefly", () => {
    vi.useFakeTimers();
    try {
      render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
      const input = search();
      fireEvent.keyDown(document.body, { key: "f", metaKey: isMac, ctrlKey: !isMac });
      expect(document.activeElement).toBe(input);
      fireEvent.change(input, { target: { value: "text size" } });
      const result = screen.getByRole("option", { name: /Text size/ });
      expect(input.getAttribute("aria-activedescendant")).toBe(result.id);
      result.closest("section")!.scrollTop = 400;
      const scrolled = vi.mocked(Element.prototype.scrollIntoView);
      scrolled.mockClear();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(input.value).toBe("");
      const target = row("general.textSize")!;
      expect(document.activeElement).toBe(target);
      expect(scrolled.mock.contexts).toContain(target);
      expect(scrolled).toHaveBeenCalledWith({ block: "start" });
      expect(target.closest("section")!.scrollTop).toBe(0);
      expect(target.dataset.settingHighlight).toBe("on");
      act(() => { vi.advanceTimersByTime(SETTING_HIGHLIGHT_HOLD_MS); });
      expect(target.dataset.settingHighlight).toBe("fading");
      act(() => { vi.advanceTimersByTime(SETTING_HIGHLIGHT_FADE_MS); });
      expect(target.dataset.settingHighlight).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws the highlight from design tokens and drops its transition under reduced motion", () => {
    render(<SettingsPage initialTab="general.textSize" onBack={vi.fn()} />);
    const section = row("general.textSize")!.closest("section")!;
    expect(row("general.textSize")!.dataset.settingHighlight).toBe("on");
    expect(section.className).toContain("[&_[data-setting-highlight=on]]:bg-selected");
    expect(section.className).toContain("motion-reduce:[&_[data-setting-highlight]]:transition-none");
  });

  it("highlights only the latest row: opening another moves the highlight, and a plain section clears it", () => {
    render(<SettingsPage initialTab="general.textSize" onBack={vi.fn()} />);
    const first = row("general.textSize")!;
    expect(first.dataset.settingHighlight).toBe("on");
    fireEvent.change(search(), { target: { value: "theme" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(first.dataset.settingHighlight).toBeUndefined();
    const theme = row("appearance.theme")!;
    expect(theme.dataset.settingHighlight).toBe("on");
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(theme.dataset.settingHighlight).toBeUndefined();
    expect(document.querySelector("[data-setting-highlight]")).toBeNull();
  });

  it("opens a repository row on the repositories page, which asks for a repository when none is added", () => {
    render(<SettingsPage initialTab="appearance" onBack={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "worktreeinclude" } });
    fireEvent.click(screen.getByRole("option", { name: /Files to copy/ }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Projects");
    const navigation = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(navigation).getByRole("group", { name: "Projects" })).toBeTruthy();
    expect(screen.getByText("Choose a project to view its settings.")).toBeTruthy();
  });

  it("moves with ↑/↓ as the palette does, wrapping at both ends, resets when edited, and opens a clicked result", () => {
    render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
    const input = search();
    fireEvent.change(input, { target: { value: "theme" } });
    const results = screen.getAllByRole("option");
    const active = () => input.getAttribute("aria-activedescendant");
    const selectedIds = () => results.filter((result) => result.getAttribute("aria-selected") === "true").map((result) => result.id);
    expect(active()).toBe(results[0].id);
    expect(selectedIds()).toEqual([results[0].id]);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(active()).toBe(results.at(-1)!.id);
    expect(selectedIds()).toEqual([results.at(-1)!.id]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()).toBe(results[0].id);
    // ↓ walks the rows in the order shown, across page groups, and wraps from the last to the first.
    let index = 0;
    for (let step = 0; step < results.length; step++) {
      fireEvent.keyDown(input, { key: "ArrowDown" });
      index = movePaletteSelection(index, results.length, "ArrowDown");
      expect(active()).toBe(results[index].id);
      expect(selectedIds()).toEqual([results[index].id]);
    }
    expect(index).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.change(input, { target: { value: "text size" } });
    const result = screen.getAllByRole("option")[0];
    expect(result.textContent).toContain("Text size");
    expect(active()).toBe(result.id);
    fireEvent.click(result);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
    expect(document.activeElement).toBe(row("general.textSize"));
  });

  it("opens a clicked result on its row", () => {
    render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "theme" } });
    const theme = screen.getAllByRole("option")[0];
    expect(theme.textContent).toContain("Theme");
    fireEvent.click(theme);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Appearance");
    expect(document.activeElement).toBe(row("appearance.theme"));
  });

  it("says so when nothing matches, and Escape clears the search before closing Settings (design 09.33)", () => {
    const onBack = vi.fn();
    render(<SettingsPage initialTab="appearance" onBack={onBack} />);
    const input = search();
    fireEvent.change(input, { target: { value: "zzqx" } });
    const empty = screen.getByRole("status");
    expect(within(empty).getByText("No settings match “zzqx”")).toBeTruthy();
    expect(empty.textContent).toContain("Try fewer letters, or search keyboard shortcuts.");
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.queryByText(/↑↓ to move/)).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("clears a search with results on the first Escape and closes on the second", () => {
    const onBack = vi.fn();
    render(<SettingsPage initialTab="appearance" onBack={onBack} />);
    fireEvent.change(search(), { target: { value: "theme" } });
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search().value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Appearance");
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("opens Shortcuts from the empty state's keyboard shortcuts link", () => {
    render(<SettingsPage initialTab="appearance" onBack={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "zzqx" } });
    fireEvent.click(screen.getByRole("button", { name: "search keyboard shortcuts" }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Keyboard shortcuts");
    expect(search().value).toBe("");
  });

  it("lets overlays keep Escape and find while search is active", () => {
    const onBack = vi.fn();
    render(<SettingsPage initialTab="appearance" onBack={onBack} />);
    const input = search();
    fireEvent.change(input, { target: { value: "theme" } });
    for (const role of ["dialog", "alertdialog", "menu", "listbox"]) {
      const overlay = document.createElement("div");
      overlay.setAttribute("role", role);
      overlay.tabIndex = -1;
      document.body.append(overlay);
      overlay.focus();
      fireEvent.keyDown(overlay, { key: "Escape" });
      fireEvent.keyDown(overlay, { key: "Escape" });
      fireEvent.keyDown(overlay, { key: "f", metaKey: isMac, ctrlKey: !isMac });
      expect(input.value).toBe("theme");
      expect(document.activeElement).toBe(overlay);
      expect(onBack).not.toHaveBeenCalled();
      overlay.remove();
    }
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(onBack).not.toHaveBeenCalled();
  });

  it("leaves Settings open on Escape while an overlay is open and nothing is searched", () => {
    const onBack = vi.fn();
    render(<SettingsPage initialTab="appearance" onBack={onBack} />);
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    document.body.append(overlay);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onBack).not.toHaveBeenCalled();
    } finally {
      overlay.remove();
    }
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("does not navigate on an IME's Enter and clears search for an external open request", () => {
    const { rerender } = render(<SettingsPage initialTab="general" openRequest={1} onBack={vi.fn()} />);
    const input = search();
    fireEvent.change(input, { target: { value: "theme" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(screen.getAllByRole("option")[0].textContent).toContain("Theme");
    rerender(<SettingsPage initialTab="general" openRequest={2} onBack={vi.fn()} />);
    expect(input.value).toBe("");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2 }));
  });
});

describe("Website links", () => {
  it("offers all three browser modes and can turn the chooser back on", () => {
    setPrefs({ linkBrowser: "system", linkBrowserChosen: false });
    render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
    expect(getPrefs().linkBrowserChosen).toBe(false);
    const choices = within(screen.getByRole("radiogroup", { name: "Website links" })).getAllByRole("radio");
    expect(choices.map((choice) => choice.textContent)).toEqual(["Ask every time", "System Browser", "TerminalX Browser"]);
    for (const [index, value] of [[2, "terminalx"], [1, "system"], [0, "ask"]] as const) {
      fireEvent.click(choices[index]);
      expect(getPrefs()).toMatchObject({ linkBrowser: value, linkBrowserChosen: true });
      expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).toMatchObject({ linkBrowser: value, linkBrowserChosen: true });
      expect(choices[index].getAttribute("aria-checked")).toBe("true");
    }
  });
});

describe("Autocorrect (#525)", () => {
  it("is a switch in General, after Fold tool calls, off until turned on, and saves the choice", () => {
    setPrefs({ autocorrect: false });
    render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
    const toggle = screen.getByRole("switch", { name: "Autocorrect" });
    expect(screen.getByText("Fold tool calls").compareDocumentPosition(screen.getByText("Autocorrect")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(getPrefs().autocorrect).toBe(true);
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).autocorrect).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(getPrefs().autocorrect).toBe(false);
  });
});

describe("Settings dismissal", () => {
  it("leaves by one Back, at the head of its menu", () => {
    const onBack = vi.fn();
    render(<SettingsPage initialTab="appearance" onBack={onBack} />);

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("dismisses with Escape and unregisters when Settings unmounts", () => {
    const onBack = vi.fn();
    const { unmount } = render(<SettingsPage initialTab="appearance" onBack={onBack} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Appearance" }), { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("lets an open dialog handle Escape before closing Settings", () => {
    const onBack = vi.fn();
    function SettingsWithDialog() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <SettingsPage initialTab="appearance" onBack={onBack} />
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Settings overlay</DialogTitle>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<SettingsWithDialog />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("the section Settings opens on", () => {
  // PRO-374: the general way into Settings shows General, first in the menu (it was Account, PRO-81).
  it("is General when no section is asked for", () => {
    render(<SettingsPage onBack={vi.fn()} />);
    expect(DEFAULT_SETTINGS_TAB).toBe("general");
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
    expect(screen.getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "page")).toHaveLength(1);
  });

  it("is the section asked for, with that one selected", () => {
    render(<SettingsPage initialTab="agents" onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Account" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Agents");
  });

  // Review of #269: with Settings open and another section picked by hand, the shortcut did nothing.
  it("goes back to the section asked for when Settings is asked for again while open", () => {
    const { rerender } = render(<SettingsPage openRequest={1} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Appearance");
    // Re-rendering alone keeps the reader's choice…
    rerender(<SettingsPage openRequest={1} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Appearance");
    // …asking for Settings again does not.
    rerender(<SettingsPage openRequest={2} onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
    // The same for a section asked for by name twice.
    rerender(<SettingsPage initialTab="agents" openRequest={3} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    rerender(<SettingsPage initialTab="agents" openRequest={4} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Agents");
  });

  it("is General, not a blank page, when it is handed something that names no section", () => {
    // What a click handler passes along: the click's event (O1 of the live check).
    const event = { type: "click" } as unknown as Parameters<typeof SettingsPage>[0]["initialTab"];
    render(<SettingsPage initialTab={event} onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
  });
});

describe("Usage auto-refresh interval", () => {
  it("offers Off and four intervals, starts at one minute, and saves the one chosen", async () => {
    const saved: unknown[] = [];
    const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown };
    const previous = tauri.__TAURI_INTERNALS__;
    tauri.__TAURI_INTERNALS__ = {
      transformCallback: () => 0,
      invoke: async (command: string, args: { patch?: Record<string, unknown> }) => {
        if (command !== "set_status_bar_settings") throw new Error(`unexpected ${command}`);
        saved.push(args.patch);
        return { visible: true, usage: true, resources: true, percent: "used", usageMode: "detailed", usageRefreshMinutes: 1, ...args.patch };
      },
    };
    try {
      render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
      const group = screen.getByRole("radiogroup", { name: "Usage auto-refresh interval" });
      const choices = within(group).getAllByRole("radio");
      expect(choices.map((choice) => choice.textContent)).toEqual(["Off", "1 min", "2 min", "5 min", "15 min"]);
      expect(choices[1].getAttribute("aria-checked")).toBe("true");
      for (const [index, minutes] of [[3, 5], [0, 0], [1, 1]] as const) {
        fireEvent.click(choices[index]);
        // Applied at once, before the save answers.
        expect(choices[index].getAttribute("aria-checked")).toBe("true");
        await screen.findByRole("radiogroup", { name: "Usage auto-refresh interval" });
        expect(saved.at(-1)).toEqual({ usageRefreshMinutes: minutes });
      }
    } finally {
      tauri.__TAURI_INTERNALS__ = previous;
    }
  });
});

describe("grouped settings navigation and row links (PRO-123)", () => {
  it("shows all four navigation groups and keeps their section destinations", () => {
    render(<SettingsPage onBack={vi.fn()} />);
    const nav = within(screen.getByRole("navigation", { name: "Settings sections" }));
    for (const group of ["Personal", "Agents & environment", "Projects & organizations", "More"]) expect(nav.getByRole("group", { name: group })).toBeTruthy();
    expect(within(nav.getByRole("group", { name: "Personal" })).getByRole("button", { name: "Appearance" })).toBeTruthy();
    // PRO-464: Projects and Organizations are one closed row each under one heading.
    const both = within(nav.getByRole("group", { name: "Projects & organizations" }));
    for (const name of [/^Projects/, /^Organizations/]) expect(both.getByRole("button", { name }).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens and focuses a row, keeps manual navigation, and handles a repeated request", () => {
    const view = render(<SettingsPage initialTab="general.textSize" openRequest={1} onBack={vi.fn()} />);
    const row = () => view.container.querySelector('[data-setting-id="general.textSize"]');
    expect(document.activeElement).toBe(row());
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    view.rerender(<SettingsPage initialTab="general.textSize" openRequest={1} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Appearance");
    view.rerender(<SettingsPage initialTab="general.textSize" openRequest={2} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
    expect(document.activeElement).toBe(row());
  });

  it("keeps row controls connected to the original preference keys", () => {
    setPrefs({ fontScale: "md", transcriptLayout: "wide" });
    render(<SettingsPage initialTab="general.textSize" onBack={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Text size" })).getByRole("radio", { name: "Large" }));
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).fontScale).toBe("lg");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Transcript layout" })).getByRole("radio", { name: "Chat" }));
    expect(getPrefs().transcriptLayout).toBe("chat");
  });

  it("clears an active search and focuses and highlights a repeated external row link", () => {
    const view = render(<SettingsPage initialTab="general.textSize" openRequest={1} onBack={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Search settings" });
    input.focus();
    fireEvent.change(input, { target: { value: "theme" } });
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    expect(view.container.querySelector("[data-setting-highlight]")).toBeNull();

    view.rerender(<SettingsPage initialTab="general.textSize" openRequest={2} onBack={vi.fn()} />);

    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(view.container.querySelector('[data-setting-id="general.textSize"]'));
    expect(view.container.querySelector<HTMLElement>('[data-setting-id="general.textSize"]')!.dataset.settingHighlight).toBe("on");
  });
});

it("does not move focus out of an open dialog when a row link arrives", () => {
  function WithDialog() {
    return <>
      <SettingsPage initialTab="general.textSize" onBack={vi.fn()} />
      <Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>Confirm sign in</DialogTitle><button>Continue</button></DialogContent></Dialog>
    </>;
  }
  render(<WithDialog />);
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
});


describe("consolidated page introductions (#1152)", () => {
  it.each(["machines", "agents"] as const)("renders one %s description associated with its heading", async (section) => {
    render(<SettingsPage initialTab={section} onBack={vi.fn()} />);
    const heading = screen.getByRole("heading", { level: 2, name: SETTINGS_SECTIONS[section].title });
    const description = document.getElementById(heading.getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain(SETTINGS_SECTIONS[section].subtitle);
    expect(screen.getAllByText(SETTINGS_SECTIONS[section].subtitle, { exact: false })).toHaveLength(1);
    if (section === "machines") expect(within(description!).getByRole("button", { name: "Machines guide" })).toBeTruthy();
    await act(async () => {});
  });

  it("retains the complete introduction when Agents is rendered standalone", async () => {
    render(<AgentsTab />);
    expect(screen.getByText(SETTINGS_SECTIONS.agents.subtitle)).toBeTruthy();
    await act(async () => {});
  });
});

// #1131: hints follow the bound action: ⌥⌘T on macOS, Ctrl+Alt+Shift+L elsewhere, or what the reader saved.
describe("light/dark shortcut hints", () => {
  it("keeps Appearance and Shortcuts in sync through customization, removal and reset", () => {
    const shipped = isMac ? "mod+alt+t" : "mod+alt+shift+l";
    const other = isMac ? "mod+alt+shift+l" : "mod+alt+t";
    setTheme("den");
    setPrefs({ shortcuts: {} });
    render(<><AppearanceTab /><ShortcutsTab /></>);
    const assertHint = (binding: string) => {
      const text = bindingText(binding);
      expect(screen.getByText(`${text} switches light and dark`)).toBeTruthy();
      expect(screen.getByRole("button", { name: `Switch light and dark: ${text}. Change` })).toBeTruthy();
    };
    assertHint(shipped);
    expect(screen.queryByText(`${bindingText(other)} switches light and dark`)).toBeNull();
    act(() => { expect(saveShortcut("app.toggleMode", ["mod+alt+shift+f6"])).toEqual({ ok: true }); });
    assertHint("mod+alt+shift+f6");
    expect(screen.queryByText(`${bindingText(shipped)} switches light and dark`)).toBeNull();
    act(() => { expect(saveShortcut("app.toggleMode", [])).toEqual({ ok: true }); });
    expect(screen.queryByText(/switches light and dark/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Switch light and dark: .*Change$/ })).toBeNull();
    act(() => { expect(resetShortcut("app.toggleMode")).toEqual({ ok: true }); });
    assertHint(shipped);
  });
});

// PRO-463, design 09.44: Stats & usage is a page of Settings, in Personal after Machines.
describe("Settings · Stats & usage", () => {
  it("is listed after Machines, draws its title and Refresh at the top, and is wider than the other pages", async () => {
    const state = { scope: "test", generation: 1, snapshot: null, refreshing: false, error: null };
    vi.spyOn(api, "statsUsageSnapshot").mockResolvedValue(state as never);
    vi.spyOn(api, "statsUsageRefresh").mockResolvedValue(state as never);
    render(<TooltipProvider><SettingsPage initialTab="stats" onBack={vi.fn()} /></TooltipProvider>);
    const menu = screen.getByRole("group", { name: "Personal" });
    const items = within(menu).getAllByRole("button").map((button) => button.textContent);
    expect(items.indexOf("Stats & usage")).toBe(items.indexOf("Machines") + 1);
    expect(screen.getByRole("heading", { level: 2, name: "Stats & usage" })).toBeTruthy();
    expect(screen.getByText(SETTINGS_SECTIONS.stats.subtitle)).toBeTruthy();
    const refresh = await screen.findByRole("button", { name: "Refresh local analytics" });
    // Beside the title, not inside the page's content.
    expect(refresh.closest("[data-setting-id]")).toBeNull();
    expect(document.querySelector('[data-search-page="stats"]')!.className).toContain("max-w-[58rem]");
    for (const id of ["stats.activity", "stats.accountLimits", "stats.analytics"]) expect(document.querySelector(`[data-setting-id="${id}"]`)).toBeTruthy();
  });

  it("opens from a link to General's old Usage row", () => {
    vi.spyOn(api, "statsUsageSnapshot").mockReturnValue(new Promise(() => {}) as never);
    vi.spyOn(api, "statsUsageRefresh").mockReturnValue(new Promise(() => {}) as never);
    render(<TooltipProvider><SettingsPage initialTab={"general.openUsage" as SettingsTab} onBack={vi.fn()} /></TooltipProvider>);
    expect(screen.getByRole("heading", { level: 2, name: "Stats & usage" })).toBeTruthy();
  });
});
