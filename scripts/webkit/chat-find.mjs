#!/usr/bin/env node
// PRO-262: virtual turns, Markdown ranges, folded output, and old WebKit's highlight fallback.
// pnpm build && node scripts/webkit/chat-find.mjs
import assert from "node:assert/strict";
import { launch, open, openConversation, serve, tab } from "./harness.mjs";

const server = await serve();
let browser;
try {
  browser = await launch();
  for (const [fallback, delayedCode] of [[false, false], [true, false], [false, true], [true, true], [false, "scrolled"], [true, "scrolled"]]) {
    const extra = `(() => {
      ${fallback ? 'window.Highlight = undefined;' : ''}
      localStorage.setItem("raccoon.prefs", JSON.stringify({ foldToolCalls: true }));
      window.__PW_STUB__.answers.load_tab_events = ({ tabId }) => {
        const events = [];
        const push = (payload) => events.push({ id: 'find-' + events.length, seq: events.length + 1, sessionId: 'local-s1', tabId, harness: 'gemini', ts: '2026-11-07T00:00:00Z', payload });
        for (let i = 0; i < 2000; i++) {
          push({ type: 'user_message', text: 'Inspect module ' + i, queued: false });
          push({ type: 'reasoning', text: i === 7 ? 'A hidden thought' : 'Consider the module' });
          for (let k = 0; k < 2; k++) {
            const callId = 'call-' + i + '-' + k;
            push({ type: 'tool_call_started', callId, name: 'Read', toolType: 'file_read', input: { file_path: '/repo/module' + i + '.ts' } });
            push({ type: 'tool_call_completed', callId, result: { text: i === 7 && k === 1 ? 'ordinary output\\n'.repeat(1500) + 'buried-output' : 'ordinary output', isError: false } });
          }
          push({ type: 'assistant_text', text: i === 7 ? 'The **hidden** [needle](https://example.test) is here.\\n\\n' + 'A paragraph.\\n\\n'.repeat(60) + 'Another hidden needle.\\n\\n' + '\`\`\`ts\\n' + 'const line = 1;\\n'.repeat(100) + 'const codeNeedle = true;\\n\`\`\`' : 'Finished **module** ' + i });
          push({ type: 'turn_completed', status: 'ok', durationMs: 1000 });
        }
        return events;
      };
    })();`;
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 800 }, { extra });
    // Hold the real lazy renderer until find has revealed the plain-code fallback.
    // Its replacement must retain the active result's nested scroll position.
    let releaseCode;
    let codeRequested = false;
    if (delayedCode) {
      const ready = new Promise((resolve) => { releaseCode = resolve; });
      await page.route("**/highlighted-body-*.js", async (route) => {
        codeRequested = true;
        await ready;
        await route.continue();
      });
    }
    await openConversation(page, "claude tab");
    await tab(page, "gemini tab").click();
    const chat = page.locator('[data-find-scope="chat"]:visible');
    const scroller = chat.locator('[data-chat-scroller]');
    await scroller.getByText("Inspect module 1999", { exact: true }).waitFor();
    assert.equal(await scroller.getByText("Inspect module 7", { exact: true }).count(), 0);
    await scroller.click({ position: { x: 20, y: 40 } });
    await page.keyboard.press("Meta+f");
    const input = chat.getByRole("textbox", { name: "Find in chat" });
    await input.fill("hidden needle");
    await chat.getByRole("status").filter({ hasText: "1 of 2" }).waitFor();
    const visibleHighlight = async (text) => page.waitForFunction(({ text, fallback }) => {
      const chat = [...document.querySelectorAll('[data-chat-scroller]')].find((el) => el.getBoundingClientRect().width);
      const box = chat.getBoundingClientRect();
      if (fallback) return [...document.querySelectorAll('[data-chat-search-highlight]')].some((el) => {
        const r = el.getBoundingClientRect();
        return !!el.style.outline && r.width > 0 && r.height > 0 && r.top >= box.top && r.bottom <= box.bottom;
      });
      const active = [...CSS.highlights.entries()].find(([name]) => name.endsWith('-active'))?.[1];
      if (!active) return false;
      return [...active].some((range) => {
        const r = range.getBoundingClientRect();
        let top = box.top, bottom = box.bottom - 120, left = box.left, right = box.right;
        for (let el = range.startContainer.parentElement; el && el !== chat; el = el.parentElement) {
          const style = getComputedStyle(el), clip = el.getBoundingClientRect();
          if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
          if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
        }
        return range.toString() === text && r.width > 0 && r.top >= top && r.bottom <= bottom && r.left >= left && r.right <= right;
      });
    }, { text, fallback });
    await visibleHighlight("hidden needle");
    assert.ok(await scroller.locator('[data-turn]').count() < 25);
    const firstTop = await scroller.evaluate((el) => el.scrollTop);
    await page.keyboard.press("Meta+g");
    await chat.getByRole("status").filter({ hasText: "2 of 2" }).waitFor();
    await visibleHighlight("hidden needle");
    await page.waitForFunction((top) => [...document.querySelectorAll('[data-chat-scroller]')].some((el) => el.getBoundingClientRect().width > 0 && el.scrollTop > top + 1000), firstTop);
    await page.keyboard.press("Meta+Shift+g");
    await chat.getByRole("status").filter({ hasText: "1 of 2" }).waitFor();
    await input.fill("codeNeedle");
    await visibleHighlight("codeNeedle");
    if (delayedCode) {
      assert.equal(codeRequested, true);
      const codeBody = scroller.locator('[data-streamdown="code-block-body"]');
      if (delayedCode === "scrolled") {
        await codeBody.hover();
        await page.mouse.wheel(0, -2000);
        await page.waitForFunction(() => document.querySelector('[data-streamdown="code-block-body"]').scrollTop === 0);
      }
      const topBeforeReplacement = await scroller.evaluate((el) => el.scrollTop);
      releaseCode();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-streamdown="code-block"] span')].some((el) => {
        const color = el.style.getPropertyValue("--sdm-c");
        return color && color !== "inherit";
      }));
      if (delayedCode === "scrolled") {
        assert.equal(await codeBody.evaluate((el) => el.scrollTop), 0, "keep the reader's scroll after replacing code");
        assert.equal(await scroller.evaluate((el) => el.scrollTop), topBeforeReplacement);
      } else {
        await visibleHighlight("codeNeedle");
      }
    }
    await input.fill("buried-output");
    await chat.getByRole("status").filter({ hasText: "1 of 1" }).waitFor();
    await visibleHighlight("buried-output");
    assert.ok(await scroller.locator('pre').filter({ hasText: 'buried-output' }).evaluate((el) => el.scrollTop > 0));
    await chat.getByRole("button", { name: "Include tool output" }).click();
    await chat.getByRole("status").filter({ hasText: "No matches" }).waitFor();
    await input.fill("hidden thought");
    await visibleHighlight("hidden thought");
    await input.fill("HIDDEN THOUGHT");
    await chat.getByRole("button", { name: "Match case", exact: true }).click();
    await chat.getByRole("status").filter({ hasText: "No matches" }).waitFor();
    await page.keyboard.press("Escape");
    await input.waitFor({ state: "hidden" });
    assert.equal(await scroller.getByText("A hidden thought", { exact: true }).count(), 0);
    assert.equal(await page.locator('[data-chat-search-highlight]').count(), 0);
    console.log(`ok  ${fallback ? 'fallback overlays' : 'native highlights'}${delayedCode ? ', delayed code renderer' : ''}${delayedCode === 'scrolled' ? ', reader scrolled away' : ''}: 2,000 virtual turns, Markdown, code, folded output, navigation and options`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
