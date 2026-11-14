#!/usr/bin/env node
// PRO-326: a failed action says so. A sidebar action that fails raises
// "Something went wrong" in the toast area, in WebKit, light and dark: the
// sentence names what could not be done and the error, in monospace; it is
// still there after 30 s; different errors stack without overlapping and a
// repeat is counted, not copied; Copy error puts the whole sentence on the
// clipboard and says so; it is an alert and closes from the keyboard.
// pnpm build && node scripts/webkit/error-toast.mjs
// Set ERROR_TOAST_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.ERROR_TOAST_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const CAUSE = "database is locked (SQLITE_BUSY)";
// Pinning and archiving fail as a busy database does; the clipboard is recorded.
const failing = `window.__COPIED__ = [];
window.__PW_STUB__.answers.set_session_pinned = () => { throw ${JSON.stringify(CAUSE)}; };
window.__PW_STUB__.answers.set_session_archived = () => { throw ${JSON.stringify(CAUSE)}; };
window.__PW_STUB__.answers.copy_text = ({ text }) => { window.__COPIED__.push(text); return null; };`;

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 760 }, { extra: failing, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install();
    await sidebar(page);
    const row = page.locator('[data-testid="conversation-list"] li').first();
    const choose = async (name) => {
      await row.hover();
      await row.getByRole("button", { name: /^Menu for / }).click();
      await page.getByRole("menu").getByRole("menuitem", { name }).click();
    };
    await choose(/^Pin/);
    const alerts = page.locator('[role="alert"][data-error-toast]');
    await alerts.first().waitFor();
    const first = alerts.first();
    const text = (await first.textContent()) ?? "";
    const mono = await first.getByText(CAUSE, { exact: true }).evaluate((node) => getComputedStyle(node).fontFamily);
    const bodyFont = await first.evaluate((node) => getComputedStyle(node).fontFamily);

    await choose(/^Archive/);
    await choose(/^Pin/);
    await page.clock.runFor(30_000);
    const count = await alerts.count();
    const layout = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[role="alert"][data-error-toast]')].map((node) => node.getBoundingClientRect());
      const inView = cards.every((box) => box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight);
      const overlap = cards.some((a, i) => cards.slice(i + 1).some((b) => a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right));
      // Every control and line inside its card, nothing cut off sideways.
      const contained = [...document.querySelectorAll('[role="alert"][data-error-toast]')].every((card) => {
        const box = card.getBoundingClientRect();
        return [...card.querySelectorAll("button, span, div")].every((node) => {
          const inner = node.getBoundingClientRect();
          return inner.width === 0 || (inner.left >= box.left - 0.5 && inner.right <= box.right + 0.5 && inner.top >= box.top - 0.5 && inner.bottom <= box.bottom + 0.5);
        }) && card.scrollWidth <= card.clientWidth;
      });
      return { cards: cards.map((box) => ({ left: box.left, top: box.top, width: box.width, height: box.height })), inView, overlap, contained };
    });
    if (shots) await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    if (shots) await page.screenshot({ path: join(shots, `error-toast-${colorScheme}.png`) });

    // The pin toast was raised twice: counted once, it is the newest (last) card.
    const pin = alerts.filter({ hasText: "Couldn't pin" });
    const counted = (await pin.count()) === 1 && (await pin.getByLabel("2 times").count()) === 1;
    await pin.getByRole("button", { name: "Copy error" }).click();
    await pin.getByRole("button", { name: "Copied" }).waitFor();
    const copied = await page.evaluate(() => window.__COPIED__);

    // Keyboard: Enter on Close, then Escape on the other card.
    await pin.getByRole("button", { name: "Close" }).focus();
    await page.keyboard.press("Enter");
    const afterClose = await alerts.count();
    await alerts.first().getByRole("button", { name: "Copy error" }).focus();
    await page.keyboard.press("Escape");
    const afterEscape = await alerts.count();

    failed += report(`error toast, ${colorScheme}`, {
      "a failed pin raises \"Something went wrong\" naming the conversation and the error": text.startsWith("Something went wrong") && text.includes(`Couldn't pin “Local long session”: ${CAUSE}`),
      "the error is set in monospace": /mono/i.test(mono) && mono !== bodyFont,
      "two different errors stack, the repeat is counted instead of copied": count === 2 && counted,
      "still on screen after 30 s": count === 2,
      "the toasts sit inside the window, do not overlap, and clip nothing": layout.inView && !layout.overlap && layout.contained,
      "Copy error copies the whole sentence and says it did": copied.at(-1) === `Couldn't pin “Local long session”: ${CAUSE}`,
      "closes from the keyboard, by its Close button and by Escape": afterClose === 1 && afterEscape === 0,
      "no browser errors": errors.length === 0,
    }, { text, mono, bodyFont, count, counted, layout, copied, afterClose, afterEscape, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
