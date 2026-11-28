#!/usr/bin/env node
// A bot's pages in real WebKit at 1440×900, 1280×800 and the window's smallest size, dark and light: the four checks
// bot-items, bot-handoffs, bot-runs and bot-suggestions, in one process with one server and one WebKit (CI speed work,
// 2026-11). Each part keeps its own fixture, its own pages and every one of its checks, under the names it printed.
// Run after pnpm build: node scripts/webkit/bot-pages.mjs
// Each part's <NAME>_SHOTS=<dir> (BOT_ITEMS_SHOTS, BOT_HANDOFFS_SHOTS, BOT_RUNS_SHOTS, BOT_SUGGESTIONS_SHOTS) saves a
// screenshot of each of its cases.
import { launch, open, openSession, report, serve, sidebar } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;
const matrix = (shots) => shots
  ? [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 760, height: 520 }].flatMap((viewport) => ["dark", "light"].map((colorScheme) => ({ viewport, colorScheme })))
  : [{ viewport: { width: 1440, height: 900 }, colorScheme: "dark" }, { viewport: { width: 760, height: 520 }, colorScheme: "light" }];

// ---- bot-items ----
// PRO-469: a bot's Home tab (design 23.01) and a work item's page (23.09), and the Bots page's Needs you queue (23.02),
// in real WebKit at 1440×900, 1280×800 and the window's smallest size, dark and light. The Needs you card's answers,
// the In progress and Planned lists, the item page's main column and its right column stay inside the window, do not
// overlap, and the page never scrolls sideways.
async function botItems() {
  const shots = process.env.BOT_ITEMS_SHOTS;
  let failed = 0;
  const fixture = `
    const backend = window.__PW_STUB__;
    const at = new Date().toISOString();
    const tab = (id) => ({ id, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: at, modified: at });
    const chat = (id, title, bot, extra = {}) => ({ id, kind: "quick", projectPath: "/scratch/" + id, cwd: "/home/.raccoon/bots/b1", title, created: at, modified: at,
      archived: false, pinned: false, worktreeRemoved: false, tabs: [tab(id + "-t")], activeTab: id + "-t", bot, ...extra });
    backend.answers.list_sessions = [
      chat("bot-home", "Home chat", { id: "b1", home: true }),
      chat("bot-started", "Move the macOS jobs to our own runner, with a long title that has to truncate", null, { kind: undefined, projectPath: "/repos/p0", cwd: "/repos/p0", parent: { sessionId: "bot-home" }, bot: { id: "b1" } }),
    ];
    backend.answers.load_tab_events = () => [];
    backend.answers.experimental_settings = { nativeCodex: false, bots: true };
    const bot = { id: "b1", slug: "kestrel", name: "Kestrel", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
      reportsTo: "owner", worksIn: ["personal"], created: at, modified: at };
    backend.answers.bot_list = { revision: 1, bots: [bot], unreadable: 0 };
    backend.answers.bot_home_chat = () => backend.answers.list_sessions[0];
    const long = "Move macOS CI to our own runner on the Mac mini and keep the hosted one as a fallback for forks";
    const item = (number, title, state, extra = {}) => ({ number, title, state, askedBy: "owner", addedBy: "b1", created: at, modified: at, spentUsd: 1.25, ...extra });
    const asking = item(14, long, "needsYou", { summary: "Three pieces: the runner, the job labels and the fallback.",
      question: { text: "The plan is ready. Approve it, or say what to change?", answers: ["Not now", "Approve and start", "Start, but ask before merging"], recommended: 1, asked: at } });
    const doneMeans = [{ text: "macOS jobs run on the Mac mini runner", how: "CI run", met: true, metAt: at }, { text: "Forks still use the hosted runner, with a line long enough to wrap in a narrow window", how: "a fork's PR", met: false }];
    const working = item(12, "Phase 2: merge main into phase-2 and fix what breaks", "inProgress", { doneMeans, summary: "Main moved by 40 commits.",
      links: [{ kind: "session", target: "bot-started" }, { kind: "session", target: "bot-home" }, { kind: "pullRequest", target: "#1398", title: "Merge main into phase-2" }, { kind: "ticket", target: "PRO-120" }] });
    const items = [asking, working, item(11, "Pinned sessions on the phone", "waiting"), item(10, "Sort the open issues by area", "planned"), item(9, "Weekly status", "done", { closed: at })];
    backend.answers.bot_items = () => ({ botId: "b1", revision: 2, items, unreadable: 0 });
    backend.answers.bot_item = ({ number }) => ({ ...items.find((value) => value.number === number), activity: [
      { at, by: "owner", kind: "gave", text: "You gave Kestrel this work" },
      { at, by: "b1", kind: "comment", text: "Kestrel noted", detail: "Split it into two pieces: the merge, then the fixes. This note is long enough to wrap across lines in the narrow window." },
      { at, by: "b1", kind: "checked", text: "Kestrel checked “macOS jobs run on the Mac mini runner”" },
    ] });
    backend.answers.bots_needs_you = () => ({ entries: [{ kind: "item", botId: "b1", at, item: asking }], counts: [{ botId: "b1", needsYou: 1, inProgress: 2 }] });
    // PRO-493, for the Bots page's queue only: a question its three lines cut, with a one-letter recommended answer, so
    // "Read and answer" stands in for a button narrower than itself.
    const cut = item(16, "Pick the runner's region", "needsYou", { question: { text: "Which region?\\n".repeat(6) + "Say which one, and why, before I order the machine.", answers: ["N", "Y"], recommended: 1, asked: at } });
    window.__askCutQuestion = () => {
      backend.answers.bots_needs_you = () => ({ entries: [{ kind: "item", botId: "b1", at, item: asking }, { kind: "item", botId: "b1", at, item: cut }], counts: [{ botId: "b1", needsYou: 2, inProgress: 2 }] });
      backend.emit("bot_items_changed", { botId: "b1" });
    };
  `;

  const box = (locator) => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  });
  const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

  /** Every visible control of the view stays inside it; buttons in one row do not overlap; the page does not scroll sideways. */
  async function measure(page, root) {
    return page.evaluate((selector) => {
      const view = document.querySelector(selector);
      const problems = [];
      if (!view) return ["no view"];
      const slot = view.getBoundingClientRect();
      if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
      // What a scroller hides above or below its edge is not on screen: each box is cut to its scrollers' visible part.
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        let { left, top, right, bottom } = rect;
        for (let parent = element.parentElement; parent && parent !== view.parentElement; parent = parent.parentElement) {
          if (!/auto|scroll|hidden/.test(getComputedStyle(parent).overflowY)) continue;
          const clip = parent.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        return { left, right, top, bottom, width: rect.width, height: Math.max(0, bottom - top) };
      };
      const shown = [...view.querySelectorAll("button, h1, h2, input, textarea, li, [data-testid=needs-you-answer]")].filter((element) => visible(element).width > 0 && visible(element).height > 0);
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
      // Item rows: the title truncates inside its row.
      for (const row of view.querySelectorAll("[data-testid=bot-item-row]")) {
        const rect = row.getBoundingClientRect();
        for (const child of row.querySelectorAll("span")) {
          const inner = child.getBoundingClientRect();
          if (inner.width && inner.right > rect.right + 1) problems.push(`item row ${row.textContent.slice(0, 30)}: text spills out`);
        }
      }
      return problems;
    }, root);
  }

  for (const { viewport, colorScheme } of matrix(shots)) {
      const name = `${viewport.width}×${viewport.height} ${colorScheme}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const rail = await sidebar(page);
      const view = await openSession(page, "bot-home", "Kestrel, CTO");
      const selector = "main[aria-label='Kestrel, CTO']";

      // 23.01: Home.
      await view.getByRole("tab", { name: /Home/ }).click();
      const home = view.getByTestId("bot-home");
      await home.getByTestId("needs-you-answer").first().waitFor();
      await home.getByText("Sort the open issues by area").waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-home-${viewport.width}-${colorScheme}.png` });
      const homeProblems = await measure(page, selector);
      const [needsBox, progressBox, plannedBox] = await Promise.all(["bot-home-needs-you", "bot-home-in-progress", "bot-home-planned"].map((id) => box(home.getByTestId(id))));
      const answers = await home.getByTestId("needs-you-answer").allTextContents();
      const homeCount = await view.getByTestId("bot-home-count").textContent();
      const railCount = await rail.getByTestId("bot-row-needs-you").count();
      failed += report(`bot home ${name}`, {
        "fits the view": homeProblems.length === 0,
        "Needs you, then In progress, then Planned, without overlap": needsBox.bottom <= progressBox.top + 0.5 && progressBox.bottom <= plannedBox.top + 0.5,
        "the answers in the bot's own order and numbered, the recommended one marked": answers.length === 3 && answers.every((text, index) => text.startsWith(String(index + 1))) && answers[1]?.includes("recommended"),
        "the Home tab and the sidebar row count it": homeCount?.trim() === "1" && railCount === 1,
        "the header says what it works on": (await view.getByTestId("bot-work-line").textContent()) === "Working on 2 things · 1 needs you",
        "no page errors": errors.length === 0,
      }, { homeProblems, answers, homeCount, railCount, errors });

      // Give work opens its form inside the Planned list.
      await home.getByTestId("bot-give-work").click();
      await home.getByTestId("bot-give-work-form").waitFor();
      const giveProblems = await measure(page, selector);
      failed += report(`give work ${name}`, { "fits the view": giveProblems.length === 0 }, giveProblems);

      // 23.09: the item page.
      await home.getByText("Phase 2: merge main into phase-2 and fix what breaks").click();
      const itemPage = view.getByTestId("bot-item-page");
      await itemPage.getByTestId("bot-item-activity-row").nth(2).waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-item-${viewport.width}-${colorScheme}.png` });
      const itemProblems = await measure(page, selector);
      const [mainBox, asideBox, titleBox, takeOverBox, stopBox] = await Promise.all([
        itemPage.getByRole("main", { name: "Item #12" }), itemPage.getByTestId("bot-item-aside"), itemPage.getByRole("heading", { level: 1 }), itemPage.getByTestId("bot-item-take-over"), itemPage.getByTestId("bot-item-stop"),
      ].map(box));
      failed += report(`bot item ${name}`, {
        "fits the view": itemProblems.length === 0,
        "the right column does not cover the item": !overlaps(mainBox, asideBox),
        "wide windows put the column on the right": viewport.width < 1280 || asideBox.left >= mainBox.right - 0.5,
        "the actions stand above the title": takeOverBox.bottom <= titleBox.top + 0.5 && stopBox.bottom <= titleBox.top + 0.5,
        "no page errors": errors.length === 0,
      }, { itemProblems, mainBox, asideBox, errors });

      // 23.02: the Bots page's Needs you queue.
      await rail.getByTestId("destination-list").getByRole("button", { name: /^Bots/ }).click();
      const queue = page.locator("main [data-testid=bots-needs-you]");
      await queue.getByTestId("needs-you-row").first().waitFor();
      await page.evaluate(() => window.__askCutQuestion());
      await queue.getByTestId("needs-you-read").waitFor();
      const queueProblems = await page.evaluate(() => {
        const main = document.querySelector("main").getBoundingClientRect();
        const problems = [];
        if (document.documentElement.scrollWidth > innerWidth + 1) problems.push("page scrolls sideways");
        for (const element of document.querySelectorAll("[data-testid=bots-needs-you] button, [data-testid=bots-needs-you] p")) {
          const rect = element.getBoundingClientRect();
          if (rect.width && (rect.left < main.left - 1 || rect.right > main.right + 1)) problems.push(`"${element.textContent.trim().slice(0, 40)}" leaves the main slot`);
        }
        // "Read and answer" sits inside its cell, not over the Open button beside it (PRO-493).
        for (const read of document.querySelectorAll("[data-testid=bots-needs-you] [data-testid=needs-you-read]")) {
          const cell = read.closest("[data-testid=needs-you-answer-cell]").getBoundingClientRect();
          const box = read.getBoundingClientRect();
          if (box.left < cell.left - 0.5 || box.right > cell.right + 0.5) problems.push(`"Read and answer" spills out of its cell (${box.left}–${box.right} in ${cell.left}–${cell.right})`);
          const open = read.closest("[data-testid=needs-you-row]").querySelector("[data-testid=needs-you-open]").getBoundingClientRect();
          if (box.left < open.right - 0.5 && open.left < box.right - 0.5) problems.push('"Read and answer" overlaps Open');
        }
        return problems;
      });
      const reads = await queue.getByTestId("needs-you-read").count();
      failed += report(`needs you queue ${name}`, { "fits the main slot": queueProblems.length === 0, "the cut question offers Read and answer": reads >= 1 }, queueProblems);
      await page.close();
  }
  return failed;
}

// ---- bot-handoffs ----
// PRO-475: bots as a team, in real WebKit at 1440×900, 1280×800 and the window's smallest size, dark and light. The
// team brief under "Every bot reads", "Reports to" on a lead's Home (23.01) and "Hand to another bot" on an item's
// page (23.09) stay inside the window, do not overlap, and the page never scrolls sideways.
// PRO-520 (PRO-517 decision 2, in place of design 23.04's cards): the strip above a bot's chat holds one line for each
// open hand-off and nothing for a finished one. Of the fixture's three hand-offs (working, waiting for a paused bot,
// answered) exactly two lines show, each one line high with its state and its Stop; the answered one is absent, with
// its scope and its answer; the two undelivered messages, one of them about the answered hand-off, still show with a
// Resend; and the strip is a small part of the panel, where the cards took up to 45% of it.
async function botHandoffs() {
  const shots = process.env.BOT_HANDOFFS_SHOTS;
  let failed = 0;
  const fixture = `
    const backend = window.__PW_STUB__;
    const at = new Date().toISOString();
    const tab = (id) => ({ id, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: at, modified: at });
    const chat = (id, title, bot, extra = {}) => ({ id, kind: "quick", projectPath: "/scratch/" + id, cwd: "/home/.raccoon/bots/" + bot.id, title, created: at, modified: at,
      archived: false, pinned: false, worktreeRemoved: false, tabs: [tab(id + "-t")], activeTab: id + "-t", bot, ...extra });
    backend.answers.list_sessions = [
      chat("bot-home", "Home chat", { id: "b1", home: true }),
      chat("sentry-home", "Home chat", { id: "b2", home: true }),
      chat("sentry-work", "Hand-off from Atlas: Check the runner's secrets and network access before the run merges", { id: "b2", home: false }),
    ];
    backend.answers.load_tab_events = () => [];
    backend.answers.experimental_settings = { nativeCodex: false, bots: true };
    const bot = (id, slug, name, roleTitle, roleTemplateId, reportsTo, extra = {}) => ({ id, slug, name, roleTitle, roleTemplateId, harness: "claude", model: "", access: "full", runsOn: "thisMac",
      reportsTo, worksIn: ["personal"], created: at, modified: at, ...extra });
    backend.answers.bot_list = { revision: 1, unreadable: 0, bots: [
      bot("b1", "atlas", "Atlas", "CTO", "cto", "owner"),
      bot("b2", "sentry", "Sentry", "Security auditor", "security-auditor", "b1"),
      bot("b3", "argus", "Argus with a rather long name", "Watcher", "watcher", "b1", { paused: { at, by: "owner" } }),
    ] };
    backend.answers.bot_home_chat = ({ id }) => backend.answers.list_sessions.find((value) => value.bot.id === id && value.bot.home);
    const handoff = (number, extra) => ({ number, from: "b1", to: "b2", by: "b1", title: "Hand-off " + number, state: "working", depth: 1, created: at, modified: at, started: at,
      fromSession: "bot-home", toSession: "sentry-work", item: 3, waitingMessages: 0, ...extra });
    const handoffs = [
      handoff(7, { title: "Check the runner's secrets and network access before the run merges, a title long enough to truncate", scope: "Read the runner's setup and say whether any secret reaches its logs. Look at the network rules too, and the cache keys, and anything the job prints.", due: "before the run merges on Friday afternoon" }),
      handoff(6, { to: "b3", state: "waiting", toSession: undefined, item: undefined, title: "Watch the queue time on main", waitingMessages: 1 }),
      handoff(5, { state: "answered", title: "Look at the relay token", closed: at, answer: { at, by: "b2", text: "No secret reaches the logs. The relay token is read from the keychain and never printed; the cache keys hold no secret either." } }),
    ];
    // A held answer about the answered hand-off, which has no line (PRO-520), and a message about none (lead review 1):
    // both loose in the strip, each with a Resend.
    const undelivered = [
      { id: "m1", at: "2026-11-21T10:00:00Z", from: "b2", to: "b1", kind: "answer", handoff: handoffs[2].number, tries: 3, error: "the chat could not take the message because its tab is gone", held: true },
      { id: "m2", at: "2026-11-21T10:01:00Z", from: "b2", to: "b1", kind: "tell", handoff: null, tries: 1, error: "the tab is gone", held: false },
    ];
    backend.answers.bot_handoffs = () => ({ revision: 3, handoffs, waitingMessages: 1, undelivered, unreadable: 0 });
    backend.answers.bot_brief = () => ({ text: "- Ask before anything leaves this Mac.\\n- Status updates go in a table.\\n", hash: "h1", lines: 2, modified: at, outside: true, cut: false, unreadable: null, limit: 8192 });
    const item = (number, title, state, extra = {}) => ({ number, title, state, askedBy: "owner", addedBy: "b1", created: at, modified: at, spentUsd: 1.25, ...extra });
    const items = [item(12, "Phase 2: merge main into phase-2 and fix what breaks", "inProgress", { summary: "Main moved by 40 commits." }), item(10, "Sort the open issues by area", "planned")];
    backend.answers.bot_items = () => ({ botId: "b1", revision: 2, items, unreadable: 0 });
    backend.answers.bot_item = ({ number }) => ({ ...items.find((value) => value.number === number), activity: [{ at, by: "owner", kind: "gave", text: "You gave Atlas this work" }] });
    backend.answers.bots_needs_you = () => ({ entries: [], counts: [] });
  `;

  const box = (locator) => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  });
  // The strip's largest share of the Chat panel, with two lines and two undelivered messages in it: far below the 45% the
  // cards were let take. The smallest window's panel is short, so the same few rows are a larger share of it.
  const STRIP_SHARE = { 1440: 0.25, 1280: 0.25, 760: 0.35 };
  const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

  /** Every visible control of the view stays inside it; buttons in one row do not overlap; the page does not scroll sideways. */
  async function measure(page, root) {
    return page.evaluate((selector) => {
      const view = document.querySelector(selector);
      const problems = [];
      if (!view) return ["no view"];
      const slot = view.getBoundingClientRect();
      if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
      // What a scroller hides above or below its edge is not on screen: each box is cut to its scrollers' visible part.
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        let { left, top, right, bottom } = rect;
        for (let parent = element.parentElement; parent && parent !== view.parentElement; parent = parent.parentElement) {
          if (!/auto|scroll|hidden/.test(getComputedStyle(parent).overflowY)) continue;
          const clip = parent.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        return { left, right, top, bottom, width: rect.width, height: Math.max(0, bottom - top) };
      };
      const shown = [...view.querySelectorAll("button, h1, h2, input, textarea, li, [data-testid=needs-you-answer]")].filter((element) => visible(element).width > 0 && visible(element).height > 0);
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
      // Hand-off lines: the title, the state chip and Stop stay inside the line, side by side, and the line inside the strip.
      for (const line of view.querySelectorAll("[data-testid=bot-handoff-line]")) {
        const rect = line.getBoundingClientRect();
        if (rect.left < slot.left - 1 || rect.right > slot.right + 1) problems.push(`hand-off line ${line.textContent.slice(0, 30)} leaves the strip`);
        for (const child of line.querySelectorAll("span, button, p")) {
          const inner = child.getBoundingClientRect();
          if (inner.width && (inner.right > rect.right + 1 || inner.left < rect.left - 1 || inner.top < rect.top - 1 || inner.bottom > rect.bottom + 1)) problems.push(`hand-off line ${line.textContent.slice(0, 30)}: "${child.textContent.trim().slice(0, 20)}" spills out`);
        }
        const parts = [...line.children].map((child) => ({ name: child.textContent.trim().slice(0, 20) || child.getAttribute("aria-label"), rect: child.getBoundingClientRect() }));
        for (let i = 1; i < parts.length; i++) {
          if (parts[i].rect.left < parts[i - 1].rect.right - 1) problems.push(`hand-off line ${line.textContent.slice(0, 30)}: "${parts[i].name}" overlaps "${parts[i - 1].name}"`);
        }
      }
      // Lines and undelivered messages stand one under another, never over each other.
      const rows = [...view.querySelectorAll("[data-testid=bot-handoff-line], [data-testid=bot-handoff-undelivered-message]")].map((row) => ({ name: row.textContent.trim().slice(0, 30), rect: visible(row) })).filter((row) => row.rect.height > 0);
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].rect.top < rows[i - 1].rect.bottom - 1) problems.push(`"${rows[i].name}" overlaps "${rows[i - 1].name}"`);
      }
      // Item rows: the title truncates inside its row.
      for (const row of view.querySelectorAll("[data-testid=bot-item-row]")) {
        const rect = row.getBoundingClientRect();
        for (const child of row.querySelectorAll("span")) {
          const inner = child.getBoundingClientRect();
          if (inner.width && inner.right > rect.right + 1) problems.push(`item row ${row.textContent.slice(0, 30)}: text spills out`);
        }
      }
      return problems;
    }, root);
  }

  for (const { viewport, colorScheme } of matrix(shots)) {
      const name = `${viewport.width}×${viewport.height} ${colorScheme}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await sidebar(page);
      const view = await openSession(page, "bot-home", "Atlas, CTO");
      const selector = "main[aria-label='Atlas, CTO']";

      // PRO-520: the strip of open hand-offs above the lead's chat.
      const strip = view.getByTestId("bot-handoff-cards");
      const lines = strip.getByTestId("bot-handoff-line");
      await lines.nth(1).waitFor();
      await strip.getByTestId("bot-handoff-undelivered-message").nth(1).waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-handoffs-${viewport.width}-${colorScheme}.png` });
      // The strip is measured on its own: the chat below it is SessionView's, checked by bot-chat.mjs.
      const stripProblems = await measure(page, "[data-testid=bot-handoff-cards]");
      const stripBox = await box(strip);
      const panel = await box(view.getByRole("tabpanel", { name: "Chat" }));
      const lineBoxes = await Promise.all((await lines.all()).map(box));
      const states = await strip.getByTestId("bot-handoff-state").allTextContents();
      const stripText = (await strip.textContent()) ?? "";
      const waiting = strip.getByTestId("bot-handoff-waiting");
      // One line of 12.5px text: its title's own line box is as tall as the title, so the title did not wrap.
      const titles = await lines.evaluateAll((all) => all.map((line) => {
        const title = line.querySelector("[title]");
        return { height: title.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(title).lineHeight), full: title.getAttribute("title"), cut: title.scrollWidth > title.clientWidth };
      }));
      // Where the window is too short for the strip's rows and the chat under them, the strip scrolls: its last row is
      // then reached by scrolling it, never cut off for good.
      const reach = await strip.evaluate((element) => {
        const fits = element.scrollHeight <= element.clientHeight + 1;
        const before = element.scrollTop;
        element.scrollTop = element.scrollHeight;
        const clip = element.getBoundingClientRect();
        const last = [...element.querySelectorAll("[data-testid=bot-handoff-resend]")].at(-1)?.getBoundingClientRect();
        const lastInView = !!last && last.top >= clip.top - 0.5 && last.bottom <= clip.bottom + 0.5;
        element.scrollTop = before;
        return { fits, lastInView, scrolls: /auto|scroll/.test(getComputedStyle(element).overflowY), scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
      });
      failed += report(`hand-off strip ${name}`, {
        "every row is in view at once, or in the smallest window the strip scrolls to its last": viewport.width > 760 ? reach.fits && reach.lastInView : reach.scrolls && reach.lastInView,
        "fits the view, nothing spills or overlaps": stripProblems.length === 0,
        "exactly two lines, one for each open hand-off": lineBoxes.length === 2,
        "each line is one line high (40px or less)": lineBoxes.length === 2 && lineBoxes.every((line) => line.height > 0 && line.height <= 40) && titles.every((title) => title.height <= title.lineHeight * 1.5),
        "the lines are the full width of the strip, one under the other": lineBoxes.length === 2 && lineBoxes[1].top >= lineBoxes[0].bottom && lineBoxes.every((line) => Math.abs(line.left - lineBoxes[0].left) < 1 && Math.abs(line.right - lineBoxes[0].right) < 1),
        "the strip is far below the old 45% of the panel": stripBox.height <= panel.height * STRIP_SHARE[viewport.width],
        "each open hand-off has its Stop, and there is no third": (await strip.getByTestId("bot-handoff-stop").count()) === 2 && (await lines.nth(0).getByTestId("bot-handoff-stop").count()) === 1 && (await lines.nth(1).getByTestId("bot-handoff-stop").count()) === 1,
        "the answered hand-off is absent: no line, title, state, scope or answer": !stripText.includes("Look at the relay token") && !stripText.includes("Answered") && !stripText.includes("No secret reaches the logs") && (await strip.getByTestId("bot-handoff-answer").count()) === 0 && (await strip.getByTestId("bot-handoff-scope").count()) === 0,
        "an open line has no scope and no asked or due line": !stripText.includes("Read the runner's setup") && !stripText.includes("before the run merges on Friday") && !stripText.includes("asked") && !stripText.includes("#7"),
        "the long title is whole in its tooltip, and cut on its line where the line is too short for it": titles[0]?.full === "Check the runner's secrets and network access before the run merges, a title long enough to truncate" && (viewport.width > 1280 || titles[0]?.cut === true),
        "what did not reach its chat shows, each with a Resend": (await strip.getByTestId("bot-handoff-undelivered-message").count()) === 2 && (await strip.getByTestId("bot-handoff-resend").count()) === 2,
        "the undelivered answer about the answered hand-off is among them": stripText.includes("An answer from Sentry to Atlas is not delivered"),
        "the states read Working… and Waiting · … is paused": states.length === 2 && states[0]?.startsWith("Working") && states[1] === "Waiting · Argus with a rather long name is paused",
        "only the working one spins": (await lines.nth(0).getByTestId("bot-handoff-state").locator(".animate-spin").count()) === 1 && (await lines.nth(1).getByTestId("bot-handoff-state").locator(".animate-spin").count()) === 0,
        "the message waiting for the paused bot's chat is counted on its line": (await waiting.count()) === 1 && (await lines.nth(1).getByTestId("bot-handoff-waiting").textContent())?.trim() === "1" && (await waiting.getAttribute("aria-label")) === "1 message waits for its chat to start",
        "Every bot reads lists the brief": (await view.getByTestId("bot-team-brief-row").textContent())?.includes("2 lines · changed outside"),
        "no page errors": errors.length === 0,
      }, { stripProblems, stripBox, panel, share: stripBox.height / panel.height, lineBoxes, titles, states, reach, errors });
      console.log(`     hand-off strip ${name}: strip ${stripBox.height.toFixed(1)}px of a ${panel.height.toFixed(1)}px panel (${(100 * stripBox.height / panel.height).toFixed(1)}%), lines ${lineBoxes.map((line) => line.height.toFixed(1)).join(" and ")}px high, rows ${reach.scrollHeight}px in ${reach.clientHeight}px`);

      // The team brief, where the chat was.
      await view.getByTestId("bot-team-brief-row").click();
      const brief = view.getByTestId("bot-team-brief");
      await brief.getByTestId("bot-team-brief-outside").waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-brief-${viewport.width}-${colorScheme}.png` });
      const briefProblems = await measure(page, selector);
      failed += report(`team brief ${name}`, { "fits the view": briefProblems.length === 0, "no page errors": errors.length === 0 }, { briefProblems, errors });

      // 23.01: Reports to, on the lead's Home.
      await view.getByRole("tab", { name: /Home/ }).click();
      const reports = view.getByTestId("bot-reports-to");
      await reports.getByTestId("bot-report").nth(1).waitFor();
      const homeProblems = await measure(page, selector);
      failed += report(`reports to ${name}`, {
        "fits the view": homeProblems.length === 0,
        "names the lead's reports": (await reports.getByRole("heading").textContent())?.startsWith("Reports to Atlas"),
      }, homeProblems);

      // 23.09: Hand to another bot.
      await view.getByText("Phase 2: merge main into phase-2 and fix what breaks").click();
      const itemPage = view.getByTestId("bot-item-page");
      await itemPage.getByTestId("bot-item-hand").click();
      await itemPage.getByTestId("bot-hand-form").waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-hand-${viewport.width}-${colorScheme}.png` });
      const handProblems = await measure(page, selector);
      const [formBox, titleBox] = await Promise.all([itemPage.getByTestId("bot-hand-form"), itemPage.getByRole("heading", { level: 1 })].map(box));
      failed += report(`hand to another bot ${name}`, {
        "fits the view": handProblems.length === 0,
        "the form stands above the title, not over it": formBox.bottom <= titleBox.top + 0.5,
        "no page errors": errors.length === 0,
      }, { handProblems, formBox, titleBox, errors });
      await page.close();
  }
  return failed;
}

// ---- bot-runs ----
// PRO-476: a bot leads an orchestration run, in real WebKit at 1440×900, 1280×800 and the window's smallest size, dark
// and light. The run plan card above the bot's chat (design 23.04), "Started by <bot>" with the run's row, the item's
// hand-offs to workers, its run links and check-back line (23.09), and the run chip on the bot's Home (23.01) stay
// inside the window, do not overlap, and the page never scrolls sideways.
async function botRuns() {
  const shots = process.env.BOT_RUNS_SHOTS;
  let failed = 0;
  const fixture = `
    const backend = window.__PW_STUB__;
    const at = new Date().toISOString();
    const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
    const tab = (id, status = "idle") => ({ id, harness: "claude", model: "", permissionMode: "bypassPermissions", status, created: at, modified: at });
    const chat = (id, title, bot, extra = {}) => ({ id, kind: "quick", projectPath: "/scratch/" + id, cwd: "/home/.raccoon/bots/" + bot.id, title, created: at, modified: at,
      archived: false, pinned: false, worktreeRemoved: false, tabs: [tab(id + "-t")], activeTab: id + "-t", bot, ...extra });
    const started = (id, title, extra = {}) => ({ id, kind: "quick", projectPath: "/code/app", cwd: "/code/app", title, created: at, modified: at,
      archived: false, pinned: false, worktreeRemoved: false, tabs: [tab(id + "-t")], activeTab: id + "-t", botStarted: { id: "b1" }, ...extra });
    backend.answers.list_sessions = [
      chat("bot-home", "Home chat", { id: "b1", home: true }),
      started("lead-1", "Lead: move macOS CI to our own runner"),
      started("lead-2", "Lead: Phase 2 restart"),
      started("w1", "Register the Mac mini as a runner"),
      started("w2", "Point the macOS jobs at it", { tabs: [tab("w2-t", "in_progress")], activeTab: "w2-t" }),
      started("loose", "fix/relay-token-log, a branch name long enough to truncate in the list"),
    ];
    backend.answers.load_tab_events = () => [];
    backend.answers.experimental_settings = { nativeCodex: false, bots: true, orchestratorRuns: true };
    backend.answers.bot_list = { revision: 1, unreadable: 0, bots: [{ id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "",
      access: "full", runsOn: "thisMac", reportsTo: "owner", worksIn: ["personal"], created: at, modified: at }] };
    backend.answers.bot_home_chat = () => backend.answers.list_sessions[0];
    backend.answers.bot_handoffs = () => ({ revision: 1, handoffs: [], waitingMessages: 0, undelivered: [], unreadable: 0 });
    backend.answers.bot_brief = () => ({ text: "", hash: "h", lines: 0, modified: at, outside: false, cut: false, unreadable: null, limit: 8192 });
    const piece = (id, title, agent, state, tries = []) => ({ id, title, agent, state, tries });
    const plan = { id: "run-1", goal: "Move macOS CI to our own runner, with a goal long enough to truncate in the card's header", state: "awaitingApproval", leadSessionId: "lead-1",
      estimate: { low: 4, high: 6 }, unestimated: 0, costUsd: null, minutes: 40, asked: at, decision: "", holdMerge: false, pieces: [
        piece("p1", "Register the Mac mini as a self-hosted runner with the labels the macOS jobs ask for", "codex", "queued"),
        piece("p2", "Point the macOS jobs at it", "codex", "queued"),
        piece("p3", "Check the secrets reach no log", "claude", "queued"),
      ] };
    const live = { ...plan, id: "run-2", goal: "Phase 2 restart", state: "running", leadSessionId: "lead-2", decision: "start", decided: at, costUsd: 2.4, pieces: [
      piece("p1", "Register the Mac mini as a runner", "codex", "done", [{ sessionId: "w1", branch: "orch/run-2/phase-2-merge-with-a-long-branch-name", started: minutesAgo(40), ended: minutesAgo(22), outcome: "done",
        report: "Registered as macos-mini; the job ran green on the first try and the cache restored in 40 seconds. Nothing else changed.", costUsd: 1.9 }]),
      piece("p2", "Point the macOS jobs at it", "codex", "running", [{ sessionId: "w2", branch: "orch/run-2/p2", started: minutesAgo(20), costUsd: 0.5 }]),
    ] };
    const item = (number, title, state, extra = {}) => ({ number, title, state, askedBy: "owner", addedBy: "b1", created: at, modified: at, spentUsd: 2.4, ...extra });
    const items = [
      item(14, "Move macOS CI to our own runner", "needsYou", { links: [{ kind: "session", target: "bot-home" }, { kind: "run", target: "run-1" }], runViews: [plan],
        question: { id: "q14", text: "Approve the plan and start the run?", answers: ["Approve and start", "Start, but ask before merging", "Not now"], recommended: 0, asked: at, purpose: "startRun", run: "run-1" } }),
      item(12, "Phase 2 restart", "inProgress", { links: [{ kind: "session", target: "bot-home" }, { kind: "run", target: "run-2" }, { kind: "pr", target: "https://github.com/example/app/pull/1400" }],
        runViews: [live], checkBack: { at: new Date(Date.now() + 30 * 60000).toISOString(), onReport: true, session: "lead-2" } }),
    ];
    backend.answers.bot_items = () => ({ botId: "b1", revision: 2, items, unreadable: 0 });
    backend.answers.bot_item = ({ number }) => ({ ...items.find((value) => value.number === number), activity: [
      { at: minutesAgo(45), by: "owner", kind: "gave", text: "You gave Atlas this work" },
      { at: minutesAgo(41), by: "owner", kind: "approved", text: "You approved the run and it started" },
      { at: minutesAgo(21), by: "terminalx", kind: "checkBack", text: "TerminalX woke Atlas: a worker reported" },
    ] });
    backend.answers.bots_needs_you = () => ({ entries: [{ kind: "item", botId: "b1", at, item: items[0] }], counts: [{ botId: "b1", needsYou: 1, inProgress: 1 }] });
    const run = (id, lead, goal, state, workers) => ({ id, lead: { sessionId: lead, tabId: lead + "-t" }, projectPath: "/code/app", goal, state, workerMode: "bypassPermissions",
      budget: {}, created: at, modified: at, pieces: workers.map((worker, index) => ({ id: "p" + index, title: "Piece " + index, agent: "codex", state: "running",
        worker: { sessionId: worker, tabId: worker + "-t" }, tries: [] })) });
    const runs = [run("run-1", "lead-1", plan.goal, "awaitingApproval", []), run("run-2", "lead-2", "Phase 2 restart", "running", ["w1", "w2"])];
    backend.answers.orchestration_runs = () => runs;
    backend.answers.orchestration_run_for_session = ({ sessionId }) => runs.find((value) => value.lead.sessionId === sessionId) ?? null;
  `;

  const box = (locator) => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  });
  const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

  /** Every visible control of the view stays inside it; buttons in one row do not overlap; the page does not scroll sideways. */
  async function measure(page, root) {
    return page.evaluate((selector) => {
      const view = document.querySelector(selector);
      const problems = [];
      if (!view) return ["no view"];
      const slot = view.getBoundingClientRect();
      if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
      // What a scroller hides above or below its edge is not on screen: each box is cut to its scrollers' visible part.
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        let { left, top, right, bottom } = rect;
        for (let parent = element.parentElement; parent && parent !== view.parentElement; parent = parent.parentElement) {
          if (!/auto|scroll|hidden/.test(getComputedStyle(parent).overflowY)) continue;
          const clip = parent.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        return { left, right, top, bottom, width: rect.width, height: Math.max(0, bottom - top) };
      };
      // Not what is hidden with visibility: the chat's Latest button waits so until the chat is scrolled up, and where it
      // waits in a short chat lies over the terminal view's own header, which the chat covers.
      const shown = [...view.querySelectorAll("button, h1, h2, input, textarea, li, [data-testid=needs-you-answer]")]
        .filter((element) => visible(element).width > 0 && visible(element).height > 0 && element.checkVisibility({ visibilityProperty: true }));
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
      // Run plan cards: the header, the pieces and the answers stay inside the card.
      for (const card of view.querySelectorAll("[data-testid=bot-run-plan]")) {
        const rect = card.getBoundingClientRect();
        for (const child of card.querySelectorAll("span, button, p")) {
          const inner = child.getBoundingClientRect();
          if (inner.width && (inner.right > rect.right + 1 || inner.left < rect.left - 1)) problems.push(`run plan ${card.textContent.slice(0, 30)}: "${child.textContent.trim().slice(0, 20)}" spills out`);
        }
      }
      // Item rows: the title truncates inside its row.
      for (const row of view.querySelectorAll("[data-testid=bot-item-row]")) {
        const rect = row.getBoundingClientRect();
        for (const child of row.querySelectorAll("span")) {
          const inner = child.getBoundingClientRect();
          if (inner.width && inner.right > rect.right + 1) problems.push(`item row ${row.textContent.slice(0, 30)}: text spills out`);
        }
      }
      return problems;
    }, root);
  }

  for (const { viewport, colorScheme } of matrix(shots)) {
      const name = `${viewport.width}×${viewport.height} ${colorScheme}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await sidebar(page);
      const view = await openSession(page, "bot-home", "Atlas, CTO");
      const selector = "main[aria-label='Atlas, CTO']";

      // 23.04: the run plan card above the chat, and "Started by Atlas" with each run as one row.
      const plans = view.getByTestId("bot-run-plans");
      await plans.getByTestId("bot-run-plan-piece").nth(2).waitFor();
      await view.getByTestId("bot-started-run").nth(1).waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-run-plan-${viewport.width}-${colorScheme}.png` });
      const planProblems = await measure(page, "[data-testid=bot-run-plans]");
      const listProblems = await measure(page, selector);
      const [plansBox, panel] = await Promise.all([box(plans), box(view.getByRole("tabpanel", { name: "Chat" }))]);
      const startedRuns = await view.getByTestId("bot-started-run").allTextContents();
      failed += report(`run plan card ${name}`, {
        "fits the view": planProblems.length === 0 && listProblems.length === 0,
        "the card leaves room for the chat": plansBox.height <= panel.height * 0.6,
        "three answers, the first recommended": (await plans.getByTestId("needs-you-answer").count()) === 3 && (await plans.getByTestId("needs-you-answer").first().textContent())?.includes("recommended"),
        "each run is one row with its state": startedRuns.length === 2 && startedRuns[0].includes("plan waits for you") && startedRuns[1].includes("2 workers running"),
        "the leads and workers fold under their run": !(await view.getByText("Register the Mac mini as a runner", { exact: true }).count()),
        "no page errors": errors.length === 0,
      }, { planProblems, listProblems, plansBox, panel, startedRuns, errors });

      // 23.01: the run chips on Home.
      await view.getByRole("tab", { name: /Home/ }).click();
      await view.getByTestId("needs-you-run-plan").waitFor();
      const homeProblems = await measure(page, selector);
      failed += report(`home run chips ${name}`, {
        "fits the view": homeProblems.length === 0,
        "the item at work shows its workers": (await view.getByTestId("bot-item-run-chip").allTextContents()).includes("1 worker running"),
      }, homeProblems);

      // 23.09: the item with its run, hand-offs to workers and check-back.
      await view.getByText("Phase 2 restart", { exact: true }).first().click();
      const itemPage = view.getByTestId("bot-item-page");
      await itemPage.getByTestId("bot-item-handoff-row").nth(1).waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-run-item-${viewport.width}-${colorScheme}.png` });
      const itemProblems = await measure(page, selector);
      failed += report(`item with a run ${name}`, {
        "fits the view": itemProblems.length === 0,
        "the run and its two workers are linked": (await itemPage.getByTestId("bot-item-run-worker").count()) === 2,
        "the check-back line shows": (await itemPage.getByTestId("bot-item-check-back").textContent())?.includes("Nothing runs and nothing is spent while it waits."),
        "no page errors": errors.length === 0,
      }, { itemProblems, errors });
      await page.close();
  }
  return failed;
}

// ---- bot-suggestions ----
// PRO-477: a bot's Home tab (design 23.01) with its right column: Up next, the bot's next duty runs, and the
// Suggestions its look around made, each with Start and Dismiss under a line saying how the last look went. In real
// WebKit at 1440×900, 1280×800 and the window's smallest size, dark and light: the column stays inside the window,
// sits beside the work lists in a wide window and under them in a narrow one, nothing overlaps, and the page never
// scrolls sideways. Start and Dismiss are pressed and their suggestions leave the list.
async function botSuggestions() {
  const shots = process.env.BOT_SUGGESTIONS_SHOTS;
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

  for (const { viewport, colorScheme } of matrix(shots)) {
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
  return failed;
}
// Each part runs even when one before it throws, as it did in its own process: what threw is printed and fails this check.
try {
  for (const [name, part] of [["bot-items", botItems], ["bot-handoffs", botHandoffs], ["bot-runs", botRuns], ["bot-suggestions", botSuggestions]]) {
    try {
      failed += await part();
    } catch (error) {
      console.log(`FAIL ${name}: stopped by an error\n${error.stack ?? error}`);
      failed++;
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
