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

describe("permission mode preferences (PRO-162)", () => {
  it("starts a fresh profile in Ask every time", async () => {
    const { getPrefs } = await import("./prefs");

    expect(getPrefs().lastMode).toBe("manual");
  });

  it("remembers the mode picked after that across a restart", async () => {
    const { setPrefs } = await import("./prefs");
    setPrefs({ lastMode: "plan" });
    vi.resetModules();

    expect((await import("./prefs")).getPrefs().lastMode).toBe("plan");
  });

  it("keeps a saved Bypass, and gives saved preferences that hold no mode the first-run one", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ lastMode: "bypassPermissions", sounds: false }));
    expect((await import("./prefs")).getPrefs()).toMatchObject({ lastMode: "bypassPermissions", sounds: false });

    localStorage.setItem("raccoon.prefs", JSON.stringify({ sounds: false }));
    vi.resetModules();
    expect((await import("./prefs")).getPrefs()).toMatchObject({ lastMode: "manual", sounds: false });
  });
});

describe("autocorrect preference (#525)", () => {
  it("is off on a fresh install", async () => {
    const { getPrefs } = await import("./prefs");
    expect(getPrefs().autocorrect).toBe(false);
  });

  it("is off for someone whose saved preferences predate it, and their other choices stay", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ foldToolCalls: false, sounds: false }));
    const { getPrefs } = await import("./prefs");
    expect(getPrefs()).toMatchObject({ autocorrect: false, foldToolCalls: false, sounds: false });
  });

  it("stays on across a restart once turned on, and reads anything but true as off", async () => {
    const { setPrefs } = await import("./prefs");
    setPrefs({ autocorrect: true });
    vi.resetModules();
    expect((await import("./prefs")).getPrefs().autocorrect).toBe(true);

    localStorage.setItem("raccoon.prefs", JSON.stringify({ autocorrect: "true" }));
    vi.resetModules();
    expect((await import("./prefs")).getPrefs().autocorrect).toBe(false);
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
    const { sidebarSort, ...persisted } = getPrefs();
    expect(sidebarSort).toBe("updated"); // Runtime fallback is not a saved choice.
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).toEqual(persisted);
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
    const { sidebarSort, ...persisted } = prefs;
    expect(sidebarSort).toBe("updated"); // The migration leaves an unchosen sort absent.
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(persisted);
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

// #700. A cloud project's launch switches were saved `false` with every other
// change before an issue session started with them on: that was no choice.
describe("cloud pipeline switches saved before they were a choice", () => {
  const KEY = "raccoon.prefs";
  const legacy = (patch: Record<string, unknown>) => ({
    enabled: true, autoMerge: false, resolveConflicts: false, maxResolutions: 3, requirePerson: false, maxRounds: 5, mergeMethod: "merge",
    protected: { migrations: true, deploy: true, security: true, paths: [] }, ignoredChecks: [], ...patch,
  });

  it("forgets a saved off once, keeps a switch turned on and everything else, and is not migrated again", async () => {
    localStorage.setItem(KEY, JSON.stringify({ sounds: false, cloudIssuePipelines: { "cloud:o:a": legacy({}), "cloud:o:b": legacy({ resolveConflicts: true }) } }));
    const { getPrefs, setPrefs } = await import("./prefs");
    const { cloudIssuePipelines } = getPrefs();
    expect(cloudIssuePipelines["cloud:o:a"]).not.toHaveProperty("autoMerge");
    expect(cloudIssuePipelines["cloud:o:a"]).not.toHaveProperty("resolveConflicts");
    expect(cloudIssuePipelines["cloud:o:a"].maxRounds).toBe(5);
    expect(cloudIssuePipelines["cloud:o:b"].resolveConflicts).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ cloudIssuePipelinesVersion: 1, sounds: false });

    // Turned off since, it stays off through a restart.
    setPrefs({ cloudIssuePipelines: { ...cloudIssuePipelines, "cloud:o:a": { ...cloudIssuePipelines["cloud:o:a"], resolveConflicts: false } } });
    vi.resetModules();
    const again = await import("./prefs");
    expect(again.getPrefs().cloudIssuePipelines["cloud:o:a"].resolveConflicts).toBe(false);
  });

  it("writes nothing when there is nothing to forget", async () => {
    localStorage.setItem(KEY, JSON.stringify({ sounds: false, cloudIssuePipelines: { "cloud:o:b": legacy({ autoMerge: undefined, resolveConflicts: true }) } }));
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { getPrefs } = await import("./prefs");
    expect(getPrefs().cloudIssuePipelines["cloud:o:b"].resolveConflicts).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("cloud pipeline switches saved by a newer version", () => {
  it("are left as they are, and the newer version is not lowered", async () => {
    const off = { enabled: true, resolveConflicts: false, requirePerson: false, maxRounds: 3, mergeMethod: "merge", protected: { migrations: true, deploy: true, security: true, paths: [] }, ignoredChecks: [] };
    localStorage.setItem("raccoon.prefs", JSON.stringify({ cloudIssuePipelinesVersion: 2, cloudIssuePipelines: { "cloud:o:a": off } }));
    const { getPrefs, setPrefs } = await import("./prefs");
    expect(getPrefs().cloudIssuePipelines["cloud:o:a"].resolveConflicts).toBe(false);
    setPrefs({ sounds: false });
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).cloudIssuePipelinesVersion).toBe(2);
  });
});

describe("follow-up delivery preferences", () => {
  it("preserves today's default and persists Hold across restarts", async () => {
    const { getPrefs, setPrefs } = await import("./prefs");
    expect(getPrefs().followUps).toBe("now");
    setPrefs({ followUps: "hold" });
    vi.resetModules();
    expect((await import("./prefs")).getPrefs().followUps).toBe("hold");
  });
  it("uses the default for an unrecognized saved value", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ followUps: "invalid" }));
    expect((await import("./prefs")).getPrefs().followUps).toBe("now");
  });
});

