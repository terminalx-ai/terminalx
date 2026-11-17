#!/usr/bin/env node
// PRO-399: first run in the built app, in WebKit, dark and light at 1440 wide.
// The three numbered steps (an agent, a project, permissions) in both of their
// states, "Create a project" and the runtime-failed dialog: what each shows,
// where it sits, and that none of their text is under 12px. Synthetic bridge
// only; nothing is installed and nothing is created on disk.
// SHOTS=<dir> also saves a screenshot of each state.
// pnpm build && node scripts/webkit/first-run.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const viewport = { width: 1440, height: 900 };

const agents = (available) => [
  { id: "codex", name: "Codex", binary: "codex", available, installable: true, installHint: "npm i -g @openai/codex", installUrl: "https://example.com/codex" },
  { id: "claude", name: "Claude Code", binary: "claude", available, installable: true, installHint: "npm i -g @anthropic-ai/claude-code", installUrl: "https://example.com/claude" },
];
const bridge = (available, prefs) => `
  localStorage.setItem('raccoon.prefs', JSON.stringify(${JSON.stringify(prefs)}));
  const answers = window.__PW_STUB__.answers;
  answers["plugin:app|name"] = "TerminalX";
  answers.list_harnesses = ${JSON.stringify(agents(available))};
  answers.agent_setup_running = null;
  answers.check_agent_readiness = ({ harness }) => ${available}
    ? { state: "ready", checkedAt: new Date().toISOString(), version: harness === "claude" ? "2.1.318" : "0.166.0", account: "demo@example.com" }
    : { state: "missing", checkedAt: new Date().toISOString(), version: null };
  Object.assign(answers, {
    "plugin:path|resolve_directory": "/Users/demo",
    project_start_defaults: ({ parent }) => ({ projectsDir: parent ?? "/Users/demo/TerminalX/Projects", suggestedName: "tx-review-lab" }),
    project_templates: () => [
      { id: "empty", name: "Empty", description: "A README, a .gitignore and nothing else", builtIn: true },
      { id: "vite-react", name: "Vite + React", description: "TypeScript, Tailwind and Vitest", builtIn: true },
      { id: "agent-starter", name: "Agent starter", description: "CLAUDE.md, AGENTS.md, setup and test scripts", builtIn: true },
    ],
  });`;

/** Every piece of visible text under `locator` that is drawn smaller than 12px. */
const small = (locator) => locator.evaluate((root) => {
  const found = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const words = text.textContent.trim();
    const element = text.parentElement;
    if (!words || !element) continue;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || !box.width || !box.height) continue;
    const size = parseFloat(style.fontSize);
    if (size < 12) found.push(`${size}px "${words.slice(0, 40)}"`);
  }
  return found;
});
const box = async (locator) => (await locator.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };

