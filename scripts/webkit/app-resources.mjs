#!/usr/bin/env node
// #378: the real resource popover over a live xterm and chat, using only synthetic data.
// pnpm build && node scripts/webkit/app-resources.mjs
// APP_RESOURCES_SHOTS=docs/screenshots/issue-378 also saves rendered evidence.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, serve } from "./harness.mjs";

const stub = await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8");
const shots = process.env.APP_RESOURCES_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup({ theme, mode }) {
  localStorage.setItem("raccoon.theme", theme);
  localStorage.setItem("raccoon.mode", mode);
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false }));
  const { answers, emit } = window.__PW_STUB__;
  const session = answers.list_sessions[0];
  session.title = "Synthetic resource review";
  session.tabs = [session.tabs[0]];
  session.tabs[0].status = "in_progress";
  const tabId = session.tabs[0].id;
  const paneId = `tab:${tabId}`;
  const event = (seq, payload) => ({ id: `resource-event-${seq}`, seq, sessionId: session.id, tabId, harness: "claude", ts: "2026-10-01T12:00:00Z", payload });
  const paragraph = (n) => `Synthetic build ${n}: ALPHA BRAVO CHARLIE — reviewing resource labels and high-contrast output. `.repeat(4) + "\n\n";
  const events = [event(1, { type: "user_message", text: "Review this synthetic build log.", queued: false }), event(2, { type: "turn_started" }), event(3, { type: "assistant_text", text: Array.from({ length: 24 }, (_, i) => paragraph(i)).join("") })];
  const processes = ["Atlas build", "Beacon tests", "Cedar shell"].map((title, i) => ({
    paneId: i ? `synthetic-${i}` : paneId, tabId, tabTitle: title, sessionId: session.id,
    sessionTitle: i === 2 ? "Synthetic smoke checks" : "Synthetic resource review",
    projectPath: "/repos/p0", projectName: "Synthetic demo", cwd: "/repos/p0",
    kind: i === 2 ? "shell" : "agent", harness: i === 2 ? null : "claude", orphaned: false,
    pid: 4100 + i, cpuPercent: 12.5 + i, rssBytes: (128 + i * 64) * 1024 ** 2,
    childCount: i + 1, killRule: "idle",
  }));
  const sample = {
    processes, app: { mainPid: 4000, mainCpuPercent: 2.1, mainRssBytes: 96 * 1024 ** 2, webviewCpuPercent: 3.2, webviewRssBytes: 192 * 1024 ** 2, webviewProcessCount: 2 },
    host: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, cores: 8 },
    totalCpuPercent: 45.8, totalRssBytes: 864 * 1024 ** 2, sampledAt: Date.now(),
  };
  let channel;
  let sequence = 3;
  let output = 0;
  let refreshes = 0;
  const paintTerminal = () => {
    output++;
    const color = output % 2 ? "97;45" : "30;103";
    const lines = Array.from({ length: 42 }, (_, i) => `\x1b[${color}m SYNTHETIC ${output} ${String(i).padStart(2, "0")}  ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT GOLF HOTEL INDIA JULIET KILO LIMA MIKE NOVEMBER OSCAR PAPA QUEBEC \x1b[K\x1b[0m`);
    channel?.onmessage(new TextEncoder().encode("\x1b[H" + lines.join("\r\n")).buffer);
  };
  Object.assign(answers, {
    status_bar_settings: { visible: true, usage: false, resources: true, percent: "used", usageMode: "detailed", usageRefreshMinutes: 1 },
    status_usage_snapshot: { windows: [] },
    status_resource_overview: { agentCount: 2, orphanCount: 0, rssBytes: sample.totalRssBytes, pressure: 0.2 },
    status_resource_sample: () => { refreshes++; return sample; },
    ensure_tab_started: null,
    tab_pane: { sessionId: session.id, tabId, paneId, command: "synthetic-agent", harness: "claude" },
    pty_detach_all: null, pty_detach: null, pty_ack: null, pty_resize: null,
    pty_attach: (args) => { channel = args.channel; paintTerminal(); },
    load_tab_events: () => events,
    "plugin:window|is_focused": true,
    "plugin:window|is_minimized": false,
  });
  window.__RESOURCES_FIXTURE__ = {
    update(view) {
      if (view === "terminal") paintTerminal();
      else emit("agent_event", event(++sequence, { type: "assistant_text", text: paragraph(sequence) }));
    },
    get refreshes() { return refreshes; },
    get output() { return output; },
  };
}

