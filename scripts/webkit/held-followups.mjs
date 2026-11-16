#!/usr/bin/env node
// PRO-380: held follow-ups, steering and a Codex goal (designs 03.12, 03.20, 03.21)
// in WebKit at 1440×900, light and dark. The held tray's rows are one line and
// all of them show with the edit card open; a mid-turn message is marked; the
// goal is a card with Pause and Edit; a bare /goal stays in a Codex composer;
// a /goal to Claude Code is refused with a Codex tab offered; a failed reorder
// and a failed resume are two titled toasts with Try again.
//
//   pnpm build && node scripts/webkit/held-followups.mjs
//   WEBKIT_LAYOUT_SCREENSHOTS=/some/dir to keep the captures.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launch, open, openConversation, serve, tab } from "./harness.mjs";

const extra = `(() => {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ followUps: "hold" }));
  const answers = window.__PW_STUB__.answers;
  const at = new Date().toISOString();
  const SESSION = "local-s1";
  const tab = (id, harness, title) => ({ id, harness, title, titlePinned: true, model: "", permissionMode: "default", status: "in_progress", created: at, modified: at });
  answers.list_harnesses = [{ id: "codex", name: "Codex", available: true }, { id: "claude", name: "Claude Code", available: true }];
  answers.list_sessions = [{ id: SESSION, projectPath: answers.list_sessions[0].projectPath, cwd: answers.list_sessions[0].cwd, worktreeRemoved: false, title: "Local long session", created: at, modified: at, archived: false, pinned: false,
    tabs: [tab("t-codex", "codex", "Session overview table"), tab("t-claude", "claude", "Review saved views")], activeTab: "t-codex" }];
  const queue = { items: [
    { id: "one", text: "Add a “Group by owner” option next to Group by status", images: [] },
    { id: "two", text: "Run the linter and fix what it finds before you finish", images: [] },
    { id: "three", text: "Update the screenshot in docs/overview.md", images: [{ url: "/overview-2.png", name: "overview-2.png" }] },
  ], paused: false, sending: null, next: null, error: null };
  let seq = 0;
  const event = (tabId, harness, payload) => ({ id: tabId + "-" + ++seq, seq, sessionId: SESSION, tabId, harness, ts: at, payload });
  const snapshot = tabId => event(tabId, "codex", { type: "held_queue", queue: JSON.parse(JSON.stringify(queue)) });
  answers.load_tab_events = ({ tabId }) => {
    if (tabId === "t-claude") return [
      event(tabId, "claude", { type: "user_message", text: "Review SavedViews.tsx for races with the org store.", queued: false }),
      event(tabId, "claude", { type: "turn_started" }),
      event(tabId, "claude", { type: "assistant_text", text: "Reading SavedViews.tsx and the org store now." }),
    ];
    const out = [
      event(tabId, "codex", { type: "user_message", text: "/goal Ship the overview table with sorting, grouping and saved views", queued: false }),
      event(tabId, "codex", { type: "turn_started" }),
      event(tabId, "codex", { type: "assistant_text", text: "Sorting and grouping are in and tested. Saved views next: they’re stored per user in the org store, so I’m adding a migration." }),
    ];
    const steer = event(tabId, "codex", { type: "user_message", text: "Keep the column widths from the old table, people have them memorised.", queued: true });
    out.push(steer, event(tabId, "codex", { type: "prompt_absorbed", promptSeq: steer.seq }));
    out.push(event(tabId, "codex", { type: "goal_updated", goal: { objective: "Ship the overview table with sorting, grouping and saved views", status: "active", tokenBudget: 500000, tokensUsed: 182000 } }));
    out.push(snapshot(tabId));
    return out;
  };
  window.__failing = new Set();
  window.__changes = [];
  answers.change_held_queue = ({ tabId, change }) => {
    window.__changes.push(change);
    const kind = change.type === "pause" ? (change.paused ? "pause" : "resume") : change.type;
    if (window.__failing.has(kind)) throw "Codex didn't answer within 10 seconds";
    switch (change.type) {
      case "pause": queue.paused = change.paused; break;
      case "edit": queue.items.find(item => item.id === change.id).text = change.text; break;
      case "delete": case "sendNow": queue.items = queue.items.filter(item => item.id !== change.id); break;
      case "enqueue": if (!change.sendNow) queue.items.push({ id: "new-" + seq, text: change.text, images: change.images }); break;
      case "move": {
        const item = queue.items.find(item => item.id === change.id);
        queue.items = queue.items.filter(item => item.id !== change.id);
        queue.items.splice(change.beforeId ? queue.items.findIndex(item => item.id === change.beforeId) : queue.items.length, 0, item); break;
      }
    }
    return { queued: true, events: [snapshot(tabId)] };
  };
  window.__sent = [];
  answers.send_message = ({ tabId, text }) => { window.__sent.push(text); return { queued: true, events: [] }; };
})();`;

