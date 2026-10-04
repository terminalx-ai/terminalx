#!/usr/bin/env node
// #200: measure the built dashboard in WebKit, including real text/element
// bounds, scrolling and keyboard actions. jsdom cannot catch flex shrinking.
// Run: pnpm build && pnpm exec playwright install webkit && pnpm test:webkit-layout
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch, serve } from "./harness.mjs";

const stub = `${await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8")}\n${await readFile(new URL("./dashboard-stub.js", import.meta.url), "utf8")}`;
const labels = ["Needs you", "Working", "Done"];
const cards = (column) => column.locator('[role="button"]');
const layouts = [
  { name: "wide", width: 1360, height: 760, stacked: false },
  { name: "wide, short", width: 1100, height: 420, stacked: false },
  { name: "stacked, short", width: 960, height: 420, stacked: true },
  // Emulate page zoom with a smaller CSS viewport and a matching pixel scale.
  // Pixel density alone would not exercise reflow; CSS zoom on the document
  // would also scale fixed-position portals a second time in WebKit.
  { name: "150% zoom, wide", width: 1700, height: 800, zoom: 1.5, stacked: false },
  { name: "200% zoom, stacked", width: 1600, height: 900, zoom: 2, stacked: true },
  { name: "150% text, short", width: 1280, height: 480, textScale: 1.5, stacked: false },
];

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
    for (const card of rows) {
      const box = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      const scale = box.height / card.offsetHeight;
      heights.push(box.height);
      const top = box.top + parseFloat(style.paddingTop) * scale;
      const bottom = box.bottom - parseFloat(style.paddingBottom) * scale;
      // Text ranges catch glyph clipping even when a flex row's own box has
      // already shrunk. Horizontal ellipsis is intentional; vertical loss isn't.
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
      if (card.scrollHeight > card.clientHeight + 1) clipped.push("card contents overflow vertically");
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
  await page.keyboard.press(process.platform === "darwin" ? "Alt+Tab" : "Tab");
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
}

const server = await serve();
const browser = await launch();
try {
  for (const config of layouts) {
    for (const count of [0, 1, 36]) {
      const context = `${config.name}, ${count * 2} sessions per status`;
      const zoom = config.zoom ?? 1;
      const page = await browser.newPage({
        viewport: { width: Math.round(config.width / zoom), height: Math.round(config.height / zoom) },
        deviceScaleFactor: zoom,
      });
      await page.addInitScript(`window.__PW_FIXTURE__ = ${JSON.stringify({ cloud: true, localProjects: 2, dashboardCount: count })};\n${stub}`);
      await page.goto(server.url);
      await page.getByRole("button", { name: /Agent Dashboard/ }).click();
      await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
      await page.getByText(`${count * 6} total`, { exact: true }).waitFor();
      if (count) await page.getByText("Check the synthetic layout", { exact: true }).first().waitFor();
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
          await column.getByText(["None", "Nothing running.", "Nothing finished yet."][index], { exact: true }).waitFor();
          continue;
        }
        // Wheel events exercise the actual scroll owner: the column in wide
        // mode, the shared area when stacked. Headings stay put in wide mode.
        await cards(column).first().scrollIntoViewIfNeeded();
        const heading = column.locator("header");
        const before = await heading.boundingBox();
        await cards(column).first().hover();
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
            await page.waitForFunction((label) => {
              const list = document.querySelector(`section[aria-label="${label}"]`).lastElementChild;
              return list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
            }, labels[index]);
            assert.ok(await visible(last), `${context}: wheel reaches the last card`);
            assert.deepEqual(await heading.boundingBox(), before, `${context}: status heading stays put`);
          }
        }
        await last.scrollIntoViewIfNeeded();
        assert.ok(await visible(last), `${context}: last card is fully reachable`);
        await checkActions(page, column, context);
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
      assert.ok(await visible(search), `${context}: search stays visible`);
      await page.getByRole("button", { name: "Clear search", exact: true }).click();
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      await page.getByRole("menu").scrollIntoViewIfNeeded();
      assert.ok(await visible(page.getByRole("menu")), `${context}: filter menu fits in the window`);
      await page.getByRole("menuitemcheckbox", { name: "Working", exact: true }).click();
      await page.keyboard.press("Escape");
      assert.equal(await cards(columns[0]).count(), 0);
      assert.equal(await cards(columns[1]).count(), count * 2);
      assert.equal(await cards(columns[2]).count(), 0);
      if (count) {
        const local = columns[1].getByRole("button", { name: "Local working session 01, Claude, Codex", exact: true });
        await local.scrollIntoViewIfNeeded();
        await local.focus();
        await page.keyboard.press(process.platform === "darwin" ? "Alt+Tab" : "Tab");
        await page.keyboard.press("Space");
        await page.getByRole("menuitem", { name: "Stop", exact: true }).focus();
        await page.keyboard.press("Enter");
        const stopped = await page.evaluate(() => window.__PW_DASHBOARD_ACTIONS__);
        assert.deepEqual(stopped.map((action) => action.tabId), ["Local-working-0-claude", "Local-working-0-codex"], `${context}: Stop acts on the selected session's tabs`);
      }
      console.log(`ok   agent dashboard: ${context} — content, scrolling, controls and keyboard`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
