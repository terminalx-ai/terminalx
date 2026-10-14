import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => vi.restoreAllMocks());

describe("organization display preferences", () => {
  it("defaults to All and persists visibility choices across a restart", async () => {
    const { getPrefs, setPrefs } = await import("./prefs");
    expect(getPrefs()).toMatchObject({ hiddenOrganizations: [], organizationDisplay: "all", selectedOrganization: null });
    setPrefs({ hiddenOrganizations: ["org-a"], organizationDisplay: "one", selectedOrganization: "org-b" });
    vi.resetModules();
    const reloaded = await import("./prefs");
    expect(reloaded.getPrefs()).toMatchObject({ hiddenOrganizations: ["org-a"], organizationDisplay: "one", selectedOrganization: "org-b" });
  });

  it("ignores malformed saved visibility values and deduplicates organization ids", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ hiddenOrganizations: ["a", 7, "a"], organizationDisplay: "invalid", selectedOrganization: 4 }));
    const { getPrefs } = await import("./prefs");
    expect(getPrefs()).toMatchObject({ hiddenOrganizations: ["a"], organizationDisplay: "all", selectedOrganization: null });
  });
});

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
  it("asks for a browser when no preference has been saved", async () => {
    const { getPrefs } = await import("./prefs");

    expect(getPrefs()).toMatchObject({ linkBrowser: "ask", linkBrowserChosen: false });
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
  ])("honors an existing browser preference or asks when none was saved: %j", async (saved) => {
    localStorage.setItem("raccoon.prefs", JSON.stringify(saved));
    const { getPrefs } = await import("./prefs");

    expect(getPrefs()).toMatchObject({ linkBrowser: "linkBrowser" in saved ? saved.linkBrowser : "ask", sounds: false });
  });

  it.each(["ask", "system", "terminalx"] as const)("preserves a recorded Settings choice of %s", async (linkBrowser) => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ linkBrowser, linkBrowserChosen: true }));
    const { getPrefs, setPrefs } = await import("./prefs");
    expect(getPrefs().linkBrowser).toBe(linkBrowser);

    setPrefs({ sounds: false });
    vi.resetModules();
    const reloaded = await import("./prefs");
    expect(reloaded.getPrefs()).toMatchObject({ linkBrowser, linkBrowserChosen: true, sounds: false });
  });

  it.each(["ask", "system", "terminalx"] as const)("persists and reloads a remembered %s choice", async (linkBrowser) => {
    const { setPrefs } = await import("./prefs");
    setPrefs({ linkBrowser, linkBrowserChosen: true });
    vi.resetModules();
    const { getPrefs } = await import("./prefs");
    expect(getPrefs()).toMatchObject({ linkBrowser, linkBrowserChosen: true });
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

  it("asks for a browser when saved preferences are malformed", async () => {
    localStorage.setItem("raccoon.prefs", "{");
    const { getPrefs } = await import("./prefs");

    expect(getPrefs().linkBrowser).toBe("ask");
  });
});