describe("sidebar choices per window (PRO-164)", () => {
  it.each([
    { sounds: false },
    { panelWidth: 520 },
    { lastAgent: "codex" },
    { sidebarSort: "created" as const, sidebarProject: "/a" },
  ])("keeps the file layout inherited after saving %j and reloading", async (patch) => {
    const prefs = await import("./prefs");
    prefs.connectPreferenceFile(vi.fn());
    prefs.applyFilePreferences({ sidebarLayout: "list" });
    prefs.setPrefs(patch);
    expect(JSON.parse(localStorage.getItem("raccoon.prefs.sidebar.main") ?? "{}")).not.toHaveProperty("sidebarLayout");
    prefs.applyFilePreferences({ sidebarLayout: "status" });
    expect(prefs.getPrefs().sidebarLayout).toBe("status");
    vi.resetModules();
    const reloaded = await import("./prefs");
    reloaded.connectPreferenceFile(vi.fn());
    reloaded.applyFilePreferences({ sidebarLayout: "simple" });
    expect(reloaded.getPrefs().sidebarLayout).toBe("simple");
    // An explicit layout remains an override through subsequent unrelated saves.
    reloaded.setPrefs({ sidebarLayout: "status" });
    reloaded.setPrefs(patch);
    reloaded.applyFilePreferences({ sidebarLayout: "list" });
    expect(reloaded.getPrefs().sidebarLayout).toBe("status");
  });

  it("does not freeze the default before the settings file loads", async () => {
    const prefs = await import("./prefs");
    prefs.setPrefs({ panelWidth: 520 });
    prefs.connectPreferenceFile(vi.fn());
    prefs.applyFilePreferences({ sidebarLayout: "status" });
    expect(prefs.getPrefs().sidebarLayout).toBe("status");
  });

  it("migrates the old shared layout without promoting a window override into the settings file", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "list", sounds: false }));
    localStorage.setItem("raccoon.prefs.sidebar.main", JSON.stringify({ sidebarLayout: "status" }));
    const prefs = await import("./prefs");
    expect(prefs.getPrefs().sidebarLayout).toBe("status");
    expect(prefs.legacyUserPreferences()).toEqual({ sidebarLayout: "list", sounds: false });
  });

  it("keeps Custom and Updated window views independent of settings-file updates and shared storage events", async () => {
    const main = await import("./prefs");
    const writeMain = vi.fn();
    main.connectPreferenceFile(writeMain);
    main.applyFilePreferences({ sidebarLayout: "list", sounds: false });
    expect(main.getPrefs().sidebarLayout).toBe("list");
    expect(localStorage.getItem("raccoon.prefs.sidebar.main")).toBeNull();
    main.setPrefs({ sidebarLayout: "status", sidebarSort: "custom", sidebarProject: "/a", sounds: true });
    expect(writeMain).toHaveBeenCalledExactlyOnceWith({ sounds: true });

    vi.resetModules();
    (await import("./appWindow")).setAppWindowForTest("chat-secondary");
    const second = await import("./prefs");
    const writeSecond = vi.fn();
    second.connectPreferenceFile(writeSecond);
    second.applyFilePreferences({ sidebarLayout: "list", sounds: true });
    expect(second.getPrefs().sidebarLayout).toBe("list");
    second.setPrefs({ sidebarLayout: "simple", sidebarSort: "updated", sidebarProject: "/b" });
    expect(writeSecond).not.toHaveBeenCalled();

    // An external file edit updates shared settings without resetting either view.
    for (const prefs of [main, second]) prefs.applyFilePreferences({ sidebarLayout: "simple", sounds: false });
    window.dispatchEvent(new StorageEvent("storage", { key: "raccoon.prefs", storageArea: localStorage }));
    expect(main.getPrefs()).toMatchObject({ sidebarLayout: "status", sidebarSort: "custom", sidebarProject: "/a", sounds: false });
    expect(second.getPrefs()).toMatchObject({ sidebarLayout: "simple", sidebarSort: "updated", sidebarProject: "/b", sounds: false });
    const shared = JSON.parse(localStorage.getItem("raccoon.prefs")!);
    for (const key of ["sidebarLayout", "sidebarSort", "sidebarProject", "sounds"]) expect(shared).not.toHaveProperty(key);

    vi.resetModules();
    const reloaded = await import("./prefs");
    reloaded.connectPreferenceFile(vi.fn());
    reloaded.applyFilePreferences({ sidebarLayout: "list", sounds: false });
    expect(reloaded.getPrefs()).toMatchObject({ sidebarLayout: "status", sidebarSort: "custom", sidebarProject: "/a", sounds: false });
  });

  it("removes closed chat records, retaining live, newly opened and persistent windows", async () => {
    for (const label of ["main", "floating", "chat-live", "chat-closed"]) localStorage.setItem(`raccoon.prefs.sidebar.${label}`, "{}");
    const prefs = await import("./prefs");
    const candidates = prefs.sidebarChatWindowLabels();
    localStorage.setItem("raccoon.prefs.sidebar.chat-new", "{}");
    prefs.pruneSidebarWindows(["main", "floating", "chat-live"], candidates);
    expect(localStorage.getItem("raccoon.prefs.sidebar.chat-closed")).toBeNull();
    for (const label of ["main", "floating", "chat-live", "chat-new"]) expect(localStorage.getItem(`raccoon.prefs.sidebar.${label}`)).not.toBeNull();
    prefs.forgetSidebarWindow("chat-live");
    prefs.forgetSidebarWindow("main");
    expect(localStorage.getItem("raccoon.prefs.sidebar.chat-live")).toBeNull();
    expect(localStorage.getItem("raccoon.prefs.sidebar.main")).not.toBeNull();
  });

  it("preserves inherited views when another window saves its first choices", async () => {
    const legacy = { sidebarLayout: "list", sidebarFilters: { local: "unread" }, sidebarSections: { chats: "collapsed" } };
    localStorage.setItem("raccoon.prefs", JSON.stringify(legacy));
    const main = await import("./prefs");
    vi.resetModules();
    (await import("./appWindow")).setAppWindowForTest("chat-secondary");
    const second = await import("./prefs");
    second.setPrefs({ sidebarLayout: "status", sounds: false });
    window.dispatchEvent(new StorageEvent("storage", { key: "raccoon.prefs", storageArea: localStorage }));
    expect(main.getPrefs()).toMatchObject({ ...legacy, sounds: false });
    expect(second.getPrefs().sidebarLayout).toBe("status");
    vi.resetModules();
    expect((await import("./prefs")).getPrefs()).toMatchObject({ ...legacy, sounds: false });
  });

  it("remembers each window independently across a reload and shared preference changes", async () => {
    const main = await import("./prefs");
    main.setPrefs({ sidebarLayout: "status", sidebarSort: "created", sidebarProject: "/a", sidebarFilters: { local: "needs" }, sidebarSections: { "status:local:done": "collapsed" }, sidebarShowArchived: true });
    vi.resetModules();
    (await import("./appWindow")).setAppWindowForTest("chat-secondary");
    const second = await import("./prefs");
    expect(second.getPrefs()).toMatchObject({ sidebarLayout: "simple", sidebarSort: "updated", sidebarProject: null, sidebarFilters: {}, sidebarSections: {}, sidebarShowArchived: false });
    second.setPrefs({ sidebarLayout: "list", sidebarProject: "/b", sounds: false });
    vi.resetModules();
    const again = await import("./prefs");
    expect(again.getPrefs()).toMatchObject({ sidebarLayout: "status", sidebarSort: "created", sidebarProject: "/a", sidebarFilters: { local: "needs" }, sidebarSections: { "status:local:done": "collapsed" }, sidebarShowArchived: true, sounds: false });
    vi.resetModules();
    (await import("./appWindow")).setAppWindowForTest("chat-secondary");
    expect((await import("./prefs")).getPrefs()).toMatchObject({ sidebarLayout: "list", sidebarProject: "/b" });
  });

  it("ignores malformed view choices without losing shared preferences", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ sounds: false }));
    localStorage.setItem("raccoon.prefs.sidebar.main", JSON.stringify({ sidebarSort: "random", sidebarProject: 42, sidebarLayout: "invalid", sidebarSections: [], sidebarFilters: null }));
    expect((await import("./prefs")).getPrefs()).toMatchObject({ sounds: false, sidebarSort: "updated", sidebarProject: null, sidebarLayout: "simple", sidebarSections: {}, sidebarFilters: {} });
  });
});

