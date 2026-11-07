#!/usr/bin/env node
// PRO-246: real xterm search/decorations, keyboard routing and DOM reparenting.
// pnpm build && pnpm test:webkit-terminal-search (headless WebKit)
import assert from "node:assert/strict";
import { launch, open, openConversation, serve } from "./harness.mjs";

function setup() {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: true, panelTerminalOpen: true, tabStrip: true }));
  const { answers, emit } = window.__PW_STUB__;
  const session = answers.list_sessions[0];
  session.tabs.forEach((tab) => { tab.status = "idle"; });
  const shell = { id: `${session.id}:dock-search`, sessionId: session.id, title: "Search shell", cwd: session.cwd, exited: false, docked: true, created: new Date().toISOString() };
  const checks = window.__TERMINAL_CHECKS__ = { attached: 0, spawned: 0, killed: 0, inputs: [] };
  Object.assign(answers, {
    load_tab_events: [], tab_pane: null, ensure_tab_started: null, browser_pages: [], set_active_tab: null,
    pty_shells: [shell], pane_agents: [], pty_detach_all: null, pty_detach: null, pty_ack: null, pty_resize: null,
    pty_write: ({ data }) => { checks.inputs.push(data); },
    pty_spawn: () => { checks.spawned++; },
    pty_kill: () => { checks.killed++; },
    pty_set_docked: ({ docked }) => { shell.docked = docked; emit("pty_renamed", { ...shell }); return { ...shell }; },
    pty_attach_sized: ({ id, channel }) => {
      if (id !== shell.id) return;
      checks.attached++;
      const text = ["needle first", ...Array.from({ length: 180 }, (_, i) => `scrollback line ${i}`), "NEEDLE upper", "needle last", "select this output"].join("\r\n");
      const bytes = new TextEncoder().encode(text);
      const frame = new Uint8Array(bytes.length + 4);
      frame.set(bytes, 4);
      channel.onmessage(frame.buffer);
    },
  });
}

const server = await serve();
const browser = await launch();
try {
  const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1400, height: 900 }, { extra: `(${setup.toString()})()` });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openConversation(page, "claude tab");
  const dock = page.getByTestId("panel-terminal");
  await dock.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Meta+f");
  const search = page.getByRole("search", { name: "Find in terminal" });
  const input = search.getByRole("textbox", { name: "Find in terminal" });
  await input.fill("needle");
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent?.endsWith("of 3"));
  assert(await input.evaluate((el) => document.activeElement === el), "find owns focus");
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
  await search.getByRole("button", { name: "Match case" }).click();
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent?.endsWith("of 2"));
  await input.fill("absent match");
  assert.equal(await search.getByRole("status").textContent(), "No matches");
  await page.keyboard.press("Escape");
  await search.waitFor({ state: "detached" });
  assert(await dock.locator(".xterm-helper-textarea").evaluate((el) => document.activeElement === el), "Escape restores terminal focus");
  assert.equal(await dock.locator(".xterm-decoration").count(), 0, "closing clears highlights");
  assert.equal(await page.getByRole("button", { name: "Add to chat", exact: true }).count(), 0, "search results do not masquerade as a user selection");

  await dock.locator(".xterm").evaluate((el) => { window.__MOVED_XTERM__ = el; });
  await dock.getByRole("button", { name: "Move to tab" }).click();
  const full = page.getByRole("tabpanel").filter({ has: page.getByRole("button", { name: "Move to dock" }) });
  await full.waitFor();
  assert(await full.locator(".xterm").evaluate((el) => el === window.__MOVED_XTERM__), "same xterm moved to tab");
  await full.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Meta+f");
  await input.fill("needle first");
  await page.waitForFunction(() => document.querySelector('[role="search"] [role="status"]')?.textContent === "1 of 1");
  await page.keyboard.press("Escape");
  await full.getByRole("button", { name: "Move to dock" }).click();
  await dock.locator(".xterm").waitFor();
  assert(await dock.locator(".xterm").evaluate((el) => el === window.__MOVED_XTERM__), "same xterm moved back to dock");
  assert.deepEqual(await page.evaluate(() => window.__TERMINAL_CHECKS__), { attached: 1, spawned: 0, killed: 0, inputs: [] }, "moves never restart or reattach the PTY; search keys do not reach it");
  await dock.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Meta+a");
  await page.getByRole("button", { name: "Add to chat", exact: true }).click();
  await page.getByText("Added to chat draft", { exact: true }).waitFor();
  assert(await page.locator('textarea:not(.xterm-helper-textarea)').evaluateAll((fields) => fields.some((field) => field.value.startsWith("```text\n") && field.value.includes("needle first") && field.value.includes("needle last"))), "selected output reaches the active agent draft");
  assert.deepEqual(errors, []);
  console.log("ok terminal search: scrollback, highlights, wrap, previous, match case, keyboard focus, and retained xterm across dock/tab moves");
} finally {
  await browser.close();
  server.close();
}
