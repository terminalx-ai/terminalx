import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The native side: what `settings_link_take` hands out (once), and who listens for its ping.
const native = vi.hoisted(() => ({
  pending: [] as unknown[],
  taken: 0,
  order: [] as string[],
  listeners: new Map<string, Set<() => void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command !== "settings_link_take") throw new Error(`unexpected command ${command}`);
    native.taken += 1;
    native.order.push("take");
    return native.pending.shift() ?? null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    native.order.push(`listen:${event}`);
    const set = native.listeners.get(event) ?? new Set();
    set.add(handler);
    native.listeners.set(event, set);
    return () => set.delete(handler);
  }),
}));

import { getPrefs, setPrefs } from "@/lib/prefs";
import { forgetSettingToasts, getSettingToasts } from "@/lib/settingsToasts";
import {
  SETTINGS_LINK_REQUESTED,
  UNKNOWN_SETTING_LINK_MESSAGE,
  bootSettingDeepLinks,
  dismissUnknownSettingLink,
  followSettingDeepLink,
  getUnknownSettingLink,
} from "./settingsDeepLink";

const ping = () => { for (const handler of native.listeners.get(SETTINGS_LINK_REQUESTED) ?? []) handler(); };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  native.pending = [];
  native.taken = 0;
  native.order = [];
  native.listeners.clear();
  setPrefs({ sounds: false, animations: false, promptMap: false });
});
afterEach(() => {
  forgetSettingToasts();
  dismissUnknownSettingLink();
});

describe("following a setting link", () => {
  it("opens Settings at the row and changes nothing without enable", async () => {
    const open = vi.fn();
    const before = getPrefs();
    await followSettingDeepLink({ id: "general.sounds", enable: false }, open);
    expect(open).toHaveBeenCalledExactlyOnceWith("general.sounds");
    expect(getPrefs()).toBe(before);
    expect(getSettingToasts()).toEqual([]);
    expect(getUnknownSettingLink()).toBeNull();
  });

  it("turns a linkable row on and says so, with the way to it", async () => {
    const open = vi.fn();
    await followSettingDeepLink({ id: "general.sounds", enable: true }, open);
    expect(open).toHaveBeenCalledExactlyOnceWith("general.sounds");
    expect(getPrefs().sounds).toBe(true);
    expect(getSettingToasts().map(({ kind, settingId, message }) => ({ kind, settingId, message }))).toEqual([
      { kind: "enabled", settingId: "general.sounds", message: "Turned on Sounds" },
    ]);
  });

  it("changes nothing for a row that is not linkable, opens it, and says the link can't turn it on", async () => {
    const open = vi.fn();
    const before = getPrefs();
    await followSettingDeepLink({ id: "general.animations", enable: true }, open);
    expect(open).toHaveBeenCalledExactlyOnceWith("general.animations");
    expect(getPrefs()).toBe(before);
    expect(getPrefs().animations).toBe(false);
    expect(getSettingToasts().map(({ kind, message }) => ({ kind, message }))).toEqual([
      { kind: "not-linkable", message: "That link can’t turn on Pixel raccoon from outside the app" },
    ]);
  });

  it("opens Settings at its default page for an unknown id, changes nothing, and says no setting matches", async () => {
    for (const id of ["no.such.row", "general", "__proto__", "toString"]) {
      const open = vi.fn();
      const before = getPrefs();
      await followSettingDeepLink({ id, enable: true }, open);
      expect(open).toHaveBeenCalledExactlyOnceWith(null);
      expect(getPrefs()).toBe(before);
      expect(getSettingToasts()).toEqual([]);
      expect(getUnknownSettingLink()?.message).toBe(UNKNOWN_SETTING_LINK_MESSAGE);
      expect(UNKNOWN_SETTING_LINK_MESSAGE).toBe("No setting matches that link");
    }
  });

  it("lets the unknown-link notice go by itself", async () => {
    vi.useFakeTimers();
    try {
      await followSettingDeepLink({ id: "no.such.row", enable: false }, vi.fn());
      expect(getUnknownSettingLink()).not.toBeNull();
      vi.advanceTimersByTime(6000);
      expect(getUnknownSettingLink()).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});

describe("setting links from the native side", () => {
  it("takes the link that launched the app once the listener is in place, and follows it", async () => {
    native.pending = [{ id: "general.sounds", enable: true }];
    const open = vi.fn();
    const stop = bootSettingDeepLinks(open);
    await settle();
    expect(native.order).toEqual([`listen:${SETTINGS_LINK_REQUESTED}`, "take"]);
    expect(open).toHaveBeenCalledExactlyOnceWith("general.sounds");
    expect(getPrefs().sounds).toBe(true);
    stop();
  });

  it("takes a link each time the native side says one arrived, and nothing when none waits", async () => {
    const open = vi.fn();
    const stop = bootSettingDeepLinks(open);
    await settle();
    expect(open).not.toHaveBeenCalled();

    native.pending = [{ id: "general.promptMap", enable: false }];
    ping();
    await settle();
    expect(open).toHaveBeenLastCalledWith("general.promptMap");

    // A ping whose link was already taken (at start, say) finds nothing and opens nothing.
    ping();
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ignores anything the take returns that is not exactly { id, enable }", async () => {
    const open = vi.fn();
    const before = getPrefs();
    const stop = bootSettingDeepLinks(open);
    await settle();
    for (const value of [
      "terminalx://settings/general.sounds?enable=1",
      { id: "general.sounds" },
      { id: "general.sounds", enable: "1" },
      { id: 1, enable: true },
      { id: "general.sounds", enable: true, url: "terminalx://settings/general.sounds?enable=1" },
      ["general.sounds", true],
    ]) {
      native.pending = [value];
      ping();
      await settle();
    }
    expect(open).not.toHaveBeenCalled();
    expect(getPrefs()).toBe(before);
    stop();
  });

  it("stops listening when stopped, and still follows a link it already took", async () => {
    native.pending = [{ id: "general.sounds", enable: false }];
    const open = vi.fn();
    // StrictMode stops the first boot before its take answers: the taken link is not lost.
    bootSettingDeepLinks(open)();
    await settle();
    expect(open).toHaveBeenCalledExactlyOnceWith("general.sounds");
    expect(native.listeners.get(SETTINGS_LINK_REQUESTED)?.size ?? 0).toBe(0);

    native.pending = [{ id: "general.promptMap", enable: false }];
    ping();
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
