import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The window's own buttons where the app draws its title bar (Windows, Linux): only the strip at the top right shows
// them, they call the window, and macOS keeps its traffic lights.
const mocks = vi.hoisted(() => ({
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  isMaximized: vi.fn(async () => false),
  hide: vi.fn(async () => undefined),
  floating: false,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: mocks.minimize, toggleMaximize: mocks.toggleMaximize, close: mocks.close, isMaximized: mocks.isMaximized, onResized: async () => () => undefined }),
}));
vi.mock("@/lib/api", () => ({ floatingWindow: { hide: mocks.hide } }));
vi.mock("@/lib/appWindow", () => ({ inAppWindow: () => true, isFloatingWindow: () => mocks.floating }));

const { WindowControls } = await import("./WindowControls");

/** A top strip at `right` px of a 1000 px wide window. */
function strip(right: number, top = 0) {
  const view = render(<header style={{ paddingRight: "8px" }}><WindowControls mac={false} /></header>);
  const header = view.container.querySelector("header")!;
  header.getBoundingClientRect = () => ({ top, right, width: right, left: 0, bottom: 40, height: 40, x: 0, y: top, toJSON: () => ({}) });
  return view;
}

beforeEach(() => {
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
  mocks.floating = false;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("WindowControls", () => {
  it("shows Minimize, Maximize and Close in the strip at the window's top right, and they work the window", async () => {
    const view = strip(1000);
    // The strip is measured when it mounts; a resize measures it again.
    await act(async () => { globalThis.dispatchEvent(new Event("resize")); });
    expect(view.getByTestId("window-controls").style.marginRight).toBe("-8px");
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(mocks.minimize).toHaveBeenCalledOnce();
    expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("shows nothing in a strip that does not reach the top right corner, and takes no room in it", async () => {
    strip(640);
    await act(async () => { globalThis.dispatchEvent(new Event("resize")); });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByTestId("window-controls").className).toContain("hidden");
  });

  it("gives the floating panel Close only, which hides it", async () => {
    mocks.floating = true;
    strip(1000);
    await act(async () => { globalThis.dispatchEvent(new Event("resize")); });
    expect(screen.queryByRole("button", { name: "Minimize" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("draws nothing on a Mac", () => {
    render(<header><WindowControls mac /></header>);
    expect(screen.queryByTestId("window-controls")).toBeNull();
  });
});
