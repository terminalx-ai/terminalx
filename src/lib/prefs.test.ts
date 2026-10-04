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

describe("website link preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("asks for a browser when no preference has been saved", async () => {
    const { getPrefs } = await import("./prefs");
    expect(getPrefs().linkBrowser).toBe("ask");
  });

  it.each(["ask", "system", "terminalx"] as const)("persists and reloads %s", async (linkBrowser) => {
    const { setPrefs } = await import("./prefs");
    setPrefs({ linkBrowser });
    vi.resetModules();
    const { getPrefs } = await import("./prefs");
    expect(getPrefs().linkBrowser).toBe(linkBrowser);
  });

  it.each(["system", "terminalx"] as const)("preserves the existing %s browser preference", async (linkBrowser) => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ linkBrowser, sounds: false }));
    const { getPrefs } = await import("./prefs");
    expect(getPrefs()).toMatchObject({ linkBrowser, sounds: false });
  });
});
