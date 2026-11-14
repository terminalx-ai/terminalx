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
    if (window.__PW_FAIL_MOVE__ && edit.kind === 'move') throw new Error('The sidebar changed on another device');
    if (edit.kind === 'reorder') { const at = state.sections.indexOf(target); [state.sections[at], state.sections[at + edit.by]] = [state.sections[at + edit.by], target]; }
    if (edit.kind === 'move') for (const section of state.sections) { section.sessions = section.sessions.filter((id) => !edit.sessionIds.includes(id)); if (section.id === edit.sectionId) section.sessions.push(...edit.sessionIds); }
    state = { ...state, revision: state.revision + 1 };
    localStorage.setItem('pro174.sections', JSON.stringify(state));
    emit('local_sections_changed', structuredClone(state));
    return structuredClone(state);
  };
})();`;

// A real pointer drag through dnd-kit's PointerSensor, as sidebar-order.mjs does it. hold() stops short of the drop.
const hold = async (page, from, to) => {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  assert.ok(start && end);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 8, { steps: 2 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const target = await to.boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
};
const drag = async (page, from, to) => {
  await hold(page, from, to);
  await page.mouse.up();
  await page.waitForTimeout(100);
};

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
    await section("Bugs").getByText("Drag sessions here", { exact: true }).waitFor();
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
    // Since #840 the sidebar has no standing New section row: a section is made from the
    // command palette (or a chat's Move to section menu).
    assert.equal(await page.getByRole("button", { name: "New section…", exact: true }).count(), 0, "no standing New section row");
    await page.getByRole("button", { name: /^Search/ }).click();
    await page.getByLabel("Command palette search").fill("New local section");
    await page.locator('[role="option"][id="command:local-section:create"]').click();
    await page.getByLabel("Section name", { exact: true }).fill("Refactor");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await section("Refactor").waitFor();
    // A chat can also create its destination section and move there in one action.
    await section("Release").getByText("Fix retry handling", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to section", exact: true }).hover();
    await page.getByRole("menuitem", { name: "New section…", exact: true }).click();
    await page.getByLabel("Section name", { exact: true }).fill("Retries");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await section("Retries").getByText("Fix retry handling", { exact: true }).waitFor();
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
    // PRO-174: drag sessions between sections and the main list, and drag section headers.
    // Now: Release (empty), Refactor (empty), Retries [two]; one and three in the main list.
    const ids = () => page.locator('[data-local-section]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-local-section')));
    const inSection = (id) => page.locator(`[data-local-section] [data-row-sessions~="${id}"]`).count();
    await drag(page, section("Retries").getByText("Fix retry handling", { exact: true }), section("Release").getByText("Drag sessions here", { exact: true }));
    await section("Release").getByText("Fix retry handling", { exact: true }).waitFor();
    assert.equal(await section("Retries").getByText("Drag sessions here", { exact: true }).count(), 1, "the emptied section shows its drop target");
    {
      // From the main list into a section's header, then back out to the main list. In the simple layout the
      // project tree is outside the sections' drag scope and reaches them through SidebarSort's bridge.
      await hold(page, page.locator('[data-row-sessions~="three"]'), section("Retries").getByRole("button", { name: "Retries", exact: true }));
      await page.locator('[data-local-section="' + (await section("Retries").getAttribute('data-local-section')) + '"][data-drop-over]').waitFor();
      assert.equal(await page.locator('[data-drop-over]').count(), 1, "only the section under the pointer is lit");
      if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/${layout}-${colorScheme}-drag-in.png` });
      await page.mouse.up();
      const held = section("Retries").locator('[data-row-sessions~="three"]');
      await held.waitFor();
      const start = await held.boundingBox();
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 8, { steps: 2 });
      const back = page.locator('[data-main-drop-target]');
      await back.waitFor();
      assert.equal(await back.textContent(), "Drop here to move to the main list");
      if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/${layout}-${colorScheme}-drag-out.png` });
      const end = await back.boundingBox();
      await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 20 });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector('[data-local-section] [data-row-sessions~="three"]') && document.querySelector('[data-row-sessions~="three"]'));
      assert.equal(await back.count(), 0);
    }
    // A section header drags the section: Retries goes above Release.
    assert.equal((await ids())[0], 'release');
    const last = (await ids()).at(-1);
    await drag(page, section("Retries").getByRole("button", { name: "Retries", exact: true }), section("Release").getByRole("button", { name: "Release", exact: true }));
    await page.waitForFunction((id) => document.querySelector('[data-local-section]')?.getAttribute('data-local-section') === id, last);
    assert.equal(await page.getByRole("button", { name: "Reorder section Release", exact: true }).count(), 1, "headers carry a keyboard grip");
    // A failed move raises the error toast and leaves the session where it was.
    await page.evaluate(() => { window.__PW_FAIL_MOVE__ = true; });
    await drag(page, section("Release").getByText("Fix retry handling", { exact: true }), section("Retries").getByRole("button", { name: "Retries", exact: true }));
    await page.getByText("Something went wrong", { exact: true }).waitFor();
    await page.getByText("Couldn't move “Fix retry handling” to Retries", { exact: false }).waitFor();
    await page.evaluate(() => { window.__PW_FAIL_MOVE__ = false; });
    await section("Release").getByText("Fix retry handling", { exact: true }).waitFor();
    assert.equal(await inSection("two"), 1);
    const overflow = await page.getByTestId("conversation-list").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
    console.log(`ok: local sections ${layout}, ${colorScheme}`);
    await browser.close();
    browser = null;
  }
} finally { await browser?.close(); server.close(); }
