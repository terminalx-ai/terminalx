import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn(async () => undefined), getIdentifier: vi.fn(async () => "com.terminalx.next") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@tauri-apps/api/app", () => ({ getIdentifier: mocks.getIdentifier }));

const { NotificationsOffCard, showNotificationsOff, notificationsOffHidden, resetNotificationsOffForTest } = await import("./NotificationsOffCard");

afterEach(() => {
  cleanup();
  act(() => resetNotificationsOffForTest());
  mocks.openUrl.mockReset().mockResolvedValue(undefined);
  delete window.__TERMINALX_PLATFORM__;
});

const raise = (sessionTitle = "Show the diff inside edit approvals") => act(() => showNotificationsOff({ sessionId: "s1", sessionTitle }));

describe("Notifications are off for TerminalX", () => {
  it("shows nothing until a session needing the reader finds notifications off", () => {
    render(<NotificationsOffCard />);
    expect(screen.queryByRole("alert")).toBeNull();
    raise();
    const card = screen.getByRole("alert");
    expect(card.textContent).toContain("Notifications are off for TerminalX");
    expect(card.textContent).toContain("“Show the diff inside edit approvals” needs your approval, but Linux blocks TerminalX notifications.");
    // The bell-off icon is amber, as screen 17.12 draws it (PRO-400 kept the screen's colour over its table's).
    expect(card.querySelector("[data-notifications-off-icon]")!.getAttribute("class")).toContain("text-warning");
  });

  it("opens the app's own page under System Settings › Notifications on macOS", async () => {
    window.__TERMINALX_PLATFORM__ = "macos";
    render(<NotificationsOffCard />);
    raise();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open System Settings" })); });
    expect(mocks.openUrl).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.terminalx.next");
    // Opening System Settings is not an answer: the card stays until they are allowed.
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("opens Windows notification settings on Windows and surfaces opener errors", async () => {
    window.__TERMINALX_PLATFORM__ = "windows";
    render(<NotificationsOffCard />);
    raise();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open Notification Settings" })); });
    expect(mocks.openUrl).toHaveBeenCalledWith("ms-settings:notifications");

    mocks.openUrl.mockRejectedValueOnce(new Error("blocked"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open Notification Settings" })); });
    expect(screen.getByRole("status").textContent).toContain("Could not open Windows Settings");
  });

  it("shows desktop guidance instead of a macOS URL button on Linux", () => {
    window.__TERMINALX_PLATFORM__ = "linux";
    render(<NotificationsOffCard />);
    raise();
    expect(screen.queryByRole("button", { name: /Open .*Settings/ })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("desktop environment’s Settings › Notifications");
  });

  it("\"Not now\" hides it for the rest of the run", () => {
    render(<NotificationsOffCard />);
    raise();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(notificationsOffHidden()).toBe(true);
    raise("Another session");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closing it waits for the next session that needs the reader", () => {
    render(<NotificationsOffCard />);
    raise();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(notificationsOffHidden()).toBe(false);
    raise("Another session");
    expect(screen.getByRole("alert").textContent).toContain("“Another session”");
  });

  it("speaks of a session without a title", () => {
    render(<NotificationsOffCard />);
    raise("  ");
    expect(screen.getByRole("alert").textContent).toContain("“A session” needs your approval");
  });
});
