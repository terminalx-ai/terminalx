#!/usr/bin/env node
// PRO-540: the Hand-offs page under Bots (designs 23.16 and 23.19), in real WebKit at 1440×900, 1280×800 and the
// window's smallest size, dark and light.
// The page (23.16): from the Bots page's Hand-offs button, which counts the open chains. The list of chains stands
// left of one chain's thread and neither covers the other; the thread's steps are stepped in 28px for each hand-off
// deeper, a retry where the hand-off it tries again is; every step's names, number, state, Stop and time stay inside
// the step and do not overlap; every Stop can be scrolled fully into view; nothing leaves the window and the page
// never scrolls sideways.
// Its states (23.19): some unreadable (the sentence above the list), the read failed (the error row with Retry, never
// "No hand-offs yet"), empty, and loading.
// A way in: the hand-off row among an item's links opens the thread that holds that hand-off, at that step.
// Under 820 wide the page keeps its two columns: folding to one (23.18) is not built. The 760 case checks that the two
// columns stay usable there, and prints how wide each is.
// Run after pnpm build: node scripts/webkit/bot-handoffs-page.mjs
// BOT_HANDOFFS_PAGE_SHOTS=<dir> saves a screenshot of each case.
import { launch, open, openSession, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.BOT_HANDOFFS_PAGE_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;

const fixture = `
  const backend = window.__PW_STUB__;
  const at = new Date().toISOString();
  const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  const tab = (id) => ({ id, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: at, modified: at });
  const chat = (id, title, bot) => ({ id, kind: "quick", projectPath: "/scratch/" + id, cwd: "/home/.raccoon/bots/" + bot.id, title, created: at, modified: at,
    archived: false, pinned: false, worktreeRemoved: false, tabs: [tab(id + "-t")], activeTab: id + "-t", bot });
  backend.answers.list_sessions = [chat("atlas-home", "Home chat", { id: "atlas", home: true }), chat("mira-home", "Home chat", { id: "mira", home: true })];
  backend.answers.load_tab_events = () => [];
  backend.answers.experimental_settings = { nativeCodex: false, bots: true };
  const bot = (id, name, roleTitle, roleTemplateId, reportsTo, extra = {}) => ({ id, slug: id, name, roleTitle, roleTemplateId, harness: "claude", model: "", access: "full", runsOn: "thisMac",
    reportsTo, worksIn: ["personal"], created: at, modified: at, ...extra });
  backend.answers.bot_list = { revision: 1, unreadable: 0, bots: [
    bot("atlas", "Atlas", "CTO", "cto", "owner"),
    bot("mira", "Mira", "Chief of staff", "chief-of-staff", "atlas"),
    bot("iris", "Iris", "UX designer", "ux-designer", "mira"),
    bot("kestrel", "Kestrel", "QA engineer", "qa-engineer", "iris", { paused: { at, by: "owner" } }),
  ] };
  backend.answers.bot_home_chat = ({ id }) => backend.answers.list_sessions.find((value) => value.bot.id === id && value.bot.home);
  backend.answers.bot_spent_today = { usd: 0, day: new Date().toDateString() };
  backend.answers.automations_list = [];
  backend.answers.bot_brief = () => ({ text: "", hash: "h1", lines: 0, modified: at, outside: false, cut: false, unreadable: null, limit: 8192 });
  const handoff = (number, from, to, extra) => ({ number, from, to, by: from, title: "Hand-off " + number, state: "working", depth: 1, created: ago(70 - number * 5), modified: at,
    started: ago(52), waitingMessages: 0, ...extra });
  const handoffs = [
    handoff(7, "mira", "kestrel", { state: "stopped", stoppedBy: "owner", title: "List the open issues with no owner", closed: ago(4) }),
    handoff(6, "atlas", "mira", { state: "answered", title: "Say which checks still run on the hosted runner", closed: ago(5), answer: { at: ago(5), by: "mira", text: "Only the Linux ones." } }),
    // Sent from a home chat while its sender held open work: the limit counts it 2 deep, and it has no parent.
    handoff(5, "mira", "iris", { depth: 2, title: "Design the status page: how an outage is said", scope: "One page, readable on a phone, with what is down and since when." }),
    handoff(4, "iris", "kestrel", { retryOf: 3, attempt: 1, depth: 3, state: "waiting", started: undefined, title: "Check the offline screens at 760 wide, light and dark", waitingMessages: 1 }),
    handoff(3, "iris", "kestrel", { parent: 2, depth: 3, state: "failed", title: "Check the offline screens at 760 wide, light and dark", closed: ago(30),
      answer: { at: ago(30), by: "kestrel", failed: true, text: "I could not do it: the screens are designs only, and there is no build to run the layout checks on." } }),
    handoff(2, "mira", "iris", { parent: 1, depth: 2, state: "answered", title: "Design offline mode: what works without a connection, and how the app says so", closed: ago(40),
      answer: { at: ago(40), by: "iris", text: "The offline designs are done, in light and dark, and linked on the issue. Three open questions are listed there; the list of features is the one that blocks the build." } }),
    handoff(1, "atlas", "mira", { item: 3, toSession: "mira-work", fromSession: "atlas-home", title: "Offline mode: get the screens designed before any build work",
      scope: "Offline mode needs screens for what works without a connection before anyone builds it. Get the design done and bring me the open questions. The list of features is not settled yet." }),
  ];
  const listing = (handoffs, extra = {}) => ({ revision: 3, handoffs, waitingMessages: 1, undelivered: [], unreadable: 0, unreadableHandoffs: 0, unreadableMessages: 0, maxDepth: 3, maxRetries: 2, ...extra });
  // Which answer the page gets: a check sets it, then makes the page read again.
  window.__HANDOFFS_CASE__ = "chain";
  backend.answers.bot_handoffs = ({ id }) => {
    const mine = id ? handoffs.filter((value) => value.from === id || value.to === id) : handoffs;
    switch (window.__HANDOFFS_CASE__) {
      case "loading":
        return new Promise(() => undefined);
      case "empty":
        return listing([]);
      case "failed":
        throw "/Users/you/.raccoon/bot-handoffs.json cannot be read; it is left as it is";
      case "unreadable":
        return listing(mine, { unreadable: 5, unreadableHandoffs: 2, unreadableMessages: 3 });
      default:
        return listing(mine);
    }
  };
  const item = { number: 3, title: "Offline mode: get the screens designed before any build work", state: "inProgress", askedBy: "atlas", addedBy: "atlas", created: at, modified: at, spentUsd: 0.4 };
  backend.answers.bot_items = ({ id }) => ({ botId: id, revision: 2, items: id === "mira" ? [item] : [], unreadable: 0 });
  backend.answers.bot_item = () => ({ ...item, activity: [{ at, by: "atlas", kind: "added", text: "Atlas handed this on" }] });
  backend.answers.bots_needs_you = () => ({ entries: [], counts: [] });
`;

const box = (locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
});

