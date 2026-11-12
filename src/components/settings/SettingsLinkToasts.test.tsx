import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onOpenSettingRow } from "@/lib/settingsLinks";
import { forgetSettingToasts, getSettingToasts, SETTING_TOAST_MS, showSettingEnabled, showSettingLinkCopied, showSettingNotLinkable } from "@/lib/settingsToasts";
import { SettingsLinkToasts } from "./SettingsLinkToasts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); act(forgetSettingToasts); vi.useRealTimers(); });

describe("setting link toasts", () => {
  it("shows the three toasts with their exact labels", () => {
    render(<SettingsLinkToasts />);
    act(() => {
      showSettingLinkCopied("general.sounds", "Sounds");
      showSettingEnabled("general.promptMap", "Prompt map");
      showSettingNotLinkable("agents.readOnlyCommands", "Allow read-only commands in Ask mode");
    });
    expect(screen.getAllByRole("status").map((toast) => toast.getAttribute("aria-label"))).toEqual([
      "Copied a link to Sounds",
      "Turned on Prompt map",
      "That link can’t turn on Allow read-only commands in Ask mode from outside the app",
    ]);
    // Only the toast for a setting that was turned on offers to open it.
    expect(screen.getAllByRole("button", { name: "Open setting" })).toHaveLength(1);
  });

  it("opens the setting from Turned on, and dismisses", () => {
    const opened = vi.fn();
    const stop = onOpenSettingRow(opened);
    try {
      render(<SettingsLinkToasts />);
      act(() => { showSettingEnabled("general.sounds", "Sounds"); });
      fireEvent.click(screen.getByRole("button", { name: "Open setting" }));
      expect(opened).toHaveBeenCalledWith("general.sounds");
      expect(screen.queryByRole("status")).toBeNull();
      act(() => { showSettingLinkCopied("general.sounds", "Sounds"); });
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("status")).toBeNull();
    } finally { stop(); }
  });

  it("keeps one toast per setting and lets each go by itself", () => {
    render(<SettingsLinkToasts />);
    act(() => { showSettingLinkCopied("general.sounds", "Sounds"); showSettingLinkCopied("general.sounds", "Sounds"); });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(SETTING_TOAST_MS));
    expect(screen.queryByRole("status")).toBeNull();
    expect(getSettingToasts()).toEqual([]);
  });
});
