import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => vi.restoreAllMocks());

describe("permission mode preferences", () => {
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

describe("website browser preferences", () => {
  it("defaults fresh preferences to the system browser without an explicit choice", async () => {
    const { getPrefs } = await import("./prefs");

    expect(getPrefs()).toMatchObject({ linkBrowser: "system", linkBrowserChosen: false });
  });

  it("migrates a saved TerminalX default once and preserves unrelated preferences", async () => {
    // Any setting change in older versions saved the old browser default too.
    localStorage.setItem("raccoon.prefs", JSON.stringify({
      linkBrowser: "terminalx", sounds: false, fontScale: "lg", sidebarWidth: 310,
      shortcuts: { "app.toggleSidebar": ["mod+shift+b"] },
    }));
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { getPrefs } = await import("./prefs");

    expect(getPrefs()).toMatchObject({
      linkBrowser: "system", linkBrowserChosen: false, sounds: false, fontScale: "lg", sidebarWidth: 310,
      shortcuts: { "app.toggleSidebar": ["mod+shift+b"] },
    });
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).toEqual(getPrefs());
    expect(write).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const reloaded = await import("./prefs");
    expect(reloaded.getPrefs().linkBrowser).toBe("system");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([
    { sounds: false },
    { linkBrowser: "system", sounds: false },
  ])("keeps the system browser for older preferences %j", async (saved) => {
    localStorage.setItem("raccoon.prefs", JSON.stringify(saved));
    const { getPrefs } = await import("./prefs");

    expect(getPrefs()).toMatchObject({ linkBrowser: "system", sounds: false });
  });

  it.each(["system", "terminalx"] as const)("preserves a recorded Settings choice of %s", async (linkBrowser) => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ linkBrowser, linkBrowserChosen: true }));
    const { getPrefs, setPrefs } = await import("./prefs");
    expect(getPrefs().linkBrowser).toBe(linkBrowser);

    setPrefs({ sounds: false });
    vi.resetModules();
    const reloaded = await import("./prefs");
    expect(reloaded.getPrefs()).toMatchObject({ linkBrowser, linkBrowserChosen: true, sounds: false });
  });

  it("preserves a TerminalX opt-in after migrating and reloading", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ linkBrowser: "terminalx" }));
    const { getPrefs, setPrefs } = await import("./prefs");
    expect(getPrefs().linkBrowser).toBe("system");
    setPrefs({ linkBrowser: "terminalx", linkBrowserChosen: true });

    vi.resetModules();
    const reloaded = await import("./prefs");
    expect(reloaded.getPrefs()).toMatchObject({ linkBrowser: "terminalx", linkBrowserChosen: true });
  });

  it("uses migrated preferences even if persisting the migration fails", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ linkBrowser: "terminalx", sounds: false }));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    const { getPrefs } = await import("./prefs");

    expect(getPrefs()).toMatchObject({ linkBrowser: "system", sounds: false });
  });

  it("uses the system browser when saved preferences are malformed", async () => {
    localStorage.setItem("raccoon.prefs", "{");
    const { getPrefs } = await import("./prefs");

    expect(getPrefs().linkBrowser).toBe("system");
  });
});
