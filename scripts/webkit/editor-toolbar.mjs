#!/usr/bin/env node
// Real toolbar/control components and app CSS in WebKit; no native app or agent launch.
// pnpm test:webkit-editor-toolbar
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorToolbar } from '/src/components/editor/EditorToolbar.tsx';
import { Segmented } from '/src/components/ui/controls.tsx';
import '/src/styles/app.css';
import { RepoPanel } from '/src/components/changes/RepoPanel.tsx';
import { CloudGitView } from '/src/components/cloud/CloudGit.tsx';
import { AutomationEditor } from '/src/components/automations/AutomationEditor.tsx';
import { CloudCreateWorkspace } from '/src/components/cloud/CloudCreateWorkspace.tsx';
import { CloudSchedulesDialog } from '/src/components/cloud/CloudSchedulesDialog.tsx';
import { CloudWorkspaceLifecycleDialog } from '/src/components/cloud/CloudWorkspaceLifecycle.tsx';
import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
import { api } from '/src/lib/api.ts';
const noop = () => {};
// Read-only service replies; render the real callers without a running workspace.
api.cloudProviders = async () => ({ providers: [] });
api.cloudWorkspaceRepositories = async () => ({ configured: true, repositories: [] });
api.cloudSchedules = async () => ({ schedules: [] });
api.cloudWorkspaceDisposition = async () => { throw new Error('offline'); };
const client = { call: async method => {
  if (method === 'git.repositories') return { repositories: [{ repo: 'app', branch: 'main', head: 'abc', remote: null, defaultBranch: 'main' }] };
  if (method === 'git.status') return { repository: true, repo: 'app', branch: 'main', head: 'abc', files: [], conflicted: [] };
  if (method === 'git.workingChanges') return { repo: 'app', head: 'abc', files: [] };
  throw new Error('not available in layout check: ' + method);
}};
function Screens({ screen }) {
  if (screen === 'RepoPanel') return <RepoPanel cwd="/repos/p0" active={false} view="uncommitted" onViewChange={noop}/>;
  if (screen === 'CloudGit') return <CloudGitView workspaceKey="layout" client={client} active state={{state: 'connected', runtimeGeneration: 1, runtimeVersion: '1', capabilities: ['git/1'], authority: 'manage'}}/>;
  if (screen === 'AutomationEditor') return <AutomationEditor open automation={null} onOpenChange={noop} onSaved={noop}/>;
  if (screen === 'CloudCreateWorkspace') return <CloudCreateWorkspace organizationId="org-1" onOpen={noop}/>;
  if (screen === 'CloudSchedulesDialog') return <CloudSchedulesDialog orgId="org-1" workspaceId="ws-1" name="Docs" onClose={noop}/>;
  if (screen === 'CloudWorkspaceLifecycle') return <CloudWorkspaceLifecycleDialog item={{ workspace: {id: 'ws-1', orgId: 'org-1', name: 'Docs', provider: 'box', state: 'ready'}, latestOperation: null }} initial="archive" onClose={noop} onDone={noop} onExport={noop} check={async () => ({kind: 'unavailable'})}/>;
  return null;
}

