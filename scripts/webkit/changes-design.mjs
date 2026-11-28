#!/usr/bin/env node
// PRO-393: the Changes panel and diff header as designed (05.03–05.22), in WebKit, dark and light at 1440 wide.
// CHANGES_DESIGN_SHOTS=<dir> also saves a capture of each scene.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";

const entry = `
// The centre diff tab reads through the native bridge: answer the Git reads it makes, leave the rest pending.
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (command, args) => {
  const changed = window.__fixtureFiles ?? [];
  if (command === 'changes_between') return changed;
  if (command === 'review_range') return { base: 'base', head: 'head', target: 'origin/main' };
  if (command === 'file_contents_at') return window.__fixtureContents(args.path);
  return new Promise(() => {});
} };
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChangesPanel } from '/src/components/changes/ChangesPanel.tsx';
import { FileDiff } from '/src/components/changes/FileDiff.tsx';
import { saveChangesChoice } from '/src/lib/changesScope.ts';
import { DiffEditorPane } from '/src/components/editor/DiffEditorPane.tsx';
import { getEditors, openDiff } from '/src/lib/editors.ts';
import { setPrefs } from '/src/lib/prefs.ts';
import '/src/styles/app.css';
const params = new URLSearchParams(location.search);
const scene = params.get('scene');
document.documentElement.setAttribute('data-theme', 'den');
document.documentElement.setAttribute('data-mode', params.get('mode'));
setPrefs({ diffMode: scene === 'split' ? 'split' : 'unified', diffWrap: true, diffHideWhitespace: false, diffWrapFiles: {} });
const now = Date.now();
const iso = (minutes) => new Date(now - minutes * 60000).toISOString();
const ev = (seq, payload, minutes) => ({ id: 'e' + seq, sessionId: 's', tabId: 't', harness: 'codex', seq, ts: iso(minutes), payload });
const events = [
  ev(1, { type: 'user_message', text: 'Publish the layouts as an artifact', queued: false }, 52), ev(2, { type: 'turn_checkpoint', seq: 1, base: 'b1', head: 'h1' }, 52),
  ev(3, { type: 'user_message', text: 'Group the overview table by status and let people sort by any column. Remember the sort.', queued: false }, 31), ev(4, { type: 'turn_checkpoint', seq: 3, base: 'b2', head: 'h2' }, 31),
  ev(5, { type: 'user_message', text: 'Hide the Agent column by default and use the compact row density.', queued: false }, 3), ev(6, { type: 'turn_checkpoint', seq: 5, base: 'b3', head: 'h3' }, 3),
];
const files = [
  ['src/components/dashboard/OverviewTable.tsx', 'modified', 62, 9], ['src/lib/overviewSort.ts', 'added', 48, 0], ['src/lib/overviewSort.test.ts', 'added', 71, 0],
  ['src/components/dashboard/AgentDashboard.tsx', 'modified', 12, 17], ['packages/portable/src/dashboard.ts', 'modified', 9, 4], ['src/lib/prefs.ts', 'modified', 6, 0],
].map(([path, status, additions, deletions]) => ({ path, status, additions, deletions, blobHash: path }));
const long = Array.from({ length: 120 }, (_, i) => 'export const line' + i + ' = ' + i + ';').join('\\n');
const changed = long.replace('line60 = 60;', 'line60 = sortSessions(sessions, sort);\\nexport const added = true;');
const commits = [['41f0b7d', 'Add overview table columns'], ['a7d93c2', 'Sort sessions by last active'], ['5be01f4', 'Merge origin/main into raccoon/session-overview']]
  .map(([short, subject]) => ({ sha: short + 'a'.repeat(33), shortSha: short, subject, body: '', author: 'A', email: '', date: iso(10), parent: 'p'.repeat(40), tree: short === '5be01f4' ? 'empty' : 't-' + short }));
const merge = { head: '8e2d1f0' + '0'.repeat(33), mergeHead: '7'.repeat(40), names: ['origin/main', 'main'], incoming: 3, conflicted: ['apps/api/src/billing/seats.ts', 'apps/api/src/billing/webhooks.ts'],
  changedHere: [], fromBase: ['apps/api/src/billing/prices.ts', 'apps/api/src/db/schema.ts', 'apps/api/src/billing/invoices.ts'], branch: 'raccoon/teams-billing',
  conflictCounts: { 'apps/api/src/billing/seats.ts': 2, 'apps/api/src/billing/webhooks.ts': 1 } };
const mergeFiles = [...merge.conflicted, ...merge.fromBase].map((path, i) => ({ path, status: i === 2 ? 'added' : 'modified', additions: 10 + i, deletions: i, blobHash: path }));
const key = scene === 'tab' ? 'local:/repo' : 'webkit:changes-design:' + scene;
window.__fixtureFiles = files;
window.__fixtureContents = (path) => path.endsWith('.json') ? { before: 'x', after: '<file too large to show>' } : { before: long, after: changed };
if (scene === 'empty') saveChangesChoice(key, { scope: 'commit', target: null, commit: commits[2].sha });
const source = {
  key, cloud: false, canWrite: true,
  branches: async () => [{ name: 'raccoon/session-overview', current: true, remote: false }, { name: 'main', current: false, remote: false }, { name: 'origin/main', current: false, remote: true }],
  // The scope popover asks for the branch's own commits, '<target>..HEAD' (c3f9ec9b); a sha asks for that commit; null for the history.
  logCommits: async (from, limit) => from === 'origin/main..HEAD' ? commits.slice(0, limit) : from ? commits.filter((c) => c.sha.startsWith(from)).concat(from.startsWith('p') ? [{ ...commits[0], sha: 'p'.repeat(40), parent: null, tree: 'parent' }] : []) : commits.slice(0, limit),
  reviewRange: async (target, uncommitted) => ({ base: uncommitted ? 'work' : 'base', head: uncommitted ? 'work-head' : 'head', target: target || 'origin/main' }),
  changesBetween: async (base, head) => scene === 'merge' ? mergeFiles : head === 'empty' ? [] : head === 'work-head' ? files.slice(0, 3) : base === 'b3' ? files.slice(0, 2) : base === 'b2' ? files : base === 'b1' ? files.slice(5) : files,
  fileContentsAt: async (path) => path.endsWith('.json') ? { before: 'x', after: '<file too large to show>' } : { before: long, after: changed },
  workingChanges: async () => ({ head: 'work', files: files.slice(0, 3) }),
  unfinishedMerge: scene === 'merge' ? async () => merge : undefined,
  commitMerge: async () => {}, abortMerge: async () => {}, conflictFile: async () => { throw new Error('unused'); }, discard: async () => {},
  errorMessage: String,
};
const tabPath = params.get('path') ?? 'src/components/dashboard/OverviewTable.tsx';
const tabId = scene === 'tab' ? openDiff('s', '/repo', tabPath, { scope: 'all', range: { base: 'base', head: 'head' }, target: null, uncommitted: false }) : null;
const tab = tabId ? getEditors().editors.find((e) => e.id === tabId) : null;
const centre = tab ? <DiffEditorPane entry={tab} visible />
  : scene === 'empty'
  ? <FileDiff source={source} path="src-tauri/gen/schemas/macOS-schema.json" base="base" head="head" size={2.4 * 1024 * 1024} onOpenFile={() => {}} />
  : scene === 'merge' ? null
  : <FileDiff source={source} path="src/components/dashboard/OverviewTable.tsx" base="base" head="head" stats={{ additions: 62, deletions: 9 }} onDiscard={() => {}} />;
createRoot(document.getElementById('root')).render(<div className="bg-background text-foreground" style={{ display: 'flex', width: '100vw', height: '100vh' }}>
  <div style={{ width: 268 }} className="border-r border-hairline" />
  <div data-testid="centre" style={{ width: 752, height: '100%' }} className="border-r border-hairline">{centre}</div>
  <div data-testid="panel" style={{ flex: 1, minWidth: 0, height: '100%' }}><ChangesPanel source={source} events={events} version={6} active live={false} /></div>
</div>);
`;

