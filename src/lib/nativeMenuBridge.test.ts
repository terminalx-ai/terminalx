import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { setPrefs } from "./prefs";
import { registerShortcut, suspendHotkeys } from "./hotkeys";
import { saveShortcut } from "./shortcuts";
import { setAppWindowForTest } from "./appWindow";
import { dispatchNativeMenu, startNativeMenu, useNativeMenus } from "./nativeMenuBridge";
import type { NativeMenuGroup } from "./nativeMenu";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(),
  unlisten: vi.fn(),
  openProject: vi.fn(),
  projects: [{ path: "/repo", name: "Project" }],
  changes: new Set<() => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ listen: mocks.listen }) }));
vi.mock("./sessions", () => ({
  getSessionStore: () => ({ projects: mocks.projects }),
  openProjectOverview: mocks.openProject,
  subscribeSessionStore: (listener: () => void) => { mocks.changes.add(listener); return () => mocks.changes.delete(listener); },
}));

const cleanups: (() => void)[] = [];
function settingsItem() {
  const groups: NativeMenuGroup[] = mocks.invoke.mock.lastCall![1].groups;
  return groups[0].items.find((item) => item.id.endsWith(":app.settings"))!;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue(mocks.unlisten);
  setAppWindowForTest("main");
  setPrefs({ shortcuts: {} });
});
afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  setAppWindowForTest(null);
});

describe("native menu integration", () => {
  it("invokes the same registered handler as the shortcut, and keeps an unbound menu action usable", () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut("app.settings", handler));
    dispatchNativeMenu("app.settings");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(handler).toHaveBeenCalledTimes(2);
    saveShortcut("app.settings", []);
    dispatchNativeMenu("app.settings");
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("follows rebinding and reset without reinstalling the listener", async () => {
    cleanups.push(startNativeMenu());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    expect(settingsItem().accelerator).toBe("CmdOrCtrl+Comma");
    saveShortcut("app.settings", ["mod+shift+y"]);
    await waitFor(() => expect(settingsItem().accelerator).toBe("CmdOrCtrl+Shift+Y"));
    saveShortcut("app.settings", []);
    await waitFor(() => expect(settingsItem().accelerator).toBeNull());
    setPrefs({ shortcuts: {} });
    await waitFor(() => expect(settingsItem().accelerator).toBe("CmdOrCtrl+Comma"));
    expect(mocks.listen).toHaveBeenCalledTimes(1);
  });

  it("updates on cross-window preference changes", async () => {
    cleanups.push(startNativeMenu());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    // The preferences store listens to storage events from the other webview.
    saveShortcut("app.settings", ["mod+shift+y"]);
    await waitFor(() => expect(settingsItem().accelerator).toBe("CmdOrCtrl+Shift+Y"));
    const key = Object.keys(localStorage).find((key) => localStorage.getItem(key)?.includes('"shortcuts"'))!;
    const prefs = JSON.parse(localStorage.getItem(key)!);
    prefs.shortcuts = { "app.settings": ["mod+shift+g"] };
    localStorage.setItem(key, JSON.stringify(prefs));
    window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
    await waitFor(() => expect(settingsItem().accelerator).toBe("CmdOrCtrl+Shift+G"));
  });

  it("serializes updates while an older native replacement is still in flight", async () => {
    let finish!: () => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    cleanups.push(startNativeMenu());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    saveShortcut("app.settings", ["mod+shift+y"]);
    saveShortcut("app.settings", []);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(3));
    expect(settingsItem().accelerator).toBeNull();
  });

  it("gives the shortcut recorder the keys, and restores native accelerators when it closes", async () => {
    const handler = vi.fn();
    cleanups.push(registerShortcut("app.settings", handler), startNativeMenu());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    const resume = suspendHotkeys();
    cleanups.push(resume);
    await waitFor(() => expect(settingsItem().accelerator).toBeNull());
    dispatchNativeMenu("app.settings");
    expect(handler).not.toHaveBeenCalled();
    resume();
    await waitFor(() => expect(settingsItem().accelerator).toBe("CmdOrCtrl+Comma"));
    dispatchNativeMenu("app.settings");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("dispatches recent projects only while they still exist", () => {
    dispatchNativeMenu("recent:/repo");
    dispatchNativeMenu("recent:/removed");
    dispatchNativeMenu("unrecognized-action");
    expect(mocks.openProject).toHaveBeenCalledExactlyOnceWith("/repo");
  });

  it("listens in the floating window without replacing the main window's menu", async () => {
    setAppWindowForTest("floating");
    cleanups.push(startNativeMenu());
    await Promise.resolve();
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each(["floating", "chat-test"] as const)("forwards all main-window bindings from %s and follows rebinding", async (label) => {
    setAppWindowForTest(label);
    setPrefs({ shortcuts: { "app.settings": ["mod+,", "mod+shift+y"] } });
    cleanups.push(startNativeMenu());
    await Promise.resolve();
    const press = (key: string) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    press("y");
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("forward_menu_action", { action: "app.settings" });
    setPrefs({ shortcuts: { "app.settings": ["mod+,", "mod+shift+g"] } });
    press("y");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    press("g");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    const resume = suspendHotkeys();
    cleanups.push(resume);
    press("g");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it.each(["main", "floating", "chat-test"] as const)("creates a new chat window on each menu or configured shortcut invocation from %s", async (label) => {
    setAppWindowForTest(label);
    setPrefs({ shortcuts: { "app.newWindow": ["mod+alt+n"] } });
    const { unmount } = renderHook(useNativeMenus);
    cleanups.push(unmount);
    await Promise.resolve();
    dispatchNativeMenu("app.newWindow");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    if (label === "main") {
      expect(mocks.invoke.mock.calls.filter(([name]) => name === "new_chat_window")).toHaveLength(2);
    } else {
      expect(mocks.invoke).toHaveBeenNthCalledWith(1, "forward_menu_action", { action: "app.newWindow" });
      expect(mocks.invoke).toHaveBeenNthCalledWith(2, "forward_menu_action", { action: "app.newWindow" });
      expect(mocks.invoke).not.toHaveBeenCalledWith("new_chat_window");
    }
    expect(mocks.invoke).not.toHaveBeenCalledWith("floating_show", expect.anything());
  });

  it.each(["main", "floating", "chat-test"] as const)("routes the Start from menu and default shortcut from %s to the main composer", async (label) => {
    setAppWindowForTest(label);
    const startFrom = vi.fn();
    if (label === "main") cleanups.push(registerShortcut("app.startFrom", startFrom));
    const { unmount } = renderHook(useNativeMenus);
    cleanups.push(unmount);
    await Promise.resolve();
    dispatchNativeMenu("app.startFrom");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "N", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    if (label === "main") expect(startFrom).toHaveBeenCalledTimes(2);
    else expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "forward_menu_action" && args.action === "app.startFrom")).toHaveLength(2);
    expect(mocks.invoke).not.toHaveBeenCalledWith("new_chat_window");
  });

  it("cleans up a listener that finishes after unmount and does not install a stale menu", async () => {
    let finish!: (unlisten: () => void) => void;
    mocks.listen.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const stop = startNativeMenu();
    stop();
    finish(mocks.unlisten);
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalledOnce());
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.changes.size).toBe(0);
  });
});
