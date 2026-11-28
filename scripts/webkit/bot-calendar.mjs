#!/usr/bin/env node
// PRO-473: the week of duties (design 23.13) in real WebKit, at 1440×900 and at the scaled 1280×800, dark and light:
// from the Bots page's Calendar button (every bot's week, with the bot filter) and as the Calendar view of a bot's
// Duties tab. The toolbar's controls do not overlap; the seven day columns line up with their heads and with the two
// counted rows; every block stays inside its day; the right column (next today, the week so far, the key, quiet hours)
// stands right of the grid; nothing leaves the window, and no page error. Every hour of the week takes a click and the
// focus, below the counted rows and above the two hints (PRO-511).
// Run after pnpm build: node scripts/webkit/bot-calendar.mjs
// BOT_CALENDAR_SHOTS=<dir> saves a screenshot of each case.
import { launch, open, openSession, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.BOT_CALENDAR_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;

const fixture = `
  const backend = window.__PW_STUB__;
  const at = new Date().toISOString();
  const tab = (id) => ({ id, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: at, modified: at });
  backend.answers.list_sessions = [{ id: "bot-home", kind: "quick", projectPath: "/scratch/home", cwd: "/home/.raccoon/bots/b1", title: "Home chat", created: at, modified: at,
    archived: false, pinned: false, worktreeRemoved: false, tabs: [tab("bot-home-t")], activeTab: "bot-home-t", bot: { id: "b1", home: true } }];
  backend.answers.load_tab_events = () => [];
  backend.answers.experimental_settings = { nativeCodex: false, bots: true };
  const bot = (id, slug, name, roleTitle, roleTemplateId) => ({ id, slug, name, roleTitle, roleTemplateId, harness: "claude", model: "", access: "full", runsOn: "thisMac",
    reportsTo: "owner", worksIn: ["personal"], created: at, modified: at });
  const bots = [bot("b1", "atlas", "Atlas", "CTO", "cto"), bot("b2", "iris", "Iris", "UX designer", "ux-designer"), bot("b3", "sentry", "Sentry", "Security auditor", "security-auditor"),
    bot("b4", "argus", "Argus the watcher of long-running things", "Watcher", "watcher")];
  backend.answers.bot_list = { revision: 1, bots, unreadable: 0 };
  backend.answers.bot_home_chat = () => backend.answers.list_sessions[0];
  backend.answers.bot_spent_today = { usd: 0.21, day: new Date().toDateString() };
  backend.answers.bot_duties = { quietHours: { from: "22:00", to: "07:00" }, notes: {}, home: "/home/.raccoon/bots/b1" };
  const duty = (id, name, botId, cron) => ({ id, name, enabled: true, projectPath: "/home/.raccoon/bots/" + botId, harness: "claude", model: "", mode: "bypassPermissions",
    prompt: "Look.", workspace: "newWorktree", reuseSession: false, archiveOnComplete: false, keepLatestRunVisible: false,
    schedule: { kind: "cron", cron, weekdays: [], timezone: "UTC", dtstart: "2026-01-01T00:00:00Z" }, precheck: null,
    missedRunGraceMinutes: 30, nextRunAt: new Date(Date.now() + 3600000).toISOString(), created: at, modified: at, bot: { id: botId, reportsTo: "terminalx" } });
  backend.answers.automations_list = [
    duty("d1", "Look around", "b1", "0 10,14 * * *"), duty("d2", "Daily status for the owner, in a table with every run", "b1", "0 18 * * *"),
    duty("d3", "Design check", "b2", "0 16 * * 2,4"), duty("d4", "Audit of main", "b3", "0 11 * * 1"), duty("d5", "Phase 2 drift", "b4", "0 9 * * *"),
    duty("d6", "Stalled sessions and runs", "b4", "*/15 * * * *"),
  ];
  backend.answers.automation_runs = () => [];
  // This week, Monday first, in UTC; today is drawn with the now line.
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  const days = Array.from({ length: 7 }, (_, n) => new Date(monday.getTime() + n * 86400000).toISOString().slice(0, 10));
  const today = (now.getUTCDay() + 6) % 7;
  const block = (dutyId, botId, day, hour, state) => ({ dutyId, botId, day, minute: hour * 60, at: days[day] + "T" + String(hour).padStart(2, "0") + ":00:00Z", state, count: 1 });
  const blocks = [];
  for (let day = 0; day < 7; day++) {
    const state = (done) => day < today ? done : day === today ? "next" : "next";
    blocks.push(block("d5", "b4", day, 9, state(day % 2 ? "reported" : "quiet")));
    blocks.push(block("d1", "b1", day, 10, state("done")), block("d1", "b1", day, 14, state(day % 3 ? "quiet" : "done")));
    blocks.push(block("d2", "b1", day, 18, state(day === 2 ? "failed" : "done")));
    if (day === 1 || day === 3) blocks.push(block("d3", "b2", day, 16, state("reported")));
    // Two at once share the column.
    if (day === 0) blocks.push(block("d4", "b3", day, 10, state("reported")));
  }
  const count = (day, ran, reports, perDay) => ({ notKept: 0, capped: false, ...(day < today ? { ran, reports, failed: 0, planned: 0, scheduled: perDay } : day === today ? { ran: Math.floor(ran / 2), reports, failed: 0, planned: perDay / 2, scheduled: perDay } : { ran: 0, reports: 0, failed: 0, planned: perDay, scheduled: perDay }) });
  // The often duty's log no longer reaches back over Monday, and part of Tuesday (when they have passed).
  const often = days.map((_, day) => count(day, 96, day % 2, 96));
  if (today > 0) often[0] = { ...often[0], ran: 0, reports: 0, notKept: 1 };
  if (today > 1) often[1] = { ...often[1], ran: 28, notKept: 1 };
  const week = (id) => ({
    timezone: "UTC", days, today, nowMinute: now.getUTCHours() * 60 + now.getUTCMinutes(),
    blocks: id ? blocks.filter((value) => value.botId === id) : blocks,
    often, oftenDuties: ["d6"],
    events: days.map((_, day) => count(day, 6 + day, day % 2, 0)), eventDuties: ["d7"],
    nextToday: [{ dutyId: "d6", botId: "b4", minute: 13 * 60 + 30, at }, { dutyId: "d1", botId: "b1", minute: 14 * 60, at }, { dutyId: "d2", botId: "b1", minute: 18 * 60, at }]
      .filter((next) => next.minute >= now.getUTCHours() * 60 + now.getUTCMinutes()),
    totals: { checks: 4120, nothingNew: 4010, reports: 110, atLeast: true },
    quietHours: { b1: { from: "22:00", to: "07:00" }, b4: { from: "20:00", to: "08:00" } },
    notKept: days.map((_, day) => day === 0 && today > 0 ? [{ dutyId: "d1", untilMinute: 1440 }] : day === 1 && today > 1 ? [{ dutyId: "d1", untilMinute: 600 }] : []),
    logs: [
      { dutyId: "d6", botId: "b4", keptFrom: days[Math.min(1, today)] + "T10:00:00Z" },
      { dutyId: "d2", botId: "b1", unreadable: "runs.jsonl: line 3 is not JSON: expected value at line 1 column 1, and the rest of a long reason that has to wrap or cut inside its row" },
    ].filter((log) => !id || log.botId === id),
  });
  backend.answers.bot_duty_week = ({ id }) => week(id);
`;

const box = (locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
});
const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
const disjoint = (boxes) => boxes.every((a, i) => boxes.every((b, j) => i >= j || !overlaps(a, b)));