async function serve() {
  const { transformWithEsbuild } = await import("vite");
  const { createCheckServer } = await import("./vite-page.mjs");
  const server = await createCheckServer({ server: { host: "127.0.0.1", hmr: false }, plugins: [{
    resolveId(id) { if (id === "/changes-design.tsx") return "\0changes-design.tsx"; },
    async load(id) { if (id === "\0changes-design.tsx") return (await transformWithEsbuild(entry, "changes-design.tsx", { loader: "tsx", jsx: "automatic" })).code; },
    configureServer(server) {
      server.middlewares.use("/changes-design-runner", async (_request, response) => {
        response.setHeader("Content-Type", "text/javascript");
        response.end(await readFile(new URL(import.meta.url)));
      });
      server.middlewares.use("/changes-design-test", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml("/changes-design-test", '<div id="root"></div><script type="module" src="/changes-design.tsx"></script>'));
      });
    },
  }] });
  await server.listen();
  return server;
}

const shots = process.env.CHANGES_DESIGN_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
let server, browser;
try {
  server = await serve();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/changes-design-test`;
  const { launch } = await import("./harness.mjs");
  browser = await launch();
  const luminance = (rgb) => { const [r, g, b] = rgb.match(/[\d.]+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  for (const mode of shots ? ["dark", "light"] : ["dark"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Panels fade in: capture once they have settled.
    const shot = async (name) => { if (shots) { await page.waitForTimeout(450); await page.screenshot({ path: `${shots}/${name}-${mode}.png` }); } };

    // 05.03: the scope popover with the branches, live scopes, numbered turns and commits.
    await page.goto(`${url}?scene=scope&mode=${mode}`);
    await page.getByText("0 of 6 viewed").waitFor();
    await page.locator(".cm-collapsedLines").first().waitFor();
    const band = await page.locator(".cm-collapsedLines").first().evaluate((el) => ({ text: el.textContent, background: getComputedStyle(el).backgroundColor, image: getComputedStyle(el).backgroundImage, height: el.getBoundingClientRect().height }));
    assert.match(band.text, /^\d+ unmodified lines$/);
    assert.equal(band.image, "none", "no zigzag edge on the unchanged-lines band");
    if (mode === "dark") assert(luminance(band.background) < 60, `unchanged-lines band is dark in dark mode: ${band.background}`);
    assert.equal(await page.locator("input[type=checkbox]").evaluateAll((boxes) => boxes.filter((box) => getComputedStyle(box).appearance !== "none").length), 0, "no native checkboxes");
    assert.equal(await page.getByText(/review comments?/).count(), 0, "no empty review-comments bar");
    assert.equal(await page.getByLabel("Changes scope").evaluate((el) => el.tagName), "BUTTON");
    assert.equal(await page.getByRole("button", { name: "Comparison target" }).textContent(), "vs main");
    await page.getByRole("button", { name: "Changes scope" }).click();
    await page.getByText("6 files · +208 −30 against origin/main").waitFor();
    for (const row of ["Latest turn · Hide the Agent column by default and use the…", "Turn 2 · Group the overview table by status and let…", "Turn 1 · Publish the layouts as an artifact"]) await page.getByText(row, { exact: true }).waitFor();
    await page.getByText("2 files · 3 min ago").waitFor();
    await page.getByText("41f0b7d").waitFor();
    assert.equal(await page.getByText("Turns in this session").count(), 1);
    await shot("05.03-scope");
    await page.keyboard.press("Escape");

    // The file rows: status letters, no Viewed or Discard until hovered.
    const row = page.getByRole("button", { name: /OverviewTable\.tsx/ });
    assert.equal(await row.locator("[data-status]").textContent(), "MModified");
    assert.equal(await page.getByRole("button", { name: "Discard changes to src/lib/prefs.ts" }).isVisible(), false);
    await page.getByRole("button", { name: /prefs\.ts/ }).hover();
    assert.equal(await page.getByRole("button", { name: "Discard changes to src/lib/prefs.ts" }).isVisible(), true);
    // PRO-400 (17.01): Discard asks in the app's own card, which names the file and counts the lines that go back.
    await page.getByRole("button", { name: "Discard changes to src/lib/prefs.ts" }).click();
    const discard = page.getByRole("dialog", { name: "Discard changes to src/lib/prefs.ts?" });
    await discard.waitFor();
    assert.match(await discard.innerText(), /6 added lines go back to .+\. This can’t be undone\./);
    assert.deepEqual((await discard.getByRole("button").allTextContents()).map((label) => label.trim()), ["Cancel", "Discard"]);
    const red = await discard.getByRole("button", { name: "Discard", exact: true }).evaluate((button) => {
      const probe = document.createElement("i");
      probe.style.background = "var(--destructive)";
      document.body.append(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { got: getComputedStyle(button).backgroundColor, want };
    });
    assert.equal(red.got, red.want, "Discard is the red action");
    await shot("17.01-discard");
    await discard.getByRole("button", { name: "Cancel", exact: true }).click();
    await discard.waitFor({ state: "detached" });
    await page.getByLabel("Viewed src/lib/overviewSort.ts").check();
    await page.getByText("1 of 6 viewed").waitFor();
    // 05.04: one header row: chip, +/−, copy, layout, options.
    const header = await page.getByTestId("centre").locator("> div > div").first().evaluate((el) => el.getBoundingClientRect().height);
    assert(header <= 41, `diff header is one row (${header}px)`);
    await page.mouse.move(0, 0);
    await shot("05.04-diff");

    // 05.05: split with View options; missing lines hatched.
    await page.getByRole("radio", { name: "Split" }).click();
    await page.locator(".cm-mergeSpacer").first().waitFor();
    assert.match(await page.locator(".cm-mergeSpacer").first().evaluate((el) => getComputedStyle(el).backgroundImage), /repeating-linear-gradient/);
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Hide whitespace changes" }).waitFor();
    await page.getByRole("menuitemcheckbox", { name: "Wrap lines" }).waitFor();
    await shot("05.05-split");
    await page.keyboard.press("Escape");

    // 05.11: the merge card whole, its lists with nothing listed again under them.
    await page.goto(`${url}?scene=merge&mode=${mode}`);
    await page.getByText("Unresolved conflicts · 2").waitFor();
    await page.getByText(/Aborting puts the branch back at 8e2d1f0/).waitFor();
    assert.equal(await page.getByText(/Until it is committed/).count(), 0);
    assert.equal(await page.getByText(/of \d+ viewed/).count(), 0);
    assert.equal(await page.getByRole("checkbox").count(), 0);
    assert(await page.getByText(/Aborting puts/).evaluate((el) => el.getBoundingClientRect().bottom < innerHeight), "abort note is not cut off");
    await shot("05.11-merge");

    // 05.21 / 05.22: an empty commit and a file too large to diff, as calm centred states.
    await page.goto(`${url}?scene=empty&mode=${mode}`);
    await page.getByText("No file changes in 5be01f4").waitFor();
    await page.getByText("A merge with no conflicts adds no changes of its own.").waitFor();
    await page.getByRole("button", { name: "Pick another commit" }).waitFor();
    await page.getByText("No diff to show").waitFor();
    assert.equal(await page.getByRole("button", { name: "Retry" }).count(), 0);
    assert.equal(await page.getByTestId("centre").locator(".text-destructive, [role=alert]").count(), 0, "a too-large file is not an error");
    await page.getByText("2.4 MB", { exact: true }).waitFor();
    assert.equal(await page.getByText("Filter files…").count(), 0);
    await shot("05.21-22-empty");

    // 05.04 in the centre tab: one header row with the view, layout, options and Viewed; 05.22 there too.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${url}?scene=tab&mode=${mode}`);
    const centre = page.getByTestId("centre");
    await centre.getByRole("radio", { name: "Entire file" }).waitFor();
    await centre.getByText("+62").waitFor();
    await centre.locator(".cm-collapsedLines").first().waitFor();
    const viewedBox = centre.getByLabel("Viewed src/components/dashboard/OverviewTable.tsx");
    await viewedBox.check();
    await page.getByTestId("panel").getByText("1 of 6 viewed").waitFor();
    const bar = await centre.getByTestId("diff-editor").locator("> div").first().evaluate((el) => el.getBoundingClientRect().height);
    assert(bar <= 41, `centre diff header is one row (${bar}px)`);
    assert.equal(await centre.getByText("src/components/dashboard/OverviewTable.tsx").count(), 1, "the path appears once");
    await shot("05.04-tab");
    await page.goto(`${url}?scene=tab&mode=${mode}&path=src-tauri/gen/schemas/macOS-schema.json`);
    await centre.getByText("No diff to show").waitFor();
    assert.equal(await centre.locator(".text-destructive, [role=alert]").count(), 0);
    assert.equal(await centre.getByRole("button", { name: "Retry" }).count(), 0);
    await centre.getByRole("button", { name: "Open file" }).waitFor();
    await shot("05.22-tab-large");

    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal page overflow at ${width}px`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("ok scope popover, status letters, hover actions, one-row diff header, dark unchanged-lines bands, hatched split, merge card whole, calm empty and too-large states");
} finally { await browser?.close(); await server?.close(); }