describe("dashboard preferences", () => {
  it("restores the view, sorting and hidden columns after a restart", async () => {
    const saved = { view: "table" as const, sort: { column: "pr" as const, direction: "asc" as const }, hiddenColumns: ["owner" as const, "branch" as const] };
    const prefs = await import("./prefs");
    prefs.setPrefs({ dashboard: saved });
    vi.resetModules();
    expect((await import("./prefs")).getPrefs().dashboard).toEqual(saved);
  });
  it("recovers from malformed dashboard preferences", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ dashboard: { view: "unknown", sort: null, hiddenColumns: ["branch", "branch", 12] } }));
    expect((await import("./prefs")).getPrefs().dashboard).toEqual({ view: "board", sort: { column: "updated", direction: "desc" }, hiddenColumns: ["branch"] });
  });
});

describe("reset chat file choice (PRO-261)", () => {
  it("starts unchecked, remembers the choice across a restart and ignores a malformed value", async () => {
    const prefs = await import("./prefs");
    expect(prefs.getPrefs().resetFiles).toBe(false);
    prefs.setPrefs({ resetFiles: true });
    vi.resetModules();
    expect((await import("./prefs")).getPrefs().resetFiles).toBe(true);
    localStorage.setItem("raccoon.prefs", JSON.stringify({ resetFiles: "yes" }));
    vi.resetModules();
    expect((await import("./prefs")).getPrefs().resetFiles).toBe(false);
  });
});
