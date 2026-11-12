#!/usr/bin/env node
// PRO-336: text stays readable over panels, in WebKit, light and dark, in
// glass mode (the Mac look) whatever the platform. A tooltip over the chat,
// the composer and a menu over the sidebar rows are opaque: with their own
// content hidden, nothing behind them shows through, and their muted text
// reads at 4.5:1. With macOS Reduce transparency on, glass is off and comes
// back when the setting is turned off again.
// pnpm build && node scripts/webkit/readable-panels.mjs
// Set READABLE_PANELS_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, openConversation, report, serve, throughPanel } from "./harness.mjs";

const shots = process.env.READABLE_PANELS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

// Turns whose prose runs the chat's full width, so a panel over it has text behind it.
const prose = "Readable over panels: every line of this reply runs the full width of the chat so that a tooltip, a menu or the composer laid over it has words right behind it. ".repeat(4);
const transcript = `window.__PW_STUB__.answers.load_tab_events = ({ tabId }) => Array.from({ length: 6 }, (_, turn) => [
  { type: "user_message", text: "Prompt " + (turn + 1) + ": check the panels over this text", queued: false },
  { type: "turn_started" },
  { type: "assistant_text", text: ${JSON.stringify(prose)} },
  { type: "turn_completed" },
]).flat().map((payload, i) => ({ id: "p-" + i, seq: i + 1, sessionId: "local-s1", tabId, harness: "claude", ts: "2026-11-12T00:00:00Z", payload }));`;

// macOS Reduce transparency, as WebKit reports it, switchable while the page runs.
const reduceTransparency = `(() => {
  const real = window.matchMedia.bind(window);
  const listeners = new Set();
  const query = "(prefers-reduced-transparency: reduce)";
  const list = { media: query, matches: true, addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f), addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) };
  window.__setReduceTransparency = (on) => { list.matches = on; for (const f of listeners) f({ matches: on, media: query }); };
  window.matchMedia = (q) => (q === query ? list : real(q));
})();`;

/** Whether a computed colour or gradient has a colour stop below full alpha ("oklab(… / 0.92)", "rgba(…, 0.5)"). */
const translucent = (value) => /\/\s*0?\.\d|rgba\([^)]*,\s*0?\.\d|transparent/.test(value);

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const at = colorScheme;
    const shot = async (page, name) => {
      if (!shots) return;
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
      await page.screenshot({ path: join(shots, `readable-panels-${name}-${colorScheme}.png`) });
    };
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 760 }, { extra: transcript, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate(() => document.documentElement.setAttribute("data-glass", ""));
    await openConversation(page, "Local long session");
    await page.getByTestId("prompt-map").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const translucentWindow = translucent(await page.evaluate(() => getComputedStyle(document.body).backgroundImage));
    const checks = { "glass mode is on: the window tints the desktop": translucentWindow };

    // A prompt's preview opens beside its mark, over the reply's text.
    const map = page.locator('[data-testid="prompt-map"]:visible');
    await map.getByRole("button", { name: /^Prompt 2:/ }).hover();
    const preview = page.locator('[data-testid="prompt-map"]:visible ~ [role="tooltip"], [role="tooltip"]:visible').first();
    await preview.waitFor();
    const overText = await preview.evaluate((node) => {
      const box = node.getBoundingClientRect();
      node.style.visibility = "hidden";
      const under = document.elementFromPoint(box.left + 12, box.top + box.height / 2);
      node.style.visibility = "";
      return !!under?.closest("[data-chat-scroller]");
    });
    await shot(page, "tooltip-over-chat");
    const tooltip = await throughPanel(page, preview);
    checks["a tooltip over the chat lies over its text"] = overText;
    checks["nothing behind the tooltip shows through, and its muted text reads at 4.5:1"] = tooltip.showsThrough === 0 && tooltip.backdrop === "none" && tooltip.contrast >= 4.5;
    await page.mouse.move(600, 300);

    // The composer floats at the foot of the chat.
    const composer = page.locator("[data-composer-box]:visible").first();
    await shot(page, "composer");
    const box = await throughPanel(page, composer);
    checks["nothing behind the composer shows through, and its muted text reads at 4.5:1"] = box.showsThrough === 0 && box.backdrop === "none" && box.contrast >= 4.5;

    // A sidebar row's menu opens over the rows under it.
    const row = page.locator('[data-testid="conversation-list"] li').first();
    await row.hover();
    await row.getByRole("button", { name: /^Menu for / }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const overRows = await menu.evaluate((node) => {
      const rail = document.querySelector('[data-testid="sidebar-rail"]').getBoundingClientRect();
      return node.getBoundingClientRect().left < rail.right;
    });
    await shot(page, "menu-over-sidebar");
    const menuThrough = await throughPanel(page, menu);
    checks["the row's menu lies over the sidebar"] = overRows;
    checks["nothing behind the menu shows through, and its muted text reads at 4.5:1"] = menuThrough.showsThrough === 0 && menuThrough.backdrop === "none" && menuThrough.contrast >= 4.5;
    await page.keyboard.press("Escape");
    checks["no browser errors"] = errors.length === 0;
    failed += report(`glass, ${at}`, checks, { tooltip, box, menuThrough, errors });
    await page.close();

    // Reduce transparency: glass is off from the first paint, and follows the setting.
    const reduced = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1100, height: 760 }, { extra: reduceTransparency, colorScheme });
    await reduced.locator('[data-testid="sidebar-rail"]').waitFor();
    const solid = () => reduced.evaluate(() => {
      const ground = getComputedStyle(document.body).backgroundImage;
      return { glass: document.documentElement.hasAttribute("data-glass"), ground };
    });
    const off = await solid();
    await reduced.evaluate(() => window.__setReduceTransparency(false));
    const on = await solid();
    await reduced.evaluate(() => window.__setReduceTransparency(true));
    const offAgain = await solid();
    const isMac = await reduced.evaluate(() => navigator.platform.startsWith("Mac"));
    failed += report(`reduce transparency, ${at}`, {
      "with Reduce transparency on there is no glass and the window paints solid": !off.glass && !translucent(off.ground),
      "turned off while the app runs, a Mac gets its glass back; turned on again, it goes": (isMac ? on.glass : !on.glass) && !offAgain.glass,
    }, { off, on, offAgain });
    await reduced.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
