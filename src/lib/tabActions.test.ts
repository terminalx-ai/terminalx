import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerTab } from "./sessionTabs";

vi.mock("@tauri-apps/api/core", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { invoke: backend.invoke, Channel: class {} };
});
vi.mock("@tauri-apps/api/event", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { listen: backend.listen };
});
const notifications = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: notifications.send }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: async () => undefined, label: "main" }) }));

const { backend, FEATURE, tab: tabEntry } = await import("@/test/tabsBackend");
const { bootSessions, refreshSessions, selectSession, getSessionStore } = await import("./sessions");
const { bootBrowser, refreshBrowserPages } = await import("./browser");
const { adoptPane, dropSessionTerminals, getTerminalState, openTerminal, setSelectedAgent } = await import("./terminal");
const { getTabState, isTabMuted, layoutOf, resetTabLayouts } = await import("./tabLayouts");
const { closePeer, hasOwnTitle, peerAgent, peerKind, peerLabel, peerOrder, peerStateWords, workspaceRow } = await import("./sessionTabs");
const actions = await import("./tabActions");
const { setDraft } = await import("./drafts");
const { noteStatusChange } = await import("./notify");

const store = () => getSessionStore();
const sessionOf = (id: string) => store().sessions.find((session) => session.id === id)!;
const row = (id = "a") => workspaceRow(sessionOf(id));
const keys = (id = "a") => row(id).tabs.map((tab) => tab.key);
const pick = (key: string, id = "a") => row(id).tabs.find((tab) => tab.key === key)!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** What a close reached the backend for, as tab keys. */
const closedKeys = () => [
  ...backend.callsOf("remove_tab").map((args) => `agent:${args.tabId}`),
  ...backend.callsOf("pty_kill").map((args) => `terminal:${args.id}`),
  ...backend.callsOf("browser_close_page").map((args) => `browser:${args.pageId}`),
];
const harnessName = (id: string) => store().harnesses.find((harness) => harness.id === id)?.name;

let shell = "";
let otherShell = "";

beforeEach(async () => {
  backend.reset();
  await bootSessions();
  await refreshSessions();
  dropSessionTerminals(["a", "b", "other"]);
  await bootBrowser();
  await refreshBrowserPages();
  resetTabLayouts();
  await flush();
  shell = (await openTerminal("a", FEATURE)).id;
  otherShell = (await openTerminal("other", "/repo")).id;
  selectSession("a");
  setSelectedAgent("a", "a1");
  for (const id of ["a1", "a2", "a3", "b1", "o1"]) setDraft(id, "");
  backend.calls = [];
  notifications.send.mockClear();
});

