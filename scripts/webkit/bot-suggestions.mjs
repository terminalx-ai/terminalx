#!/usr/bin/env node
// PRO-477: a bot's Home tab (design 23.01) with its right column: Up next, the bot's next duty runs, and the
// Suggestions its look around made, each with Start and Dismiss under a line saying how the last look went. In real
// WebKit at 1440×900, 1280×800 and the window's smallest size, dark and light: the column stays inside the window,
// sits beside the work lists in a wide window and under them in a narrow one, nothing overlaps, and the page never
// scrolls sideways. Start and Dismiss are pressed and their suggestions leave the list.
// Run after pnpm build: node scripts/webkit/bot-suggestions.mjs
// BOT_SUGGESTIONS_SHOTS=<dir> saves a screenshot of each case.
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.BOT_SUGGESTIONS_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;

const fixture = `
  const backend = window.__PW_STUB__;
  const at = new Date().toISOString();
  const soon = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();
  const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  const tab = (id) => ({ id, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: at, modified: at });
  backend.answers.list_sessions = [{ id: "bot-home", kind: "quick", projectPath: "/scratch/home", cwd: "/home/.raccoon/bots/b1", title: "Home chat", created: at, modified: at,
    archived: false, pinned: false, worktreeRemoved: false, tabs: [tab("bot-home-t")], activeTab: "bot-home-t", bot: { id: "b1", home: true } }];
  backend.answers.load_tab_events = () => [];
  backend.answers.experimental_settings = { nativeCodex: false, bots: true };
  const bot = { id: "b1", slug: "kestrel", name: "Kestrel", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
    reportsTo: "owner", worksIn: ["personal"], created: at, modified: at };
  backend.answers.bot_list = { revision: 1, bots: [bot], unreadable: 0 };
  backend.answers.bot_home_chat = () => backend.answers.list_sessions[0];
  const item = (number, title, state) => ({ number, title, state, askedBy: "owner", addedBy: "b1", created: at, modified: at, spentUsd: 0 });
  const items = [item(12, "Phase 2: merge main into phase-2 and fix what breaks", "inProgress"), item(10, "Sort the open issues by area", "planned")];
  backend.answers.bot_items = () => ({ botId: "b1", revision: 2, items, unreadable: 0 });
  backend.answers.bots_needs_you = () => ({ entries: [], counts: [{ botId: "b1", needsYou: 0, inProgress: 1 }] });
  const duty = (id, name, minutes, extra) => ({ id, name, enabled: true, projectPath: "/home/.raccoon/bots/b1", harness: "claude", model: "", mode: "bypassPermissions",
    prompt: "Look.", workspace: "newWorktree", reuseSession: false, archiveOnComplete: false, keepLatestRunVisible: false,
    schedule: { kind: "cron", cron: "0 8,12,16,20 * * *", weekdays: [], timezone: "UTC", dtstart: "2026-01-01T00:00:00Z" },
    missedRunGraceMinutes: 30, nextRunAt: soon(minutes), created: at, modified: at, bot: { id: "b1", reportsTo: "terminalx" }, ...extra });
  backend.answers.automations_list = [
    duty("look", "Look around", 40, { bot: { id: "b1", reportsTo: "terminalx", builtin: "lookAround", focus: "Open pull requests" } }),
    duty("tidy", "Tidy memory", 700, { bot: { id: "b1", reportsTo: "terminalx", builtin: "tidyMemory" } }),
    duty("status", "Daily status for the team, with a name long enough to have to truncate in the column", 90, {}),
  ];
  backend.answers.automation_runs = () => [];
  const suggestion = (number, title, why) => ({ number, title, why, state: "open", created: ago(20), from: { kind: "lookAround", run: "look-3", runNumber: 3 } });
  let open = [
    suggestion(3, "Merge main into phase-2", "Each day adds conflicts; main moved 40 commits since the branch was cut."),
    suggestion(2, "Close PR #1247: #1198 covers it, and it has conflicted with main for two days now", "It duplicates #1198."),
    suggestion(1, "Sort the 37 untriaged issues by area", "Nobody has looked at them since Monday."),
  ];
  const status = () => ({ lookAround: { dutyId: "look", enabled: true, nextRunAt: soon(40), running: false, focus: "Open pull requests",
    last: { runId: "look-3", runNumber: 3, at: ago(20), status: "completed", why: null, suggestions: 3, refused: 2, refusedWhat: ["\`git push\`", "\`gh pr close 1247\`"] } },
    tidyMemory: null, paused: false, readOnly: false });
  backend.answers.bot_suggestions = () => ({ suggestions: open, unreadable: 0, status: status() });
  backend.answers.bot_suggestion_start = ({ number }) => {
    const started = open.find((value) => value.number === number);
    open = open.filter((value) => value !== started);
    setTimeout(() => backend.emit("bot_suggestions_changed", { botId: "b1" }), 0);
    return { suggestion: { ...started, state: "started", item: 21 }, item: item(21, started.title, "inProgress"), delivery: { sent: true, sessionId: "bot-home" } };
  };
  backend.answers.bot_suggestion_dismiss = ({ number }) => {
    const dismissed = open.find((value) => value.number === number);
    open = open.filter((value) => value !== dismissed);
    return { ...dismissed, state: "dismissed" };
  };
`;

const box = (locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
});

