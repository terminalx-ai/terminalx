import { beforeEach, describe, expect, it, vi } from "vitest";

describe("permission mode preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("defaults fresh preferences to bypass permissions", async () => {
    const { getPrefs } = await import("./prefs");

    expect(getPrefs().lastMode).toBe("bypassPermissions");
  });

  it("preserves an explicitly saved permission mode", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ lastMode: "manual" }));
    const { getPrefs } = await import("./prefs");

    expect(getPrefs().lastMode).toBe("manual");
  });
});