// #427. "Stop the running turn" on Escape (`session.stop`) used to end the agent's process. It is now two actions:
// the interrupt Escape sends (`session.interrupt`), and a hard stop that has no keys until the reader gives it some.
describe("shortcuts saved before Escape was split into interrupt and stop", () => {
  const KEY = "raccoon.prefs";
  const load = async (saved: unknown) => {
    localStorage.setItem(KEY, JSON.stringify(saved));
    const prefs = await import("./prefs");
    const { resolveKeymap } = await import("./shortcuts");
    return { prefs: prefs.getPrefs(), keymap: resolveKeymap(prefs.getPrefs().shortcuts, false) };
  };

  it("moves the keys chosen for stopping a turn to the interrupt, once, and leaves the hard stop without any", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { prefs, keymap } = await load({ sounds: false, shortcuts: { "session.stop": ["shift+escape"], "app.toggleSidebar": ["mod+shift+b"] } });
    expect(prefs.shortcuts).toEqual({ "session.interrupt": ["shift+escape"], "app.toggleSidebar": ["mod+shift+b"] });
    expect(keymap["session.interrupt"]).toEqual(["shift+escape"]);
    expect(keymap["session.stop"]).toEqual([]);
    expect(prefs).toMatchObject({ sounds: false, shortcutsVersion: 2 });
    // Saved, with its version, by the one write the migration makes (the first is the test's own).
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(prefs);
    expect(write).toHaveBeenCalledTimes(2);

    vi.resetModules();
    const again = await import("./prefs");
    expect(again.getPrefs().shortcuts).toEqual(prefs.shortcuts);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("keeps Escape free for someone who had taken the action off it", async () => {
    const { keymap } = await load({ shortcuts: { "session.stop": [] } });
    expect(keymap["session.interrupt"]).toEqual([]);
    expect(keymap["session.stop"]).toEqual([]);
  });

  it("never leaves Escape, or any key kept beside it, ending the agent's process", async () => {
    const { keymap } = await load({ shortcuts: { "session.stop": ["escape", "mod+."] } });
    expect(keymap["session.interrupt"]).toEqual(["escape", "mod+."]);
    expect(keymap["session.stop"]).toEqual([]);
  });

  it("gives Escape to the interrupt for everyone who never changed it, and writes nothing", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { prefs, keymap } = await load({ sounds: false, shortcuts: { "app.toggleSidebar": ["mod+shift+b"] } });
    expect(keymap["session.interrupt"]).toEqual(["escape"]);
    expect(keymap["session.stop"]).toEqual([]);
    expect(prefs.shortcuts).toEqual({ "app.toggleSidebar": ["mod+shift+b"] });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("leaves a hard stop the reader set after the split where it is", async () => {
    const { prefs, keymap } = await load({ shortcutsVersion: 2, shortcuts: { "session.stop": ["mod+."] } });
    expect(prefs.shortcuts).toEqual({ "session.stop": ["mod+."] });
    expect(keymap["session.stop"]).toEqual(["mod+."]);
    expect(keymap["session.interrupt"]).toEqual(["escape"]);
  });

  it("does not migrate twice: a hard stop set in this version survives a restart", async () => {
    await load({ shortcuts: { "session.stop": ["shift+escape"] } });
    const { saveShortcut } = await import("./shortcuts");
    expect(saveShortcut("session.stop", ["mod+."])).toEqual({ ok: true });

    vi.resetModules();
    const prefs = await import("./prefs");
    expect(prefs.getPrefs().shortcuts).toEqual({ "session.interrupt": ["shift+escape"], "session.stop": ["mod+."] });
  });

  it("does not touch shortcuts written by a newer version", async () => {
    const { prefs } = await load({ shortcutsVersion: 3, shortcuts: { "session.stop": ["mod+."] } });
    expect(prefs).toMatchObject({ shortcutsVersion: 3, shortcuts: { "session.stop": ["mod+."] } });
  });

  it("survives anything stored in place of the shortcuts", async () => {
    for (const shortcuts of [null, "escape", ["session.stop"], 7]) {
      localStorage.clear();
      vi.resetModules();
      const { keymap } = await load({ shortcuts });
      expect(keymap["session.interrupt"]).toEqual(["escape"]);
      expect(keymap["session.stop"]).toEqual([]);
    }
  });
});

describe("personal sections of cloud projects (PRO-23)", () => {
  it("survive a restart, per account and organization, in their order", async () => {
    const { getPrefs, setPrefs } = await import("./prefs");
    expect(getPrefs().cloudSections).toEqual({});
    const sections = { "a@example.com": { "org-a": [{ id: "s2", name: "Parked", projects: ["blank/notes"] }, { id: "s1", name: "Active", projects: ["github.com/acme/api"] }] } };
    setPrefs({ cloudSections: sections });
    vi.resetModules();
    const reloaded = await import("./prefs");
    expect(reloaded.getPrefs().cloudSections).toEqual(sections);
  });

  it("drop whatever saved part is malformed, and keep the rest", async () => {
    localStorage.setItem(
      "raccoon.prefs",
      JSON.stringify({ cloudSections: { "a@example.com": { "org-a": [{ id: "s1", name: "Active", projects: ["x", 3] }, { id: 2, name: "Bad", projects: [] }, "junk"], "org-b": "junk" }, "b@example.com": [] } }),
    );
    const { getPrefs } = await import("./prefs");
    expect(getPrefs().cloudSections).toEqual({ "a@example.com": { "org-a": [{ id: "s1", name: "Active", projects: ["x"] }] } });
  });
});
