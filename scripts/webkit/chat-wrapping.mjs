#!/usr/bin/env node
// #623: real WebKit ranges must wrap, without changing the selectable source.
// pnpm build && pnpm exec playwright install webkit && node scripts/webkit/chat-wrapping.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { webkit } from "playwright";
import { open, openConversation, serve, tab } from "./harness.mjs";

const text = "Normal paragraph with spaces.\n\n" + "─".repeat(200) + "\n" + "_".repeat(200) + "\n" + "unbrokenIdentifier".repeat(30) + "\n  Explicit indentation\nhttps://example.test/docs";
const code = "identifier".repeat(100);
// Opt in only on a disposable macOS guest: this replaces its system clipboard.
const clipboard = process.env.WEBKIT_WRAPPING_CLIPBOARD === "1";
if (clipboard) assert.equal(process.platform, "darwin");
const server = await serve();
let browser;
try {
  browser = await webkit.launch({ headless: !clipboard });
  for (const floating of [false, true]) {
    for (const transcriptLayout of ["chat", "wide"]) {
      const extra = `(() => {
        localStorage.setItem("raccoon.prefs", JSON.stringify({ transcriptLayout: ${JSON.stringify(transcriptLayout)} }));
        window.__PW_STUB__.answers.load_tab_events = ({ tabId }) => {
          const payloads = [
            { type: "user_message", text: ${JSON.stringify(text)}, queued: false, images: [{ url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'/%3E" }] },
            { type: "turn_started" },
            { type: "user_message", text: ${JSON.stringify(text)}, queued: true },
            { type: "prompt_absorbed", promptSeq: 3 },
            { type: "user_message", text: ${JSON.stringify(text)}, queued: true },
            { type: "assistant_text", text: ${JSON.stringify("```text\n" + code + "\n```")} },
          ];
          return payloads.map((payload, i) => ({ id: "wrap-" + i, seq: i + 1, sessionId: "local-s1", tabId, harness: "gemini", ts: "2026-10-24T00:00:00Z", payload }));
        };
      })();`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, floating }, { width: 1100, height: 800 }, { extra });
      if (!floating) {
        await openConversation(page, "claude tab");
        await tab(page, "gemini tab").click();
      }
      await page.locator('[data-testid="queued-message"]:visible').waitFor();
      await page.evaluate(() => document.fonts.ready);
      // Main windows have a native minimum width of 760px; floating windows can be narrower.
      const sizes = floating ? [[1100, 1], [640, 1], [360, 1], [640, 1.5]] : [[1100, 1], [760, 1], [1100, 1.5], [760, 1.5]];
      for (const [width, zoom] of sizes) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate((zoom) => { document.documentElement.style.zoom = String(zoom); }, zoom);
        const result = await page.evaluate(({ text, code }) => {
          const root = [...document.querySelectorAll("[data-chat-scroller]")].find((el) => el.getBoundingClientRect().width > 0);
          const readers = [...root.querySelectorAll('[data-testid="reader-message"] > div')];
          const queued = root.querySelector('[data-testid="queued-message"]');
          const targets = [...readers.map((bubble) => ({ bubble, content: bubble.lastElementChild })), { bubble: queued, content: queued.querySelector('.whitespace-pre-wrap') }];
          const messages = targets.map(({ bubble, content }) => {
            const box = content.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(content);
            const rects = [...range.getClientRects()].filter((r) => r.width > 0);
            const selection = window.getSelection();
            selection.removeAllRanges(); selection.addRange(range);
            const selected = selection.toString();
            selection.removeAllRanges();
            return { exact: content.textContent === text && selected === text, contained: rects.every((r) => r.left >= box.left - 1 && r.right <= box.right + 1), lines: rects.length, overflow: bubble.scrollWidth - bubble.clientWidth, link: content.querySelector('a')?.getAttribute('href') };
          });
          const scroller = root;
          const pre = [...root.querySelectorAll('pre')].find((p) => p.textContent.includes(code));
          let scrollableCode = false;
          for (let p = pre; p && p !== scroller; p = p.parentElement) {
            if (p.scrollWidth > p.clientWidth && ['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) scrollableCode = true;
          }
          const image = readers[0].querySelector('img');
          return { messages, conversationOverflow: scroller.scrollWidth - scroller.clientWidth, image: image?.complete && image.naturalWidth > 0, scrollableCode };
        }, { text, code });
        const label = `${floating ? 'floating' : 'main'} ${transcriptLayout} ${width}px zoom ${zoom}`;
        assert.equal(result.messages.length, 3, label);
        for (const [i, message] of result.messages.entries()) {
          assert.ok(message.contained, `${label} message ${i}: rendered ranges overflow ${JSON.stringify(result)}`);
          assert.ok(message.overflow <= 1, `${label} message ${i}: bubble overflow`);
          assert.ok(message.exact, `${label} message ${i}: selection/source changed`);
          assert.ok(message.lines > 8, `${label} message ${i}: long runs did not wrap`);
          assert.equal(message.link, 'https://example.test/docs');
        }
        assert.ok(result.conversationOverflow <= 1, `${label}: conversation overflow ${JSON.stringify(result)}`);
        assert.ok(result.image, `${label}: attachment loaded`);
        assert.ok(result.scrollableCode, `${label}: code retains horizontal scrolling`);
        if (clipboard) {
          for (let index = 0; index < 3; index++) {
            await page.evaluate((index) => {
              const root = [...document.querySelectorAll('[data-chat-scroller]')].find((el) => el.getBoundingClientRect().width > 0);
              const contents = [...root.querySelectorAll('[data-testid="reader-message"] > div')].map((bubble) => bubble.lastElementChild);
              contents.push(root.querySelector('[data-testid="queued-message"] .whitespace-pre-wrap'));
              contents[index].scrollIntoView();
              const range = document.createRange();
              range.selectNodeContents(contents[index]);
              const selection = window.getSelection();
              selection.removeAllRanges(); selection.addRange(range);
            }, index);
            execFileSync("/usr/bin/pbcopy", { input: "clipboard sentinel" });
            await page.keyboard.press("Meta+c");
            // pbpaste otherwise uses the guest shell's ASCII locale and replaces U+2500.
            assert.equal(execFileSync("/usr/bin/pbpaste", { encoding: "utf8", env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } }), text, `${label} message ${index}: clipboard is exact`);
            await page.evaluate(() => window.getSelection().removeAllRanges());
          }
        }
        if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) {
          await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/${floating ? "floating" : "main"}-${transcriptLayout}-${width}-${zoom}.png` });
        }
        console.log(`ok  ${label}: three message paths contained; source, links, attachment and code scrolling preserved${clipboard ? "; system clipboard exact" : ""}`);
      }
      await page.close();
    }
  }
} finally {
  await browser?.close();
  server.close();
}
