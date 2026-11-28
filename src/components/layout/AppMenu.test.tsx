import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

// The app's menu where there is no menu bar (Windows, Linux): the menu bar's groups, each item running its action.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined), dispatch: vi.fn(), setStatusSettings: vi.fn(async () => undefined), statusVisible: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/appWindow", () => ({ inAppWindow: () => true, isCompactWindow: () => false }));
vi.mock("@/lib/nativeMenuBridge", () => ({ dispatchNativeMenu: mocks.dispatch }));
vi.mock("@/lib/status", () => ({
  useStatusSelector: (selector: (s: { settings: { visible: boolean } }) => unknown) => selector({ settings: { visible: mocks.statusVisible } }),
  setStatusSettings: mocks.setStatusSettings,
}));

const { AppMenu, menuAction } = await import("./AppMenu");

afterEach(cleanup);

/** Radix opens a menu on a pointer press, and a submenu on the keyboard's right arrow. */
function open(name: string) {
  const trigger = screen.getByRole(name === "Menu" ? "button" : "menuitem", { name });
  if (name === "Menu") fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  else fireEvent.keyDown(trigger, { key: "ArrowRight" });
}

describe("AppMenu", () => {
  it("lists the menu bar's groups and runs an item's action", async () => {
    render(<TooltipProvider><AppMenu mac={false} /></TooltipProvider>);
    open("Menu");
    for (const group of ["TerminalX", "File", "View", "Go", "Help"]) expect(await screen.findByRole("menuitem", { name: group })).toBeTruthy();
    open("TerminalX");
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Settings/ }));
    expect(mocks.dispatch).toHaveBeenCalledWith("app.settings");
  });

  it("ends TerminalX with Stop all and quit, and Quit, which ask the app to quit", async () => {
    render(<TooltipProvider><AppMenu mac={false} /></TooltipProvider>);
    open("Menu");
    open("TerminalX");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Quit" }));
    expect(mocks.invoke).toHaveBeenCalledWith("app_menu_item", { id: "app-quit" });
  });

  it("is not drawn on a Mac, which has its menu bar", () => {
    render(<TooltipProvider><AppMenu mac /></TooltipProvider>);
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
  });

  it("reads the action out of a menu bar item's id", () => {
    expect(menuAction("command:main:app.settings")).toBe("app.settings");
    expect(menuAction("command:focused:session.closeTab")).toBe("session.closeTab");
    expect(menuAction("recent:/code/web")).toBe("recent:/code/web");
    expect(menuAction("app-quit")).toBeNull();
  });

  it("includes a Status Bar toggle in View", async () => {
    mocks.statusVisible = true;
    mocks.setStatusSettings.mockClear();
    render(<TooltipProvider><AppMenu mac={false} /></TooltipProvider>);
    open("Menu");
    open("View");
    const toggle = await screen.findByRole("menuitemcheckbox", { name: "Status Bar" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(mocks.setStatusSettings).toHaveBeenCalledWith({ visible: false });
  });
});
