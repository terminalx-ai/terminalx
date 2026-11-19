import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Links reach these functions through the one router (desktopLinks.test.ts); nothing native is asked here.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => { throw new Error(`unexpected command ${command}`); }),
}));

import { getPrefs, setPrefs } from "@/lib/prefs";
import { forgetSettingToasts, getSettingToasts } from "@/lib/settingsToasts";
import {
  UNKNOWN_SETTING_LINK_MESSAGE,
  dismissUnknownSettingLink,
  followSettingDeepLink,
  getUnknownSettingLink,
} from "./settingsDeepLink";


beforeEach(() => {
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