const server = await serve();
let browser;
let failures = 0;
try {
  browser = await launch();
  for (const colorScheme of ["dark", "light"]) {
    const prefs = { sidebarOpen: false, theme: colorScheme };
    const shoot = async (page, name) => {
      if (shots) await page.screenshot({ path: join(shots, `${name}-${colorScheme}.png`), animations: "disabled" });
    };

    // 1. No agent on this Mac: the agent step is the one in hand.
    {
      const page = await open(browser, server.url, { cloud: false, localProjects: 0 }, viewport, { colorScheme, extra: bridge(false, prefs) });
      const start = page.getByTestId("start-screen");
      await start.getByRole("heading", { level: 1, name: "Welcome to TerminalX" }).waitFor();
      const codex = start.getByRole("region", { name: "Codex setup" });
      await codex.getByText("Not installed", { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const title = await box(start.getByRole("heading", { level: 1 }));
      const icon = await box(start.locator("header img"));
      const step = await box(start.locator('[data-step="1"]'));
      const install = await box(codex.getByRole("button", { name: "Install Codex and sign in" }));
      const name = await box(codex.getByText("Codex by OpenAI"));
      const tile = await box(codex.locator("span[aria-hidden]").first());
      const number = start.locator('[data-step="1"] > span').first();
      const colors = await number.evaluate((node) => ({ number: getComputedStyle(node).backgroundColor, accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), card: getComputedStyle(node.parentElement).backgroundColor }));
      failures += report(`${colorScheme} first run, no agent`, {
        "the agent step is in hand": (await start.getAttribute("data-stage")) === "agent",
        "three steps in order": (await start.getByRole("heading", { level: 2 }).allTextContents()).join("|") === "Set up an agent|Open a project|Choose how much the agent may do alone",
        "the header is left-aligned: a 40px tile beside the title": Math.round(icon.width) === 40 && Math.abs(icon.x - step.x) < 1 && title.x > icon.x + icon.width && title.x < icon.x + icon.width + 20,
        "each agent says who makes it": (await start.getByRole("region", { name: "Claude Code setup" }).textContent()).includes("Claude Code by Anthropic"),
        "the install action sits at the right of its card, beside the name": install.x > name.x + name.width && install.y < tile.y + tile.height && install.y + install.height > tile.y,
        "one action per agent": (await codex.getByRole("button").count()) === 1,
        "only the step number is amber": colors.number !== colors.card && (await start.getByTestId("start-no-agent").getByRole("alert").count()) === 0,
        "the project step offers its two buttons": (await start.locator("button[data-start-card]").allTextContents()).join("|") === "Open folder|Clone from GitHub",
        "the permission choice is offered": (await start.getByRole("button", { name: "Permissions: Ask every time" }).count()) === 1,
        "the footer says an account is optional, and links the guide": (await start.locator("footer").textContent()).includes("A TerminalX account is optional for local work.") && (await start.getByRole("button", { name: "Read the guide" }).count()) === 1,
        "no text under 12px": (await small(start)).length === 0,
        "no sideways scroll": await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      }, { title, icon, step, install, name, tile, colors, small: await small(start) });
      await shoot(page, "01-agent-setup");
      await page.close();
    }

    // 2. An agent can run: step 1 is done, the project step opens, and the permission choice is saved.
    {
      const page = await open(browser, server.url, { cloud: false, localProjects: 0 }, viewport, { colorScheme, extra: bridge(true, prefs) });
      const start = page.getByTestId("start-screen");
      await start.getByRole("heading", { name: "Agents ready" }).waitFor();
      await start.getByRole("region", { name: "Codex setup" }).getByText("Ready", { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const titles = await Promise.all(["local", "github", "quick"].map((id) => box(start.locator(`#start-card-label-${id}`))));
      failures += report(`${colorScheme} first run, agents ready`, {
        "the project step is in hand": (await start.getAttribute("data-stage")) === "project",
        "three steps in order": (await start.getByRole("heading", { level: 2 }).allTextContents()).join("|") === "Agents ready|Open a project|Choose how much the agent may do alone",
        "all three ways to a project": (await start.locator("button[data-start-card]").count()) === 3,
        "the three card titles sit on one line": titles.every((title) => Math.abs(title.y - titles[0].y) < 1),
        "no text under 12px": (await small(start)).length === 0,
        "no sideways scroll": await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      }, { titles, small: await small(start) });
      await shoot(page, "02-agents-ready");

      await start.getByRole("button", { name: "Permissions: Ask every time" }).click();
      const menu = page.getByRole("menu");
      await menu.getByRole("menuitemradio", { name: /^Auto/ }).waitFor();
      const smallInMenu = await small(menu);
      await shoot(page, "03-permission-choice");
      await menu.getByRole("menuitemradio", { name: /^Auto/ }).click();
      await start.getByRole("button", { name: "Permissions: Auto" }).waitFor();
      failures += report(`${colorScheme} permission choice`, {
        "five modes, none under 12px": smallInMenu.length === 0,
        "the pick is the mode new chats start in": await page.evaluate(() => JSON.parse(localStorage.getItem("raccoon.prefs")).lastMode === "auto"),
        "the step says what the pick means": (await start.locator('[data-step="3"]').textContent()).includes("Auto: Routine actions are approved; risky ones ask."),
      }, { smallInMenu });

      // 3. Create a project, from its card.
      await start.getByRole("button", { name: "Quick start", exact: true }).click();
      const dialog = page.getByTestId("start-quick-dialog");
      await dialog.getByRole("radiogroup", { name: "Template" }).waitFor();
      await page.waitForFunction(() => document.querySelector("#start-quick-name")?.value === "tx-review-lab");
      failures += report(`${colorScheme} create a project`, {
        "no text under 12px": (await small(dialog)).length === 0,
        "the footer names Settings › Projects": (await dialog.getByRole("button", { name: "Add your own templates in Settings › Projects", exact: true }).count()) === 1,
      }, await small(dialog));
      await shoot(page, "04-create-a-project");
      await page.close();
    }

    // 4. The runtime that failed to start, with the real log path.
    {
      const startFailed = {
        process: "terminalx-serve", code: 78, signal: null, ranMs: 412,
        error: "terminalx-serve: open the state directory: Permission denied (os error 13)",
        log: "/Users/someone/Library/Logs/com.terminalx.next/runtime.log",
        at: Date.UTC(2026, 10, 11, 9, 41, 12), app: "0.2.30", os: "macOS 26.1 (25B78)",
      };
      const extra = `
        localStorage.setItem('raccoon.prefs', JSON.stringify(${JSON.stringify(prefs)}));
        window.__PW_STUB__.answers.local_runtime_status = ${JSON.stringify({ state: "unavailable", message: "Could not connect to the background runtime", startFailed })};`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, viewport, { colorScheme, extra });
      const dialog = page.getByRole("dialog", { name: "TerminalX couldn't start its agent runtime" });
      await dialog.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const path = dialog.getByTestId("runtime-log-path");
      const note = dialog.getByText("· logs can include file paths and branch names");
      const [pathBox, noteBox, dialogBox] = [await box(path), await box(note), await box(dialog)];
      failures += report(`${colorScheme} runtime failed to start`, {
        "no text under 12px": (await small(dialog)).length === 0,
        "the log footer is one line": Math.abs(pathBox.y - noteBox.y) < 4 && noteBox.height < 24 && pathBox.height < 24,
        "the note stays inside the dialog": noteBox.x + noteBox.width <= dialogBox.x + dialogBox.width,
        "the log's file name shows, and the whole path is kept": (await path.textContent()) === "~/Library/Logs/com.terminalx.next/runtime.log" && (await path.getAttribute("title")) === "~/Library/Logs/com.terminalx.next/runtime.log",
      }, { pathBox, noteBox, dialogBox, small: await small(dialog) });
      await shoot(page, "05-runtime-failed");
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
