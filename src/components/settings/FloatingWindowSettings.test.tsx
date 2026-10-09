import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));

let status: { shortcut: string | null; alwaysOnTop: boolean; retentionDays: number; shortcutError: string | null };
/** What the system says when it is asked to register a shortcut; null registers it. */
let taken: string | null;

async function mount(which: "shortcut" | "general") {
  vi.resetModules();
  const { SystemShortcutSection, QuickChatSettings } = await import("./FloatingWindowSettings");
  const utils = render(which === "shortcut" ? <SystemShortcutSection /> : <QuickChatSettings />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("floating_status"));
  return utils;
}

const patches = () => mocks.invoke.mock.calls.filter(([command]) => command === "set_floating_settings").map(([, args]) => (args as { patch: unknown }).patch);

beforeEach(() => {
  localStorage.clear();
  mocks.listeners.clear();
  status = { shortcut: "alt+shift+space", alwaysOnTop: true, retentionDays: 30, shortcutError: null };
  taken = null;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: { patch?: { shortcut?: string; alwaysOnTop?: boolean; retentionDays?: number } } = {}) => {
    if (command === "floating_status") return status;
    if (command === "set_floating_settings") {
      const patch = args.patch ?? {};
      // The backend refuses what can never be a system-wide shortcut, before saving it.
      if (patch.shortcut === "shift+a") throw "A system-wide shortcut needs Command, Control or Option.";
      status = {
        ...status,
        ...(patch.shortcut !== undefined ? { shortcut: patch.shortcut || null, shortcutError: patch.shortcut ? taken : null } : {}),
        ...(patch.alwaysOnTop !== undefined ? { alwaysOnTop: patch.alwaysOnTop } : {}),
        ...(patch.retentionDays !== undefined ? { retentionDays: patch.retentionDays } : {}),
      };
      return status;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  cleanup();
});

describe("the floating window's system-wide shortcut", () => {
  it("shows the shortcut, and records a new one from the keys pressed", async () => {
    await mount("shortcut");
    expect(await screen.findByRole("button", { name: /^Change (⌥⇧Space|Alt\+Shift\+Space)$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const recorder = await screen.findByRole("button", { name: "Press the new shortcut" });
    // A modifier on its way down is not the shortcut yet.
    fireEvent.keyDown(recorder, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(patches()).toEqual([]);
    fireEvent.keyDown(recorder, { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    await waitFor(() => expect(patches()).toEqual([{ shortcut: "mod+alt+k" }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Press the new shortcut" })).toBeNull());
  });

  it("refuses keys that would be taken from every other app, without asking the backend", async () => {
    await mount("shortcut");
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.keyDown(await screen.findByRole("button", { name: "Press the new shortcut" }), { key: "A", code: "KeyA", shiftKey: true });
    expect((await screen.findByTestId("system-shortcut-error")).textContent).toContain("A system-wide shortcut needs");
    expect(patches()).toEqual([]);
    // Escape gives up and leaves the shortcut as it was.
    fireEvent.keyDown(screen.getByRole("button", { name: "Press the new shortcut" }), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Press the new shortcut" })).toBeNull());
    expect(status.shortcut).toBe("alt+shift+space");
  });

  it("says so when the system will not register it, and keeps saying so until it is changed or turned off", async () => {
    taken = "⌃⌥K could not be registered; another app may already use it.";
    await mount("shortcut");
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.keyDown(await screen.findByRole("button", { name: "Press the new shortcut" }), { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    expect((await screen.findByRole("alert")).textContent).toContain("another app may already use it");

    // Turned off: nothing is registered, so there is nothing to fail.
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(patches()).toEqual([{ shortcut: "mod+alt+k" }, { shortcut: "" }]));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("Off")).toBeTruthy();

    // And back on with the default.
    taken = null;
    fireEvent.click(screen.getByRole("button", { name: /^Use / }));
    await waitFor(() => expect(patches().at(-1)).toEqual({ shortcut: "alt+shift+space" }));
  });

  it("shows a failure found at launch, and follows a change made from the other window", async () => {
    status = { ...status, shortcutError: "System-wide shortcuts are not available under Wayland." };
    await mount("shortcut");
    expect((await screen.findByRole("alert")).textContent).toContain("Wayland");
    mocks.listeners.get("floating_status")?.({ payload: { ...status, shortcut: "mod+shift+k", shortcutError: null } });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("quick chat settings", () => {
  it("pins the window on top or lets it go behind", async () => {
    await mount("general");
    const pin = await screen.findByRole("switch");
    await waitFor(() => expect(pin.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(pin);
    await waitFor(() => expect(patches()).toEqual([{ alwaysOnTop: false }]));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
  });

  it("sets how long idle quick chats are kept, including for ever", async () => {
    await mount("general");
    fireEvent.click(await screen.findByRole("radio", { name: "7 days" }));
    fireEvent.click(screen.getByRole("radio", { name: "For ever" }));
    await waitFor(() => expect(patches()).toEqual([{ retentionDays: 7 }, { retentionDays: 0 }]));
  });

  it("shows a number of days set outside the usual choices as it is", async () => {
    status = { ...status, retentionDays: 14 };
    await mount("general");
    expect((await screen.findByRole("radio", { name: "14 days" })).getAttribute("aria-checked")).toBe("true");
  });
});
