#!/usr/bin/env node
// PRO-246: real xterm search/decorations, keyboard routing and DOM reparenting.
// PRO-402: at 1440 wide, in dark and in light, the find bar card, the header row
// and every control sit clear of the first output row; Add to chat is a pill
// under the selection. A capture for each theme goes to TERMINAL_SEARCH_SHOTS
// (default: a terminalx-webkit-terminal folder in the system temp directory).
// pnpm build && pnpm test:webkit-terminal-search (headless WebKit)
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, open, openConversation, serve } from "./harness.mjs";

const shots = process.env.TERMINAL_SEARCH_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

function setup() {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: true, panelTerminalOpen: true, tabStrip: true }));
  const { answers, emit } = window.__PW_STUB__;
  const session = answers.list_sessions[0];
  session.tabs.forEach((tab) => { tab.status = "in_progress"; });
  const shell = { id: `${session.id}:dock-search`, sessionId: session.id, title: "Search shell", cwd: session.cwd, exited: false, docked: true, created: new Date().toISOString() };
  const checks = window.__TERMINAL_CHECKS__ = { attached: 0, spawned: 0, killed: 0, interrupted: 0, inputs: [] };
  Object.assign(answers, {
    load_tab_events: [], tab_pane: null, ensure_tab_started: null, browser_pages: [], set_active_tab: null,
    pty_shells: [shell], pane_agents: [], pty_detach_all: null, pty_detach: null, pty_ack: null,
    pty_resize: ({ cols, rows }) => { window.__TERMINAL_SIZE__ = { cols, rows }; },
    interrupt_turn: () => { checks.interrupted++; return true; },
    pty_write: ({ data }) => { checks.inputs.push(data); },
    pty_spawn: () => { checks.spawned++; },
    pty_kill: () => { checks.killed++; },
    pty_set_docked: ({ docked }) => { shell.docked = docked; emit("pty_renamed", { ...shell }); return { ...shell }; },
    pty_attach_sized: ({ id, channel }) => {
      if (id !== shell.id) return;
      checks.attached++;
      const text = ["needle first", ...Array.from({ length: 180 }, (_, i) => `scrollback line ${i}`), "NEEDLE upper", "needle last", "select this output"].join("\r\n");
      window.__TERMINAL_OUTPUT__ = (text) => {
        const bytes = new TextEncoder().encode(text);
        const frame = new Uint8Array(bytes.length + 4);
        frame.set(bytes, 4);
        channel.onmessage(frame.buffer);
      };
      window.__TERMINAL_OUTPUT__(text);
    },
  });
}


/**
 * Controls in a terminal view that sit on its first output row. Every button,
 * field, keycap, bar and row the view draws outside xterm itself counts; the
 * Add to chat pill is placed on purpose by the selection and is checked apart.
 */
function overFirstRow(screenEl) {
  const frame = screenEl.closest('[data-testid="terminal-drop-target"]');
  const s = screenEl.getBoundingClientRect();
  const rows = window.__TERMINAL_SIZE__?.rows || 24;
  const row = { top: s.top, bottom: s.top + s.height / rows, left: s.left, right: s.right };
  const controls = frame.querySelectorAll('button, input, kbd, [role="search"], [role="status"], [role="alert"], [data-testid="terminal-header"], [data-testid="terminal-find-row"]');
  return [...controls].filter((el) => {
    if (el.closest(".xterm") || el.closest('[data-testid="terminal-add-to-chat"]')) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden" || getComputedStyle(el).opacity === "0") return false;
    return r.top < row.bottom && r.bottom > row.top && r.left < row.right && r.right > row.left;
  }).map((el) => `${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.getAttribute("data-testid") ?? el.textContent?.trim().slice(0, 30)}`);
}

