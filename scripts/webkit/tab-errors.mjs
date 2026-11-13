#!/usr/bin/env node
// PRO-291: a chat tab that would not open or close says so, in WebKit, light
// and dark. A close whose agent did not stop within 10 seconds leaves the tab
// in the strip and raises "Couldn't close the chat. Try again." naming it; a
// new tab whose agent exited while starting is gone again and raises
// "Couldn't open a new Claude Code tab: …" with the agent's own line in
// monospace, Try again and Open settings.json. The two stack in the toast
// area inside the window without overlapping or clipping; Open settings.json
// opens the file the line names; Try again repeats the action, and the toast
// goes once it works.
// pnpm build && node scripts/webkit/tab-errors.mjs
// Set TAB_ERRORS_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, openConversation, report, serve, tab } from "./harness.mjs";

const shots = process.env.TAB_ERRORS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const LINE = "~/.claude/settings.json line 14: Unexpected token }";
// The close and the new tab's start fail until the page says otherwise; what was asked is recorded.
const failing = `window.__FAIL__ = { close: true, start: true };
window.__ASKED__ = { inspected: [], removed: [], started: [] };
(() => {
  const answers = window.__PW_STUB__.answers;
  const at = new Date().toISOString();
  let seq = 0;
  answers.list_harnesses = [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }];
  answers.add_tab = ({ sessionId, tab }) => ({ id: "new-" + (++seq), harness: tab.harness, model: "", permissionMode: "default", status: "idle", created: at, modified: at });
  answers.ensure_tab_started = ({ tabId }) => {
    window.__ASKED__.started.push(tabId);
    if (tabId.startsWith("new-") && window.__FAIL__.start) throw ${JSON.stringify(`claude exited while starting\n${LINE}`)};
    return null;
  };
  answers.remove_tab = ({ tabId }) => {
    window.__ASKED__.removed.push(tabId);
    if (tabId === "lt-pty" && window.__FAIL__.close) throw "Claude Code didn't stop within 10 seconds";
    return null;
  };
  answers["plugin:path|resolve_directory"] = () => "/Users/demo";
  answers.inspect_local_path = ({ base, path }) => {
    window.__ASKED__.inspected.push(path);
    return { kind: "file", path, root: "/Users/demo/.claude", rel: "settings.json", text: true };
  };
})();`;

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 760 }, { extra: failing, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openConversation(page, "Local long session");
    const strip = page.getByRole("tablist", { name: "Workspace tabs" });
    const alerts = page.locator('[role="alert"][data-error-toast]');

    // Close the claude tab from its menu: its agent will not stop.
    await tab(page, "claude tab").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Close tab( |$)/ }).click();
    const closing = alerts.filter({ hasText: "Couldn't close the chat" });
    await closing.waitFor();
    const closeText = (await closing.textContent()) ?? "";
    const stillOpen = (await tab(page, "claude tab").count()) === 1;

    // A new Claude Code tab whose agent exits while starting.
    await page.getByRole("button", { name: "New tab" }).click();
    await page.getByRole("menuitem", { name: "Claude Code" }).click();
    const opening = alerts.filter({ hasText: "Couldn't open a new Claude Code tab" });
    await opening.waitFor();
    const openText = (await opening.textContent()) ?? "";
    const mono = await opening.getByText(LINE, { exact: true }).evaluate((node) => getComputedStyle(node).fontFamily);
    const bodyFont = await opening.evaluate((node) => getComputedStyle(node).fontFamily);
    const openButtons = await opening.getByRole("button").allTextContents();
    const tabsAfterOpen = await strip.getByRole("tab").count();

    const layout = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[role="alert"][data-error-toast]')];
      const boxes = cards.map((node) => node.getBoundingClientRect());
      const inView = boxes.every((box) => box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight);
      const overlap = boxes.some((a, i) => boxes.slice(i + 1).some((b) => a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right));
      const contained = cards.every((card) => {
        const box = card.getBoundingClientRect();
        return [...card.querySelectorAll("button, span, div")].every((node) => {
          const inner = node.getBoundingClientRect();
          return inner.width === 0 || (inner.left >= box.left - 0.5 && inner.right <= box.right + 0.5 && inner.top >= box.top - 0.5 && inner.bottom <= box.bottom + 0.5);
        }) && card.scrollWidth <= card.clientWidth;
      });
      // The buttons of one card sit in a row without covering each other.
      const buttonsApart = cards.every((card) => {
        const buttons = [...card.querySelectorAll("button")].map((node) => node.getBoundingClientRect()).filter((box) => box.width > 0);
        return buttons.every((a, i) => buttons.slice(i + 1).every((b) => !(a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right)));
      });
      return { count: cards.length, boxes: boxes.map((box) => ({ left: box.left, top: box.top, width: box.width, height: box.height })), inView, overlap, contained, buttonsApart };
    });
    if (shots) await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    if (shots) await page.screenshot({ path: join(shots, `tab-errors-${colorScheme}.png`) });

    // Open settings.json opens the file the line names; the toast stays.
    await opening.getByRole("button", { name: "Open settings.json" }).click();
    await page.waitForFunction(() => window.__ASKED__.inspected.length > 0);
    const inspected = await page.evaluate(() => window.__ASKED__.inspected);
    const keptAfterOpen = (await opening.count()) === 1;

    // Try again, once each works: the toast goes, the tab closes, a new tab opens.
    await page.evaluate(() => { window.__FAIL__.close = false; window.__FAIL__.start = false; });
    await closing.getByRole("button", { name: "Try again" }).click();
    await closing.waitFor({ state: "detached" });
    const closedNow = (await tab(page, "claude tab").count()) === 0;
    await opening.getByRole("button", { name: "Try again" }).click();
    await opening.waitFor({ state: "detached" });
    const opened = await page.evaluate(() => window.__ASKED__.started.filter((id) => id.startsWith("new-")));
    const tabsAtEnd = await strip.getByRole("tab").count();

    failed += report(`tab errors, ${colorScheme}`, {
      "a close that timed out says so, names the tab, and leaves it open": closeText.includes("Couldn't close the chat. Try again.") && closeText.includes("Claude Code didn't stop within 10 seconds, so “claude tab” is still open.") && stillOpen,
      "a tab that failed to start says why, with the agent's line in monospace": openText.includes("Couldn't open a new Claude Code tab: claude exited while starting") && openText.includes(LINE) && /mono/i.test(mono) && mono !== bodyFont,
      "it offers Try again and Open settings.json beside Copy error": ["Try again", "Open settings.json", "Copy error"].every((label) => openButtons.includes(label)),
      "no empty tab is left behind": tabsAfterOpen === 2,
      "the two toasts sit inside the window, apart, and clip nothing": layout.count === 2 && layout.inView && !layout.overlap && layout.contained && layout.buttonsApart,
      "Open settings.json opens the named file and keeps the toast": inspected.at(-1) === "/Users/demo/.claude/settings.json" && keptAfterOpen,
      "Try again closes the tab once it can, and its toast goes": closedNow,
      "Try again opens the tab once its agent starts, and its toast goes": opened.length >= 2 && tabsAtEnd === 2,
      "no browser errors": errors.length === 0,
    }, { closeText, stillOpen, openText, mono, bodyFont, openButtons, tabsAfterOpen, layout, inspected, keptAfterOpen, closedNow, opened, tabsAtEnd, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