/** Every visible control of the view stays inside it; no two buttons overlap; the page does not scroll sideways. */
async function measure(page, root) {
  return page.evaluate((selector) => {
    const view = document.querySelector(selector);
    if (!view) return ["no view"];
    const problems = [];
    const slot = view.getBoundingClientRect();
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      let { top, bottom } = rect;
      for (let parent = element.parentElement; parent && parent !== view.parentElement; parent = parent.parentElement) {
        if (!/auto|scroll|hidden/.test(getComputedStyle(parent).overflowY)) continue;
        const clip = parent.getBoundingClientRect();
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
      return { left: rect.left, right: rect.right, top, bottom, width: rect.width, height: Math.max(0, bottom - top) };
    };
    const shown = [...view.querySelectorAll("button, h2, li, p")].filter((element) => visible(element).width > 0 && visible(element).height > 0);
    for (const element of shown) {
      const rect = visible(element);
      if (rect.left < slot.left - 1 || rect.right > slot.right + 1) problems.push(`"${element.textContent.trim().slice(0, 40)}" leaves the view`);
    }
    const buttons = shown.filter((element) => element.tagName === "BUTTON");
    for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
      if (buttons[i].contains(buttons[j]) || buttons[j].contains(buttons[i])) continue;
      const [a, b] = [visible(buttons[i]), visible(buttons[j])];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) problems.push(`"${buttons[i].textContent.trim().slice(0, 30)}" overlaps "${buttons[j].textContent.trim().slice(0, 30)}"`);
    }
    // Up next: the name truncates inside its row, the time stays whole.
    for (const row of view.querySelectorAll("[data-testid=bot-up-next-row]")) {
      const rect = row.getBoundingClientRect();
      for (const child of row.children) if (child.getBoundingClientRect().right > rect.right + 1) problems.push(`up next ${row.textContent.slice(0, 30)}: spills out`);
    }
    return problems;
  }, root);
}

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 760, height: 520 }]) {
    for (const colorScheme of ["dark", "light"]) {
      const name = `${viewport.width}×${viewport.height} ${colorScheme}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Open the bot's session until its view shows: the first open can land before the bots are read.
      const view = page.getByRole("main", { name: "Kestrel, CTO" });
      for (let attempt = 0; attempt < 20 && !(await view.isVisible()); attempt++) {
        await page.evaluate(() => window.__PW_STUB__.emit("open_session", { sessionId: "bot-home" }));
        await page.waitForTimeout(150);
      }
      await view.waitFor();
      const selector = "main[aria-label='Kestrel, CTO']";
      await view.getByRole("tab", { name: /Home/ }).click();
      const home = view.getByTestId("bot-home");
      const aside = home.getByTestId("bot-home-aside");
      await aside.getByTestId("bot-suggestion").nth(2).waitFor();
      await aside.getByTestId("bot-up-next-row").nth(2).waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-suggestions-${viewport.width}-${colorScheme}.png` });
      const problems = await measure(page, selector);
      const [progressBox, asideBox, upNextBox, suggestionsBox] = await Promise.all([home.getByTestId("bot-home-in-progress"), aside, aside.getByTestId("bot-up-next"), aside.getByTestId("bot-suggestions")].map(box));
      const upNext = (await aside.getByTestId("bot-up-next-row").allTextContents()).map((text) => text.replace(/\d{1,2}:\d{2}|in \d+[mhd]/, "").trim());
      const statusLine = await aside.getByTestId("bot-look-status").textContent();
      const wide = viewport.width >= 1280;
      failed += report(`bot suggestions ${name}`, {
        "fits the view": problems.length === 0,
        "wide windows put the column on the right, narrow ones under the work": wide ? asideBox.left >= progressBox.right - 0.5 : asideBox.top >= progressBox.bottom - 0.5,
        "the column is the design's 312px when beside the work": !wide || Math.abs(asideBox.width - 312) < 1.5,
        "Up next above Suggestions": upNextBox.bottom <= suggestionsBox.top + 0.5,
        "Up next, soonest first": upNext[0] === "Look around" && upNext[1].startsWith("Daily status") && upNext[2] === "Tidy memory",
        "the status line says the last look and what was refused": /Last looked 20m ago: 3 suggestions; 2 actions refused/.test(statusLine ?? "") && (await aside.getByTestId("bot-look-refused").isVisible()),
        "no page errors": errors.length === 0,
      }, { problems, asideBox, progressBox, upNext, statusLine, errors });

      // Start and Dismiss: each suggestion leaves the list.
      await aside.getByTestId("bot-suggestion").first().getByTestId("bot-suggestion-start").click();
      await aside.getByTestId("bot-suggestion").nth(1).waitFor();
      await page.waitForFunction(() => document.querySelectorAll("[data-testid=bot-suggestion]").length === 2);
      await aside.getByTestId("bot-suggestion").first().getByTestId("bot-suggestion-dismiss").click();
      await page.waitForFunction(() => document.querySelectorAll("[data-testid=bot-suggestion]").length === 1);
      const after = await aside.getByTestId("bot-suggestion").allTextContents();
      failed += report(`bot suggestions act ${name}`, {
        "Start and Dismiss each take one away": after.length === 1 && after[0].includes("Sort the 37 untriaged issues"),
        "fits the view after": (await measure(page, selector)).length === 0,
        "no page errors": errors.length === 0,
      }, { after, errors });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
