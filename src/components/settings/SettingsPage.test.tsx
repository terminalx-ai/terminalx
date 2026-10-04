import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DEFAULT_SETTINGS_TAB, SettingsPage } from "./SettingsPage";
import { getPrefs } from "@/lib/prefs";

afterEach(cleanup);

it("records an explicit browser choice only when the Website links control is used", () => {
  render(<SettingsPage initialTab="general" onBack={vi.fn()} />);
  expect(getPrefs()).toMatchObject({ linkBrowser: "system", linkBrowserChosen: false });

  fireEvent.click(screen.getByRole("radio", { name: "TerminalX Browser" }));
  expect(getPrefs()).toMatchObject({ linkBrowser: "terminalx", linkBrowserChosen: true });
  expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).toMatchObject({ linkBrowser: "terminalx", linkBrowserChosen: true });

  fireEvent.click(screen.getByRole("radio", { name: "System Browser" }));
  expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).toMatchObject({ linkBrowser: "system", linkBrowserChosen: true });
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
