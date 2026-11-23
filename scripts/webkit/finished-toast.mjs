#!/usr/bin/env node
// #1499 in WebKit: an "agent finished" notice for another session shows top right, under the tabs, and
// covers neither the composer (nor its Send) nor the last turn's footer of the session being read, at
// the common window widths. The settings' "can't save" alert joins the same column.
//   pnpm build && node scripts/webkit/finished-toast.mjs
//   WEBKIT_LAYOUT_SCREENSHOTS=/path/to/shots node scripts/webkit/finished-toast.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launch, open, openConversation, serve } from "./harness.mjs";

// The session being read: two finished turns, so the last one's footer sits just above the composer. The other
// session's turn is the one that ends.
const fixture = `
  const backend = window.__PW_STUB__;
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const tab = (id, title, status) => ({ id, harness: "claude", title, model: "claude-opus-5-5", permissionMode: "default", status, created: at(30), modified: at(1) });
  const session = (id, title, t) => ({ id, projectPath: "/repos/p0", cwd: "/repos/p0", branch: id, worktreeRemoved: false, title, created: at(30), modified: at(1), archived: false, pinned: false, activeTab: t.id, tabs: [t] });
  backend.answers.list_sessions = [session("ft-read", "Fix duplicate permission cards", tab("ft-read-t", "Fix duplicate permission cards", "completed")), session("ft-other", "Tidy the release notes", tab("ft-other-t", "Tidy the release notes", "idle"))];
  backend.answers.list_harnesses = [{ id: "claude", name: "Claude Code", available: true }];
  let seq = 0;
  const event = (tabId, minutesAgo, payload, extra = {}) => ({ id: "e" + (++seq), seq, sessionId: "ft-read", tabId, harness: "claude", ts: at(minutesAgo), payload, ...extra });
  const usage = { inputTokens: 66, outputTokens: 1058, cacheReadTokens: 96065, cacheWriteTokens: 36895, costUsd: 0.38, model: "claude-opus-5-5", effort: "high", fast: false, contextUsed: 312000, contextMax: 1000000 };
  backend.answers.load_tab_events = ({ tabId }) => tabId !== "ft-read-t" ? [] : [
    event(tabId, 12, { type: "user_message", text: "Permission cards show up twice. Dedupe them by tool_use_id and add a regression test.", queued: false }, { messageTs: at(12) }),
    event(tabId, 12, { type: "turn_started" }),
    event(tabId, 11, { type: "assistant_text", text: "Done. Permission cards are now keyed by tool_use_id, so the hook frame and the transcript line collapse into one card." }, { messageTs: at(11) }),
    event(tabId, 11, { type: "turn_completed", status: "ok", durationMs: 72000, usage, authFailed: false }),
    event(tabId, 3, { type: "user_message", text: "Commit it and open a PR.", queued: false }, { messageTs: at(3) }),
    event(tabId, 3, { type: "turn_started" }),
    event(tabId, 2, { type: "assistant_text", text: "Committed and opened a PR against main with the Summary, Test plan and Risk sections filled in." }, { messageTs: at(2) }),
    event(tabId, 2, { type: "turn_completed", status: "ok", durationMs: 38000, usage, authFailed: false }),
  ];
`;
const painted = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const shots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });

const server = await serve();
let browser;
try {
  browser = await launch();
  for (const width of [1280, 1440, 1728]) {
    for (const colorScheme of ["dark", "light"]) {
      const label = `${width}px ${colorScheme}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width, height: 900 }, { extra: fixture, colorScheme });
      page.setDefaultTimeout(10_000);
      await openConversation(page, "Fix duplicate permission cards");
      await page.getByTestId("turn-footer").first().waitFor();
      const composer = page.locator('[role="tabpanel"]:not([aria-hidden="true"]) [data-composer-box]');
      await composer.waitFor();
      // Another session's turn ends while the reader is here.
      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        window.__PW_STUB__.emit("tab_status", { sessionId: "ft-other", tabId: "ft-other-t", status: "in_progress" });
      });
      // The turn is seen running before it ends: "finished" is said of a turn that was in progress.
      await painted(page);
      await page.evaluate(() => window.__PW_STUB__.emit("tab_status", { sessionId: "ft-other", tabId: "ft-other-t", status: "completed" }));
      const notice = page.locator('[data-notice-column] [role="status"]').filter({ hasText: /finished/ });
      await notice.first().waitFor();
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
      await painted(page);
      const layout = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const apart = (a, b) => a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
        const card = box([...document.querySelectorAll('[data-notice-column] [role="status"]')].find((el) => /finished/.test(el.textContent)));
        const panel = document.querySelector('[role="tabpanel"]:not([aria-hidden="true"])');
        const composer = box(panel.querySelector("[data-composer-box]"));
        const footers = [...panel.querySelectorAll('[data-testid="turn-footer"]')].map(box).filter((r) => r.width > 0 && r.bottom > 0 && r.top < innerHeight);
        return {
          card: card.toJSON(),
          composer: composer.toJSON(),
          inside: card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight,
          offComposer: apart(card, composer),
          // The column the toast is in stops above the composer, however many notices it holds.
          columnAbove: box(document.querySelector('[data-notice-column="top"]')).bottom <= composer.top,
          offFooter: !footers.length || apart(card, footers.at(-1)),
          upTop: card.bottom < composer.top && card.top < innerHeight / 2,
          belowTabs: card.top >= 38,
          footers: footers.length,
        };
      });
      if (shots) await page.screenshot({ path: `${shots}/finished-toast-${width}-${colorScheme}.png` });
      assert.ok(layout.inside, `${label}: notice inside the window ${JSON.stringify(layout)}`);
      assert.ok(layout.offComposer, `${label}: notice clear of the composer ${JSON.stringify(layout)}`);
      assert.ok(layout.columnAbove, `${label}: the notice column stops above the composer ${JSON.stringify(layout)}`);
      assert.ok(layout.offFooter, `${label}: notice clear of the last turn's footer ${JSON.stringify(layout)}`);
      assert.ok(layout.upTop && layout.belowTabs, `${label}: notice top right, under the title bar ${JSON.stringify(layout)}`);
      console.log(`ok ${label}: finished notice at ${Math.round(layout.card.left)},${Math.round(layout.card.top)}, clear of the composer and the last turn's footer (${layout.footers} footers on screen)`);
      await page.close();
    }
  }
} finally {
  await browser?.close();
  server.close();
}
