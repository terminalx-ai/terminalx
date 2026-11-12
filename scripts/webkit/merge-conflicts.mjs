#!/usr/bin/env node
// PRO-293: the conflict view in a centre tab and the Merge in progress card, wide and narrow.
// A fake GitSource stands in for the checkout; the components are the app's own, rendered through Vite.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";

const SHOTS = process.env.MERGE_CONFLICTS_SHOTS
  ?? "/private/tmp/claude-501/-Users-developer-code-ai-raccoon--raccoon-worktrees-pro-293-resolve-merge-conflicts-in-the-a/8a20d9ee-0694-4452-ad96-be237749a02a/scratchpad/shots";

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConflictView } from '/src/components/changes/ConflictView.tsx';
import { MergeInProgress } from '/src/components/changes/MergeInProgress.tsx';
import { getEditors, openConflict } from '/src/lib/editors.ts';
import { upsertSession } from '/src/lib/sessions.ts';
import { TabIcon } from '/src/components/session/WorkspaceTabStrip.tsx';
import '/src/styles/app.css';

const head = '8e2d1f0' + '0'.repeat(33), mergeHead = '5'.repeat(40);
const path = 'apps/api/src/billing/seats.ts';
const now = Math.floor(Date.now() / 1000);
const merge = { head, mergeHead, names: ['origin/main'], incoming: 6, branch: 'raccoon/teams-billing',
  conflicted: [path, 'apps/api/src/billing/webhooks.ts'], conflictCounts: { [path]: 2, 'apps/api/src/billing/webhooks.ts': 1 },
  changedHere: [], fromBase: ['apps/api/src/billing/prices.ts', 'apps/api/src/db/schema.ts', 'apps/api/src/billing/invoices.ts'] };