describe("the row of a workspace's tabs", () => {
  it("lists every tab of the open workspace, across its sessions, in the order they were opened", () => {
    expect(keys()).toEqual(["agent:a1", "agent:a2", "agent:a3", "agent:b1", "browser:page-feature", `terminal:${shell}`]);
    // The same row from either of the workspace's sessions.
    expect(keys("b")).toEqual(keys("a"));
  });

  it("never lists a tab of another workspace, whatever is asked of it", () => {
    for (const key of ["agent:o1", `terminal:${otherShell}`, "browser:page-main"]) expect(keys()).not.toContain(key);
    expect(keys("other")).toEqual(["agent:o1", "browser:page-main", `terminal:${otherShell}`]);
    // Not by position, not by stepping round, and not by any bulk close.
    for (let position = 1; position <= 9; position++) actions.openTabAt(row(), position);
    expect(store().selectedSessionId).not.toBe("other");
    for (const action of ["others", "right", "left", "idle", "all"] as const) {
      const plan = actions.planBulkClose(action, row().tabs, pick("agent:a2"));
      expect([...plan.targets, ...plan.pinned].every((tab) => keys().includes(tab.key))).toBe(true);
    }
  });

  it("gives the sidebar each session's part of it, in the same order", () => {
    actions.moveTab(row(), pick("agent:a3"), 0);
    expect(keys()).toEqual(["agent:a3", "agent:a1", "agent:a2", "agent:b1", "browser:page-feature", `terminal:${shell}`]);
    const layout = layoutOf(getTabState(), FEATURE);
    const pages = row().tabs.flatMap((tab) => (tab.kind === "browser" ? [tab.page] : []));
    expect(peerOrder(sessionOf("a"), getTerminalState().panes, pages, layout).map((tab) => tab.key)).toEqual(["agent:a3", "agent:a1", "agent:a2", "browser:page-feature", `terminal:${shell}`]);
  });

  it("names a tab by the reader's title, else its conversation, its agent, its shell or its page", async () => {
    const label = (key: string) => peerLabel(pick(key), row().layout, harnessName);
    expect(label("agent:a2")).toBe("Fix flaky test");
    expect(label(`terminal:${shell}`)).toBe("Terminal 1");
    expect(label("browser:page-feature")).toBe("Page page-feature");
    await actions.renamePeer(row(), pick("agent:a2"), "  Flaky checkout  ");
    await actions.renamePeer(row(), pick(`terminal:${shell}`), "dev server");
    await actions.renamePeer(row(), pick("browser:page-feature"), "Preview");
    expect([label("agent:a2"), label(`terminal:${shell}`), label("browser:page-feature")]).toEqual(["Flaky checkout", "dev server", "Preview"]);
    // An agent tab's title is its own as well, so everything else that lists tabs shows it.
    expect(backend.callsOf("rename_tab")).toEqual([{ sessionId: "a", tabId: "a2", title: "Flaky checkout" }]);
    await actions.renamePeer(row(), pick("agent:a2"), null);
    expect(backend.callsOf("rename_tab").at(-1)).toEqual({ sessionId: "a", tabId: "a2", title: null });
    expect(layoutOf(getTabState(), FEATURE).titles).toEqual({ [`terminal:${shell}`]: "dev server", "browser:page-feature": "Preview" });
  });

  it("says a tab's state in words", () => {
    expect(peerStateWords(pick("agent:a1"))).toBeNull();
    expect(peerStateWords(pick("agent:a2"))).toBe("working");
    expect(peerStateWords(pick("agent:a3"))).toBe("waiting for an answer");
    expect(peerStateWords(pick("agent:a3"), true)).toBe("needs attention");
    expect(peerStateWords(pick("agent:b1"))).toBe("unread reply");
  });
});

