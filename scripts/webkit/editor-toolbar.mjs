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
import { AttachmentToolbar } from '/src/components/editor/AttachmentToolbar.tsx';
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
    saveDisabled={false} saveKeys={['⌘', 'S']} onSave={() => { window.saved = true; }} {...overrides}
  /></div><button id="after">After toolbar</button>
  <div id="attach" style={{width: 700}}><AttachmentToolbar
    path="/Users/me/.terminalx/attachments/7c1d2e9a-session/k3f9qa/release-checklist-for-the-november-build.md" name="release-checklist-for-the-november-build.md"
    sentAt={new Date(2026, 10, 13, 14, 31).toISOString()} markdown viewMode={mode} onViewModeChange={setMode} copyContents={() => '# Release'}
  /></div>
  <div id="attach-media" style={{width: 700}}><AttachmentToolbar path="/Users/me/.terminalx/attachments/7c1d2e9a-session/k3f9qa/shot.png" name="shot.png" /></div>
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
  const toolbar = page.locator('#pane').getByTestId('editor-toolbar');
  await toolbar.waitFor();
  for (const width of [700, 600, 520, 519, 440, 439, 360, 359, 300, 260, 259, 180, 120, 80]) {
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
        const controls = [...toolbar.querySelectorAll('button')].map(box);
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
      assert.equal(result.notes, width >= 260);
      if (width >= 180) assert(result.scrollWidth <= result.clientWidth + 1, `unexpected overflow at ${width}`);
      await group.focus();
      await page.keyboard.press('ArrowRight');
      // Key delivery can finish before React commits the selection in WebKit.
      // Wait for the expected state; a missing keyboard update must still fail.
      await group.getByRole('radio', { name: selected === 'Preview' ? 'Source' : 'Preview', exact: true, checked: true }).waitFor({ state: 'attached', timeout: 3000 });
      // WebKit on macOS uses Option-Tab to include buttons in keyboard navigation.
      await page.keyboard.press('Alt+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Reveal in Finder');
    }
    console.log(`ok toolbar geometry, responsive order, names and keyboard at ${width}px`);
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
  // The attachment tab's toolbar (PRO-290, screen 03.22) from wide to narrow.
  const attachment = page.locator('#attach [data-testid=attachment-toolbar]');
  for (const width of [900, 700, 520, 519, 480, 479, 360, 359, 300, 240]) {
    await page.locator('#attach, #attach-media').evaluateAll((panes, width) => { for (const pane of panes) pane.style.width = `${width}px`; }, width);
    await page.waitForTimeout(50);
    const result = await attachment.evaluate((toolbar) => {
      const box = el => el.getBoundingClientRect();
      const visible = el => !!el && box(el).width > 0 && box(el).height > 0;
      const row = toolbar.querySelector('[data-testid=editor-toolbar] > div');
      const path = toolbar.querySelector('[data-testid=attachment-path]');
      const [folder, file] = path.children;
      const sent = toolbar.querySelector('[data-testid=attachment-sent]');
      const group = toolbar.querySelector('[role=radiogroup]');
      const button = name => toolbar.querySelector(`[aria-label="${name}"]`);
      const controls = [toolbar.querySelector('svg[data-icon]'), path, ...(visible(sent) ? [sent] : []), group, button('Copy'), button('Download'), button('More')].map(box);
      return {
        clip: visible(toolbar.querySelector('svg')),
        title: path.title,
        text: path.textContent,
        fileWhole: file.scrollWidth <= file.clientWidth + 1 || box(file).width >= box(path).width - 1,
        folderTruncates: folder.scrollWidth >= folder.clientWidth,
        mono: getComputedStyle(path).fontFamily.toLowerCase().includes('mono'),
        sent: visible(sent) ? sent.textContent : null,
        separate: controls.every((b, i) => !i || b.left >= controls[i - 1].right - 0.5),
        labels: ['Copy', 'Download'].map(name => visible(button(name).querySelector('span'))),
        radioLabels: [...group.querySelectorAll('[role=radio]')].every(radio => visible(radio.querySelector('span'))),
        fits: row.scrollWidth <= row.clientWidth + 1,
        height: box(toolbar.querySelector('[data-testid=editor-toolbar]')).height,
      };
    });
    assert(result.clip && result.separate && result.fits && result.mono && result.fileWhole, `attachment ${width}: ${JSON.stringify(result)}`);
    assert.equal(result.height, 32);
    assert.equal(result.title, '/Users/me/.terminalx/attachments/7c1d2e9a-session/k3f9qa/release-checklist-for-the-november-build.md');
    assert.equal(result.text, '~/.terminalx/attachments/7c1d2e9a-session/k3f9qa/release-checklist-for-the-november-build.md');
    assert.equal(result.sent, width >= 480 ? 'on your message · 14:31' : null);
    assert.deepEqual(result.labels, width >= 360 ? [true, true] : [false, false]);
    assert.equal(result.radioLabels, width >= 520);
    const media = await page.locator('#attach-media [data-testid=attachment-toolbar]').evaluate((toolbar) => ({
      group: toolbar.querySelectorAll('[role=radiogroup]').length,
      sent: toolbar.querySelectorAll('[data-testid=attachment-sent]').length,
      fits: toolbar.querySelector('[data-testid=editor-toolbar] > div').scrollWidth <= toolbar.querySelector('[data-testid=editor-toolbar] > div').clientWidth + 1,
    }));
    assert.deepEqual(media, { group: 0, sent: 0, fits: true });
    console.log(`ok attachment toolbar at ${width}px`);
  }
  // Keyboard: the switch, then Copy, Download and More in order.
  await page.locator('#attach').evaluate(pane => { pane.style.width = '700px'; });
  await attachment.getByRole('radio', { name: 'Source', exact: true }).click();
  await attachment.getByRole('radio', { name: 'Source', exact: true, checked: true }).waitFor({ state: 'attached', timeout: 3000 });
  await attachment.getByRole('radiogroup', { name: 'View' }).focus();
  const order = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Alt+Tab');
    order.push(await page.evaluate(() => document.activeElement.getAttribute('aria-label')));
  }
  assert.deepEqual(order, ['Copy', 'Download', 'More']);
  await attachment.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Reveal in Finder' }).waitFor();
  await page.keyboard.press('Escape');
  console.log('ok attachment toolbar keyboard order and overflow menu');
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