const files = [
  { path: 'apps/api/src/billing/prices.ts', status: 'added', additions: 64, deletions: 0 },
  { path: 'apps/api/src/db/schema.ts', status: 'modified', additions: 12, deletions: 3 },
  { path: 'apps/api/src/billing/invoices.ts', status: 'modified', additions: 21, deletions: 9 },
];
const second = { kind: 'conflict', hunk: { index: 1, line: 23, ours: '  return { description: \`Seats ×\${change.delta}\`, amount: prorate(change, change.period) };\\n', theirs: '  return { description: \`Seats ×\${change.delta} (\${change.period.currency})\`, amount: prorate(change, change.period), currency: change.period.currency };\\n', base: null } };
const conflictFile = (version, both) => ({
  path, version, unsupported: null, conflicts: both ? 2 : 1,
  ours: { branch: 'raccoon/teams-billing', commit: { id: 'a', subject: 'Seat deltas', author: 'Paresh', time: now - 7200, pr: null } },
  theirs: { branch: 'origin/main', commit: { id: 'b', subject: 'Multi-currency prices with a subject long enough to need truncating in a narrow tab', author: 'Aisha', time: now - 86400, pr: 209 } },
  segments: [
    { kind: 'text', text: 'import { priceFor, roundCents } from "./prices";\\n\\nexport function prorate(seats: SeatChange, period: BillingPeriod) {\\n  const days = daysLeft(period);\\n' },
    ...(both ? [{ kind: 'conflict', hunk: { index: 0, line: 5, ours: '  const unit = seats.plan.pricePerSeat / period.days;\\n  return Math.round(unit * days * seats.delta);\\n', theirs: '  const unit = priceFor(seats.plan, period.currency);\\n  return roundCents((unit / period.days) * days * seats.delta);\\n', base: null } }]
      : [{ kind: 'text', text: '  const unit = seats.plan.pricePerSeat / period.days;\\n  return Math.round(unit * days * seats.delta);\\n  const unit = priceFor(seats.plan, period.currency);\\n  return roundCents((unit / period.days) * days * seats.delta);\\n' }]),
    { kind: 'text', text: '}\\n\\nexport function seatInvoiceLine(change: SeatChange) {\\n' },
    both ? second : { ...second, hunk: { ...second.hunk, index: 0, line: 19 } },
    { kind: 'text', text: '}\\n' },
  ],
});
window.writes = [];
const source = {
  key: 'local:/repo', cloud: false, canWrite: true,
  unfinishedMerge: async () => merge,
  conflictFile: async () => conflictFile('v1', true),
  resolveConflict: async (_m, file, index, choice) => { window.writes.push([file.version, index, choice]); return conflictFile('v2', false); },
  markResolved: async () => {},
  commitMerge: async () => {}, abortMerge: async () => {},
  errorMessage: String,
};
const watcher = { kind: 'local', stat: async () => ({ version: '1' }), watch: () => () => {} };
// The session the tab belongs to, with its agent tab open in chat: the Ask buttons send to it.
upsertSession({ id: 's1', kind: 'quick', title: 'Seat-based Teams billing', projectPath: '/repo', cwd: '/repo', activeTab: 't1', tabs: [{ id: 't1', front: 'chat', status: 'idle' }] });
const id = openConflict('s1', '/repo', path, merge, 2);
function App() {
  const editors = React.useSyncExternalStore((cb) => { const t = setInterval(cb, 100); return () => clearInterval(t); }, () => getEditors());
  const tab = editors.editors.find((e) => e.id === id);
  return <div style={{ display: 'flex', width: '100vw', height: '100vh' }}>
    <main data-testid="centre" style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-hairline px-3 text-[13px]">
        <TabIcon tab={{ kind: 'review', id, key: id, sessionId: 's1', editor: tab }} />
        <span data-testid="tab-title">{tab.name}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}><ConflictView entry={tab} visible source={source} files={watcher} /></div>
    </main>
    <aside data-testid="panel" className="border-l border-hairline" style={{ width: 'var(--panel-w)', flex: 'none', overflowY: 'auto', overflowX: 'hidden' }}>
      <MergeInProgress source={source} merge={merge} files={files} allChanges={false} sessionId="s1" openPath={path}
        onChanged={() => {}} onOpenConflict={() => {}} onOpenFile={() => {}} />
    </aside>
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
`;

/** The app's Tauri bridge: the agent tab takes what is sent to it; any other command fails the check. */
const BRIDGE = `
window.sent = [];
window.__TAURI_INTERNALS__ = {
  invoke: async (command, args) => {
    if (command === "send_message") { window.sent.push(args); return { events: [], queued: false }; }
    // The app's theme follows the page; the window chrome has nothing to answer.
    if (command === "plugin:window|set_theme") return null;
    throw new Error(command + " is not part of this check");
  },
  transformCallback: () => 0,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};`;

async function serve() {
  const { createServer, transformWithEsbuild } = await import("vite");
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "merge-conflicts-check",
    resolveId(id) { if (id === "/merge-conflicts.tsx") return "\0merge-conflicts.tsx"; },
    async load(id) { if (id === "\0merge-conflicts.tsx") return (await transformWithEsbuild(entry, "merge-conflicts.tsx", { loader: "tsx", jsx: "automatic" })).code; },
    configureServer(server) {
      server.middlewares.use("/merge-conflicts-runner", async (_request, response) => {
        response.setHeader("Content-Type", "text/javascript");
        response.end(await readFile(new URL(import.meta.url)));
      });
      server.middlewares.use("/merge-conflicts-test", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml("/merge-conflicts-test", `<script>${BRIDGE}</script><div id="root"></div><script type="module" src="/merge-conflicts.tsx"></script>`));
      });
    },
  }] });
  await server.listen();
  return server;
}

/** Nothing in the box scrolls sideways, and every button in it lies inside it. */
async function fits(page, testId) {
  return page.getByTestId(testId).evaluate((box) => {
    const outer = box.getBoundingClientRect();
    const scrollers = [box, ...box.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible" && getComputedStyle(el).overflowX !== "hidden" && !el.className.toString().includes("truncate"));
    const buttons = [...box.querySelectorAll("button")].map((button) => ({ text: button.textContent.trim() || button.getAttribute("aria-label"), rect: button.getBoundingClientRect() }));
    const outside = buttons.filter(({ rect }) => rect.width === 0 || rect.left < outer.left - 0.5 || rect.right > outer.right + 0.5).map(({ text }) => text);
    return { scrollers: scrollers.map((el) => el.tagName + "." + el.className.toString().slice(0, 40)), outside, buttons: buttons.length };
  });
}

let server, browser;
try {
  server = await serve();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/merge-conflicts-test`;
  await mkdir(SHOTS, { recursive: true });
  const { webkit } = await import("playwright");
  browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  for (const [name, width, panel] of [["wide", 1440, 420], ["narrow", 880, 320]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((w) => document.documentElement.style.setProperty("--panel-w", `${w}px`), panel);
    await page.getByText("Conflict 1 of 2").waitFor();
    const centre = await page.getByTestId("centre").evaluate((el) => el.getBoundingClientRect().width);
    assert(Math.abs(centre - (width - panel)) < 2, `${name}: centre is ${width - panel}px (got ${centre})`);
    assert.equal(await page.getByTestId("tab-title").textContent(), "seats.ts · 2 conflicts");
    const first = page.getByRole("group", { name: "Conflict 1 of 2, line 5" });
    const yours = await first.getByRole("region", { name: "Yours" }).boundingBox();
    const theirs = await first.getByRole("region", { name: "Theirs" }).boundingBox();
    assert(theirs.y >= yours.y + yours.height - 0.5, `${name}: Theirs stacks under Yours`);
    assert(Math.abs(theirs.width - yours.width) < 1, `${name}: Yours and Theirs share the width`);
    for (const label of ["Keep yours", "Keep theirs", "Keep both", "Ask the agent to combine them", "Mark resolved", "Previous conflict", "Next conflict"]) {
      const button = await page.getByTestId("centre").getByRole("button", { name: label }).boundingBox();
      assert(button && button.width > 0 && button.x >= 0 && button.x + button.width <= width - panel + 0.5, `${name}: ${label} stays visible in the centre`);
    }
    for (const label of ["Ask the agent to resolve", "Abort merge…"]) {
      const button = await page.getByTestId("panel").getByRole("button", { name: label }).boundingBox();
      assert(button && button.x >= width - panel - 0.5 && button.x + button.width <= width + 0.5, `${name}: ${label} stays visible in the panel`);
    }
    // With an agent tab in chat, both Ask buttons are live, as the design draws them.
    assert(await page.getByRole("button", { name: "Ask the agent to combine them" }).isEnabled(), `${name}: Ask the agent to combine them is enabled`);
    assert(await page.getByRole("button", { name: "Ask the agent to resolve" }).isEnabled(), `${name}: Ask the agent to resolve is enabled`);
    // The row of the file open in the centre is marked.
    assert.equal(await page.getByTitle(`Unresolved · ${"apps/api/src/billing/seats.ts"}`).getAttribute("aria-current"), "page", `${name}: the open file's row is current`);
    assert.equal(await page.getByTitle("Unresolved · apps/api/src/billing/webhooks.ts").getAttribute("aria-current"), null);
    assert(await page.getByTestId("centre").getByLabel("Merge conflict").isVisible(), `${name}: the tab shows the warning icon`);
    for (const id of ["centre", "panel"]) {
      const fit = await fits(page, id);
      assert.deepEqual(fit.scrollers, [], `${name}: nothing in the ${id} scrolls sideways`);
      assert.deepEqual(fit.outside, [], `${name}: every button in the ${id} is inside it`);
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no horizontal page overflow`);
    await page.getByText("Unresolved conflicts · 2").waitFor();
    await page.getByText("Brought in by the merge · 3").waitFor();
    await page.getByText("Aborting puts the branch back at 8e2d1f0 and keeps your uncommitted work.").waitFor();
    await page.screenshot({ path: `${SHOTS}/merge-conflicts-${name}.png` });
    console.log(`ok ${name}: ${width - panel}px centre, ${panel}px panel; sides stack, buttons visible, no sideways scroll; ${SHOTS}/merge-conflicts-${name}.png`);
  }
  // Asking the agent sends to the session's agent tab: one conflict, then every conflicted file.
  await page.getByRole("button", { name: "Ask the agent to combine them" }).click();
  await page.getByText("Conflict 1 sent to the agent tab.").waitFor();
  await page.getByRole("button", { name: "Ask the agent to resolve" }).click();
  await page.getByText("Sent to the agent tab.", { exact: true }).waitFor();
  const sent = await page.evaluate(() => window.sent);
  assert.deepEqual(sent.map(({ sessionId, tabId }) => [sessionId, tabId]), [["s1", "t1"], ["s1", "t1"]]);
  assert.match(sent[0].text, /the file "apps\/api\/src\/billing\/seats\.ts" has 2 conflicts\. Resolve conflict 1 of 2, the one whose <<<<<<< marker is on line 5/);
  assert.match(sent[1].text, /- "apps\/api\/src\/billing\/seats\.ts": 2 conflicts\n- "apps\/api\/src\/billing\/webhooks\.ts": 1 conflict/);
  console.log("ok Ask the agent sends conflict 1 of seats.ts, then every conflicted file, to the session's agent tab");
  // A Keep shows the file the backend returned, and the tab title follows.
  await page.getByRole("group", { name: "Conflict 1 of 2, line 5" }).getByRole("button", { name: "Keep both" }).click();
  await page.getByText("Conflict 1 of 1").waitFor();
  assert.deepEqual(await page.evaluate(() => window.writes), [["v1", 0, "both"]]);
  await page.waitForFunction(() => document.querySelector('[data-testid="tab-title"]')?.textContent === "seats.ts · 1 conflict");
  await page.screenshot({ path: `${SHOTS}/merge-conflicts-narrow-after-keep.png` });
  assert.deepEqual(errors, []);
  console.log("ok Keep both writes conflict 1 with the version read and the tab counts 1 conflict");
} finally { await browser?.close(); await server?.close(); }