describe("reordering", () => {
  it("saves one order for the workspace, which moving a tab next to another session's does not change the owner of", () => {
    actions.moveTab(row(), pick("agent:b1"), 1);
    expect(keys()).toEqual(["agent:a1", "agent:b1", "agent:a2", "agent:a3", "browser:page-feature", `terminal:${shell}`]);
    expect(backend.callsOf("set_tab_layout")).toEqual([{ workspace: FEATURE, layout: { order: keys(), pinned: [], muted: [], titles: {} } }]);
    expect(pick("agent:b1").sessionId).toBe("b");
    expect(sessionOf("a").tabs.map((tab) => tab.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("moves left, right, to the start and to the end, and stops at the ends", () => {
    const tab = () => pick("agent:a2");
    expect(actions.canMoveTab(row(), pick("agent:a1"), "left")).toBe(false);
    actions.moveTabBy(row(), tab(), "left");
    expect(keys().slice(0, 2)).toEqual(["agent:a2", "agent:a1"]);
    actions.moveTabBy(row(), tab(), "end");
    expect(keys().at(-1)).toBe("agent:a2");
    expect(actions.canMoveTab(row(), tab(), "right")).toBe(false);
    actions.moveTabBy(row(), tab(), "start");
    expect(keys()[0]).toBe("agent:a2");
    actions.moveTabBy(row(), tab(), "right");
    expect(keys().slice(0, 2)).toEqual(["agent:a1", "agent:a2"]);
  });

  it("keeps pinned tabs together at the left", () => {
    actions.setTabPinned(row(), pick("agent:a3"), true);
    actions.setTabPinned(row(), pick("browser:page-feature"), true);
    expect(keys().slice(0, 2)).toEqual(["agent:a3", "browser:page-feature"]);
    expect(row().tabs.filter((tab) => tab.pinned).map((tab) => tab.key)).toEqual(["agent:a3", "browser:page-feature"]);
    // A tab that is not pinned cannot be put among them, nor a pinned one among the rest.
    actions.moveTab(row(), pick("agent:a1"), 0);
    expect(keys()[2]).toBe("agent:a1");
    actions.moveTab(row(), pick("agent:a3"), 5);
    expect(keys().slice(0, 2)).toEqual(["browser:page-feature", "agent:a3"]);
    // Unpinned, it is the first of the rest.
    actions.setTabPinned(row(), pick("agent:a3"), false);
    expect(keys().slice(0, 2)).toEqual(["browser:page-feature", "agent:a3"]);
    expect(pick("agent:a3").pinned).toBe(false);
  });

  it("opens a new tab directly after the one it was asked from, in that tab's session", async () => {
    const key = await actions.newTab(row(), { kind: "terminal" }, pick("agent:a1"));
    expect(keys().slice(0, 3)).toEqual(["agent:a1", key, "agent:a2"]);
    // After another session's tab: the new one is that session's, and that session is opened.
    const agent = await actions.newTab(row(), { kind: "agent", harness: "codex", mode: "default" }, pick("agent:b1"));
    expect(keys()[keys().indexOf("agent:b1") + 1]).toBe(agent);
    expect(pick(agent).sessionId).toBe("b");
    expect(store().selectedSessionId).toBe("b");
    // A duplicate is a fresh conversation with the same provider and model.
    const copy = await actions.duplicateTab(row(), pick("agent:a2"));
    expect(keys()[keys().indexOf("agent:a2") + 1]).toBe(copy);
    expect(backend.callsOf("add_tab").at(-1)).toEqual({ sessionId: "a", tab: { harness: "codex", model: "opus", effort: null, permissionMode: "default" } });
  });
});

describe("the tab shortcuts", () => {
  it("open a tab by its place in the row, and its session with it", () => {
    expect(actions.openTabAt(row(), 2)).toBe(true);
    expect(getTerminalState().selected.a).toEqual({ kind: "agent", id: "a2" });
    // The fourth tab is the other session's: that session is opened on it.
    expect(actions.openTabAt(row(), 4)).toBe(true);
    expect(store().selectedSessionId).toBe("b");
    expect(getTerminalState().selected.b).toEqual({ kind: "agent", id: "b1" });
    // There is no ninth tab.
    expect(actions.openTabAt(row("b"), 9)).toBe(false);
    expect(store().selectedSessionId).toBe("b");
    // The last one, wherever the row ends.
    actions.openTabAt(row("b"), row("b").tabs.length);
    expect(store().selectedSessionId).toBe("a");
    expect(getTerminalState().selected.a).toEqual({ kind: "terminal", id: shell });
  });

  it("step through the row in its order and wrap round", () => {
    actions.moveTab(row(), pick("agent:a3"), 0);
    actions.stepTab(row(), { kind: "agent", id: "a3" }, 1);
    expect(getTerminalState().selected.a).toEqual({ kind: "agent", id: "a1" });
    actions.stepTab(row(), { kind: "agent", id: "a3" }, -1);
    expect(getTerminalState().selected.a).toEqual({ kind: "terminal", id: shell });
  });
});

describe("closing several tabs", () => {
  const plan = (action: Parameters<typeof actions.planBulkClose>[0], anchor: string) => {
    const made = actions.planBulkClose(action, row().tabs, pick(anchor));
    return { targets: made.targets.map((tab) => tab.key), pinned: made.pinned.map((tab) => tab.key) };
  };

  it("names exactly the tabs each action closes", () => {
    expect(plan("others", "agent:a2").targets).toEqual(["agent:a1", "agent:a3", "agent:b1", "browser:page-feature", `terminal:${shell}`]);
    expect(plan("right", "agent:a3").targets).toEqual(["agent:b1", "browser:page-feature", `terminal:${shell}`]);
    expect(plan("left", "agent:a3").targets).toEqual(["agent:a1", "agent:a2"]);
    expect(plan("all", "agent:a3").targets).toEqual(keys());
    // Idle: an agent with nothing running. A shell that is still open is not idle, a page is not either.
    expect(plan("idle", "agent:a3").targets).toEqual(["agent:a1", "agent:b1"]);
  });

  it("counts an exited shell as idle", () => {
    backend.emit("pty_exit", { id: shell, code: 0 });
    expect(plan("idle", "agent:a1").targets).toEqual(["agent:a1", "agent:b1", `terminal:${shell}`]);
  });

  it("leaves pinned tabs open and says which it left", () => {
    actions.setTabPinned(row(), pick("agent:a1"), true);
    actions.setTabPinned(row(), pick("agent:b1"), true);
    for (const action of ["others", "left", "idle", "all"] as const) {
      const made = plan(action, "agent:a3");
      expect(made.targets).not.toContain("agent:a1");
      expect(made.targets).not.toContain("agent:b1");
      expect(made.pinned).toEqual(["agent:a1", "agent:b1"]);
    }
    expect(plan("right", "agent:a3")).toEqual({ targets: ["browser:page-feature", `terminal:${shell}`], pinned: [] });
  });

  it("finds what a close would end or lose", () => {
    setDraft("a1", "half a thought");
    backend.busy.add(shell);
    const busy = actions.busyTabs(row().tabs, new Set([shell]));
    expect(busy.map((entry) => [entry.tab.key, entry.reasons])).toEqual([
      ["agent:a1", ["unsent draft"]],
      ["agent:a2", ["working"]],
      ["agent:a3", ["waiting for an answer"]],
      [`terminal:${shell}`, ["running a command"]],
    ]);
  });

  it("closes the stated tabs through the usual close, and nothing of another workspace", async () => {
    const targets = actions.planBulkClose("others", row().tabs, pick("agent:a2")).targets;
    await actions.closeTabs(row(), targets, { kind: "agent", id: "a1" });
    expect(closedKeys().sort()).toEqual(["agent:a1", "agent:a3", "agent:b1", "browser:page-feature", `terminal:${shell}`].sort());
    expect(keys()).toEqual(["agent:a2"]);
    // The tab on screen was closed: the one that stays takes the view.
    expect(getTerminalState().selected.a).toEqual({ kind: "agent", id: "a2" });
    // The other workspace is as it was.
    expect(keys("other")).toEqual(["agent:o1", "browser:page-main", `terminal:${otherShell}`]);
    // A session left with no tabs is still there: closing tabs archives and deletes nothing.
    expect(sessionOf("b")).toMatchObject({ archived: false, tabs: [] });
    expect(backend.calls.some((call) => ["delete_session", "set_session_archived"].includes(call.command))).toBe(false);
  });

  it("closes every tab of the row for 'close all', and only those", async () => {
    await actions.closeTabs(row(), actions.planBulkClose("all", row().tabs, null).targets, { kind: "agent", id: "a1" });
    expect(keys()).toEqual([]);
    expect(closedKeys()).not.toContain("agent:o1");
    expect(closedKeys()).not.toContain(`terminal:${otherShell}`);
    expect(closedKeys()).not.toContain("browser:page-main");
    expect(store().sessions.map((session) => session.id).sort()).toEqual(["a", "b", "other"]);
  });
});

describe("closing one tab", () => {
  it("hands the view to its neighbour, in another session if that is where the neighbour is", async () => {
    selectSession("b");
    setSelectedAgent("b", "b1");
    await closePeer("b", pick("agent:b1", "b"), row("b").tabs, { kind: "agent", id: "b1" });
    // Its neighbour in the row is the workspace's browser page, shown in the session that is open.
    expect(getTerminalState().selected.b).toEqual({ kind: "browser", id: "page-feature" });
    expect(store().selectedSessionId).toBe("b");
    await closePeer("b", pick("browser:page-feature", "b"), row("b").tabs, { kind: "browser", id: "page-feature" });
    // Now the nearest tab is session a's shell: the view follows it there.
    expect(store().selectedSessionId).toBe("a");
    expect(getTerminalState().selected.a).toEqual({ kind: "terminal", id: shell });
  });
});

describe("reopening a closed tab", () => {
  it("brings back the last one closed, where it stood, with what the reader set on it", async () => {
    actions.setTabPinned(row(), pick("agent:a3"), true);
    await actions.renamePeer(row(), pick("agent:a3"), "Pinned review");
    actions.setTabMuted(row(), pick("agent:a3"), true);
    expect(actions.canReopenTab(row(), getTabState())).toBe(false);

    await closePeer("a", pick("agent:a3"), row().tabs, { kind: "agent", id: "a1" });
    await flush();
    expect(keys()).not.toContain("agent:a3");
    // Closing it took its traces out of the layout.
    expect(layoutOf(getTabState(), FEATURE)).toMatchObject({ pinned: [], muted: [], titles: {} });
    expect(actions.canReopenTab(row(), getTabState())).toBe(true);

    expect(await actions.reopenClosedTab(row())).toBe(true);
    await flush();
    // The same tab, with its conversation: the backend put its entry back.
    expect(backend.callsOf("reopen_tab")).toEqual([{ sessionId: "a", tabId: "a3" }]);
    expect(pick("agent:a3").kind === "agent" && (pick("agent:a3") as Extract<PeerTab, { kind: "agent" }>).tab.providerSessionId).toBe("conversation-a3");
    expect(keys()[0]).toBe("agent:a3");
    expect(layoutOf(getTabState(), FEATURE)).toMatchObject({ pinned: ["agent:a3"], muted: ["agent:a3"], titles: { "agent:a3": "Pinned review" } });
    expect(getTerminalState().selected.a).toEqual({ kind: "agent", id: "a3" });
    expect(actions.canReopenTab(row(), getTabState())).toBe(false);
    expect(await actions.reopenClosedTab(row())).toBe(false);
  });

  it("reopens a page at its address, in its place", async () => {
    actions.moveTab(row(), pick("browser:page-feature"), 1);
    await closePeer("a", pick("browser:page-feature"), row().tabs, { kind: "agent", id: "a1" });
    await flush();
    expect(keys()).not.toContain("browser:page-feature");
    expect(await actions.reopenClosedTab(row())).toBe(true);
    await flush();
    expect(backend.callsOf("browser_open_tab")).toEqual([{ workspace: FEATURE, url: "https://example.test/page-feature", profile: null }]);
    expect(keys()[1]).toMatch(/^browser:page-new-/);
  });

  it("is offered in the workspace the tab was closed in, not in another", async () => {
    await closePeer("a", pick("agent:a1"), row().tabs, null);
    await flush();
    expect(actions.canReopenTab(row("b"), getTabState())).toBe(true);
    expect(actions.canReopenTab(row("other"), getTabState())).toBe(false);
  });
});

describe("a muted tab", () => {
  const change = () => noteStatusChange(sessionOf("a"), sessionOf("a").tabs.find((tab) => tab.id === "a2")!, "in_progress", "completed");

  it("raises nothing, and an unmuted one does", async () => {
    change();
    await flush();
    expect(notifications.send).toHaveBeenCalledTimes(1);

    actions.setTabMuted(row(), pick("agent:a2"), true);
    expect(isTabMuted(sessionOf("a"), "a2")).toBe(true);
    expect(isTabMuted(sessionOf("a"), "a1")).toBe(false);
    change();
    await flush();
    expect(notifications.send).toHaveBeenCalledTimes(1);

    actions.setTabMuted(row(), pick("agent:a2"), false);
    change();
    await flush();
    expect(notifications.send).toHaveBeenCalledTimes(2);
  });
});

describe("a tab that follows what runs in its terminal (#437)", () => {
  const entry = (id: string) => backend.sessions.find((session) => session.id === "a")!.tabs.find((candidate) => candidate.id === id)!;

  it("keeps the place, the pin and the title of the shell an agent was started in", async () => {
    actions.setTabPinned(row(), pick(`terminal:${shell}`), true);
    await actions.renamePeer(row(), pick(`terminal:${shell}`), "dev server");
    await flush();
    expect(keys()[0]).toBe(`terminal:${shell}`);
    // Codex is typed into it: the session lists the shell as a tab of its own, in the shell's pane.
    backend.sessions.find((session) => session.id === "a")!.tabs.push(tabEntry("typed", 9, { harness: "codex", front: "by_hand", pane: shell, permissionMode: "terminal" }));
    await refreshSessions();
    expect(keys()[0]).toBe("agent:typed");
    expect(keys()).not.toContain(`terminal:${shell}`);
    const typed = pick("agent:typed");
    expect(typed.pinned).toBe(true);
    expect(peerLabel(typed, row().layout, harnessName)).toBe("dev server");
    expect(hasOwnTitle(typed, row().layout)).toBe(true);
    expect(peerKind(typed, harnessName)).toBe("Codex");
    // Muted as the shell, it is muted as the tab, before anything is saved again.
    backend.layouts = { [FEATURE]: { ...backend.layouts[FEATURE], muted: [`terminal:${shell}`] } };
    backend.emit("tab_state_changed", { workspaces: backend.layouts, closed: [] });
    expect(isTabMuted(sessionOf("a"), "typed")).toBe(true);
    // The next thing saved is said of the tab, and nothing is left of the shell.
    actions.moveTabBy(row(), pick("agent:a1"), "right");
    await flush();
    expect(backend.layouts[FEATURE].order[0]).toBe("agent:typed");
    expect(backend.layouts[FEATURE].pinned).toEqual(["agent:typed"]);
    expect(backend.layouts[FEATURE].titles).toEqual({ "agent:typed": "dev server" });
    expect(JSON.stringify(backend.layouts[FEATURE])).not.toContain("terminal:");
  });

  it("is a terminal while no agent is in it: named, drawn and closed as one", async () => {
    // Its agent was working when it left the terminal: the status it was last in says nothing now.
    Object.assign(entry("a2"), { front: "terminal", terminalTitle: "Terminal 4" });
    await refreshSessions();
    const was = pick("agent:a2");
    expect(peerLabel(was, row().layout, harnessName)).toBe("Terminal 4");
    expect(peerKind(was, harnessName)).toBe("Terminal");
    expect(peerAgent(was)).toBeNull();
    expect(peerStateWords(was)).toBeNull();
    expect(actions.canRestartAgent(was)).toBe(false);
    expect(actions.busyTabs([was])).toEqual([]);
    // Its shell is asked about like any other, by the pane it runs in.
    expect(actions.busyTabs([was], new Set(["tab:a2"])).map((busy) => busy.reasons)).toEqual([["running a command"]]);
    const idle = () => actions.planBulkClose("idle", row().tabs, null).targets.map((tab) => tab.key);
    expect(idle()).not.toContain("agent:a2");
    // Its shell has exited: nothing is left running in it.
    await adoptPane({ id: "tab:a2", sessionId: "a", title: "Agent", hidden: true, owned: true });
    backend.emit("pty_exit", { id: "tab:a2", code: 1 });
    expect(peerStateWords(pick("agent:a2"))).toBe("exited (1)");
    expect(idle()).toContain("agent:a2");
    expect(actions.busyTabs([pick("agent:a2")], new Set(["tab:a2"]))).toEqual([]);
    // An agent the app has no chat for is in front of it: the tab is drawn as that agent's, and is still a terminal.
    expect(peerKind({ ...pick("agent:a2"), paneAgent: "opencode" } as PeerTab, () => "OpenCode")).toBe("OpenCode, running in a terminal");
  });

  it("duplicates as what it is now, and only restarts an agent the app started", async () => {
    Object.assign(entry("a1"), { front: "terminal" });
    Object.assign(entry("a3"), { front: "by_hand", permissionMode: "terminal" });
    await refreshSessions();
    expect(actions.canRestartAgent(pick("agent:a1"))).toBe(false);
    expect(actions.canRestartAgent(pick("agent:a2"))).toBe(true);
    expect(actions.canRestartAgent(pick("agent:a3"))).toBe(false);
    const made = await actions.duplicateTab(row(), pick("agent:a1"));
    expect(made.startsWith("terminal:")).toBe(true);
    expect(backend.callsOf("add_tab")).toEqual([]);
    expect(keys()[keys().indexOf("agent:a1") + 1]).toBe(made);
    // An agent started by hand runs in a mode only its terminal knows: its duplicate is started in the reader's usual one.
    await actions.duplicateTab(row(), pick("agent:a3"));
    expect((backend.callsOf("add_tab").at(-1)!.tab as { permissionMode: string }).permissionMode).not.toBe("terminal");
  });

  it("goes by the reader's name whatever runs in it, until they take it back", async () => {
    await actions.renamePeer(row(), pick("agent:a2"), "Flaky test hunt");
    await refreshSessions();
    expect(entry("a2").titlePinned).toBe(true);
    Object.assign(entry("a2"), { front: "terminal", terminalTitle: "Terminal 4" });
    await refreshSessions();
    expect(peerLabel(pick("agent:a2"), row().layout, harnessName)).toBe("Flaky test hunt");
    await actions.renamePeer(row(), pick("agent:a2"), null);
    await refreshSessions();
    expect(entry("a2").titlePinned).toBe(false);
    expect(hasOwnTitle(pick("agent:a2"), row().layout)).toBe(false);
    expect(peerLabel(pick("agent:a2"), row().layout, harnessName)).toBe("Terminal 4");
  });
});
