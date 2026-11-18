#!/usr/bin/env node
// PRO-397: a file's Markdown preview (screens 03.22 and 06.11) in WebKit, dark and light, at 1440 wide: H1 22px,
// H2 15px with a hairline under it, checklist items as a box only, a 624px column inset 48px, code blocks without
// chrome, and the attachment's stored path in 12px mono. The chat's own prose keeps its headings and lists.
// pnpm exec node scripts/webkit/attachment-preview.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, searchForWorkspaceRoot, transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '/src/components/chat/Markdown.tsx';
import { EditorPane } from '/src/components/editor/EditorPane.tsx';
import { setMode } from '/src/lib/theme.ts';
import '/src/styles/app.css';
const text = '# Release checklist\\n\\nIntro paragraph for the build.\\n\\n## Before the build\\n\\n- [ ] Tag the commit\\n- [x] Update the changelog\\n\\nA paragraph between.\\n\\n- plain item\\n\\n## Commands\\n\\n\`\`\`sh\\npnpm build\\npnpm test\\n\`\`\`\\n\\n\`\`\`sh\\ncurl https://example.com\\n\`\`\`\\n';
window.setMode = setMode;
const root = "/Users/me/.terminalx/attachments/7c1d2e9a-session";
const rel = "k3f9qa/release.md";
const entry = { id: "attachment", sessionId: "test-session", workspaceRoot: "/repo", root, rel, name: "release.md", dirty: false, viewMode: "preview", kind: "text", attachment: { path: root + "/" + rel } };
Object.assign(window.__PW_STUB__.answers, {
  read_text_file: { content: text, binary: false, truncated: false, mtimeMs: 1, size: text.length },
  file_mtime: 1,
});
const file = { ...entry, id: "file", root: "/repo", rel: "release.md", attachment: undefined };
createRoot(document.getElementById('root')).render(<div style={{width: 1440}}>
  <div id="pane" style={{height: 500}}><EditorPane entry={entry} visible /></div>
  <div id="file" style={{height: 500}}><EditorPane entry={file} visible /></div>
  <div id="chat"><Markdown text={text} className="prose-chat-probe"/></div>
</div>);
`;
const server = await createServer({
  server: {
    port: 0,
    host: '127.0.0.1',
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), await realpath(fileURLToPath(new URL('../../node_modules', import.meta.url)))] },
  },
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
  await page.locator('#file h1').waitFor();
  await page.locator('#pane [data-streamdown="code-block-body"] code span').first().waitFor();
  const shots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const mode of ['dark', 'light']) {
    await page.evaluate(mode => window.setMode(mode), mode);
    await page.waitForFunction(mode => document.documentElement.getAttribute('data-mode') === mode, mode);
    await page.evaluate(() => document.fonts.ready);
    const r = await page.evaluate(() => {
      const q = (root, selector) => document.querySelector(`${root} ${selector}`);
      const css = el => getComputedStyle(el);
      const col = q('#pane', '.prose-chat').parentElement.getBoundingClientRect();
      const pane = q('#pane', '.prose-chat').parentElement.parentElement.getBoundingClientRect();
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
        buttons: [...document.querySelectorAll('#pane [data-streamdown="code-block"] button')].filter(el => el.getBoundingClientRect().width > 0).length,
        pre: css(q('#pane', 'pre')).fontFamily.toLowerCase().includes('mono'),
        path: parseFloat(css(document.querySelector('[data-testid=attachment-path]')).fontSize),
        pathMono: css(document.querySelector('[data-testid=attachment-path]')).fontFamily,
        fileH1: parseFloat(css(q('#file', 'h1')).fontSize),
        lineNumbers: [...document.querySelectorAll('#pane pre code > span')].some(el => !['none', 'normal'].includes(getComputedStyle(el, '::before').content)),
        chatH1: parseFloat(css(q('#chat', 'h1')).fontSize),
        chatH2Border: css(q('#chat', 'h2')).borderBottomWidth,
        chatList: css(q('#chat', 'ul')).listStyleType,
      };
    });
    console.log(mode, JSON.stringify(r));
    assert(r.h1 >= 21 && r.h1 <= 23, `${mode}: H1 ${r.h1}`);
    assert.equal(r.fileH1, r.h1, `${mode}: workspace file uses the same preview`);
    assert.equal(r.h2, 15);
    assert(r.h2Weight === '600' || r.h2Weight === 'bold', `${mode}: H2 weight ${r.h2Weight}`);
    assert(parseFloat(r.h2Border) >= 1 && r.h2BorderStyle === 'solid', `${mode}: H2 border`);
    assert.equal(r.taskCount, 2);
    assert(r.taskList.every(style => style === 'none') && r.taskParent === 'none', `${mode}: checklist ${JSON.stringify(r.taskList)}`);
    assert(r.boxAligned, `${mode}: checkbox aligned with its text`);
    assert.equal(r.plainList, 'disc');
    assert(Math.abs(r.width - 624) <= 2, `${mode}: column ${r.width}`);
    assert(Math.abs(r.inset - 48) <= 2, `${mode}: inset ${r.inset}`);
    assert(r.header.length === 2 && r.header.every(display => display === 'none') && r.buttons === 0, `${mode}: code chrome ${JSON.stringify(r.header)} ${r.buttons}`);
    assert.equal(r.lineNumbers, false);
    assert(r.pre, `${mode}: code is mono`);
    assert.equal(r.path, 12);
    assert(r.pathMono.toLowerCase().includes('mono'), `${mode}: path font ${r.pathMono}`);
    // The chat keeps its own sizes and discs.
    assert.equal(r.chatH1, 15);
    assert.equal(r.chatH2Border, '0px');
    assert.equal(r.chatList, 'disc');
    if (shots) await page.screenshot({ path: join(shots, `attachment-preview-${mode}.png`) });
    console.log(`ok attachment preview typography and column in ${mode}`);
  }
} finally {
  await browser?.close();
  await server.close();
}
