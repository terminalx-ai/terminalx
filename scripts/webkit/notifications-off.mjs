#!/usr/bin/env node
// pnpm build && node scripts/webkit/notifications-off.mjs
// PRO-327 in WebKit: "Notifications are off for TerminalX" when a session needs
// the reader and macOS blocks the app's banners, and the microphone row above
// the composer. Both fit the window, cover nothing they should not (the
// composer, its send button, the session's header, a toast) and go away the
// way they say.
import assert from "node:assert/strict";
import { launch, open, openConversation, serve, sidebar } from "./harness.mjs";

const extra = `
  const stub = window.__PW_STUB__;
  window.__NOTIFICATIONS__ = "denied";
  window.__OPENED__ = [];
  stub.answers.notification_permission = () => window.__NOTIFICATIONS__;
  stub.answers["plugin:app|identifier"] = "com.terminalx.next";
  stub.answers["plugin:opener|open_url"] = ({ url }) => { window.__OPENED__.push(url); };
  stub.answers.dictation_start = () => {
    setTimeout(() => stub.emit("dictation", { kind: "error", settings: "microphone", message: "Dictation needs it. Turn TerminalX on in System Settings › Privacy & Security › Microphone, then press the dictation shortcut again." }), 0);
  };
`;
/** The in-app notices in the bottom-right stack. */
const toast = '[data-app-shell] > .fixed.bottom-8 [role="status"]';
const painted = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
/** A tab of `sessionId` starts waiting for the reader. */
const waits = (page, sessionId, tabId) => page.evaluate(({ sessionId, tabId }) => {
  window.__PW_STUB__.emit("tab_status", { sessionId, tabId, status: "in_progress" });
  window.__PW_STUB__.emit("tab_status", { sessionId, tabId, status: "waiting" });
}, { sessionId, tabId });
const refocus = (page) => page.evaluate(() => {
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
});

