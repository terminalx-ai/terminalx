#!/usr/bin/env node
// PRO-397, screen 02.11 (Session starting · worktree and setup): the real Chat with the app's CSS in WebKit,
// right after Create. The first message (with an image and a file) is held while its send is pending: it is
// on screen at once, the start progress under it, then the line that it waits for the agent, and never the
// empty-chat line. When the send's events arrive the held copy gives way, and the message is there once.
// node scripts/webkit/session-start.mjs
// WEBKIT_LAYOUT_SCREENSHOTS=/tmp/shots node scripts/webkit/session-start.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";

// A real one-pixel PNG, so the thumbnail goes through the image path like any screenshot.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PROMPT = "Permission cards show up twice when the hook and the transcript both report the same request. Dedupe them by tool_use_id in AskCards.tsx and add a regression test. Don't commit.";

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/app.css';
import { Chat } from '/src/components/chat/Chat.tsx';
import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
import { bootSessions } from '/src/lib/sessions.ts';
import { holdFirstMessage, releaseFirstMessage } from '/src/lib/firstMessage.ts';
import { buildTranscript } from '/src/lib/transcript.ts';
const noop = () => {};
const PROMPT = ${JSON.stringify(PROMPT)};
const image = { mediaType: 'image/png', data: ${JSON.stringify(PNG)}, name: 'duplicate-cards.png' };
function App() {
  const [events, setEvents] = useState([]);
  window.__arrive = () => {
    // The send's reply: its events into the conversation and the held copy released, as the shells do.
    setEvents([{ id: 'e1', seq: 1, sessionId: 's-new', tabId: 't-new', harness: 'claude', ts: new Date().toISOString(),
      payload: { type: 'user_message', text: PROMPT, queued: false, images: [{ url: 'data:image/png;base64,' + image.data, name: image.name }] } }]);
    releaseFirstMessage('s-new', 't-new');
  };
  return <TooltipProvider>
    <div className="flex h-dvh flex-col bg-chat text-foreground">
      <Chat sessionId="s-new" checkpointTabId="t-new" cwd="/repos/p0/.raccoon/worktrees/dedupe-permission-cards"
        transcript={buildTranscript(events, false)} stream={[]} live={false} loading={!events.length}
        answering={false} onAnswerPermission={noop} onAnswerQuestions={noop}
        footer={<div data-testid="composer-stand-in" className="mx-auto mb-4 h-24 w-full max-w-3xl rounded-xl bg-card hairline" />} />
    </div>
  </TooltipProvider>;
}
await bootSessions();
holdFirstMessage('s-new', 't-new', PROMPT, [image], [{ name: 'notes.md', path: '/Users/demo/notes.md' }], Date.now() - 2600);
createRoot(document.getElementById('root')).render(<App/>);
`;

// The new session, its agent and its setup script, as the runtime reports them right after Create.
const fixture = `(() => {
  const answers = window.__PW_STUB__.answers;
  const at = new Date().toISOString();
  answers.list_sessions = [{ id: 's-new', projectPath: '/repos/p0', cwd: '/repos/p0/.raccoon/worktrees/dedupe-permission-cards',
    worktreeName: 'dedupe-permission-cards', branch: 'raccoon/dedupe-permission-cards', baseRef: 'main', worktreeRemoved: false,
    worktreeBase: { commit: 'abc', fetched: true, warning: null, from: 'origin/main',
      fileCopy: { copiedCount: 3, copiedBytes: 900, firstCopied: '.env.local', skippedCount: 0, warnings: [], skipped: [], error: null } },
    title: 'Fix duplicate permission cards', created: at, modified: at, archived: false, pinned: false,
    tabs: [{ id: 't-new', harness: 'claude', model: 'opus', permissionMode: 'default', status: 'idle', created: at, modified: at }], activeTab: 't-new' }];
  answers.list_harnesses = [{ id: 'claude', name: 'Claude Code', binary: 'claude', available: true }];
  answers.workspace_setup = ({ operation }) => operation === 'list'
    ? [{ sessionId: 's-new', paneId: 'setup-1', command: 'bun install', status: 'running', exitCode: null, error: null, hasPane: true }]
    : null;
})();`;

const screenshots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });

const server = await createServer({
  logLevel: "error",
  server: { port: 0, strictPort: false, host: "127.0.0.1" },
  plugins: [{
    name: "session-start-check",
    resolveId(id) { if (id === "/session-start.tsx") return "\0session-start.tsx"; },
    async load(id) {
      if (id === "\0session-start.tsx") return (await transformWithEsbuild(entry, "session-start.tsx", { loader: "tsx", jsx: "automatic" })).code;
    },
    configureServer(server) {
      server.middlewares.use("/session-start-page", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml("/session-start-page", '<div id="root"></div><script type="module" src="/session-start.tsx"></script>'));
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  browser = await launch();
  const stub = await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8");
  for (const scheme of ["dark", "light"]) {
    const width = 1440;
    const label = `${width}px ${scheme}`;
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    if (process.env.WEBKIT_DEBUG) page.on("console", (m) => console.error("console:", m.text()));
    await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: false, localProjects: 1 };\n${stub}\n${fixture}`);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/session-start-page`);
    const held = page.getByTestId("first-message");
    await held.waitFor();
    // The setup run and the agent's name come from the runtime's answers.
    await page.locator('[data-step="setup"]').waitFor();
    await page.getByText("as soon as Claude Code is ready").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="first-message"] img')].every((img) => img.complete && img.naturalWidth > 0));

    const layout = await page.evaluate(() => {
      const rect = (el) => el.getBoundingClientRect();
      const held = document.querySelector('[data-testid="first-message"]');
      const message = held.querySelector('[data-testid="reader-message"]');
      const progress = held.querySelector('[data-testid="start-progress"]');
      const line = held.querySelector('[data-testid="first-message-held"]');
      const img = held.querySelector("img");
      const column = held.parentElement;
      const stand = document.querySelector('[data-testid="composer-stand-in"]');
      const visible = (el) => { const r = rect(el); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0; };
      // WCAG contrast of an element's text against the page behind it.
      // Colours are resolved through a canvas: the theme writes them as oklch(), which no regex reads.
      const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
      const rgba = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
      const lum = (c) => { const [r, g, b] = rgba(c).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const background = (el) => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c && rgba(c)[3] === 255) return c; } return "rgb(255, 255, 255)"; };
      const contrast = (el) => { const a = lum(getComputedStyle(el).color), b = lum(background(el)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
      return {
        text: message.textContent,
        visible: [message, progress, line, img].every(visible),
        imageBox: img ? rect(img).toJSON() : null,
        files: [...held.querySelectorAll('[data-testid="reader-message"] *')].some((el) => el.childElementCount === 0 && el.textContent === "notes.md"),
        steps: [...progress.querySelectorAll("[data-step]")].map((step) => [step.dataset.step, step.dataset.state, step.textContent]),
        header: progress.firstElementChild.textContent,
        line: line.textContent,
        lineContrast: contrast(line),
        stepContrast: contrast(progress.querySelector("[data-step] span")),
        order: rect(message).bottom <= rect(progress).top + 0.5 && rect(progress).bottom <= rect(line).top + 0.5,
        inColumn: [message, progress, line].every((el) => rect(el).left >= rect(column).left - 0.5 && rect(el).right <= rect(column).right + 0.5),
        clearOfComposer: rect(line).bottom <= rect(stand).top + 0.5,
        empty: document.body.textContent.includes("Nothing here yet"),
        loading: document.body.textContent.includes("Loading the conversation"),
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    if (screenshots) await page.screenshot({ path: `${screenshots}/session-start-${width}-${scheme}.png` });
    assert.ok(layout.text.includes("Dedupe them by tool_use_id in AskCards.tsx"), `${label}: the prompt as written ${layout.text}`);
    assert.ok(layout.visible, `${label}: message, image, progress and hold line on screen ${JSON.stringify(layout)}`);
    assert.ok(layout.imageBox && layout.imageBox.width >= 40, `${label}: the image is a thumbnail ${JSON.stringify(layout.imageBox)}`);
    assert.ok(layout.files, `${label}: the file is named under the message`);
    assert.ok(layout.header.startsWith("Starting the session") && /\d+\.\ds/.test(layout.header), `${label}: progress header with its time (${layout.header})`);
    assert.deepEqual(layout.steps, [
      ["worktree", "done", "Created worktree raccoon/dedupe-permission-cards from origin/main"],
      ["copy", "done", "Copied .env.local and 2 other files"],
      ["setup", "running", "Running the setup script · bun install"],
      ["agent", "running", "Starting Claude Code"],
    ], `${label}: the start steps`);
    assert.equal(layout.line, "Your first message is held and sent as soon as Claude Code is ready.", `${label}: hold line`);
    assert.ok(layout.order, `${label}: message, then progress, then the hold line`);
    assert.ok(layout.inColumn, `${label}: all inside the chat column`);
    assert.ok(layout.clearOfComposer, `${label}: the hold line is above the composer`);
    assert.ok(layout.lineContrast >= 4.5 && layout.stepContrast >= 4.5, `${label}: readable (${layout.lineContrast.toFixed(2)}, ${layout.stepContrast.toFixed(2)})`);
    assert.ok(!layout.empty && !layout.loading, `${label}: no empty-chat or loading line while the send is pending`);
    assert.ok(layout.pageOverflow <= 1, `${label}: page does not scroll sideways (${layout.pageOverflow})`);

    // The send returns: its own message replaces the held one, once.
    await page.evaluate(() => window.__arrive());
    await held.waitFor({ state: "detached" });
    const after = await page.evaluate(() => ({
      messages: document.querySelectorAll('[data-testid="reader-message"]').length,
      prompts: document.body.textContent.split("Dedupe them by tool_use_id").length - 1,
      holdLine: document.body.textContent.includes("is held and sent"),
      empty: document.body.textContent.includes("Nothing here yet"),
    }));
    if (screenshots) await page.screenshot({ path: `${screenshots}/session-start-${width}-${scheme}-sent.png` });
    assert.deepEqual(after, { messages: 1, prompts: 1, holdLine: false, empty: false }, `${label}: one message after the send's events`);
    assert.deepEqual(errors, [], `${label}: no page errors`);
    console.log(`ok ${label}: held first message with image and file, 4 start steps, hold line, no empty line; one message after the send`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