/** Every box inside the viewport, and none of `boxes` overlapping another. */
async function laidOut(page, selectors) {
  return page.evaluate((selectors) => {
    const rects = selectors.map((selector) => {
      const el = [...document.querySelectorAll(selector)].find((node) => node.offsetParent !== null);
      if (!el) return { selector, missing: true };
      const r = el.getBoundingClientRect();
      return { selector, x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    });
    const missing = rects.filter((r) => r.missing);
    const outside = rects.filter((r) => !r.missing && (r.x < 0 || r.y < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1));
    return { missing, outside, horizontal: document.documentElement.scrollWidth - innerWidth };
  }, selectors);
}

const server = await serve();
const screenshots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
let browser;
try {
  browser = await launch({ headless: true });
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 }, { extra, colorScheme });
    await openConversation(page, "Local long session");
    await tab(page, "Session overview table").click();
    const tray = page.getByRole("region", { name: "Held follow-ups" }).filter({ visible: true });
    await tray.waitFor();

    // 03.12: the goal card, the steering note, the tray with its edit card open, the composer hint.
    const goal = page.getByRole("region", { name: "Codex goal" }).filter({ visible: true });
    assert.match(await goal.innerText(), /GOAL · PURSUING/i);
    assert.match(await goal.innerText(), /182K \/ 500K tokens/);
    await goal.getByRole("button", { name: "Pause" }).waitFor();
    await goal.getByRole("button", { name: "Edit" }).waitFor();
    assert.equal(await page.getByTestId("steered-note").filter({ visible: true }).first().innerText(), "Sent mid-turn · Codex reads it at its next tool call");
    assert.match(await tray.innerText(), /HELD UNTIL THE TURN ENDS · 3/i);
    const hint = page.getByTestId("follow-up-hint").filter({ visible: true });
    assert.match(await hint.innerText(), /holds it for after the turn · .* sends now and interrupts · change the default in Settings › Agents › Follow-ups/);
    const rowHeights = await tray.locator("li:not([aria-hidden])").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    assert.deepEqual(rowHeights.map((h) => h <= 37), [true, true, true], JSON.stringify(rowHeights));
    await tray.getByLabel("Edit follow-up 2", { exact: true }).click();
    await tray.getByText("Editing held message 2").waitFor();
    await tray.getByRole("button", { name: "Pause queue" }).waitFor();
    // Every row shows whole, the third row's attachment chip too: nothing scrolls inside the tray.
    const clip = await tray.evaluate((el) => {
      const list = el.querySelector("ol");
      const chip = [...el.querySelectorAll("span")].find((span) => span.textContent === "overview-2.png");
      const l = list.getBoundingClientRect();
      const c = chip.getBoundingClientRect();
      return { scroll: list.scrollHeight - list.clientHeight, chipInside: c.top >= l.top && c.bottom <= l.bottom + 1 };
    });
    assert.deepEqual(clip, { scroll: 0, chipInside: true });
    const layout = await laidOut(page, ['[data-held-tray]', '[data-composer-box]', 'section[aria-label="Codex goal"]', '[data-testid="follow-up-hint"]']);
    assert.deepEqual(layout, { missing: [], outside: [], horizontal: 0 }, JSON.stringify(layout));
    if (screenshots) await page.screenshot({ path: `${screenshots}/03.12-${colorScheme}.png` });
    await tray.getByLabel("Edit held follow-up").press("Escape");
    await tray.getByText("Editing held message 2").waitFor({ state: "detached" });

    // 03.21: a failed reorder and a failed resume, said apart, with Try again; the row that went back is marked.
    await page.evaluate(() => { window.__failing.add("move"); window.__failing.add("resume"); });
    await tray.getByLabel("Edit follow-up 3", { exact: true }).focus();
    await page.keyboard.press("Alt+ArrowUp");
    const reorder = page.locator("[data-error-toast]").filter({ hasText: "Couldn't reorder held messages" });
    await reorder.waitFor();
    assert.match(await reorder.innerText(), /“Update the screenshot in docs\/overview\.md” went back to 3rd/);
    await reorder.getByRole("button", { name: "Try again" }).waitFor();
    await tray.getByTestId("held-moved-back").waitFor();
    await tray.getByRole("button", { name: "Pause queue" }).click();
    await tray.getByTestId("held-paused").waitFor();
    await tray.getByRole("button", { name: "Resume" }).click();
    const resume = page.locator("[data-error-toast]").filter({ hasText: "Couldn't resume the held messages" });
    await resume.waitFor();
    assert.match(await resume.innerText(), /They're still paused and in the same order/);
    assert.match(await resume.innerText(), /Codex didn't answer within 10 seconds/);
    await resume.getByRole("button", { name: "Try again" }).waitFor();
    assert.equal(await reorder.count(), 1, "the reorder failure is still there");
    const toasts = await laidOut(page, ['[data-error-toast]', '[data-held-tray]', '[data-composer-box]']);
    assert.deepEqual(toasts, { missing: [], outside: [], horizontal: 0 }, JSON.stringify(toasts));
    await tray.getByTestId("held-moved-back").waitFor();
    // The toasts keep off the composer's box and the held tray over it.
    await page.waitForTimeout(600);
    const clear = await page.evaluate(() => {
      const boxes = ["[data-composer-box]", "[data-held-tray]"].map((selector) => [...document.querySelectorAll(selector)].find((node) => node.offsetParent !== null).getBoundingClientRect());
      return [...document.querySelectorAll("[data-error-toast]")].every((toast) => {
        const r = toast.getBoundingClientRect();
        return boxes.every((box) => r.bottom <= box.top || r.left >= box.right || r.right <= box.left || r.top >= box.bottom);
      });
    });
    assert.equal(clear, true, "error toasts overlap the composer or the held tray");
    if (screenshots) await page.screenshot({ path: `${screenshots}/03.21-${colorScheme}.png`, animations: "disabled" });
    await page.evaluate(() => window.__failing.clear());
    await resume.getByRole("button", { name: "Try again" }).click();
    await resume.waitFor({ state: "detached" });
    await reorder.getByRole("button", { name: "Try again" }).click();
    await reorder.waitFor({ state: "detached" });
    await tray.getByTestId("held-moved-back").waitFor({ state: "detached" });

    // A narrow window: the tray and its rows stay inside it, nothing scrolls sideways.
    await page.setViewportSize({ width: 760, height: 900 });
    const narrow = await tray.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { inside: r.x >= 0 && r.right <= innerWidth + 1, overflow: el.scrollWidth - el.clientWidth,
        buttons: [...el.querySelectorAll("button")].every((button) => { const b = button.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right + 1; }) };
    });
    assert.deepEqual(narrow, { inside: true, overflow: 0, buttons: true }, JSON.stringify(narrow));
    await page.setViewportSize({ width: 1440, height: 900 });
    await tray.getByLabel("Delete follow-up 1", { exact: true }).click();
    await tray.getByText("Held until the turn ends · 2").waitFor();
    // ⌘↵ in the composer sends the other way: now, interrupting the turn.
    const followUp = page.locator("textarea[data-composer]:visible");
    await followUp.fill("Send this immediately.");
    await followUp.press("Meta+Enter");
    await page.waitForFunction(() => window.__changes.some((change) => change.type === "enqueue" && change.sendNow === true));

    // 03.20: a bare /goal stays in the Codex composer; a /goal to Claude Code is refused with a Codex tab offered.
    const composer = page.locator("textarea[data-composer]:visible");
    await composer.fill("/goal");
    await composer.press("Enter");
    await page.getByTestId("goal-missing").filter({ visible: true }).waitFor();
    assert.equal(await composer.inputValue(), "/goal");
    assert.equal(await composer.getAttribute("aria-invalid"), "true");
    assert.notEqual(await page.locator("[data-composer-box]:visible").evaluate((el) => getComputedStyle(el).outlineStyle), "none");
    if (screenshots) await page.screenshot({ path: `${screenshots}/03.20-codex-${colorScheme}.png`, animations: "disabled" });
    // The goal card's Edit does not throw away a half-written message: it asks first.
    await composer.fill("Also check the empty state");
    await page.getByRole("region", { name: "Codex goal" }).filter({ visible: true }).getByRole("button", { name: "Edit" }).click();
    const replace = page.locator("[data-error-toast]").filter({ hasText: "Replace your draft with the goal?" });
    await replace.waitFor();
    assert.equal(await composer.inputValue(), "Also check the empty state");
    await replace.getByRole("button", { name: "Replace the draft" }).click();
    await replace.waitFor({ state: "detached" });
    assert.equal(await composer.inputValue(), "/goal Ship the overview table with sorting, grouping and saved views");
    await composer.fill("");
    await tab(page, "Review saved views").click();
    const claude = page.locator("textarea[data-composer]:visible");
    await claude.fill("/goal Keep the overview tests green while you refactor");
    await claude.press("Enter");
    const only = page.locator("[data-error-toast]").filter({ hasText: "Goals work in Codex chats only" });
    await only.waitFor();
    assert.match(await only.innerText(), /“Review saved views” runs Claude Code, which has no goals\. Your text is still in the composer\./);
    await only.getByRole("button", { name: "Open a Codex tab" }).waitFor();
    assert.equal(await claude.inputValue(), "/goal Keep the overview tests green while you refactor");
    assert.deepEqual(await page.evaluate(() => window.__sent), []);
    if (screenshots) await page.screenshot({ path: `${screenshots}/03.20-claude-${colorScheme}.png`, animations: "disabled" });
    await page.close();
  }
  console.log("Held follow-ups (PRO-380): goal card, steering note, one-line tray with edit card, failure toasts, /goal checks passed in dark and light at 1440×900.");
} finally { await browser?.close(); server.close(); }
