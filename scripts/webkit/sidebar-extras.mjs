// PRO-179: production sidebar interactions with synthetic native state.
// Run in the local VM after pnpm build. No host UI or real sessions are used.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launch, open, serve, sidebar } from "./harness.mjs";

const fixture = (layout) => `(() => {
  const { answers, emit } = window.__PW_STUB__;
  const prefs = JSON.parse(localStorage.getItem('raccoon.prefs') || '{}');
  localStorage.setItem('raccoon.prefs', JSON.stringify({ ...prefs, sidebarLayout: ${JSON.stringify(layout)}, sidebarWidth: 268, branchSessions: 'sidebar', animations: false, colourLineCounts: true, shortcuts: { 'session.archive': ['mod+shift+e'] } }));
  const session = (id, branch, modified) => ({ id, title: 'First request ' + id, projectPath: '/repo', cwd: '/repo/' + id, branch, worktreeName: id, worktreeRemoved: false, created: modified, modified, archived: false, pinned: false, activeTab: id + '-tab', tabs: [{ id: id + '-tab', title: 'First request ' + id, harness: 'gemini', model: '', permissionMode: 'auto', created: modified, modified, status: 'waiting' }] });
  let sessions = JSON.parse(localStorage.getItem('pro179.sessions') || 'null') || [session('one', 'feature/fix-sidebar', '2026-11-07T12:00:00Z'), session('two', 'feature/check-routes', '2026-11-07T11:00:00Z')];
  answers.list_sessions = () => structuredClone(sessions);
  answers.list_projects = { projects: [{ path: '/repo', name: 'Example', kind: 'git' }], lastSelected: null };
  answers.list_workspaces = sessions.map((s, i) => ({ path: s.cwd, name: s.id, branch: s.branch, head: 'abc', isMain: false, managed: true, additions: i ? 8 : 23, deletions: i ? 2 : 7, uncommitted: 1, unpushed: 0, ahead: 0, behind: 0 }));
  answers.list_harnesses = [{ id: 'gemini', name: 'Gemini', available: true }];
  answers.listening_sessions = ['one'];
  answers.pty_shells = [];
  answers.pty_busy = [];
  answers.pane_agents = [];
  answers.session_summaries = [];
  answers.local_sections = { revision: 0, sections: [] };
  answers.chats_dir = '/Chats';
  answers.load_tab_events = [];
  answers.tab_queued_messages = [];
  answers.tab_status = ({ sessionId }) => sessions.find(s => s.id === sessionId)?.tabs[0].status;
  answers.start_tab = null;
  const save = (session) => { localStorage.setItem('pro179.sessions', JSON.stringify(sessions)); emit('session_updated', structuredClone(session)); };
  answers.set_tab_unread = ({ sessionId, tabId, unread }) => { const s = sessions.find(s => s.id === sessionId); s.tabs.find(t => t.id === tabId).markedUnread = unread; save(s); return null; };
  answers.mark_tab_read = ({ sessionId, tabId }) => { const s = sessions.find(s => s.id === sessionId); s.tabs.find(t => t.id === tabId).markedUnread = false; save(s); return null; };
})();`;

const server = await serve();
let browser;
try {
  if (process.env.SCREENSHOTS) await mkdir(process.env.SCREENSHOTS, { recursive: true });
  for (const layout of ["simple", "list"]) for (const colorScheme of ["light", "dark"]) {
    browser = await launch();
    const page = await open(browser, server.url, { cloud: false, localProjects: 0 }, { width: 1100, height: 760 }, { extra: fixture(layout), colorScheme });
    page.setDefaultTimeout(15_000);
    await sidebar(page);
    const row = (id) => page.locator(`[data-row-sessions="${id}"]`);
    await row("one").getByText("+23", { exact: true }).waitFor();
    await row("one").getByRole("img", { name: "Open port", exact: true }).waitFor();
    assert.equal(await row("one").getByText("−7", { exact: true }).count(), 1);
    await row("one").hover();
    await row("one").getByRole("button", { name: /^Menu for/ }).focus();
    await page.keyboard.press("ArrowDown");
    await page.getByRole("menuitem", { name: "Mark as unread", exact: true }).waitFor();
    await page.keyboard.press("r");
    await page.getByRole("menuitem", { name: "Mark as read", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.reload();
    await sidebar(page);
    await row("one").hover();
    await row("one").getByRole("button", { name: /^Menu for/ }).focus();
    await page.keyboard.press("ArrowDown");
    await page.getByRole("menuitem", { name: "Mark as read", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    // A real shortcut opens the first waiting session, and the next follows dashboard recency.
    await page.keyboard.press("ControlOrMeta+Alt+l");
    await row("one").locator('button[aria-current="true"]').waitFor();
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('pro179.sessions'))[0].tabs[0].markedUnread);
    const composer = page.locator("textarea").first();
    await composer.fill("Finish the regression test before pushing");
    await row("one").getByTestId("row-draft").waitFor();
    await page.keyboard.press("ControlOrMeta+Alt+l");
    await row("two").locator('button[aria-current="true"]').waitFor();
    await page.keyboard.press("ControlOrMeta+Alt+l");
    await row("one").locator('button[aria-current="true"]').waitFor();
    assert.equal(await composer.inputValue(), "Finish the regression test before pushing");
    assert.equal(await page.getByTestId("conversation-list").evaluate(el => el.scrollWidth > el.clientWidth + 1), false, "row extras fit the sidebar");
    await page.mouse.move(700, 350);
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/${layout}-${colorScheme}.png` });
    await row("one").hover();
    await row("one").getByRole("button", { name: /^Archive / }).hover();
    await page.getByRole("tooltip").filter({ hasText: "Archive" }).waitFor();
    assert.ok((await page.getByRole("tooltip").innerText()).includes("E"), "Archive tooltip includes its configured shortcut");
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/${layout}-${colorScheme}-archive.png` });
    await browser.close();
    browser = null;
    console.log(`ok sidebar extras: ${layout}, ${colorScheme}`);
  }
} finally {
  await browser?.close();
  server.close();
}
