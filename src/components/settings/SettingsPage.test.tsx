import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DEFAULT_SETTINGS_TAB, SettingsPage } from "./SettingsPage";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { isMac } from "@/lib/hotkeys";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});

afterEach(cleanup);

describe("Settings search", () => {
  it("focuses with the find shortcut, highlights font matches, and opens the section with Enter", () => {
    render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Search settings" });
    fireEvent.keyDown(document.body, { key: "f", metaKey: isMac, ctrlKey: !isMac });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "font" } });
    const result = screen.getByRole("option", { name: /Appearance/ });
    expect(result.querySelector("mark")?.textContent).toBe("font");
    expect(input.getAttribute("aria-activedescendant")).toBe(result.id);
    result.closest("section")!.scrollTop = 400;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Appearance");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2 }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).closest("section")!.scrollTop).toBe(0);
  });

  it("wraps arrow navigation, resets selection when edited, and opens a clicked result", () => {
    render(<SettingsPage initialTab="appearance" onBack={vi.fn()} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "a" } });
    const results = screen.getAllByRole("option");
    expect(results.length).toBeGreaterThan(2);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(results.at(-1)!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(results[0].id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(results[1].id);
    fireEvent.change(input, { target: { value: "hotkeys" } });
    const result = screen.getByRole("option", { name: /Shortcuts/ });
    expect(input.getAttribute("aria-activedescendant")).toBe(result.id);
    fireEvent.click(result);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Shortcuts");
  });

  it("clears an empty-result search with Escape before closing Settings", () => {
    const onBack = vi.fn();
    render(<SettingsPage initialTab="appearance" onBack={onBack} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "zzzz-no-such-setting" } });
    expect(screen.getByRole("status").textContent).toBe("No settings match zzzz-no-such-setting");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("lets overlays keep Escape and find while search is active", () => {
    const onBack = vi.fn();
    render(<SettingsPage initialTab="appearance" onBack={onBack} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "font" } });
    for (const role of ["dialog", "alertdialog", "menu", "listbox"]) {
      const overlay = document.createElement("div");
      overlay.setAttribute("role", role);
      overlay.tabIndex = -1;
      document.body.append(overlay);
      overlay.focus();
      fireEvent.keyDown(overlay, { key: "Escape" });
      fireEvent.keyDown(overlay, { key: "f", metaKey: isMac, ctrlKey: !isMac });
      expect((input as HTMLInputElement).value).toBe("font");
      expect(document.activeElement).toBe(overlay);
      expect(onBack).not.toHaveBeenCalled();
      overlay.remove();
    }
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(onBack).not.toHaveBeenCalled();
  });

  it("does not navigate on an IME's Enter and clears search for an external open request", () => {
    const { rerender } = render(<SettingsPage initialTab="general" openRequest={1} onBack={vi.fn()} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "font" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(screen.getByRole("option", { name: /Appearance/ })).toBeTruthy();
    rerender(<SettingsPage initialTab="general" openRequest={2} onBack={vi.fn()} />);
    expect((input as HTMLInputElement).value).toBe("");
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
  it("offers Close and keeps Back working", () => {
    const onBack = vi.fn();
    render(<SettingsPage initialTab="appearance" onBack={onBack} />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to previous page" }));
    expect(onBack).toHaveBeenCalledTimes(2);
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
  // PRO-81: the general way into Settings shows Account.
  it("is Account when no section is asked for", () => {
    render(<SettingsPage onBack={vi.fn()} />);
    expect(DEFAULT_SETTINGS_TAB).toBe("account");
    expect(screen.getByRole("button", { name: "Account" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Account");
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
    expect(screen.getByRole("button", { name: "Account" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Account");
    // The same for a section asked for by name twice.
    rerender(<SettingsPage initialTab="agents" openRequest={3} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    rerender(<SettingsPage initialTab="agents" openRequest={4} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Agents");
  });

  it("is Account, not a blank page, when it is handed something that names no section", () => {
    // What a click handler passes along: the click's event (O1 of the live check).
    const event = { type: "click" } as unknown as Parameters<typeof SettingsPage>[0]["initialTab"];
    render(<SettingsPage initialTab={event} onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Account" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Account");
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
      render(<SettingsPage initialTab="appearance" onBack={vi.fn()} />);
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
  it("shows all five navigation groups and keeps their section destinations", () => {
    render(<SettingsPage onBack={vi.fn()} />);
    const nav = within(screen.getByRole("navigation", { name: "Settings sections" }));
    for (const group of ["Personal", "Agents & environment", "Repositories", "Admin", "More"]) expect(nav.getByRole("group", { name: group })).toBeTruthy();
    expect(within(nav.getByRole("group", { name: "Personal" })).getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(within(nav.getByRole("group", { name: "Admin" })).getByRole("button", { name: "Organizations" })).toBeTruthy();
  });

  it("opens and focuses a row, keeps manual navigation, and handles a repeated request", () => {
    const view = render(<SettingsPage initialTab="appearance.textSize" openRequest={1} onBack={vi.fn()} />);
    const row = () => view.container.querySelector('[data-setting-id="appearance.textSize"]');
    expect(document.activeElement).toBe(row());
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    view.rerender(<SettingsPage initialTab="appearance.textSize" openRequest={1} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
    view.rerender(<SettingsPage initialTab="appearance.textSize" openRequest={2} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Appearance");
    expect(document.activeElement).toBe(row());
  });

  it("keeps row controls connected to the original preference keys", () => {
    setPrefs({ fontScale: "md", transcriptLayout: "wide" });
    render(<SettingsPage initialTab="appearance.textSize" onBack={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Text size" })).getByRole("radio", { name: "Large" }));
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).fontScale).toBe("lg");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Transcript layout" })).getByRole("radio", { name: "Chat" }));
    expect(getPrefs().transcriptLayout).toBe("chat");
  });

  it("clears an active search and focuses a repeated external row link", () => {
    const view = render(<SettingsPage initialTab="appearance.textSize" openRequest={1} onBack={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Search settings" });
    input.focus();
    fireEvent.change(input, { target: { value: "hotkeys" } });
    expect(screen.getByRole("option", { name: /Shortcuts/ })).toBeTruthy();

    view.rerender(<SettingsPage initialTab="appearance.textSize" openRequest={2} onBack={vi.fn()} />);

    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(view.container.querySelector('[data-setting-id="appearance.textSize"]'));
  });
});

it("does not move focus out of an open dialog when a row link arrives", () => {
  function WithDialog() {
    return <>
      <SettingsPage initialTab="appearance.textSize" onBack={vi.fn()} />
      <Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>Confirm sign in</DialogTitle><button>Continue</button></DialogContent></Dialog>
    </>;
  }
  render(<WithDialog />);
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
});
