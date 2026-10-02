import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SettingsPage } from "./SettingsPage";

afterEach(cleanup);

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
  it("is General when no section is asked for", () => {
    render(<SettingsPage onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
  });

  it("is General, not a blank page, when it is handed something that names no section", () => {
    // What a click handler passes along: the click's event (O1 of the live check).
    const event = { type: "click" } as unknown as Parameters<typeof SettingsPage>[0]["initialTab"];
    render(<SettingsPage initialTab={event} onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("General");
  });
});
