#!/usr/bin/env node
// PRO-378: the chat transcript as designed, in real WebKit through the real Chat renderer, dark and light at 1440 wide.
// Synthetic events only; no app or agent launch.
//   node scripts/webkit/chat-transcript.mjs
//   WEBKIT_LAYOUT_SCREENSHOTS=/path/to/dir node scripts/webkit/chat-transcript.mjs   (keeps the captures)
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';
import { createServer, transformWithEsbuild } from 'vite';
import { launch } from './harness.mjs';

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from '/src/components/chat/Chat.tsx';
import { ResetChatDialog } from '/src/components/session/ResetChatDialog.tsx';
import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
import { buildTranscript } from '/packages/portable/src/transcript.ts';
import { setPrefs } from '/src/lib/prefs.ts';
import '/src/styles/app.css';
const now = Date.now();
const at = (s) => new Date(now - 3_600_000 + s * 1000).toISOString();
let seq = 0;
const ev = (t, payload) => ({ id: 'e' + (++seq), seq, ts: at(t), messageTs: at(t), payload, sessionId: 's', tabId: 't', harness: 'claude' });
const call = (t, callId, name, toolType, input) => ev(t, { type: 'tool_call_started', callId, name, toolType, input });
const done = (t, callId, text, extra = {}) => ev(t, { type: 'tool_call_completed', callId, result: { text, isError: false, ...extra } });
const events = [
  ev(0, { type: 'user_message', text: 'Permission cards show twice when the hook and the transcript both report a request. Dedupe them by tool_use_id in AskCards and add a regression test. Don\\'t commit.', queued: false }),
  ev(1, { type: 'turn_started' }),
  ev(3, { type: 'assistant_text', text: "I'll read the card list and the permission event mapper, then dedupe by tool_use_id." }),
  call(4, 'r1', 'Read', 'file_read', { file_path: '/repo/src/components/chat/AskCards.tsx' }),
  done(5, 'r1', Array.from({ length: 301 }, (_, i) => String(i + 1).padStart(6) + '→line ' + (i + 1)).join('\\n')),
  call(6, 'g1', 'Grep', 'search', { pattern: 'tool_use_id', path: '/repo/src-tauri/src', output_mode: 'content', '-n': true }),
  done(7, 'g1', 'src-tauri/src/events.rs:88: tool_use_id\\nsrc-tauri/src/events.rs:90: tool_use_id\\nsrc-tauri/src/hooks.rs:41: tool_use_id\\nsrc-tauri/src/hooks.rs:44: tool_use_id\\nsrc-tauri/src/transcript.rs:120: tool_use_id\\nsrc-tauri/src/transcript.rs:121: tool_use_id'),
  ev(16, { type: 'reasoning', text: 'Both paths emit a card for one request; key them by tool_use_id instead of event order so the later frame merges into the first.' }),
  call(17, 'e1', 'Edit', 'file_edit', { file_path: '/repo/src/components/chat/AskCards.tsx' }),
  ev(17, { type: 'file_edits', callId: 'e1', edits: [{ path: '/repo/src/components/chat/AskCards.tsx', kind: 'update', oldText: 'export function cardsFor(events: AskEvent[]): AskCard[] {\\n  return events.map(toCard);', newText: 'export function cardsFor(events: AskEvent[]): AskCard[] {\\n  const byTool = new Map<string, AskCard>();\\n  for (const e of events) byTool.set(e.toolUseId, toCard(e));\\n  return [...byTool.values()];' }] }),
  done(18, 'e1', "The file /repo/src/components/chat/AskCards.tsx has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\\n    41→export function cardsFor(events: AskEvent[]): AskCard[] {\\n    42→  const byTool = new Map<string, AskCard>();\\n    43→  for (const e of events) byTool.set(e.toolUseId, toCard(e));\\n    44→  return [...byTool.values()];"),
  call(19, 'w1', 'Write', 'file_write', { file_path: '/repo/src/components/chat/AskCards.test.tsx' }),
  ev(19, { type: 'file_edits', callId: 'w1', edits: [{ path: '/repo/src/components/chat/AskCards.test.tsx', kind: 'create', oldText: '', newText: Array.from({ length: 36 }, (_, i) => 'line ' + i).join('\\n') }] }),
  done(20, 'w1', 'ok'),
  call(21, 'b1', 'Bash', 'shell', { command: 'bun test src/components/chat/AskCards.test.tsx' }),
  done(22.4, 'b1', '✓ one card per tool_use_id\\n✓ the later frame merges its diff preview\\n14 pass · 0 fail'),
  ev(24, { type: 'assistant_text', text: 'Done. Permission cards are now keyed by \`tool_use_id\`, so the hook frame and the transcript line for one request collapse into one card.\\n\\n\`\`\`ts\\nexport function cardsFor(events: AskEvent[]): AskCard[] {\\n  return [...byTool.values()];\\n}\\n\`\`\`' }),
  ev(25, { type: 'turn_completed', status: 'ok', durationMs: 72_000, usage: { inputTokens: 66, outputTokens: 1058, cacheReadTokens: 96065, cacheWriteTokens: 36895 } }),
  ev(30, { type: 'context_compacted', preTokens: 412_000, postTokens: 38_000 }),
  ev(40, { type: 'user_message', text: 'Commit it and open a PR using the template I attached.', queued: false }),
  ev(41, { type: 'turn_started' }),
  ev(48, { type: 'error', message: 'Anthropic error: overloaded (529)', fatal: false }),
  ev(49, { type: 'turn_completed', status: 'error', durationMs: 9000, finalText: 'Anthropic error: overloaded (529)' }),
  ev(60, { type: 'user_message', text: 'Now open a PR against main with a short summary.', queued: false }),
  ev(61, { type: 'turn_started' }),
  call(62, 'b2', 'Bash', 'shell', { command: 'git status --short && git log --oneline -3' }),
  done(63, 'b2', ' M src/slug.js'),
  call(64, 'b3', 'Bash', 'shell', { command: "git commit -am 'Make slugify collapse punctuation and trim dashes'" }),
  done(65, 'b3', '[raccoon/make-slugify ede0b4d] Make slugify collapse punctuation and trim dashes\\n 2 files changed'),
  call(66, 'b4', 'Bash', 'shell', { command: 'git push -u origin raccoon/make-slugify' }),
];
const transcript = buildTranscript(events, true);
// The same chat, ended on the failed turn: Retry is offered on the last turn only.
const failedLast = buildTranscript(events.slice(0, events.findIndex((e) => e.payload.text === 'Now open a PR against main with a short summary.')), true);
const root = createRoot(document.getElementById('root'));
window.draw = ({ fold = true, reset = false, failed = false } = {}) => {
  setPrefs({ foldToolCalls: fold, transcriptLayout: 'chat', promptMap: false, turnChanges: false });
  root.render(<TooltipProvider><div style={{ height: '100vh', display: 'flex' }} className="bg-chat">
    <Chat key={failed ? 'failed' : 'running'} cwd="/repo" sessionId="s" transcript={failed ? failedLast : transcript} stream={[]} live progressing answering={false} onAnswerPermission={() => {}} onAnswerQuestions={() => {}} footer={<div className="h-24" />} onSendAgain={() => {}} onRetry={() => {}} onSecondOpinion={() => {}} onRetryInNewChat={() => {}} onReset={() => {}} />
    {reset && <ResetChatDialog sessionId="s" tabId="t" endSeq={9} target={{ turn: 2, removed: [3, 4], files: 3 }} agent="Claude Code" onClose={() => {}} onWarning={() => {}} />}
  </div></TooltipProvider>);
};
window.draw();
`;

// A free port of its own: other checks' vite servers may hold the default one.
const port = await new Promise((resolve) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const server = await createServer({ logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', hmr: false }, plugins: [{
  name: 'chat-transcript',
  resolveId(id) { if (id === '/chat-transcript-test.tsx') return '\0chat-transcript-test.tsx'; },
  async load(id) { if (id === '\0chat-transcript-test.tsx') return (await transformWithEsbuild(entry, 'chat-transcript-test.tsx', { loader: 'tsx', jsx: 'automatic' })).code; },
  configureServer(server) { server.middlewares.use('/chat-transcript', async (_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(await server.transformIndexHtml('/chat-transcript', '<div id="root"></div><script type="module" src="/chat-transcript-test.tsx"></script>'));
  }); },
}] });
const shots = process.env.WEBKIT_LAYOUT_SCREENSHOTS ?? await mkdtemp(join(tmpdir(), 'terminalx-378-'));
await mkdir(shots, { recursive: true });
let browser;
try {
  await server.listen();
  browser = await launch();
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1600 }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(await readFile(new URL('./tauri-stub.js', import.meta.url), 'utf8'));
    await page.addInitScript((theme) => {
      localStorage.setItem('raccoon.prefs', JSON.stringify({ theme }));
    }, theme);
    // A cold vite optimises dependencies on the first load.
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/chat-transcript`, { timeout: 240_000, waitUntil: 'commit' });
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    const chat = page.locator('[data-chat-scroller]');
    await chat.getByTestId('turn-fold').first().waitFor({ timeout: 120_000 });
    await page.evaluate(() => document.fonts.ready);

    // The folded header leads with its chevron and ends with the kinds of tools used.
    const fold = chat.getByTestId('turn-fold').first();
    assert.equal(await fold.locator('svg').first().evaluate((el) => el === el.parentElement.firstElementChild), true, 'chevron leads');
    assert.ok(await fold.getByTestId('tool-kinds').locator('svg').count() >= 3, 'tool kinds after the summary');

    // The reader's bubble: hairline border, right-aligned, about 560 wide at most, its time inside.
    const bubble = chat.getByTestId('reader-message').first().locator('> div').first();
    const box = await bubble.boundingBox();
    const column = await chat.locator('> div').boundingBox();
    assert.ok(box.width <= 561 && Math.abs(box.x + box.width - (column.x + column.width - 24)) < 2, `bubble right-aligned and ≤ 560: ${JSON.stringify(box)}`);
    assert.notEqual(await bubble.evaluate((el) => getComputedStyle(el).borderTopWidth), '0px');
    assert.equal(await bubble.locator('time').count(), 1, 'time inside the bubble');
    assert.equal(await chat.getByTestId('turn-divider').count(), 0, 'no day divider');

    // The footer: duration · time, cache hit, tokens/s, copy and Second opinion.
    const footer = chat.getByTestId('turn-footer').first();
    assert.match(await footer.innerText(), /1m 12s · .*cache hit 72%.*1[45] tok\/s.*Second opinion/s);

    // One error card with Retry for the failed turn; its error said once.
    assert.equal(await chat.getByText('Anthropic error: overloaded (529)', { exact: true }).count(), 1, 'error said once');
    assert.equal(await chat.getByTestId('turn-failure').getByRole('button', { name: 'Retry', exact: true }).count(), 0, 'Retry only on the last turn');

    // Compaction: a centred divider with compact token figures.
    const compaction = chat.getByTestId('compaction-row');
    assert.match(await compaction.innerText(), /Chat compacted · 412K → 38K tokens/);
    const cbox = await compaction.boundingBox();
    const label = await compaction.locator('> span').nth(1).boundingBox();
    assert.ok(Math.abs(label.x + label.width / 2 - (cbox.x + cbox.width / 2)) < 2, 'compaction label centred');

    // The running turn: git steps by name, the running row in amber, Ran with its exit status.
    assert.match(await chat.innerText(), /Committed\s+ede0b4d Make slugify collapse punctuation and trim dashes/);
    const pushing = chat.getByTestId('tool-row').filter({ hasText: 'Pushing' });
    const amber = await pushing.getByText('Pushing').evaluate((el) => getComputedStyle(el).color);
    assert.equal(amber, await pushing.getByTestId('tool-running').evaluate((el) => getComputedStyle(el).color), 'spinner and verb share the amber');
    assert.match(await chat.getByTestId('tool-exit').first().innerText(), /^exit 0 · 1\.0s$/);
    await page.screenshot({ path: join(shots, `${theme}-folded.png`), fullPage: false });

    // Opened: the intro sentence first, then the steps in order; targets plain, chevrons beside the text.
    await fold.click();
    const body = chat.getByTestId('turn-fold-body');
    const order = await body.innerText();
    const at = (s) => { const i = order.indexOf(s); assert.ok(i >= 0, `${s} in the fold`); return i; };
    assert.ok(at("I'll read the card list") < at('Read') && at('Read') < at('Searched') && at('Searched') < at('Thought for 9s') && at('Thought for 9s') < at('Edited') && at('Edited') < at('Ran'), order);
    assert.match(order, /AskCards\.tsx\s*· 301 lines/);
    assert.match(order, /Searched\s*"tool_use_id"\s*in src-tauri\/src\s*· 6 matches in 3 files/);
    assert.ok(!order.includes('Done. Permission cards'), 'the answer stays after the fold');
    for (const row of await body.getByTestId('tool-row').all()) {
      const r = await row.boundingBox();
      const chevron = row.locator('> svg');
      if (await chevron.count()) assert.ok((await chevron.boundingBox()).x + 20 < r.x + r.width, 'no chevron pinned to the far edge');
    }
    const target = body.getByTestId('tool-row').filter({ hasText: 'Read' }).locator('span.font-mono').first();
    assert.equal(await target.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'no chip behind the target');
    const counts = body.getByTestId('edit-counts');
    assert.deepEqual(await counts.allInnerTexts(), ['+3 −1', '+36']);
    assert.equal(await counts.first().evaluate((el) => getComputedStyle(el).fontSize), '12px');

    // The edit's diff: numbered, removed line first, no path header and no "ok".
    await body.getByTestId('tool-row').filter({ hasText: 'Edited' }).click();
    const diff = body.getByTestId('diff-block');
    const lines = await diff.locator('[data-diff-line]').evaluateAll((rows) => rows.map((r) => `${r.dataset.diffLine}:${r.firstElementChild.textContent}`));
    assert.deepEqual(lines, ['ctx:41', 'del:42', 'add:42', 'add:43', 'add:44']);
    assert.ok(!(await diff.innerText()).includes('AskCards.tsx'), 'no path header');
    await body.getByTestId('tool-row').filter({ hasText: 'Wrote' }).click();
    assert.equal(await body.getByText('ok', { exact: true }).count(), 0, 'no ok result box');

    // Code blocks: no line numbers, a labelled Copy, no download.
    const code = chat.locator('[data-streamdown="code-block"]').first();
    assert.equal(await code.locator('[data-streamdown="code-block-download-button"]').count(), 0);
    assert.match(await code.locator('[data-streamdown="code-block-copy-button"]').evaluate((el) => getComputedStyle(el, '::after').content), /Copy/);
    assert.ok(!(await code.locator('[data-streamdown="code-block-body"]').innerText()).match(/^\s*1\s/m), 'no line numbers');

    // Find: a compact floating card at the top right, with a labelled Tool output checkbox.
    await chat.click({ position: { x: 600, y: 300 } });
    await page.keyboard.press('Meta+f');
    const find = page.getByTestId('chat-find');
    await find.waitFor();
    await find.getByRole('textbox').fill('tool_use_id');
    const fbox = await find.boundingBox();
    const scroller = await chat.boundingBox();
    assert.ok(fbox.width <= 481 && fbox.height <= 41 && Math.abs(fbox.x + fbox.width - (scroller.x + scroller.width - 16)) < 2 && fbox.y - scroller.y < 16, `floating find ${JSON.stringify(fbox)}`);
    assert.equal(await find.getByRole('checkbox', { name: 'Tool output' }).isChecked(), true);
    const names = await find.locator('button, input, [role=status]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.getAttribute('role') ?? el.type));
    assert.deepEqual(names, ['Find in chat', 'status', 'Previous match', 'Next match', 'Match case', 'checkbox', 'Close find']);
    await page.screenshot({ path: join(shots, `${theme}-expanded-find.png`), fullPage: false });
    await page.keyboard.press('Escape');

    // Ended on the failure: one card, its time, Retry and Retry in a new chat.
    await page.evaluate(() => window.draw({ failed: true }));
    const failure = page.getByTestId('turn-failure');
    await failure.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    await failure.getByRole('button', { name: 'Retry in a new chat' }).waitFor();
    assert.equal(await failure.locator('time').count(), 1);
    assert.equal(await page.getByText('Anthropic error: overloaded (529)', { exact: true }).count(), 1);
    await failure.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, `${theme}-failed.png`), fullPage: false });

    // The reset dialog names the turn, the turns that go and the files.
    await page.evaluate(() => window.draw({ reset: true }));
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Reset the chat to turn 2?' }).waitFor();
    assert.match(await dialog.innerText(), /Turns 3 and 4 are removed from this chat and from what Claude Code remembers/);
    assert.match(await dialog.innerText(), /3 files changed since turn 2 go back to how they were then/);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, `${theme}-reset.png`), fullPage: false });

    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`Chat transcript (PRO-378) layout checks passed in dark and light at 1440. Captures: ${shots}`);
} finally {
  await browser?.close();
  await server.close();
}