/** What is wrong with the page's layout, as sentences; none when it is sound. */
async function measure(page) {
  return page.evaluate(async () => {
    const problems = [];
    const view = document.querySelector("[data-testid=bots-handoffs]");
    if (!view) return ["no Hand-offs page"];
    const slot = view.getBoundingClientRect();
    const text = (element) => (element.textContent ?? "").trim().slice(0, 32) || element.getAttribute("data-testid") || element.tagName;
    const crosses = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    for (const element of view.querySelectorAll("button, h1, h2, p, time, [data-testid=bots-handoffs-step-depth]")) {
      const rect = element.getBoundingClientRect();
      if (rect.width && (rect.left < slot.left - 1 || rect.right > slot.right + 1)) problems.push(`"${text(element)}" leaves the page`);
    }
    const list = view.querySelector("[data-testid=bots-handoffs-list]");
    const thread = view.querySelector("[data-testid=bots-handoffs-thread]");
    if (list && thread) {
      const [a, b] = [list.getBoundingClientRect(), thread.getBoundingClientRect()];
      if (a.right > b.left + 1) problems.push(`the list (to ${a.right}) covers the thread (from ${b.left})`);
      if (a.width < 150) problems.push(`the list is ${a.width}px wide`);
      if (b.width < 240) problems.push(`the thread is ${b.width}px wide`);
      for (const row of list.querySelectorAll("[data-testid=bots-handoffs-chain]")) {
        const rect = row.getBoundingClientRect();
        for (const child of row.querySelectorAll("span")) {
          const inner = child.getBoundingClientRect();
          if (inner.width && (inner.right > rect.right + 1 || inner.left < rect.left - 1)) problems.push(`chain "${text(row)}": "${text(child)}" spills out of its row`);
        }
      }
    }
    const scroller = view.querySelector("[data-testid=bots-handoffs-steps]");
    for (const step of view.querySelectorAll("[data-testid=bots-handoffs-step]")) {
      const name = `step ${step.dataset.number}`;
      const rect = step.getBoundingClientRect();
      const clip = scroller.getBoundingClientRect();
      if (rect.left < clip.left - 1 || rect.right > clip.right + 1) problems.push(`${name} leaves the thread`);
      // Its head: both names, the number, the state, Stop and the time. Each inside the step, none over another.
      const head = [...step.querySelectorAll("[data-testid=bots-handoffs-step-depth], [data-testid=bots-handoffs-step-state], [data-testid=bots-handoffs-stop], time, .truncate.font-medium, .min-w-0.truncate:not(button *):not([data-testid] *)")];
      const parts = [...new Set(head)].filter((element) => element.getBoundingClientRect().width > 0 && !element.closest("[data-testid=bots-handoffs-step-state]")?.contains(element) || element.matches("[data-testid=bots-handoffs-step-state]"));
      for (const part of parts) {
        const inner = part.getBoundingClientRect();
        if (inner.left < rect.left - 1 || inner.right > rect.right + 1) problems.push(`${name}: "${text(part)}" is cut off by the step`);
      }
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
        if (parts[i].contains(parts[j]) || parts[j].contains(parts[i])) continue;
        if (crosses(parts[i].getBoundingClientRect(), parts[j].getBoundingClientRect())) problems.push(`${name}: "${text(parts[i])}" overlaps "${text(parts[j])}"`);
      }
      // Stop is whole once scrolled to: not cut by the thread's edge, with its bot's name readable.
      const stop = step.querySelector("[data-testid=bots-handoffs-stop]");
      if (stop) {
        stop.scrollIntoView({ block: "center" });
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const [inner, now] = [stop.getBoundingClientRect(), scroller.getBoundingClientRect()];
        if (inner.left < now.left - 1 || inner.right > now.right + 1 || inner.top < now.top - 1 || inner.bottom > now.bottom + 1) problems.push(`${name}: Stop is clipped by the thread`);
        const label = stop.querySelector("span");
        if (label && label.scrollWidth > label.clientWidth + 1) problems.push(`${name}: Stop's label is cut ("${text(stop)}")`);
        if (inner.height < 20) problems.push(`${name}: Stop is ${inner.height}px high`);
      }
      // The card under the head holds its text.
      for (const paragraph of step.querySelectorAll("p")) {
        const inner = paragraph.getBoundingClientRect();
        if (inner.width && (inner.right > rect.right + 1 || inner.left < rect.left - 1)) problems.push(`${name}: "${text(paragraph)}" spills out of its card`);
      }
    }
    scroller?.scrollTo(0, 0);
    return problems;
  });
}

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 760, height: 520 }]) {
    for (const colorScheme of ["dark", "light"]) {
      const name = `${viewport.width}×${viewport.height} ${colorScheme}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = async (what) => { if (shots) await page.screenshot({ path: `${shots}/bot-handoffs-page-${what}-${viewport.width}-${colorScheme}.png` }); };
      const setCase = (value) => page.evaluate((next) => { window.__HANDOFFS_CASE__ = next; }, value);
      const readAgain = () => page.evaluate(() => window.__PW_STUB__.emit("bot_handoffs_changed", { revision: 4 }));

      // The way in from the Bots page: a Hand-offs button beside Calendar, with how many chains are open.
      const rail = await sidebar(page);
      await rail.getByTestId("destination-list").getByRole("button", { name: "Bots", exact: true }).click();
      const main = page.locator("main");
      const button = main.getByTestId("bots-handoffs-open");
      await button.getByTestId("bots-handoffs-open-count").waitFor();
      const [calendarBox, buttonBox] = await Promise.all([box(main.getByTestId("bots-calendar")), box(button)]);
      const buttonText = `${await button.evaluate((element) => element.firstChild?.nextSibling?.textContent?.trim() ?? "")} ${await button.getByTestId("bots-handoffs-open-count").textContent()}`;
      await shot("button");
      await button.click();

      // 23.16: the chain three deep, with its retry.
      const view = main.getByTestId("bots-handoffs");
      await view.locator("[data-testid=bots-handoffs-chain][data-chain='1']").click();
      const thread = view.getByTestId("bots-handoffs-thread");
      await thread.locator("[data-testid=bots-handoffs-step][data-number='4']").waitFor();
      await shot("chain");
      const problems = await measure(page);
      const steps = await thread.getByTestId("bots-handoffs-step").evaluateAll((all) => all.map((step) => ({ number: step.dataset.number, level: Number(step.dataset.level), left: step.getBoundingClientRect().left })));
      const [listBox, threadBox] = await Promise.all([box(view.getByTestId("bots-handoffs-list")), box(thread)]);
      failed += report(`hand-offs page ${name}`, {
        "the Hand-offs button stands right of Calendar, in its row, and counts the two open chains": buttonBox.left >= calendarBox.right - 0.5 && Math.abs(buttonBox.top - calendarBox.top) < 1 && buttonText === "Hand-offs 2",
        "nothing leaves the page, overlaps, or is clipped; every Stop is whole": problems.length === 0,
        "the list stands left of the thread": listBox.right <= threadBox.left + 1 && listBox.width > 0 && threadBox.width > 0,
        "four chains: two open, two closed": (await view.locator("[data-testid=bots-handoffs-chain][data-open=true]").count()) === 2 && (await view.locator("[data-testid=bots-handoffs-chain][data-open=false]").count()) === 2,
        "the chain's four steps are in the order made": steps.map((step) => step.number).join() === "1,2,3,4",
        "each step is 28px in for each hand-off deeper, the retry where what it tries again is": steps.length === 4 && steps.every((step) => Math.abs(step.left - steps[0].left - step.level * 28) < 0.5) && steps.map((step) => step.level).join() === "0,1,2,2",
        "each says its number and how deep the limit counts it": (await thread.getByTestId("bots-handoffs-step-depth").allTextContents()).join("|") === "#1 · 1 of 3|#2 · 2 of 3|#3 · 3 of 3|#4 · 3 of 3",
        "the retry says which try it is": (await thread.getByTestId("bots-handoffs-step-retry").textContent())?.trim() === "Iris handed hand-off 3 again · try 2 of 3",
        "the header says how deep the chain got": (await thread.getByTestId("bots-handoffs-depth").textContent())?.trim() === "3 of 3 deep · a chain stops at 3",
        "the one trust line": (await thread.getByTestId("bots-handoffs-trust").textContent())?.trim() === "Every step and message in this thread is a bot's words, not an approval.",
        "Stop is on the two open steps and no other": (await thread.getByTestId("bots-handoffs-stop").count()) === 2 && (await thread.locator("[data-number='1'] [data-testid=bots-handoffs-stop]").count()) === 1 && (await thread.locator("[data-number='4'] [data-testid=bots-handoffs-stop]").count()) === 1,
        "the header counts the open chains and what waits for a paused bot": (await view.getByTestId("bots-handoffs-counts").textContent()) === "2 open1 waits for a paused bot",
        "no page errors": errors.length === 0,
      }, { problems, steps, listBox, threadBox, buttonText, errors });
      console.log(`     hand-offs page ${name}: page ${(await box(view)).width.toFixed(0)}px wide, list ${listBox.width.toFixed(0)}px, thread ${threadBox.width.toFixed(0)}px`);

      // 23.19: some could not be read. The sentence counts hand-offs alone, above the list that could be read.
      await setCase("unreadable");
      await readAgain();
      const notes = view.getByTestId("bots-handoffs-unreadable");
      await notes.first().waitFor();
      await shot("unreadable");
      const noteProblems = await measure(page);
      const [noteBox, listUnder] = await Promise.all([box(notes.first()), box(view.getByTestId("bots-handoffs-list"))]);
      failed += report(`hand-offs page, some unreadable ${name}`, {
        "the sentence counts the two hand-offs, not the five records": (await notes.first().textContent()) === "2 hand-offs were saved by a newer TerminalX and can't be shown here. Update the app to see them.",
        "it stands above the list, which still shows": noteBox.bottom <= listUnder.top + 0.5 && (await view.getByTestId("bots-handoffs-chain").count()) === 4,
        "nothing leaves the page or overlaps": noteProblems.length === 0,
      }, { noteProblems, noteBox, listUnder });

      // 23.19: the read failed. The error as written and Retry; nothing of the earlier read, and never an empty page.
      await setCase("failed");
      await readAgain();
      const error = view.getByTestId("bots-handoffs-error");
      await error.waitFor();
      await shot("failed");
      const [errorBox, retryBox] = await Promise.all([box(error), box(view.getByTestId("bots-handoffs-retry"))]);
      failed += report(`hand-offs page, the read failed ${name}`, {
        "says what could not be read, as written": (await error.textContent())?.includes("Couldn't read the hand-offs: /Users/you/.raccoon/bot-handoffs.json cannot be read; it is left as it is"),
        "Retry is inside the row": retryBox.left >= errorBox.left && retryBox.right <= errorBox.right + 0.5 && retryBox.top >= errorBox.top && retryBox.bottom <= errorBox.bottom + 0.5,
        "it is not an empty page, and nothing of the earlier read stays": (await view.getByText("No hand-offs yet").count()) === 0 && (await view.getByTestId("bots-handoffs-list").count()) === 0 && (await view.getByTestId("bots-handoffs-counts").count()) === 0,
        "the page does not scroll sideways": await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      }, { errorBox, retryBox });

      // 23.19: empty, reached by Retry once the read works.
      await setCase("empty");
      await view.getByTestId("bots-handoffs-retry").click();
      const empty = view.getByTestId("bots-handoffs-empty");
      await empty.waitFor();
      await shot("empty");
      const [emptyBox, viewBox, textBox] = await Promise.all([box(empty), box(view), box(empty.locator("p"))]);
      failed += report(`hand-offs page, empty ${name}`, {
        "No hand-offs yet, and what brings one": (await empty.getByRole("heading").textContent()) === "No hand-offs yet" && (await empty.locator("p").textContent())?.startsWith("When one bot hands work to another"),
        "no button starts anything": (await empty.getByRole("button").count()) === 0,
        "its text is inside the page": textBox.left >= viewBox.left && textBox.right <= viewBox.right + 0.5 && emptyBox.bottom <= viewBox.bottom + 0.5,
      }, { emptyBox, viewBox, textBox });

      // 23.19: loading. The page is opened again while the read has not ended.
      await setCase("loading");
      await view.getByTestId("bots-handoffs-back").click();
      await main.getByTestId("bots-handoffs-open").click();
      const reading = view.getByTestId("bots-handoffs-reading");
      await reading.waitFor();
      await shot("loading");
      failed += report(`hand-offs page, loading ${name}`, {
        "says it is reading": (await reading.textContent())?.trim() === "Reading the hand-offs…",
        "no counts, no list and no empty page until the read ends": (await view.getByTestId("bots-handoffs-counts").count()) === 0 && (await view.getByTestId("bots-handoffs-list").count()) === 0 && (await view.getByTestId("bots-handoffs-empty").count()) === 0,
      });

      // A way in: the hand-off row among an item's links opens the thread that holds it, at that step.
      await setCase("chain");
      const mira = await openSession(page, "mira-home", "Mira, Chief of staff");
      await mira.getByRole("tab", { name: /Home/ }).click();
      await mira.getByText("Offline mode: get the screens designed before any build work").first().click();
      const row = mira.getByTestId("bot-item-handoff-link");
      await row.waitFor();
      const [rowBox, asideBox] = await Promise.all([box(row), box(mira.getByTestId("bot-item-aside"))]);
      const rowText = (await row.textContent())?.replace(/\s+/g, " ").trim();
      await shot("item-row");
      await row.click();
      const opened = page.locator("main").getByTestId("bots-handoffs-thread");
      await opened.locator("[data-testid=bots-handoffs-step][aria-current=step]").waitFor();
      failed += report(`hand-off row on an item's page ${name}`, {
        "names the hand-off and the bot it came from, inside the item's links": rowText?.startsWith("Hand-off 1 · from Atlas") && rowBox.left >= asideBox.left - 0.5 && rowBox.right <= asideBox.right + 0.5,
        "opens the thread that holds it": (await opened.getAttribute("data-chain")) === "1",
        "at that step": (await opened.locator("[data-testid=bots-handoffs-step][aria-current=step]").getAttribute("data-number")) === "1",
        "no page errors": errors.length === 0,
      }, { rowText, rowBox, asideBox, errors });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
