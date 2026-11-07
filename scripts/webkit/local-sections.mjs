// PRO-174: the real sidebar in both layouts, with synthetic native storage.
// Run after pnpm build. SCREENSHOTS optionally saves light/dark review images.
// WEBKIT_TIMEOUT_MS allows slower shared VMs to use a longer assertion timeout.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launch, open, serve, sidebar } from "./harness.mjs";

const extra = (layout) => `(() => {
  const { answers, emit } = window.__PW_STUB__;
  answers["plugin:app|name"] = "TerminalX";
  answers["plugin:app|version"] = "0.2.24";
  const prefs = JSON.parse(localStorage.getItem('raccoon.prefs') || '{}');
  localStorage.setItem('raccoon.prefs', JSON.stringify({ ...prefs, sidebarLayout: ${JSON.stringify(layout)}, sidebarWidth: 268, branchSessions: 'sidebar', animations: false }));
  const session = (id, title, projectPath, branch) => ({ id, title, projectPath, cwd: projectPath, branch, created: '2026-11-01T12:00:00Z', modified: '2026-11-01T12:00:00Z', archived: false, pinned: false, worktreeRemoved: false, tabs: [], activeTab: null });
  answers.list_projects = { projects: [{ path: '/web', name: 'Website', kind: 'git' }, { path: '/api', name: 'API', kind: 'git' }], lastSelected: null };
  answers.list_sessions = [session('one', 'Prepare release notes', '/web', 'release'), session('two', 'Fix retry handling', '/api', 'fix-retry'), session('three', 'Simplify the parser', '/api', 'refactor')];
  answers.session_summaries = [];
  answers.chats_dir = '/Chats';
  let state = JSON.parse(localStorage.getItem('pro174.sections') || 'null') || { revision: 1, sections: [{ id: 'release', name: 'Release', emoji: '🚀', sessions: ['one', 'two'] }, { id: 'bugs', name: 'Bugs', emoji: '🐛', sessions: [] }] };
  answers.local_sections = () => structuredClone(state);
  answers.edit_local_section = ({ edit }) => {
    const target = state.sections.find((section) => section.id === edit.id);
    if (edit.kind === 'create') {
      const ids = edit.sessionIds || [];
      for (const section of state.sections) section.sessions = section.sessions.filter((id) => !ids.includes(id));
      state.sections.push({ id: 'created-' + state.revision, name: edit.name.trim(), emoji: edit.emoji, sessions: ids });
    }
    if (edit.kind === 'rename') target.name = edit.name.trim();
    if (edit.kind === 'emoji') target.emoji = edit.emoji;
    if (edit.kind === 'delete') state.sections = state.sections.filter((section) => section.id !== edit.id);
    if (edit.kind === 'reorder') { const at = state.sections.indexOf(target); [state.sections[at], state.sections[at + edit.by]] = [state.sections[at + edit.by], target]; }
    if (edit.kind === 'move') for (const section of state.sections) { section.sessions = section.sessions.filter((id) => !edit.sessionIds.includes(id)); if (section.id === edit.sectionId) section.sessions.push(...edit.sessionIds); }
    state = { ...state, revision: state.revision + 1 };
    localStorage.setItem('pro174.sections', JSON.stringify(state));
    emit('local_sections_changed', structuredClone(state));
    return structuredClone(state);
  };
})();`;

const server = await serve();
let browser;
try {
  if (process.env.SCREENSHOTS) await mkdir(process.env.SCREENSHOTS, { recursive: true });
  for (const layout of ["simple", "list"]) for (const colorScheme of ["light", "dark"]) {
    browser = await launch();
    const page = await open(browser, server.url, { cloud: false, localProjects: 0 }, { width: 1100, height: 760 }, { extra: extra(layout), colorScheme });
    page.setDefaultTimeout(Number(process.env.WEBKIT_TIMEOUT_MS ?? 30_000));
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await sidebar(page);
    const section = (name) => page.getByRole("region", { name: `${name} section`, exact: true });
    const menu = async (name, action) => {
      await page.getByRole("button", { name: `Menu for section ${name}`, exact: true }).click();
      await page.getByRole("menuitem", { name: action, exact: true }).click();
    };
    await section("Release").getByText("Prepare release notes", { exact: true }).waitFor();
    await section("Bugs").getByText(/Move sessions here/).waitFor();
    assert.equal(await page.locator('[data-row-sessions~="one"]').count(), 1);
    assert.equal(await page.locator('[data-row-sessions~="two"]').count(), 1);
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/${layout}-${colorScheme}.png` });

    await section("Release").getByText("Prepare release notes", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to section", exact: true }).hover();
    await page.getByRole("menuitem", { name: /Bugs/ }).click();
    await section("Bugs").getByText("Prepare release notes", { exact: true }).waitFor();
    await menu("Bugs", "Move section up");
    assert.equal(await page.locator('[data-local-section]').first().getAttribute('data-local-section'), 'bugs');
    await menu("Bugs", "Rename section…");
    await page.getByLabel("Section name", { exact: true }).fill("Fixes");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await section("Fixes").waitFor();
    await menu("Fixes", "Change emoji…");
    await page.getByLabel("Emoji (optional)", { exact: false }).fill("W".repeat(32));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(await section("Fixes").getByRole("button", { name: "Fixes", exact: true }).evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, "long emoji text stays within the section heading");
    assert.equal(await page.getByTestId("conversation-list").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, "long emoji text stays within the sidebar");
    await section("Release").getByText("Fix retry handling", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to section", exact: true }).hover();
    await page.getByRole("menuitem", { name: "New section…", exact: true }).click();
    await page.getByLabel("Section name", { exact: true }).fill("Refactor");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await section("Refactor").getByText("Fix retry handling", { exact: true }).waitFor();
    await section("Fixes").getByRole("button", { name: "Fixes", exact: true }).click();
    await page.reload();
    await section("Fixes").waitFor();
    assert.equal(await section("Fixes").getByRole("button", { name: "Fixes", exact: true }).getAttribute('aria-expanded'), 'false');
    await section("Fixes").getByRole("button", { name: "Fixes", exact: true }).click();
    await section("Fixes").getByText("Prepare release notes", { exact: true }).waitFor();
    await menu("Fixes", "Delete section…");
    await page.getByRole("dialog").getByRole("button", { name: "Delete section", exact: true }).click();
    await section("Fixes").waitFor({ state: "detached" });
    assert.equal(await page.locator('[data-row-sessions~="one"]').count(), 1);
    assert.equal(await page.evaluate(() => window.__PW_STUB__.answers.list_sessions.filter((session) => !session.archived).length), 3);
    const overflow = await page.getByTestId("conversation-list").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
    console.log(`ok: local sections ${layout}, ${colorScheme}`);
    await browser.close();
    browser = null;
  }
} finally { await browser?.close(); server.close(); }
