#!/usr/bin/env node
// PRO-475: bots as a team, in real WebKit at 1440×900, 1280×800 and the window's smallest size, dark and light. The
// team brief under "Every bot reads", "Reports to" on a lead's Home (23.01) and "Hand to another bot" on an item's
// page (23.09) stay inside the window, do not overlap, and the page never scrolls sideways.
// PRO-520 (PRO-517 decision 2, in place of design 23.04's cards): the strip above a bot's chat holds one line for each
// open hand-off and nothing for a finished one. Of the fixture's three hand-offs (working, waiting for a paused bot,
// answered) exactly two lines show, each one line high with its state and its Stop; the answered one is absent, with
// its scope and its answer; the two undelivered messages, one of them about the answered hand-off, still show with a
// Resend; and the strip is a small part of the panel, where the cards took up to 45% of it.
// Run after pnpm build: node scripts/webkit/bot-handoffs.mjs
// BOT_HANDOFFS_SHOTS=<dir> saves a screenshot of each case.
import { launch, open, openSession, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.BOT_HANDOFFS_SHOTS;
const server = await serve();
const browser = await launch();
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

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 760, height: 520 }]) {
    for (const colorScheme of ["dark", "light"]) {
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
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