const server = await serve();
const browser = await launch();
try {
  for (const theme of ["den", "slate", "moss", "ember"]) {
    for (const mode of theme === "ember" ? ["dark"] : ["dark", "light"]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => console.error(error.message));
      await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: false, localProjects: 1, localSession: true };\n${stub}\n(${setup})(${JSON.stringify({ theme, mode })});`);
      await page.goto(server.url);
      await page.getByRole("button", { name: "Expand main", exact: true }).click();
      await page.getByRole("button", { name: "Synthetic resource review", exact: true }).click();
      await page.locator("[data-chat-scroller]").waitFor();
      await page.evaluate(() => document.fonts.ready);
      for (const view of ["terminal", "chat"]) {
        await page.getByRole("button", { name: view === "terminal" ? "Show terminal view" : "Back to chat", exact: true }).click();
        const background = page.locator(view === "terminal" ? ".xterm-screen" : "[data-chat-scroller]").filter({ visible: true });
        await background.waitFor();
        if (view === "terminal") {
          await page.waitForFunction(() => window.__RESOURCES_FIXTURE__.output > 0);
          console.log(`terminal renderer (${theme}-${mode}): ${await background.locator("canvas").count() ? "canvas/WebGL" : "DOM"}`);
          // A real xterm selection, extending underneath the right-aligned popover.
          const box = await background.boundingBox();
          await page.mouse.move(box.x + 4, box.y + 70);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width - 8, box.y + 230, { steps: 12 });
          await page.mouse.up();
        }
        for (const glass of [true, false]) {
          const name = `${theme}-${mode}-${view}-${glass ? "glass" : "solid"}`;
          await page.evaluate((enabled) => document.documentElement.toggleAttribute("data-glass", enabled), glass);
          await page.getByRole("button", { name: /2 live agents using/ }).click();
          const panel = page.getByRole("dialog").filter({ hasText: "App resources" });
          await panel.getByText("Atlas build", { exact: true }).waitFor();
          await panel.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
          const surface = await panel.evaluate((el) => {
            const style = getComputedStyle(el);
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = style.backgroundColor;
            ctx.fillRect(0, 0, 1, 1);
            const rect = el.getBoundingClientRect();
            return {
              alpha: ctx.getImageData(0, 0, 1, 1).data[3], opacity: style.opacity,
              layer: getComputedStyle(el.parentElement).zIndex,
              menuLayer: style.getPropertyValue("--z-menu").trim(),
              topmost: [20, rect.height / 2, rect.height - 20].every((dy) => el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + dy))),
            };
          });
          if (shots && theme === "den" && glass) await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" });
          assert.equal(surface.alpha, 255, `${name}: opaque panel surface`);
          assert.equal(surface.opacity, "1", `${name}: full panel opacity`);
          assert.equal(surface.layer, surface.menuLayer, `${name}: shared menu layer`);
          assert.ok(surface.topmost, `${name}: panel owns hit testing above the background`);
          const row = panel.getByRole("button", { name: /^Claude Atlas build/ });
          const idle = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
          await row.hover();
          assert.notEqual(await row.evaluate((el) => getComputedStyle(el).backgroundColor), idle, `${name}: visible row hover`);
          await page.keyboard.press("Tab");
          await row.focus();
          assert.ok(await row.evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).boxShadow !== "none"), `${name}: visible keyboard focus`);
          if (shots && name === "den-dark-terminal-glass") await page.screenshot({ path: join(shots, `${name}-row-focus.png`), animations: "disabled" });
          // Exclude rounded corners: every pixel inside the panel must stay
          // identical when the actual terminal/chat behind it repaints.
          const box = await panel.boundingBox();
          const clip = { x: box.x + 12, y: box.y + 12, width: box.width - 24, height: box.height - 24 };
          const before = await page.screenshot({ clip, animations: "disabled" });
          const backgroundBefore = await background.screenshot({ animations: "disabled" });
          await page.evaluate((view) => window.__RESOURCES_FIXTURE__.update(view), view);
          await page.waitForTimeout(150);
          assert.ok(!backgroundBefore.equals(await background.screenshot({ animations: "disabled" })), `${name}: background actually repaints`);
          assert.ok(before.equals(await page.screenshot({ clip, animations: "disabled" })), `${name}: background repaint cannot change panel pixels, including the highlighted row`);
          const refreshes = await page.evaluate(() => window.__RESOURCES_FIXTURE__.refreshes);
          await panel.getByRole("button", { name: "Refresh resources", exact: true }).click();
          await page.waitForFunction((count) => window.__RESOURCES_FIXTURE__.refreshes > count, refreshes);
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "hidden" });
          console.log(`ok  ${name}: opaque surface, stacking, row states, live output and refresh`);
        }
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
