import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppWindow } from "./appWindow";

const f = vi.hoisted(() => ({
  permission: vi.fn<() => Promise<boolean>>(),
  request: vi.fn<() => Promise<string>>(),
  send: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: f.permission,
  requestPermission: f.request,
  sendNotification: f.send,
}));

const realAdd = window.addEventListener.bind(window);
const listeners: [string, EventListenerOrEventListenerObject][] = [];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  f.permission.mockResolvedValue(true);
  f.request.mockResolvedValue("denied");
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    listeners.push([type, listener]);
    realAdd(type, listener, options);
  }) as typeof window.addEventListener;
});
afterEach(() => {
  for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener);
  window.addEventListener = realAdd;
  vi.restoreAllMocks();
});

async function boot({ mac = true, focused = false, label = "main" }: { mac?: boolean; focused?: boolean; label?: AppWindow } = {}) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(mac ? "MacIntel" : "Win32");
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  (await import("./appWindow")).setAppWindowForTest(label);
  return (await import("./notify")).notifyOrganizationEvent;
}

describe("organization event banners", () => {
  it("sends generic copy for each authorized event while the main macOS window is away", async () => {
    const notify = await boot();
    await notify("share-added", () => true);
    await notify("reassigned", () => true);
    expect(f.send.mock.calls).toEqual([
      [{ title: "Workspace shared with you", body: "Open TerminalX to view the workspace." }],
      [{ title: "Workspace reassigned to you", body: "Open TerminalX to view the workspace." }],
    ]);
  });

  it.each([
    { mac: false },
    { label: "chat-other" as const },
    { focused: true },
  ])("does not ask for permission or send in %j", async (options) => {
    const notify = await boot(options);
    await notify("share-added", () => true);
    expect(f.permission).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("suppresses banners while another app window is focused", async () => {
    const notify = await boot();
    localStorage.setItem("raccoon.presence.floating", JSON.stringify({ focused: true }));
    await notify("share-added", () => true);
    expect(f.permission).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("honors denied notification permission", async () => {
    const notify = await boot();
    f.permission.mockResolvedValue(false);
    await notify("share-added", () => true);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(["focus returned", "access changed"])("rechecks after a permission wait when %s", async (change) => {
    const notify = await boot();
    let grant!: (value: boolean) => void;
    f.permission.mockReturnValueOnce(new Promise((resolve) => { grant = resolve; }));
    let authorized = true;
    const delivery = notify("share-added", () => authorized);
    if (change === "focus returned") window.dispatchEvent(new Event("focus"));
    else authorized = false;
    grant(true);
    await delivery;
    expect(f.send).not.toHaveBeenCalled();
  });
});
