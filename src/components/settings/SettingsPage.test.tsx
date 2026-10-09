import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DEFAULT_SETTINGS_TAB, SettingsPage } from "./SettingsPage";
import { getPrefs, setPrefs } from "@/lib/prefs";

afterEach(cleanup);

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
