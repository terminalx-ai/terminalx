#!/usr/bin/env node
// PRO-397: a file's Markdown preview (screens 03.22 and 06.11) in WebKit, dark and light, at 1440 wide: H1 22px,
// H2 15px with a hairline under it, checklist items as a box only, a 624px column inset 48px, code blocks without
// chrome, and the attachment's stored path in 12px mono. The chat's own prose keeps its headings and lists.
// pnpm exec node scripts/webkit/attachment-preview.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '/src/components/chat/Markdown.tsx';
import { AttachmentToolbar } from '/src/components/editor/AttachmentToolbar.tsx';
import { setMode } from '/src/lib/theme.ts';
import '/src/styles/app.css';
const text = '# Release checklist\\n\\nIntro paragraph for the build.\\n\\n## Before the build\\n\\n- [ ] Tag the commit\\n- [x] Update the changelog\\n\\nA paragraph between.\\n\\n- plain item\\n\\n## Commands\\n\\n\`\`\`sh\\npnpm build\\npnpm test\\n\`\`\`\\n';
window.setMode = setMode;
// The same container and classes as the preview in EditorPane.
createRoot(document.getElementById('root')).render(<div style={{width: 1440}}>
  <AttachmentToolbar path="/Users/me/.terminalx/attachments/7c1d2e9a-session/k3f9qa/release.md" name="release.md" markdown viewMode="preview" onViewModeChange={() => {}} copyContents={() => ''}/>
  <div id="pane" tabIndex={-1} className="min-h-0 flex-1 overflow-auto scrollbar-thin py-4 pr-6 pl-12 outline-none select-text">
    <Markdown text={text} className="prose-preview max-w-[624px]"/>
  </div>
  <div id="chat"><Markdown text={text} className="prose-chat-probe"/></div>
</div>);
`;
const server = await createServer({
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
  plugins: [{
    name: 'attachment-preview',
    resolveId(id) { if (id === '/attachment-preview.tsx') return '\0attachment-preview.tsx'; },
    async load(id) {
      if (id === '\0attachment-preview.tsx') return (await transformWithEsbuild(entry, 'attachment-preview.tsx', { loader: 'tsx', jsx: 'automatic' })).code;
    },
    configureServer(server) {
      server.middlewares.use('/preview-test', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/preview-test', '<div id="root"></div><script type="module" src="/attachment-preview.tsx"></script>'));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => console.error(error));
  await page.addInitScript(await readFile(new URL('./tauri-stub.js', import.meta.url), 'utf8'));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/preview-test`);
  await page.locator('#pane h1').waitFor();
  for (const mode of ['dark', 'light']) {
    await page.evaluate(mode => window.setMode(mode), mode);
    await page.waitForFunction(mode => document.documentElement.getAttribute('data-mode') === mode, mode);
    await page.evaluate(() => document.fonts.ready);
    const r = await page.evaluate(() => {
      const q = (root, selector) => document.querySelector(`${root} ${selector}`);
      const css = el => getComputedStyle(el);
      const col = document.querySelector('#pane > div').getBoundingClientRect();
      const pane = document.querySelector('#pane').getBoundingClientRect();
      const boxes = [...document.querySelectorAll('#pane li.task-list-item')];
      return {
        h1: parseFloat(css(q('#pane', 'h1')).fontSize),
        h2: parseFloat(css(q('#pane', 'h2')).fontSize),
        h2Weight: css(q('#pane', 'h2')).fontWeight,
        h2Border: css(q('#pane', 'h2')).borderBottomWidth,
        h2BorderStyle: css(q('#pane', 'h2')).borderBottomStyle,
        taskCount: boxes.length,
        taskList: boxes.map(li => css(li).listStyleType),
        taskParent: css(boxes[0].parentElement).listStyleType,
        boxAligned: boxes.every(li => { const b = li.querySelector('input').getBoundingClientRect(), t = li.getBoundingClientRect(); return b.top >= t.top - 1 && b.bottom <= t.bottom + 1; }),
        plainList: css([...document.querySelectorAll('#pane li')].find(li => !li.classList.contains('task-list-item')).parentElement).listStyleType,
        width: col.width,
        inset: col.left - pane.left,
        header: [...document.querySelectorAll('#pane [data-streamdown="code-block-header"]')].map(el => css(el).display),
        buttons: [...document.querySelectorAll('#pane [data-streamdown="code-block-actions"] button')].filter(el => el.getBoundingClientRect().width > 0).length,
        pre: css(q('#pane', 'pre')).fontFamily.toLowerCase().includes('mono'),
        path: parseFloat(css(document.querySelector('[data-testid=attachment-path]')).fontSize),
        pathMono: css(document.querySelector('[data-testid=attachment-path]')).fontFamily,
        chatH1: parseFloat(css(q('#chat', 'h1')).fontSize),
        chatH2Border: css(q('#chat', 'h2')).borderBottomWidth,
        chatList: css(q('#chat', 'ul')).listStyleType,
      };
    });
    console.log(mode, JSON.stringify(r));
    assert(r.h1 >= 21 && r.h1 <= 23, `${mode}: H1 ${r.h1}`);
    assert.equal(r.h2, 15);
    assert(r.h2Weight === '600' || r.h2Weight === 'bold', `${mode}: H2 weight ${r.h2Weight}`);
    assert(parseFloat(r.h2Border) >= 1 && r.h2BorderStyle === 'solid', `${mode}: H2 border`);
    assert.equal(r.taskCount, 2);
    assert(r.taskList.every(style => style === 'none') && r.taskParent === 'none', `${mode}: checklist ${JSON.stringify(r.taskList)}`);
    assert(r.boxAligned, `${mode}: checkbox aligned with its text`);
    assert.equal(r.plainList, 'disc');
    assert(Math.abs(r.width - 624) <= 2, `${mode}: column ${r.width}`);
    assert(Math.abs(r.inset - 48) <= 2, `${mode}: inset ${r.inset}`);
    assert(r.header.every(display => display === 'none') && r.buttons === 0, `${mode}: code chrome ${JSON.stringify(r.header)} ${r.buttons}`);
    assert(r.pre, `${mode}: code is mono`);
    assert.equal(r.path, 12);
    assert(r.pathMono.toLowerCase().includes('mono'), `${mode}: path font ${r.pathMono}`);
    // The chat keeps its own sizes and discs.
    assert.equal(r.chatH1, 15);
    assert.equal(r.chatH2Border, '0px');
    assert.equal(r.chatList, 'disc');
    console.log(`ok attachment preview typography and column in ${mode}`);
  }
} finally {
  await browser?.close();
  await server.close();
}