async function check(browser, url, colorScheme) {
  const page = await open(browser, url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 }, { extra: `(${setup.toString()})()`, colorScheme });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  const mod = mac ? "Meta" : "Control";
  const keys = mac ? { matchCase: "⌥⌘C", addToChat: "⇧⌘L", clear: "⌘K" } : { matchCase: "Ctrl+Alt+C", addToChat: "Ctrl+Shift+L", clear: "Ctrl+K" };
  await openConversation(page, "Local long session");
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-mode")), colorScheme, `the app follows the ${colorScheme} appearance`);
  const dock = page.getByTestId("panel-terminal");
  await dock.locator(".xterm-screen").waitFor();
  await page.waitForFunction(() => window.__TERMINAL_SIZE__);
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  assert.equal(await dock.locator('[aria-label="Search terminal"]').count(), 0, "no Search control is drawn over terminal text");
  await dock.locator(".xterm-screen").hover();
  assert.deepEqual(await dock.locator(".xterm-screen").evaluate(overFirstRow), [], "hovering the terminal reveals nothing over its first row");
  await dock.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press(`${mod}+f`);
  const search = page.getByRole("search", { name: "Find in terminal" });
  const input = search.getByRole("textbox", { name: "Find in terminal" });
  await input.fill("needle");
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent?.endsWith("of 3"));
  assert(await input.evaluate((el) => document.activeElement === el), "find owns focus");
  assert.deepEqual(await search.getByRole("listitem").allTextContents(), ["↵ next", "⇧↵ previous", `${keys.matchCase} match case`, "esc closes"], "the keys hint row");
  for (const [name, text] of [["Match case", "Aa"], ["Match whole word", "ab"], ["Use regular expression", ".*"]]) {
    assert.equal(await search.getByRole("button", { name, exact: true }).textContent(), text, `${name} toggle`);
  }
  // The dock is narrower than the card: it takes the dock's width, and still its own room.
  assert.deepEqual(await dock.locator(".xterm-screen").evaluate(overFirstRow), [], "the open find bar is clear of the dock's first output row");
  // Opening the bar takes rows from the dock's terminal, and xterm keeps the
  // bottom of a shrunk grid; addon-search recomputes 200 ms after a resize.
  // Once that settles, an explicit step brings a match back into view.
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await dock.locator(".xterm-find-result-decoration:visible").first().waitFor();
  assert(await dock.locator(".xterm-decoration").count() > 0, "matches have visible decorations");
  const first = await search.getByRole("status").textContent();
  for (let i = 0; i < 3; i++) await search.getByRole("button", { name: "Next match", exact: true }).click();
  assert.equal(await search.getByRole("status").textContent(), first, "next wraps through scrollback");
  await search.getByRole("button", { name: "Previous match", exact: true }).click();
  assert.notEqual(await search.getByRole("status").textContent(), first, "previous moves backwards");
  await input.focus();
  await page.keyboard.press("Enter");
  assert.equal(await search.getByRole("status").textContent(), first, "Enter advances");
  await page.keyboard.press("Shift+Enter");
  assert.notEqual(await search.getByRole("status").textContent(), first, "Shift+Enter goes backwards");
  await page.keyboard.press(`${mod}+Alt+c`);
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent?.endsWith("of 2"));
  assert.equal(await search.getByRole("button", { name: "Match case", exact: true }).getAttribute("aria-pressed"), "true", `${keys.matchCase} toggles match case`);
  assert(await input.evaluate((el) => document.activeElement === el), "the match case key leaves the focus in the field");
  await input.fill("needl");
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent?.endsWith("of 2"));
  await search.getByRole("button", { name: "Match whole word", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent === "No matches");
  await search.getByRole("button", { name: "Match whole word", exact: true }).click();
  await input.fill("need.e (first|last)");
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent === "No matches");
  await search.getByRole("button", { name: "Use regular expression", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent?.endsWith("of 2"));
  await search.getByRole("button", { name: "Use regular expression", exact: true }).click();
  await search.getByRole("button", { name: "Match case", exact: true }).click();

  // There is one match, so its rendered rectangles identify it without an
  // active-decoration class (which this addon version does not add).
  await input.fill("needle last");
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent === "1 of 1");
  await page.waitForTimeout(300);
  const renderedMatchInView = (screen) => {
    const box = screen.getBoundingClientRect();
    return [...screen.closest(".xterm").querySelectorAll(".xterm-find-result-decoration")].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > box.top && r.top < box.bottom;
    });
  };
  const screen = await dock.locator(".xterm-screen").elementHandle();
  const matchInView = () => screen.evaluate(renderedMatchInView);
  assert.equal(await matchInView(), true, "explicit search shows its unique match");
  await dock.locator(".xterm-screen").hover();
  await page.mouse.wheel(0, -10000);
  await page.waitForTimeout(300);
  assert.equal(await matchInView(), false, "the user can scroll away from the selected match");
  await page.evaluate(() => window.__TERMINAL_OUTPUT__("\r\nunrelated live output\r\n"));
  // addon-search recomputes 200 ms after parsed output. Observe its settled viewport.
  await page.waitForTimeout(500);
  assert.equal(await matchInView(), false, "unrelated output preserves the user's viewport");
  await search.getByRole("button", { name: "Next match", exact: true }).click();
  // xterm renders decorations on an animation frame after scrolling.
  await page.waitForFunction(renderedMatchInView, screen);
  assert.equal(await matchInView(), true, "explicit navigation can return to the selected match");

  await input.fill("absent match");
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent === "No matches");
  assert.equal(await search.getByRole("status").textContent(), "No matches");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => window.__TERMINAL_CHECKS__.interrupted), 0, "closing terminal search must not interrupt the running agent");
  await search.waitFor({ state: "detached" });
  assert(await dock.locator(".xterm-helper-textarea").evaluate((el) => document.activeElement === el), "Escape restores terminal focus");
  assert.equal(await dock.locator(".xterm-decoration").count(), 0, "closing clears highlights");
  assert.equal(await page.getByRole("button", { name: "Add to chat", exact: true }).count(), 0, "search results do not masquerade as a user selection");

  await dock.locator(".xterm").evaluate((el) => { window.__MOVED_XTERM__ = el; });
  await dock.getByRole("button", { name: "Move to tab" }).click();
  const full = page.getByRole("tabpanel").filter({ has: page.getByRole("button", { name: "Move to dock" }) });
  await full.waitFor();
  assert(await full.locator(".xterm").evaluate((el) => el === window.__MOVED_XTERM__), "same xterm moved to tab");
  // The tab's header row: the shell's icon, name and folder, Move to dock and Clear, above the output.
  const header = full.getByTestId("terminal-header");
  assert(await header.locator('[data-testid="terminal-title"] svg').count() === 1, "the header has the shell's icon");
  assert.match(await header.getByTestId("terminal-title").textContent(), /^Search shell.*\//, "the header names the shell and its folder");
  assert.equal(await header.getByRole("button", { name: "Move to dock" }).count(), 1, "Move to dock is in the header");
  assert.equal((await header.getByRole("button", { name: /^Clear/ }).textContent()).replace(/\s+/g, " ").trim(), `Clear ${keys.clear}`, "Clear shows its keys");
  await page.mouse.move(0, 0);
  assert.deepEqual(await full.locator(".xterm-screen").evaluate(overFirstRow), [], "the header row is clear of the first output row");
  await full.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press(`${mod}+f`);
  await input.fill("needle first");
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent === "1 of 1");
  const card = await search.evaluate((bar) => {
    const r = bar.getBoundingClientRect(), f = bar.closest('[data-testid="terminal-drop-target"]').getBoundingClientRect();
    const screen = bar.closest('[data-testid="terminal-drop-target"]').querySelector(".xterm-screen").getBoundingClientRect();
    return { width: r.width, rightGap: f.right - r.right, topGap: r.top - f.top, bottom: r.bottom, screenTop: screen.top };
  });
  assert(card.width >= 465 && card.width <= 485, `the find bar is a card about 475px wide (${card.width})`);
  assert(card.rightGap >= 0 && card.rightGap <= 16, `the card sits at the right (${card.rightGap})`);
  assert(card.bottom <= card.screenTop, `the card ends above the output (${card.bottom} > ${card.screenTop})`);
  // Every row is on screen: focusing the field scrolled nothing out of view.
  const hidden = await full.evaluate((panel) => {
    const frame = panel.querySelector('[data-testid="terminal-drop-target"]');
    const scrolled = [];
    for (let el = frame; el && el !== document.body; el = el.parentElement) if (el.scrollTop) scrolled.push(`${el.tagName} ${el.className.toString().slice(0, 40)} ${el.scrollTop}`);
    const missing = ['[data-testid="terminal-header"]', '[role="search"]'].filter((selector) => {
      const r = frame.querySelector(selector).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 4);
      return !hit || !frame.querySelector(selector).contains(hit);
    });
    return { scrolled, missing };
  });
  assert.deepEqual(hidden, { scrolled: [], missing: [] }, "the header and the find bar are on screen, nothing scrolled under the tab strip");
  await full.locator(".xterm-screen").hover();
  assert.deepEqual(await full.locator(".xterm-screen").evaluate(overFirstRow), [], "header and find bar are clear of the first output row, under the pointer too");
  if (shots) {
    const findShot = join(shots, `terminal-find-${colorScheme}.png`);
    await page.screenshot({ path: findShot, animations: "disabled" });
    console.log(`capture ${findShot}`);
  }
  await page.keyboard.press("Escape");
  // Moving into a closed panel must acquire the new host without recreating xterm.
  await page.getByRole("button", { name: "Toggle panel", exact: true }).click();
  await dock.waitFor({ state: "detached" });
  // The header's controls are ordinary buttons in the tab order.
  await full.getByRole("button", { name: "Move to dock" }).focus();
  assert(await full.getByRole("button", { name: "Move to dock" }).evaluate((el) => document.activeElement === el), "the header exposes Move to dock to keyboard navigation");
  await page.keyboard.press("Enter");
  await dock.locator(".xterm").waitFor();
  assert(await dock.locator(".xterm").evaluate((el) => el === window.__MOVED_XTERM__), "same xterm moved back to dock");
  assert.deepEqual(await page.evaluate(() => window.__TERMINAL_CHECKS__), { attached: 1, spawned: 0, killed: 0, interrupted: 0, inputs: [] }, "moves never restart or reattach the PTY; search keys do not reach it");

  // A selection made with the pointer: the pill sits under its last line, inside the frame.
  await page.waitForTimeout(200);
  const grid = await dock.locator(".xterm-screen").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, row: r.height / window.__TERMINAL_SIZE__.rows, col: r.width / window.__TERMINAL_SIZE__.cols };
  });
  await page.mouse.move(grid.left + grid.col * 2.5, grid.top + grid.row * 2.5);
  await page.mouse.down();
  await page.mouse.move(grid.left + grid.col * 14.5, grid.top + grid.row * 4.5, { steps: 6 });
  await page.mouse.up();
  const pill = dock.getByTestId("terminal-add-to-chat");
  await pill.getByRole("button", { name: "Add to chat", exact: true }).waitFor();
  await page.waitForTimeout(100);
  const placed = await pill.evaluate((el) => {
    const r = el.getBoundingClientRect(), f = el.closest('[data-testid="terminal-drop-target"]').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, frame: { top: f.top, bottom: f.bottom, left: f.left, right: f.right } };
  });
  const lastLineBottom = grid.top + grid.row * 5;
  assert(placed.top >= lastLineBottom - 1 && placed.top <= lastLineBottom + grid.row, `the pill is under the selection's last line (${placed.top} vs ${lastLineBottom})`);
  assert(placed.left >= placed.frame.left && placed.right <= placed.frame.right && placed.top >= placed.frame.top && placed.bottom <= placed.frame.bottom, "the pill stays inside the frame");
  assert.equal(await pill.locator("button svg").count(), 1, "the pill has the chat icon");
  assert.equal(await pill.locator("button kbd").textContent(), keys.addToChat, "the pill shows its keys");
  if (shots) {
    const pillShot = join(shots, `terminal-add-to-chat-${colorScheme}.png`);
    await page.screenshot({ path: pillShot, animations: "disabled" });
    console.log(`capture ${pillShot}`);
  }

  await dock.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+Shift+l`);
  await page.getByText("Added to chat draft", { exact: true }).waitFor();
  assert(await page.locator('textarea:not(.xterm-helper-textarea)').evaluateAll((fields) => fields.some((field) => field.value.startsWith("```text\n") && field.value.includes("needle first") && field.value.includes("needle last"))), `${keys.addToChat} sends the selected output to the active agent draft`);

  // ⌘K in the terminal clears it (the command palette keeps the key elsewhere).
  await dock.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press(`${mod}+k`);
  assert.equal(await page.getByRole("dialog").count(), 0, "the terminal's Clear key does not open the command palette");
  await page.keyboard.press(`${mod}+f`);
  await input.fill("needle");
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent === "No matches");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await page.close();
}

const server = await serve();
const browser = await launch();
try {
  for (const colorScheme of shots ? ["dark", "light"] : ["dark"]) {
    await check(browser, server.url, colorScheme);
    console.log(`ok terminal search (${colorScheme}, 1440 wide): find card with Aa/ab/.* and keys row, header row, nothing over the first output row, Add to chat pill under the selection, Clear, and retained xterm across dock/tab moves`);
  }
} finally {
  await browser.close();
  server.close();
}