/** Inside the window, on top where it is drawn, and clear of every box named in `others`. */
async function placed(page, selector, others) {
  return page.evaluate(({ selector, others }) => {
    // "text:A|B" names buttons by what they say.
    const find = (s) => s.startsWith("text:") ? [...document.querySelectorAll("button")].filter((b) => s.slice(5).split("|").includes(b.textContent.trim())) : [...document.querySelectorAll(s)];
    const visible = (s) => find(s).filter((el) => el.getBoundingClientRect().width > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
    const el = visible(selector)[0];
    const r = el.getBoundingClientRect();
    const points = [0.1, 0.5, 0.9].flatMap((x) => [0.15, 0.5, 0.85].map((y) => [r.left + r.width * x, r.top + r.height * y]));
    const apart = (b) => b.bottom <= r.top + 1 || b.top >= r.bottom - 1 || b.right <= r.left + 1 || b.left >= r.right - 1;
    const overlaps = Object.entries(others).flatMap(([name, s]) => visible(s).filter((other) => other !== el && !el.contains(other) && !other.contains(el) && !apart(other.getBoundingClientRect())).map(() => name));
    const buttons = [...el.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
    return {
      box: r.toJSON(),
      contained: r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      onTop: points.every(([x, y]) => el.contains(document.elementFromPoint(x, y))),
      buttonsInside: buttons.every((b) => b.width > 0 && b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1),
      textFits: [...el.querySelectorAll("div")].every((d) => d.scrollWidth <= d.clientWidth + 1),
      overlaps,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  }, { selector, others });
}

const server = await serve();
let browser;
try {
  browser = await launch();
  for (const colorScheme of ["light", "dark"]) {
    for (const [width, height, zoom] of [[1100, 800, 1], [760, 600, 1], [640, 480, 1], [760, 600, 1.5]]) {
      const where = `${colorScheme} ${width}x${height} zoom ${zoom}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, localSessions: 1 }, { width, height }, { extra, colorScheme });
      page.setDefaultTimeout(10_000);
      await sidebar(page);
      await page.evaluate((zoom) => { document.documentElement.style.zoom = String(zoom); }, zoom);
      await openConversation(page, "Local long session");
      await page.locator("[data-composer-box]:visible").waitFor();
      await page.evaluate(() => document.fonts.ready);

      // The session on screen needs the reader, then another one does too: the card names the latest. (Its toast
      // waits while the approval on screen is open, so the toast check below holds only for whatever is there.)
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await waits(page, "local-s1", "lt-chat");
      await waits(page, "many-s0", "many-s0-t");
      const card = page.locator("[data-notifications-off]");
      await card.waitFor();
      await painted(page);
      assert.match(await card.innerText(), /Notifications are off for TerminalX/);
      assert.match(await card.innerText(), /“Chat 0” needs your approval, but macOS blocks TerminalX banners and the dock badge\./);
      const others = {
        composer: "[data-composer-box]",
        "send button": '[data-composer-box] button[aria-label="Send"]',
        toast,
        "approval buttons": "text:Allow|Deny",
        "stop session": "text:Stop session",
        tabs: '[role="tablist"]',
      };
      const geometry = await placed(page, "[data-notifications-off]", others);
      // At 760x600 zoom 1.5 (about 500x400 of layout) no floating notice fits beside the approval: the card may cover
      // its "Stop session", never Allow, Deny, the composer or its send button, and it has Not now and close.
      const tight = width / zoom < 600;
      const blocking = geometry.overlaps.filter((name) => !(tight && name === "stop session"));
      assert.ok(geometry.contained && geometry.onTop && geometry.buttonsInside && geometry.textFits && blocking.length === 0 && !geometry.overflow, `card ${where}: ${JSON.stringify(geometry)}`);
      console.log(`ok ${where}: notifications card fits, on top, clear of composer, send, Allow/Deny, tabs and toasts${geometry.overlaps.length ? ` (covers ${geometry.overlaps.join(", ")} in this tight window)` : ""}`);

      // Open System Settings: the app's own Notifications page; the card stays until they are allowed.
      await card.getByRole("button", { name: "Open System Settings" }).click();
      await page.waitForFunction(() => window.__OPENED__.length > 0);
      assert.deepEqual(await page.evaluate(() => window.__OPENED__), ["x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.terminalx.next"]);
      assert.ok(await card.isVisible());

      // Still off when the reader comes back: it stays. Allowed: it goes.
      await refocus(page);
      await painted(page);
      assert.ok(await card.isVisible(), `card stays while still off ${where}`);
      await page.evaluate(() => { window.__NOTIFICATIONS__ = "granted"; });
      await refocus(page);
      await card.waitFor({ state: "detached" });
      console.log(`ok ${where}: card opens the Notifications page and goes once they are allowed`);

      // Off again, "Not now": nothing more for this run.
      await page.evaluate(() => { window.__NOTIFICATIONS__ = "denied"; });
      await waits(page, "local-s1", "lt-chat");
      await card.waitFor();
      await card.getByRole("button", { name: "Not now" }).click();
      await card.waitFor({ state: "detached" });
      await waits(page, "local-s1", "lt-chat");
      await painted(page);
      await page.waitForTimeout(50);
      assert.equal(await card.count(), 0, `"Not now" holds for the run ${where}`);
      console.log(`ok ${where}: "Not now" holds for the run`);

      // The microphone row above the composer.
      await page.getByRole("button", { name: "Dictate" }).filter({ visible: true }).first().click();
      const mic = page.locator("[data-dictation-error]").filter({ visible: true });
      await mic.waitFor();
      await painted(page);
      const text = await mic.innerText();
      assert.match(text, /Microphone access is off for TerminalX/);
      assert.match(text, /Dictation needs it\. Turn TerminalX on in System Settings › Privacy & Security › Microphone, then press ⌘⇧D again\./);
      const row = await placed(page, "[data-dictation-error]", { composer: "[data-composer-box]" });
      assert.ok(row.contained && row.onTop && row.buttonsInside && row.textFits && row.overlaps.length === 0 && !row.overflow, `microphone row ${where}: ${JSON.stringify(row)}`);
      await mic.getByRole("button", { name: "Open System Settings" }).click();
      await page.waitForFunction(() => window.__OPENED__.includes("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"));
      await mic.getByRole("button", { name: "Dismiss" }).click();
      await mic.waitFor({ state: "detached" });
      console.log(`ok ${where}: microphone row fits above the composer, opens its privacy pane, dismisses`);
      await page.close();
    }
  }
} finally {
  await browser?.close();
  server.close();
}
