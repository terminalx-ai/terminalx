#!/usr/bin/env node
// #200: measure the built dashboard in WebKit, including real text/element
// bounds, scrolling and keyboard actions. jsdom cannot catch flex shrinking.
// Run: pnpm build && pnpm exec playwright install webkit && pnpm test:webkit-layout
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { FOCUS_NEXT, launch, serve } from "./harness.mjs";

const stub = `${await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8")}\n${await readFile(new URL("./dashboard-stub.js", import.meta.url), "utf8")}`;
const labels = ["Needs you", "Working", "Done", "Not started"];
const cards = (column) => column.locator('[role="button"]');
const allLayouts = [
  { name: "wide", width: 1360, height: 760, stacked: false, counts: [0, 1] },
  { name: "wide, short", width: 1360, height: 420, stacked: false, counts: [36] },
  { name: "stacked at four columns", width: 1100, height: 420, stacked: true, counts: [1] },
  { name: "stacked, short", width: 960, height: 420, stacked: true, counts: [0, 36] },
  // Emulate page zoom with a smaller CSS viewport and a matching pixel scale.
  // Pixel density alone would not exercise reflow; CSS zoom on the document
  // would also scale fixed-position portals a second time in WebKit.
  { name: "150% zoom, wide", width: 2100, height: 800, zoom: 1.5, stacked: false, counts: [36] },
  { name: "200% zoom, stacked", width: 1600, height: 900, zoom: 2, stacked: true, counts: [36] },
  { name: "150% text, short", width: 1360, height: 480, textScale: 1.5, stacked: false, counts: [36] },
];
// All seven by default. `--layouts i/n` runs part i of n: the layouts are dealt out in turn, so each is in exactly
// one part whatever n is. run-all.mjs runs the check as three parts: the 21 pages together took 470 s on a slow
// runner, against run-all's 600 s limit for one check.
const { values: options } = parseArgs({ options: { layouts: { type: "string" } } });
const part = /^(\d+)\/(\d+)$/.exec(options.layouts ?? "1/1");
const [partIndex, partCount] = part ? [Number(part[1]), Number(part[2])] : [];
if (!part || partCount < 1 || partIndex < 1 || partIndex > partCount) {
  console.error(`--layouts takes <i>/<n> with 1 ≤ i ≤ n, not ${JSON.stringify(options.layouts)}.`);
  process.exit(2);
}
const layouts = allLayouts.filter((_, index) => index % partCount === partIndex - 1);
if (!layouts.length) {
  console.error(`--layouts ${options.layouts} holds no layout: there are ${allLayouts.length}.`);
  process.exit(2);
}

/** Include clipping by every scroll container, not just the viewport. */
const visible = (locator) => locator.evaluate((element) => {
  const box = element.getBoundingClientRect();
  let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
  }
  return box.height > 0 && box.width > 0 && box.top >= top - 1 && box.bottom <= bottom + 1 && box.left >= left - 1 && box.right <= right + 1;
});

async function checkColumn(column, expectedCount, context) {
  const layout = await column.evaluate((section) => {
    const list = section.lastElementChild;
    const rows = [...list.querySelectorAll('[role="button"]')];
    const clipped = [];
    const heights = [];
    for (let cardIndex = 0; cardIndex < rows.length; cardIndex++) {
      const card = rows[cardIndex];
      const box = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      const scale = box.height / card.offsetHeight;
      heights.push(box.height);
      const top = box.top + parseFloat(style.paddingTop) * scale;
      const bottom = box.bottom - parseFloat(style.paddingBottom) * scale;
      if (card.scrollHeight > card.clientHeight + 1) clipped.push("card contents overflow vertically");
      // Text ranges catch glyph clipping even when a flex row's own box has
      // already shrunk. Sample head and tail cards on large synthetic lists
      // (all 72 share the same card template).
      if (rows.length <= 12 || cardIndex < 6 || cardIndex >= rows.length - 4) {
        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim() || node.parentElement.closest("button")) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (rect.height < 1 || rect.top < top - 1 || rect.bottom > bottom + 1) clipped.push(node.textContent);
        }
        for (const element of card.querySelectorAll("svg, button")) {
          const rect = element.getBoundingClientRect();
          if (rect.height < 1 || rect.top < box.top || rect.bottom > box.bottom + 1) clipped.push(element.getAttribute("aria-label") ?? element.tagName);
        }
        const contentRows = [...card.children].filter((el) => getComputedStyle(el).position !== "absolute");
        for (let i = 1; i < contentRows.length; i++) {
          if (contentRows[i].getBoundingClientRect().top < contentRows[i - 1].getBoundingClientRect().bottom + 1) clipped.push("rows lost their spacing");
        }
      }
    }
    const heading = section.firstElementChild;
    const headingBox = heading.getBoundingClientRect();
    const headingFits = [...heading.children].every((el) => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && rect.top >= headingBox.top - 1 && rect.bottom <= headingBox.bottom + 1;
    });
    return { count: rows.length, heading: heading.textContent, headingFits, heights, clipped, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
  });
  assert.equal(layout.count, expectedCount, `${context}: card count`);
  assert.deepEqual(layout.clipped, [], `${context}: vertically clipped content; heights=${layout.heights.slice(0, 4)}`);
  assert.ok(layout.heights.every((height) => height >= 90), `${context}: cards retain readable height`);
  assert.ok(layout.headingFits, `${context}: status heading and count retain their height`);
  return layout;
}

