#!/usr/bin/env node
// The dialog for a runtime that exited while starting (PRO-287), in WebKit:
// it holds the window, fits it, keeps each button on one line, and its four
// actions reach the app. SHOTS=<dir> also saves a screenshot of each state.
// pnpm build && node scripts/webkit/runtime-start-failed.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const failed = {
  process: "terminalx-serve", code: 78, signal: null, ranMs: 412,
  error: "terminalx-serve: open the state directory: Permission denied (os error 13)",
  log: "/Users/someone/Library/Logs/com.terminalx.next/runtime.log",
  at: Date.UTC(2026, 10, 11, 9, 41, 12), app: "0.2.30", os: "macOS 26.1 (25B78)",
};
const states = {
  exited: failed,
  signalled: { ...failed, code: null, signal: 9, ranMs: 2_300, error: null },
  "not started": { ...failed, code: null, signal: null, ranMs: 0, error: "start local runtime: Permission denied (os error 13)" },
  "long error": { ...failed, error: `terminalx-serve: take over from the runtime this one replaces: read /Users/someone/.raccoon/run/handover-${"0123456789abcdef".repeat(6)}.json: No such file or directory (os error 2)` },
};
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const server = await serve();
let browser;
let failures = 0;
try {
  browser = await launch();
  for (const colorScheme of ["dark", "light"]) {
    for (const [name, startFailed] of Object.entries(states)) {
      if (colorScheme === "light" && name !== "exited") continue;
      const extra = `
        const calls = window.__PW_CALLS__ = [];
        const answers = window.__PW_STUB__.answers;
        answers.local_runtime_status = ${JSON.stringify({ state: "unavailable", message: "Could not connect to the background runtime", startFailed })};
        answers.local_runtime_log = () => { calls.push("log"); return "[2026-11-11T09:41:12Z ERROR raccoon_lib::serve] terminalx-serve: open the state directory\\n"; };
        answers.copy_text = ({ text }) => { calls.push("copy:" + text.length); };
        answers["plugin:opener|open_url"] = ({ url }) => { calls.push("open:" + url.split("?")[0]); };
        answers["plugin:process|restart"] = () => { calls.push("restart"); return new Promise(() => {}); };
        answers["plugin:process|exit"] = ({ code }) => { calls.push("exit:" + code); return new Promise(() => {}); };`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 }, { extra, colorScheme });
      const dialog = page.getByRole("dialog", { name: "TerminalX couldn't start its agent runtime" });
      await dialog.waitFor();
      await page.evaluate(() => document.fonts.ready);
      for (const [width, height] of [[1440, 900], [760, 600], [480, 640]]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(250);
        const geometry = await dialog.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const buttons = [...node.querySelectorAll("button")].map((button) => ({ label: button.textContent, lines: Math.round(button.getBoundingClientRect().height / parseFloat(getComputedStyle(button).lineHeight || "20")), height: button.getBoundingClientRect().height, right: button.getBoundingClientRect().right }));
          return { box: box.toJSON(), buttons, innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth };
        });
        const label = `${colorScheme} ${name} ${width}x${height}`;
        failures += report(label, {
          "inside the window": geometry.box.left >= 0 && geometry.box.top >= 0 && geometry.box.right <= geometry.innerWidth + 1 && geometry.box.bottom <= geometry.innerHeight + 1,
          "four buttons in order": geometry.buttons.map((button) => button.label).join("|") === "Quit|Copy logs|Report…|Restart TerminalX",
          "each button on one line": geometry.buttons.every((button) => button.height <= 34),
          "buttons inside the dialog": geometry.buttons.every((button) => button.right <= geometry.box.right + 1),
          "no sideways scroll": geometry.scrollWidth <= geometry.innerWidth + 1,
        }, geometry);
        if (shots && (width === 1440 || name === "exited")) await page.screenshot({ path: join(shots, `${colorScheme}-${name.replace(/ /g, "-")}-${width}x${height}.png`) });
      }
      if (name === "exited" && colorScheme === "dark") {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.keyboard.press("Escape");
        await page.mouse.click(40, 40);
        failures += report("holds the window", { "Escape and a click outside leave it open": await dialog.isVisible() });
        await dialog.getByRole("button", { name: "Copy logs" }).click();
        await dialog.getByRole("button", { name: "Copied" }).waitFor();
        if (shots) await page.screenshot({ path: join(shots, "dark-copied-1440x900.png") });
        await dialog.getByRole("button", { name: "Report…" }).click();
        await dialog.getByRole("button", { name: "Restart TerminalX" }).click();
        await dialog.getByRole("button", { name: "Restarting…" }).waitFor();
        if (shots) await page.screenshot({ path: join(shots, "dark-restarting-1440x900.png") });
        const calls = await page.evaluate(() => window.__PW_CALLS__);
        failures += report("actions", {
          "Copy logs reads the log and copies it": calls[0] === "log" && calls[1]?.startsWith("copy:"),
          "Report… opens a new issue": calls.includes("open:https://github.com/terminalx-ai/raccoon/issues/new"),
          "Restart TerminalX relaunches": calls.includes("restart"),
        }, calls);
        await page.close();
        // Quit, on a page of its own: Restarting… holds the other buttons.
        const quitting = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 }, { extra, colorScheme });
        const again = quitting.getByRole("dialog", { name: "TerminalX couldn't start its agent runtime" });
        await again.getByRole("button", { name: "Quit" }).click();
        await quitting.waitForFunction(() => window.__PW_CALLS__.includes("exit:0"));
        failures += report("actions", { "Quit quits": true });
        await quitting.close();
        continue;
      }
      await page.close();
    }
  }
} finally {
  await browser?.close();
  server.close();
}
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
