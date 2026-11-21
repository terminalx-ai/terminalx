#!/usr/bin/env node
// PRO-469: a bot's Home tab (design 23.01) and a work item's page (23.09), and the Bots page's Needs you queue (23.02),
// in real WebKit at 1440×900, 1280×800 and the window's smallest size, dark and light. The Needs you card's answers,
// the In progress and Planned lists, the item page's main column and its right column stay inside the window, do not
// overlap, and the page never scrolls sideways.
// Run after pnpm build: node scripts/webkit/bot-items.mjs
// BOT_ITEMS_SHOTS=<dir> saves a screenshot of each case.
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.BOT_ITEMS_SHOTS;
const server = await serve();
const browser = await launch();
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

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 760, height: 520 }]) {
    for (const colorScheme of ["dark", "light"]) {
      const name = `${viewport.width}×${viewport.height} ${colorScheme}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const rail = await sidebar(page);
      await page.evaluate(() => window.__PW_STUB__.emit("open_session", { sessionId: "bot-home" }));
      const view = page.getByRole("main", { name: "Kestrel, CTO" });
      await view.waitFor();
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
      await queue.getByTestId("needs-you-row").waitFor();
      const queueProblems = await page.evaluate(() => {
        const main = document.querySelector("main").getBoundingClientRect();
        const problems = [];
        if (document.documentElement.scrollWidth > innerWidth + 1) problems.push("page scrolls sideways");
        for (const element of document.querySelectorAll("[data-testid=bots-needs-you] button, [data-testid=bots-needs-you] p")) {
          const rect = element.getBoundingClientRect();
          if (rect.width && (rect.left < main.left - 1 || rect.right > main.right + 1)) problems.push(`"${element.textContent.trim().slice(0, 40)}" leaves the main slot`);
        }
        return problems;
      });
      failed += report(`needs you queue ${name}`, { "fits the main slot": queueProblems.length === 0 }, queueProblems);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