async function checkActions(page, column, context) {
  const rows = cards(column);
  // Leave the keyboard cursor near the end, then scroll back to the start.
  // ArrowDown must bring the final card fully into view again.
  await rows.nth(await rows.count() - 2).focus();
  await rows.first().scrollIntoViewIfNeeded();
  const last = rows.last();
  const idleShadow = await last.evaluate((el) => getComputedStyle(el).boxShadow);
  await page.keyboard.press("ArrowDown");
  assert.ok(await visible(last), `${context}: keyboard cursor reaches the last card`);
  assert.notEqual(await last.evaluate((el) => getComputedStyle(el).boxShadow), idleShadow, `${context}: cursor is marked`);
  // WebKit on macOS uses Option-Tab to include buttons in focus traversal.
  await last.focus();
  await page.keyboard.press(FOCUS_NEXT);
  const trigger = last.getByRole("button", { name: "Session menu" });
  assert.ok(await trigger.evaluate((el) => el === document.activeElement && el.matches(":focus-visible")), `${context}: Tab focuses the session menu`);
  await page.waitForFunction(() => getComputedStyle(document.activeElement).opacity === "1");
  assert.ok(await visible(trigger), `${context}: the focused menu trigger is not clipped`);
  await page.keyboard.press("Space");
  const menu = page.getByRole("menu");
  await menu.waitFor();
  assert.ok(await visible(menu), `${context}: session actions fit in the window`);
  await page.getByRole("menuitem", { name: "Open", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await closed(page, await trigger.elementHandle());
}

/**
 * Once a menu is closed: Radix gives focus back to its trigger from a timer after the menu unmounts. Until that timer
 * has run, focus given to another control is taken back by it; on a busy Linux runner it ran in the middle of the
 * search box's fill, the text went to the trigger and the search stayed empty ("search: card count 2 !== 1").
 */
async function closed(page, trigger) {
  await page.getByRole("menu").waitFor({ state: "detached" });
  await page.waitForFunction((element) => document.activeElement === element, trigger);
}

const server = await serve();
const browser = await launch();
try {
  for (const config of layouts) {
    for (const count of config.counts) {
      const context = `${config.name}, ${count * 2} sessions per status`;
      const zoom = config.zoom ?? 1;
      const page = await browser.newPage({
        viewport: { width: Math.round(config.width / zoom), height: Math.round(config.height / zoom) },
        deviceScaleFactor: zoom,
      });
      await page.addInitScript(`window.__PW_FIXTURE__ = ${JSON.stringify({ cloud: true, localProjects: 2, dashboardCount: count })};\n${stub}`);
      await page.goto(server.url);
      // Check the bridge contract directly: do not depend on the 15s background
      // timer firing before this layout finishes to catch a bogus updater handle.
      assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:updater|check")), null, `${context}: fixture reports no app update`);
      // The sidebar's destination is "Overview, <counts>" (PRO-384); it was "Dashboard" (#484) and "Agent Dashboard" before.
      await page.getByRole("button", { name: /^Overview/ }).click();
      // PRO-385: the toolbar row (02.01) replaced the "Agents" heading and its total.
      // In the page, not the sidebar: the sidebar's destination is named "New session" too (PRO-384).
      await page.getByRole("main").getByRole("button", { name: "New session", exact: true }).waitFor();
      if (count) await page.getByText("Check the synthetic layout", { exact: true }).first().waitFor();
      assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:updater|check")), null, "layout fixture reports no available update");
      await page.evaluate(async ({ textScale }) => {
        await document.fonts.ready;
        if (textScale) {
          const nodes = [...document.querySelector("main").querySelectorAll("*")];
          const sizes = nodes.map((el) => parseFloat(getComputedStyle(el).fontSize) * textScale);
          nodes.forEach((el, i) => el.style.fontSize = `${sizes[i]}px`);
        }
      }, config);
      const columns = labels.map((label) => page.getByRole("region", { name: label, exact: true }));
      const boxes = await Promise.all(columns.map((column) => column.boundingBox()));
      assert.equal(boxes[1].y > boxes[0].y + 10, config.stacked, `${context}: expected stacked/multi-column layout`);
      for (const [index, column] of columns.entries()) {
        const expectedCount = index === 2 ? Math.min(50, count * 2) : count * 2;
        const layout = await checkColumn(column, expectedCount, `${context}, ${labels[index]}`);
        assert.equal(layout.heading, `${labels[index]}${count * 2}`, `${context}: heading/count`);
        if (!count) {
          await column.getByText(["None", "Nothing running.", "Nothing finished yet.", "No chats waiting to start."][index], { exact: true }).waitFor();
          continue;
        }
        // Wheel events exercise the actual scroll owner: the column in wide
        // mode, the shared area when stacked. Headings stay put in wide mode.
        if (count <= 1 || index === 0 || index === 2) {
          await cards(column).first().scrollIntoViewIfNeeded();
          const heading = column.locator("header");
          const before = await heading.boundingBox();
          await cards(column).first().hover();
          await page.evaluate(() => { window.__wheelStill = {}; });
          await page.mouse.wheel(0, 100_000);
          const last = cards(column).last();
          if (count > 1) {
            await page.waitForFunction((label) => {
              const section = document.querySelector(`section[aria-label="${label}"]`);
              for (let el = section.lastElementChild; el; el = el.parentElement) if (el.scrollTop > 0) return true;
              return false;
            }, labels[index]);
            if (!config.stacked) {
              assert.ok(layout.scrollHeight > layout.clientHeight, `${context}: populated column overflows`);
              // At the end and no longer moving: WebKit on Linux animates a wheel scroll, and at 150% zoom its last step is a
              // pixel. Read within a pixel of the end, the last card was 1.4 px past the column (hosted-runner run
              // 45392734637; 3 of 36 copies in a Linux container) and fully in it a step later.
              await page.waitForFunction((label) => {
                const list = document.querySelector(`section[aria-label="${label}"]`).lastElementChild;
                const still = window.__wheelStill;
                const seen = still[label] ?? { at: null, frames: 0 };
                still[label] = { at: list.scrollTop, frames: seen.at === list.scrollTop ? seen.frames + 1 : 0 };
                return still[label].frames >= 3 && list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
              }, labels[index], { polling: "raf" });
              assert.ok(await visible(last), `${context}: wheel reaches the last card`);
              assert.deepEqual(await heading.boundingBox(), before, `${context}: status heading stays put`);
            }
          }
          await last.scrollIntoViewIfNeeded();
          assert.ok(await visible(last), `${context}: last card is fully reachable`);
          if (index === 0) await checkActions(page, column, context);
        }
      }
      if (count > 1) {
        const more = page.getByRole("button", { name: "Show 22 more", exact: true });
        await more.scrollIntoViewIfNeeded();
        assert.ok(await visible(more), `${context}: pagination is visible`);
        assert.ok((await more.boundingBox()).height >= 26, `${context}: pagination keeps its height`);
        await more.click();
        await checkColumn(columns[2], 72, `${context}, Done after pagination`);
        await cards(columns[2]).last().scrollIntoViewIfNeeded();
        assert.ok(await visible(cards(columns[2]).last()), `${context}: final paginated card is reachable`);
      }
      const search = page.getByRole("textbox", { name: "Search sessions" });
      await search.fill("Local done session 01");
      await checkColumn(columns[2], count ? 1 : 0, `${context}, search`);
      assert.equal(await cards(columns[0]).count(), 0);
      assert.equal(await cards(columns[1]).count(), 0);
      assert.equal(await cards(columns[3]).count(), 0);
      assert.ok(await visible(search), `${context}: search stays visible`);
      await page.getByRole("button", { name: "Clear search", exact: true }).click();
      // The same button is named "Filter, 1 on" once a filter is chosen.
      const filter = await page.getByRole("button", { name: "Filter", exact: true }).elementHandle();
      await filter.click();
      await page.getByRole("menu").scrollIntoViewIfNeeded();
      assert.ok(await visible(page.getByRole("menu")), `${context}: filter menu fits in the window`);
      await page.getByRole("menuitemcheckbox", { name: "Working", exact: true }).click();
      await page.keyboard.press("Escape");
      // The keys below go to a card's menu: the filter menu's focus return must not take them.
      await closed(page, filter);
      assert.equal(await cards(columns[0]).count(), 0);
      assert.equal(await cards(columns[1]).count(), count * 2);
      assert.equal(await cards(columns[2]).count(), 0);
      assert.equal(await cards(columns[3]).count(), 0);
      if (count) {
        const local = columns[1].getByRole("button", { name: "Local working session 01, Claude, Codex", exact: true });
        await local.scrollIntoViewIfNeeded();
        await local.focus();
        await page.keyboard.press(FOCUS_NEXT);
        await page.keyboard.press("Space");
        await page.getByRole("menuitem", { name: "Stop", exact: true }).focus();
        await page.keyboard.press("Enter");
        const stopped = await page.evaluate(() => window.__PW_DASHBOARD_ACTIONS__);
        assert.deepEqual(stopped.map((action) => action.tabId), ["Local-working-0-claude", "Local-working-0-codex"], `${context}: Stop acts on the selected session's tabs`);
      }
      assert.equal(await page.getByTestId("update-notice").count(), 0, `${context}: no unrelated update notice`);
      console.log(`ok   agent dashboard: ${context} — content, scrolling, controls and keyboard`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