function App() {
  const [screen, setScreen] = useState(null);
  window.showScreen = setScreen;
  const [mode, setMode] = useState('preview');
  const [overrides, setOverrides] = useState({});
  window.configureToolbar = setOverrides;
  if (screen) return <TooltipProvider><div style={{width: '100%', height: 700}}><Screens key={screen} screen={screen}/></div></TooltipProvider>;
  return <><div id="pane" style={{width: 700}}><EditorToolbar
    path="/repos/project/docs/deeply/nested/README.md" relativePath="docs/deeply/nested/README.md"
    markdown viewMode={mode} onViewModeChange={setMode} readOnly dirty truncated
    saveDisabled={false} saveKeys={['⌘', 'S']} onSave={() => { window.saved = true; }}
    copyKeys={['⌥', '⌘', 'C']} contentsDisabled={false}
    onCopy={() => { window.actions.push('copy'); }} onDownload={() => { window.actions.push('download'); }} {...overrides}
  /></div><button id="after">After toolbar</button>
  <div id="shared" style={{width: 120}}>{[
    ['RepoPanel', 'Uncommitted · 123', 'History'],
    ['CloudGit', 'Changes', 'Pull request'],
    ['AutomationEditor', 'New worktree per run', 'Existing session'],
    ['CloudCreateWorkspace', 'Only me', 'Organization'],
    ['CloudSchedulesDialog', 'Hourly', 'Daily', 'Weekdays', 'Weekly'],
    ['CloudWorkspaceLifecycle', 'Stop', 'Archive', 'Delete'],
  ].map(([name, ...labels]) => <div key={name} style={{display: 'flex', width: 120}}>
    <Segmented aria-label={name} value={labels[0]} onChange={() => {}} options={labels.map(label => ({value: label, label}))}/><button>Next</button>
  </div>)}</div></>;
}
window.actions = [];
createRoot(document.getElementById('root')).render(<App/>);
`;
const server = await createServer({
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
  plugins: [{
    name: 'editor-toolbar-regression',
    resolveId(id) { if (id === '/toolbar-regression.tsx') return '\0toolbar-regression.tsx'; },
    async load(id) {
      if (id === '\0toolbar-regression.tsx') return (await transformWithEsbuild(entry, 'toolbar-regression.tsx', { loader: 'tsx', jsx: 'automatic' })).code;
    },
    configureServer(server) {
      server.middlewares.use('/toolbar-test', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/toolbar-test', '<div id="root"></div><script type="module" src="/toolbar-regression.tsx"></script>'));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on('pageerror', error => console.error(error));
  await page.addInitScript(await readFile(new URL('./tauri-stub.js', import.meta.url), 'utf8'));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/toolbar-test`);
  const toolbar = page.getByTestId('editor-toolbar');
  await toolbar.waitFor();
  for (const width of [700, 600, 520, 519, 440, 439, 400, 399, 360, 359, 300, 290, 289, 260, 220, 219, 180, 120, 80]) {
    await page.locator('#pane').evaluate((pane, width) => { pane.style.width = `${width}px`; }, width);
    for (const selected of ['Preview', 'Source']) {
      const group = toolbar.getByRole('radiogroup', { name: 'View' });
      await group.focus();
      await page.keyboard.press(selected === 'Source' ? 'ArrowRight' : 'ArrowLeft');
      // Select explicitly for the first iteration too, then let the thumb finish sliding.
      // At scrolling widths WebKit's overlay scrollbar can cover the radio's
      // center between pointer-down and pointer-up. Click its uncovered top edge.
      await toolbar.getByRole('radio', { name: selected, exact: true }).click({ position: { x: 5, y: 5 } });
      await group.getByRole('radio', { name: selected, exact: true, checked: true }).waitFor({ state: 'attached', timeout: 3000 });
      await page.waitForTimeout(180);
      const result = await toolbar.evaluate((toolbar) => {
        const box = el => el.getBoundingClientRect();
        const visible = el => el && box(el).width > 0 && box(el).height > 0;
        const group = toolbar.querySelector('[role=radiogroup]');
        const radios = [...group.querySelectorAll('[role=radio]')];
        const thumb = box(group.firstElementChild);
        const selected = box(group.querySelector('[aria-checked=true]'));
        const controls = [...toolbar.querySelectorAll('button')].filter(visible).map(box);
        const save = toolbar.querySelector('[aria-label=Save]');
        return {
          pathTitle: toolbar.firstElementChild.firstElementChild.title,
          pathSeparate: box(toolbar.firstElementChild.firstElementChild).right <= box(group.parentElement).left + 0.5,
          statusSeparate: box(toolbar.querySelector('[data-testid=editor-notes]')).right <= box(group).left + 0.5,
          equal: Math.abs(box(radios[0]).width - box(radios[1]).width) < 0.5,
          thumb: Math.abs(thumb.left - selected.left) < 0.5 && Math.abs(thumb.width - selected.width) < 0.5,
          separate: controls.every((box, i) => !i || box.left >= controls[i - 1].right - 0.5),
          fits: radios.every(radio => radio.scrollWidth <= radio.clientWidth + 1),
          labels: radios.every(radio => visible(radio.querySelector('span'))),
          icons: radios.every(radio => visible(radio.querySelector('svg'))),
          saveLabel: visible(save.querySelector('span')),
          inlineContents: visible(toolbar.querySelector('[aria-label="Copy file contents"]')) && visible(toolbar.querySelector('[aria-label=Download]')),
          viewOptions: visible(toolbar.querySelector('[aria-label="View options"]')),
          reveal: visible(toolbar.querySelector('[aria-label="Reveal in Finder"]')),
          hint: visible(save.querySelector('kbd')),
          notes: visible(toolbar.querySelector('[data-testid=editor-notes] > span')),
          tabStops: group.tabIndex === 0 && radios.every(radio => radio.tabIndex === -1),
          scrollWidth: toolbar.firstElementChild.scrollWidth,
          clientWidth: toolbar.firstElementChild.clientWidth,
        };
      });
      assert(result.equal && result.thumb && result.separate && result.pathSeparate && result.statusSeparate && result.fits && result.tabStops, `${width}/${selected}: ${JSON.stringify(result)}`);
      assert.equal(result.pathTitle, '/repos/project/docs/deeply/nested/README.md');
      assert.equal(result.hint, width >= 520);
      assert.equal(result.saveLabel, width >= 440);
      assert.equal(result.labels, width >= 360);
      assert.equal(result.icons, width < 360);
      assert.equal(result.notes, width >= 290);
      assert.equal(result.reveal, width >= 220);
      // The menu holds Copy and Download too, so their own buttons give way first.
      assert.equal(result.inlineContents, width >= 400);
      assert(result.viewOptions, `View options button hidden at ${width}`);
      if (width >= 180) assert(result.scrollWidth <= result.clientWidth + 1, `unexpected overflow at ${width}`);
      await group.focus();
      await page.keyboard.press('ArrowRight');
      // Key delivery can finish before React commits the selection in WebKit.
      // Wait for the expected state; a missing keyboard update must still fail.
      await group.getByRole('radio', { name: selected === 'Preview' ? 'Source' : 'Preview', exact: true, checked: true }).waitFor({ state: 'attached', timeout: 3000 });
      // WebKit on macOS uses Option-Tab to include buttons in keyboard navigation.
      await page.keyboard.press('Alt+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), width >= 400 ? 'Copy file contents' : 'View options');
      if (width >= 220 && width < 400) {
        await page.keyboard.press('Alt+Tab');
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Reveal in Finder');
      }
    }
    console.log(`ok toolbar geometry, responsive order, names and keyboard at ${width}px`);
  }
  // View options (PRO-297): the four items in order, inside the window at every width, in Preview and Source.
  for (const width of [700, 399, 260, 220, 219, 180, 120]) {
    await page.locator('#pane').evaluate((pane, width) => { pane.style.width = `${width}px`; }, width);
    for (const selected of ['Preview', 'Source']) {
      await toolbar.getByRole('radio', { name: selected, exact: true }).click({ position: { x: 5, y: 5 } });
      const trigger = toolbar.getByRole('button', { name: 'View options' });
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const menu = page.getByRole('menu');
      await menu.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('[role=menu]')].every(menu => menu.getAnimations().every(animation => animation.playState === 'finished')));
      const items = await menu.evaluate(menu => [...menu.querySelectorAll('[role=menuitem],[role=menuitemcheckbox]')].map(item => item.textContent.trim()));
      // Too narrow for its own button, Reveal in Finder follows the four after a separator.
      assert.deepEqual(items, ['Wrap lines', 'Show whitespace', 'Copy file contents⌥⌘C', 'Download', ...(width < 220 ? ['Reveal in Finder'] : [])], `${width}/${selected}: ${items}`);
      const geometry = await menu.evaluate(menu => {
        const box = menu.getBoundingClientRect();
        const rows = [...menu.querySelectorAll('[role=menuitem],[role=menuitemcheckbox]')];
        return {
          inside: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
          width: Math.round(box.width),
          rows: rows.every(row => row.scrollWidth <= row.clientWidth + 1 && Math.round(row.getBoundingClientRect().height) === 32),
          label: menu.firstElementChild.textContent,
        };
      });
      assert(geometry.inside && geometry.rows && geometry.width === 262 && geometry.label === 'View options', `${width}/${selected}: ${JSON.stringify(geometry)}`);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
    }
    console.log(`ok view options menu at ${width}px`);
  }
  await page.locator('#pane').evaluate(pane => { pane.style.width = '700px'; });
  // Toggles keep the menu open, change at once and are remembered app-wide.
  await toolbar.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Wrap lines' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Wrap lines', checked: true }).waitFor();
  await page.getByRole('menuitemcheckbox', { name: 'Show whitespace', checked: false }).waitFor();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('raccoon.prefs'))).editorWrap, true);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/view-options-preview-700.png`, clip: { x: 0, y: 0, width: 720, height: 240 } });
  await page.getByRole('menuitem', { name: /Copy file contents/ }).click();
  await toolbar.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitem', { name: 'Download' }).click();
  await toolbar.getByRole('button', { name: 'Copy file contents' }).click();
  await toolbar.getByRole('button', { name: 'Download' }).click();
  assert.deepEqual(await page.evaluate(() => window.actions), ['copy', 'download', 'copy', 'download']);
  await page.evaluate(() => window.configureToolbar({ contentsDisabled: true }));
  assert(await toolbar.getByRole('button', { name: 'Copy file contents' }).isDisabled());
  await page.evaluate(() => window.configureToolbar({}));
  console.log('ok view options toggles and actions');
  if (process.env.SHOTS) {
    for (const width of [400, 260]) {
      await page.locator('#pane').evaluate((pane, width) => { pane.style.width = `${width}px`; }, width);
      await toolbar.getByRole('button', { name: 'View options' }).click();
      await page.getByRole('menu').waitFor();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${process.env.SHOTS}/view-options-${width}.png`, clip: { x: 0, y: 0, width: Math.max(width, 300) + 20, height: 240 } });
      await page.keyboard.press('Escape');
    }
  }
  await page.locator('#pane').evaluate(pane => { pane.style.width = '300px'; });
  await toolbar.getByRole('button', { name: 'Save', exact: true }).click();
  assert(await page.evaluate(() => window.saved));
  assert.equal(await toolbar.getByRole('button', { name: 'Save', exact: true }).getAttribute('title'), 'Save ⌘S');
  assert.equal(await toolbar.getByRole('radio', { name: 'Preview', exact: true }).getAttribute('title'), 'Preview');
  await page.evaluate(() => window.configureToolbar({ cloud: true, markdown: false, saveDisabled: true }));
  await toolbar.getByTestId('editor-cloud-file').waitFor({ state: 'attached' });
  assert.equal(await toolbar.getByRole('radiogroup').count(), 0);
  assert.equal(await toolbar.getByRole('button', { name: 'Reveal in Finder' }).count(), 0);
  assert(await toolbar.getByRole('button', { name: 'Save', exact: true }).isDisabled());
  console.log('ok cloud/plain-text toolbar and save state');
  // The shared switch under flex pressure with the unequal labels from every caller.
  // These are control-level checks, not end-to-end navigation through those screens.
  for (const group of await page.locator('#shared [role=radiogroup]').all()) {
    for (const constrained of [false, true]) {
      const geometry = await group.evaluate((group, constrained) => {
        if (constrained) group.style.width = '100%';
        const radios = [...group.querySelectorAll('button')];
        const boxes = radios.map(radio => radio.getBoundingClientRect());
        const next = group.nextElementSibling.getBoundingClientRect();
        return radios.every((radio, i) => radio.scrollWidth <= radio.clientWidth + 1 && Math.abs(boxes[i].width - boxes[0].width) < 0.5 && (!i || boxes[i].left >= boxes[i-1].right)) && boxes.at(-1).right <= next.left;
      }, constrained);
      assert(geometry, await group.getAttribute('aria-label'));
    }
    console.log(`ok shared switch: ${await group.getAttribute('aria-label')} at 120px`);
  }
  // Also measure the actual callers, including controls inside portalled dialogs.
  for (const [screen, name] of [
    ['RepoPanel', 'Repository view'], ['CloudGit', 'Git panel'],
    ['AutomationEditor', 'Run workspace'], ['CloudCreateWorkspace', 'Visibility'],
    ['CloudSchedulesDialog', 'How often'], ['CloudWorkspaceLifecycle', 'Action'],
  ]) {
    await page.evaluate(screen => window.showScreen(screen), screen);
    if (screen === 'CloudSchedulesDialog') await page.getByRole('button', { name: /New scheduled task/ }).click();
    await page.getByRole('radiogroup', { name, exact: true }).waitFor();
    // The dialog entrance scales its children. Measure after it finishes so
    // adjacent rectangles are compared at the same scale in WebKit.
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')].every(dialog =>
      dialog.getAnimations().every(animation => animation.playState === 'finished')));
    for (const width of [360, 240]) {
      await page.setViewportSize({ width, height: 900 });
      // WebKit can sample neighbouring boxes from different frames of a dialog's
      // entrance scale, reporting an overlap that is absent in the settled grid.
      // Measure the real layout after that animation, keeping every assertion.
      await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')]
        .every(dialog => dialog.getAnimations().every(animation => animation.playState === 'finished')),
      undefined, { timeout: 3000 });
      for (const group of await page.getByRole('radiogroup').all()) {
        const ok = await group.evaluate(group => {
          const radios = [...group.querySelectorAll('[role=radio]')];
          const boxes = radios.map(radio => radio.getBoundingClientRect());
          const thumb = group.firstElementChild.getBoundingClientRect();
          const selected = group.querySelector('[aria-checked=true]').getBoundingClientRect();
          const neighbours = [...group.parentElement.querySelectorAll('button')].filter(button => !group.contains(button)).map(button => button.getBoundingClientRect());
          const separate = boxes.every(box => neighbours.every(other => box.right <= other.left + 0.5 || box.left >= other.right - 0.5 || box.bottom <= other.top + 0.5 || box.top >= other.bottom - 0.5));
          return separate && radios.every((radio, i) => radio.scrollWidth <= radio.clientWidth + 1 && Math.abs(boxes[i].width - boxes[0].width) < 0.5 && (!i || boxes[i].left >= boxes[i-1].right)) && Math.abs(thumb.width - selected.width) < 0.5;
        });
        assert(ok, screen + ' / ' + await group.getAttribute('aria-label') + ' at ' + width);
      }
      console.log('ok real screen switches: ' + screen + ' at ' + width + 'px');
    }
  }

} finally {
  await browser?.close();
  await server.close();
}
