#!/usr/bin/env node
// PRO-263: real pointer drags, two live transcript views, restart persistence,
// keyboard focus, and two real xterms resizing in the built app's WebKit.
// Run after pnpm build; PANE_SPLIT_SHOTS optionally captures light and dark.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, serve } from "./harness.mjs";

function setup() {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, sidebarOpen: true, tabStrip: true }));
  const { answers, emit } = window.__PW_STUB__;
  const at = "2026-10-01T12:00:00Z";
  const tab = (id) => ({ id, title: `Agent ${id}`, harness: "claude", model: "", permissionMode: "default", status: "in_progress", created: at, modified: at });
  const session = (id, tabs, title) => ({ id, title, tabs: tabs.map(tab), activeTab: tabs[0], projectPath: "/repos/p0", cwd: "/repos/p0", branch: "main", worktreeRemoved: false, archived: false, pinned: false, created: at, modified: at });
  const sessions = JSON.parse(localStorage.getItem("pane-test-sessions") ?? "null") ?? [session("s-a", ["a1", "a2"], "Split pane review"), session("s-b", ["b1"], "Second pane session")];
  const event = (tabId, seq, payload) => ({ id: `${tabId}-${seq}`, sessionId: tabId === "b1" ? "s-b" : "s-a", tabId, harness: "claude", seq, ts: at, payload });
  Object.assign(answers, {
    list_sessions: sessions,
    list_workspaces: [{ path: "/repos/p0", name: "main", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
    load_tab_events: ({ tabId }) => [event(tabId, 1, { type: "user_message", text: `Review ${tabId}`, queued: false }), event(tabId, 2, { type: "turn_started" })],
    tab_state: JSON.parse(localStorage.getItem("pane-test-layout") ?? "null") ?? { workspaces: {}, closed: [] },
    ensure_tab_started: null, tab_pane: null, pane_agents: [], browser_pages: [],
    pty_shells: ["s-a:one", "s-a:two"].map((id, i) => ({ id, sessionId: "s-a", title: `Terminal ${i + 1}`, cwd: "/repos/p0", exited: false, created: at })),
    pty_detach_all: null, pty_detach: null, pty_ack: null,
    pty_attach_sized: ({ channel }) => {
      const bytes = new TextEncoder().encode("Pane resize check\r\n$ ");
      const frame = new Uint8Array(bytes.length + 4);
      frame.set(bytes, 4);
      channel.onmessage(frame.buffer);
    },
    pty_resize: (args) => { window.__RESIZES__.push(args); },
    set_active_tab: ({ sessionId, tabId }) => {
      sessions.find((session) => session.id === sessionId).activeTab = tabId;
      localStorage.setItem("pane-test-sessions", JSON.stringify(sessions));
    },
    remove_tab: ({ sessionId, tabId }) => {
      const session = sessions.find((session) => session.id === sessionId);
      session.tabs = session.tabs.filter((tab) => tab.id !== tabId);
      if (session.activeTab === tabId) session.activeTab = session.tabs[0]?.id;
      localStorage.setItem("pane-test-sessions", JSON.stringify(sessions));
    },
    "plugin:window|is_focused": true, "plugin:window|is_minimized": false,
  });
  const save = answers.set_tab_layout;
  answers.set_tab_layout = (args) => {
    window.__SAVES__.push(args);
    save(args);
    localStorage.setItem("pane-test-layout", JSON.stringify(answers.tab_state));
  };
  window.__SAVES__ = [];
  window.__RESIZES__ = [];
  window.__STREAM__ = (tabId, seq) => emit("agent_event", event(tabId, seq, { type: "assistant_text", text: `Streaming ${tabId} update ${seq}\n\n` }));
}

const server = await serve();
const browser = await launch();
const shots = process.env.PANE_SPLIT_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const extra = `(${setup.toString()})();`;
const panel = (page, id) => page.locator(`#session-agent-panel-${id}`);
const strip = (page, id) => page.locator(`[data-pane-id="${id}"] > [data-testid="workspace-tab-strip"]`);
const drag = async (page, from, to, finish = true) => {
  const box = await from.boundingBox();
  assert(box);
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (finish) await page.mouse.up();
};
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra, colorScheme });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.getByTestId("conversation-list").getByRole("button", { name: "main, 2 sessions", exact: true }).click();
    await page.getByTestId("workspace-panes").waitFor();
    const host = page.getByTestId("workspace-panes");
    const bounds = await host.boundingBox();
    const edge = { x: bounds.x + bounds.width - 10, y: bounds.y + 180 };
    await drag(page, page.getByRole("tab", { name: "Agent a2", exact: true }), edge, false);
    await page.getByTestId("pane-drop-preview").waitFor();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await page.getByTestId("pane-drop-preview").count(), 0);
    assert.equal(await page.evaluate(() => window.__SAVES__.length), 0);

    await drag(page, page.getByRole("tab", { name: "Agent a2", exact: true }), edge);
    await page.getByRole("separator", { name: "Resize tab panes" }).waitFor();
    assert.equal(await page.getByRole("tablist", { name: "Workspace tabs" }).count(), 2);
    await panel(page, "a1").waitFor({ state: "visible" });
    await panel(page, "a2").waitFor({ state: "visible" });
    await page.evaluate(() => { window.__STREAM__("a1", 3); window.__STREAM__("a2", 3); });
    await panel(page, "a1").getByText("Streaming a1 update 3").waitFor();
    await panel(page, "a2").getByText("Streaming a2 update 3").waitFor();
    if (shots) await page.screenshot({ path: join(shots, `${colorScheme}-agents.png`) });

    // Sibling sessions remain mounted when either pane takes focus.
    await panel(page, "a2").evaluate((element) => { window.__KEPT_PANEL__ = element; });
    await strip(page, "left").getByRole("tab", { name: "Agent b1", exact: true }).click();
    assert(await panel(page, "a2").evaluate((element) => window.__KEPT_PANEL__ === element));
    await page.evaluate(() => { window.__STREAM__("b1", 3); window.__STREAM__("a2", 4); });
    await panel(page, "b1").getByText("Streaming b1 update 3").waitFor();
    await panel(page, "a2").getByText("Streaming a2 update 4").waitFor();
    const mod = await page.evaluate(() => /Mac/.test(navigator.platform) ? "Meta" : "Control");
    await page.keyboard.press(`${mod}+Alt+o`);
    await page.waitForFunction(() => document.activeElement?.closest('[role="tabpanel"]')?.id === "session-agent-panel-a2");

    // A browser restart re-reads the backend's persisted layout and active tabs.
    await page.reload();
    await page.getByTestId("conversation-list").getByRole("button", { name: "main, 2 sessions", exact: true }).click();
    await page.getByTestId("workspace-panes").waitFor();
    await panel(page, "a2").waitFor({ state: "visible" });
    await panel(page, "b1").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("tablist", { name: "Workspace tabs" }).count(), 2);

    const left = await strip(page, "left").boundingBox();
    await drag(page, strip(page, "right").getByRole("tab", { name: "Agent a2", exact: true }), { x: left.x + 45, y: left.y + left.height / 2 });
    await page.getByRole("separator", { name: "Resize tab panes" }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("tab", { name: "Agent a2", exact: true }).count(), 1);

    // Menu split and last-tab close use the same model as a drag.
    await page.getByRole("tab", { name: "Agent a2", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
    await page.getByRole("separator", { name: "Resize tab panes" }).waitFor();
    await strip(page, "right").getByRole("button", { name: "Close Agent a2", exact: true }).click();
    await page.getByRole("separator", { name: "Resize tab panes" }).waitFor({ state: "detached" });

    // Two actual xterms, with backend resize requests from each ResizeObserver.
    await page.getByRole("tab", { name: "Terminal 1", exact: true }).click();
    await page.getByRole("tab", { name: "Terminal 2", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
    const separator = page.getByRole("separator", { name: "Resize tab panes" });
    await separator.waitFor();
    await page.waitForFunction(() => ["s-a:one", "s-a:two"].every((id) => window.__RESIZES__.some((entry) => entry.id === id && entry.cols > 0)));
    await page.evaluate(() => { window.__RESIZES__ = []; });
    const divider = await separator.boundingBox();
    await page.mouse.move(divider.x + 2, divider.y + 150);
    await page.mouse.down();
    await page.mouse.move(divider.x + 140, divider.y + 150, { steps: 15 });
    await page.mouse.up();
    await page.waitForFunction(() => ["s-a:one", "s-a:two"].every((id) => window.__RESIZES__.some((entry) => entry.id === id && entry.cols > 0)));
    const sizes = await page.evaluate(() => ["s-a:one", "s-a:two"].map((id) => window.__RESIZES__.findLast((entry) => entry.id === id)));
    assert(sizes[0].cols > sizes[1].cols, JSON.stringify(sizes));
    const ratio = await separator.getAttribute("aria-valuenow");
    assert(Number(ratio) > 50);
    if (shots) await page.screenshot({ path: join(shots, `${colorScheme}-terminals.png`) });
    // Moving the focused terminal back with the shortcut removes the split.
    await page.keyboard.press(`${mod}+Alt+Shift+o`);
    await separator.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    console.log(`ok  ${colorScheme}: drag/cancel, streams, focus, persistence, menu/close, two xterm sizes, move shortcut`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