/** The calendar's own checks: toolbar, columns, rows, blocks, right column. */
async function measure(page, calendar, viewport) {
  const window_ = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const [calendarBox, toolbarBox, mainBox, asideBox, gridBox, scrollBox] = await Promise.all(
    ["", "calendar-toolbar", "calendar-main", "calendar-aside", "calendar-grid", "calendar-scroll"].map((id) => box(id ? calendar.getByTestId(id) : calendar)),
  );
  // Each control once: the List | Calendar switch as a whole, not its two choices as well.
  const controls = await calendar.getByTestId("calendar-toolbar").evaluate((toolbar) => [...toolbar.querySelectorAll("button, h1, h2, [role=radiogroup]")]
    .filter((element) => !element.parentElement.closest("[role=radiogroup]") && element.getBoundingClientRect().width > 0)
    .map((element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }));
  const headCells = await calendar.getByTestId("calendar-head").evaluate((head) => [...head.children].slice(1).map((cell) => { const r = cell.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
  const columns = await Promise.all((await calendar.getByTestId("calendar-day").all()).map(box));
  const rows = await Promise.all(["calendar-often", "calendar-events"].map((id) => calendar.getByTestId(id).evaluate((row) => [...row.querySelectorAll("[data-testid=calendar-count]")].map((cell) => {
    const r = cell.getBoundingClientRect();
    const text = cell.firstElementChild.getBoundingClientRect();
    return { left: r.left, right: r.right, fits: text.right <= r.right + 0.5 };
  }))));
  const blocksFit = await calendar.getByTestId("calendar-grid").evaluate((grid) => [...grid.querySelectorAll("[data-testid=calendar-day]")].every((day) => {
    const outer = day.getBoundingClientRect();
    return [...day.querySelectorAll("[data-testid=calendar-block]")].every((block) => { const r = block.getBoundingClientRect(); return r.left >= outer.left - 0.5 && r.right <= outer.right + 0.5 && r.width > 8; });
  }));
  const blocksApart = await calendar.getByTestId("calendar-grid").evaluate((grid) => [...grid.querySelectorAll("[data-testid=calendar-day]")].every((day) => {
    const boxes = [...day.querySelectorAll("[data-testid=calendar-block]")].map((block) => block.getBoundingClientRect());
    return boxes.every((a, i) => boxes.every((b, j) => i >= j || !(a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)));
  }));
  const asideParts = await Promise.all(["calendar-totals", "calendar-key"].map((id) => box(calendar.getByTestId(id))));
  const logs = await Promise.all((await calendar.getByTestId("calendar-log").all()).map(box));
  const headBox = await box(calendar.getByTestId("calendar-head"));
  const totalsFit = await calendar.getByTestId("calendar-totals").evaluate((row) => [...row.querySelectorAll("[data-testid=calendar-total] p")].every((text) => text.scrollWidth <= text.clientWidth + 1));
  const bands = await calendar.getByTestId("calendar-grid").evaluate((grid) => [...grid.querySelectorAll("[data-testid=calendar-not-kept]")].every((band) => {
    const r = band.getBoundingClientRect();
    const outer = band.parentElement.getBoundingClientRect();
    return r.left >= outer.left - 0.5 && r.right <= outer.right + 0.5;
  }));
  const totals = await Promise.all((await calendar.getByTestId("calendar-total").all()).map(box));
  // PRO-511: every hour of the week, scrolled to the way the arrow keys scroll to it, takes a click (the hit test a
  // pointer makes, at the cell's right edge, which no block covers) and the focus; nothing outside the grid's scroll box
  // (the counted rows above, the two hints below) answers for it.
  const hints = await Promise.all(["calendar-hint", "calendar-keys"].map((id) => box(calendar.getByTestId(id))));
  const unreachable = await calendar.getByTestId("calendar-scroll").evaluate((scroll) => {
    const before = scroll.scrollTop;
    const cells = [...scroll.querySelectorAll("[data-testid=calendar-cell]")];
    const missed = cells.filter((cell) => {
      cell.scrollIntoView({ block: "nearest" });
      const r = cell.getBoundingClientRect();
      const hit = document.elementFromPoint(r.right - 1.5, r.top + r.height / 2);
      cell.focus({ preventScroll: true });
      return hit !== cell || document.activeElement !== cell;
    }).map((cell) => cell.getAttribute("aria-label"));
    document.activeElement?.blur?.();
    scroll.scrollTop = before;
    return cells.length === 168 ? missed : [`${cells.length} cells, not 168`];
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  const lined = (cells) => cells.length === 7 && cells.every((cell, i) => Math.abs(cell.left - columns[i].left) < 1.5 && Math.abs(cell.right - columns[i].right) < 1.5);
  return {
    checks: {
      "the calendar fits the window": inside(calendarBox, window_) && !overflow,
      "the toolbar's controls do not overlap and stay inside it": disjoint(controls) && controls.every((control) => inside(control, toolbarBox)),
      "the grid stands left of the right column": mainBox.right <= asideBox.left + 0.5 && gridBox.right <= asideBox.left + 0.5,
      "the right column is inside the calendar": inside(asideBox, calendarBox),
      "seven day columns, each wide enough for a block": columns.length === 7 && disjoint(columns) && columns.every((column) => column.width >= 60),
      "the day heads line up with the columns": lined(headCells),
      "the two counted rows line up with the columns, and their text stays in its cell": rows.every((cells) => lined(cells) && cells.every((cell) => cell.fits)),
      "every block stays inside its day": blocksFit,
      "blocks of a day do not cover each other": blocksApart,
      "the grid scrolls inside its own box": inside({ ...scrollBox, bottom: scrollBox.top + 1 }, calendarBox) && scrollBox.bottom <= calendarBox.bottom + 0.5,
      "the three totals stand side by side inside the right column": totals.length === 3 && disjoint(totals) && totals.every((total) => inside(total, asideBox)),
      "the key sits below the totals": asideParts[1].top >= asideParts[0].bottom - 0.5,
      "the log notices stand above the grid, inside it and apart": disjoint(logs) && logs.every((log) => inside(log, mainBox) && log.bottom <= headBox.top + 0.5),
      "an \"at least\" total fits its tile": totalsFit,
      "a history-not-kept band stays inside its day": bands,
      "the two hints stand below the grid's scroll box": hints.every((hint) => hint.top >= scrollBox.bottom - 0.5),
      "every hour of the week takes a click and the focus": unreachable.length === 0,
    },
    boxes: { calendarBox, toolbarBox, mainBox, asideBox, gridBox, scrollBox, hints, unreachable, columns: columns.map((c) => [c.left, c.right]), headCells },
  };
}

// One fixed instant, a Wednesday morning in UTC: the week, today, the now line and the counted rows do not hang on when
// the check runs.
const NOW = new Date("2026-11-18T10:30:00Z");

const calCases = shots
  ? [{ width: 1440, height: 900 }, { width: 1280, height: 800 }].flatMap((viewport) => ["dark", "light"].map((colorScheme) => ({ viewport, colorScheme })))
  : [{ viewport: { width: 1440, height: 900 }, colorScheme: "dark" }, { viewport: { width: 1280, height: 800 }, colorScheme: "light" }];

try {
  for (const { viewport, colorScheme } of calCases) {
      const name = `${viewport.width}×${viewport.height} ${colorScheme}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme, now: NOW });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));

      // Every bot's week, from the Bots page.
      const rail = await sidebar(page);
      await rail.getByTestId("destination-list").getByRole("button", { name: "Bots", exact: true }).click();
      const main = page.locator("main");
      await main.getByTestId("bots-calendar").click();
      const calendar = main.getByTestId("duties-calendar");
      await calendar.getByTestId("calendar-block").first().waitFor();
      await calendar.getByTestId("calendar-quiet").waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-calendar-${viewport.width}-${colorScheme}.png` });
      const team = await measure(page, calendar, viewport);
      const chips = await Promise.all((await calendar.getByTestId("calendar-filter-bot").all()).map(box));
      failed += report(`bots calendar ${name}`, {
        ...team.checks,
        "the four bot filters do not overlap": chips.length === 4 && disjoint(chips),
        "the now line is on today": (await calendar.getByTestId("calendar-now").count()) === 1,
        "no page errors": errors.length === 0,
      }, { ...team.boxes, chips, errors });

      // A clicked empty hour asks which bot. Since PRO-499 the hours are the grid's own cells (the day columns let
      // clicks through to them), so the click goes to Sunday's 12:00 cell itself, scrolled into view.
      await calendar.getByRole("gridcell", { name: /^Sun \d+, 12:00/ }).click();
      const choose = main.getByTestId("bots-duties-choose");
      await choose.waitFor();
      const chooseBox = await box(choose);
      const choices = await Promise.all((await choose.getByRole("button").all()).map(box));
      failed += report(`bots calendar bot choice ${name}`, {
        "the choice spans the page above the calendar": chooseBox.right <= viewport.width + 0.5 && chooseBox.bottom <= (await box(calendar)).top + 0.5,
        "its buttons do not overlap": disjoint(choices) && choices.every((choice) => inside(choice, chooseBox)),
      }, { chooseBox, choices });
      await choose.getByRole("button", { name: "Cancel" }).click();

      // One bot's week, on its Duties tab.
      const view = await openSession(page, "bot-home", "Atlas, CTO");
      await view.getByRole("tab", { name: "Duties" }).click();
      await view.getByRole("radio", { name: "Calendar" }).click();
      const own = view.getByTestId("duties-calendar");
      await own.getByTestId("calendar-block").first().waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-calendar-tab-${viewport.width}-${colorScheme}.png` });
      const tabbed = await measure(page, own, viewport);
      failed += report(`bot duties calendar ${name}`, {
        ...tabbed.checks,
        "no bot filter on one bot's week": (await own.getByTestId("calendar-filter").count()) === 0,
        "no page errors": errors.length === 0,
      }, { ...tabbed.boxes, errors });
      await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
