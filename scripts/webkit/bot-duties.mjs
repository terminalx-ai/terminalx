#!/usr/bin/env node
// PRO-471: a bot's Duties tab (design 23.05) and a duty's page (23.10) in real WebKit, at 1440×900 and at the scaled
// 1280×800, dark and light. On the tab: the duties table, the "Add a duty" tiles and, beside them, Today, the log and
// quiet hours. On a duty's page: Back, the actions on one band, the four stat cards, the four steps, the runs and the
// right column. Nothing overlaps, nothing leaves the window, and no page error.
// Run after pnpm build: node scripts/webkit/bot-duties.mjs
// BOT_DUTIES_SHOTS=<dir> saves a screenshot of each case.
import { launch, open, openSession, report, serve } from "./harness.mjs";

const shots = process.env.BOT_DUTIES_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;

const fixture = `
  const backend = window.__PW_STUB__;
  const at = new Date().toISOString();
  const clock = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const tab = (id) => ({ id, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: at, modified: at });
  backend.answers.list_sessions = [{ id: "bot-home", kind: "quick", projectPath: "/scratch/home", cwd: "/home/.raccoon/bots/b1", title: "Home chat", created: at, modified: at,
    archived: false, pinned: false, worktreeRemoved: false, tabs: [tab("bot-home-t")], activeTab: "bot-home-t", bot: { id: "b1", home: true } }];
  backend.answers.load_tab_events = () => [];
  backend.answers.experimental_settings = { nativeCodex: false, bots: true };
  const bot = { id: "b1", slug: "argus", name: "Argus", roleTitle: "Watcher", roleTemplateId: "watcher", harness: "claude", model: "", access: "full", runsOn: "thisMac",
    reportsTo: "owner", worksIn: ["personal"], created: at, modified: at };
  backend.answers.bot_list = { revision: 1, bots: [bot], unreadable: 0 };
  backend.answers.bot_home_chat = () => backend.answers.list_sessions[0];
  backend.answers.bot_spent_today = { usd: 0.21, day: new Date().toDateString() };
  const duty = (id, name, extra) => ({ id, name, enabled: true, projectPath: "/home/.raccoon/bots/b1", harness: "claude", model: "", mode: "bypassPermissions",
    prompt: "Say which pull requests have waited longest for a review, and why. Reply Nothing new. when nothing changed since your note.", workspace: "newWorktree",
    reuseSession: false, archiveOnComplete: false, keepLatestRunVisible: false,
    schedule: { kind: "cron", cron: "*/30 * * * *", weekdays: [], timezone: "UTC", dtstart: "2026-01-01T00:00:00Z" },
    precheck: { command: "gh pr list --search 'review:required -is:draft' --json number,title --jq '.[] | \\"#\\\\(.number) \\\\(.title)\\"'", timeoutSeconds: 30 },
    missedRunGraceMinutes: 30, nextRunAt: new Date(Date.now() + 34 * 60000).toISOString(), created: at, modified: at,
    bot: { id: "b1", reportsTo: "terminalx" }, ...extra });
  backend.answers.automations_list = [
    duty("d1", "Watch pull requests that have been waiting for a review for a long time", {}),
    duty("d2", "Watch stalled sessions", { schedule: { kind: "cron", cron: "*/15 * * * *", weekdays: [], timezone: "UTC", dtstart: "2026-01-01T00:00:00Z" } }),
    duty("d3", "Release readiness", { enabled: false, precheck: null, bot: { id: "b1", reportsTo: "lead", template: "release-readiness" } }),
  ];
  const quiet = { exitCode: 0, stdoutTail: "", stderrTail: "", truncated: false, timedOut: false, durationMs: 400 };
  const found = { ...quiet, stdoutTail: "#1432 Bots: settings and access\\n#1435 Bots: role and memory\\n", durationMs: 1300 };
  const run = (automationId, n, extra) => ({ runId: automationId + "-" + n, runNumber: n, automationId, trigger: "scheduled", status: "completed", repeatCount: 1, ...extra });
  const runs = {
    d1: [
      run("d1", 3, { startedAt: clock(13, 0), endedAt: clock(13, 2), sessionId: "s1", tabId: "t1", precheck: found, duty: { reportedTo: "owner", notified: true } }),
      run("d1", 2, { status: "skippedPrecheck", startedAt: clock(9, 0), endedAt: clock(9, 0), lastRepeatAt: clock(12, 30), repeatCount: 8, precheck: quiet }),
      run("d1", 1, { status: "failed", startedAt: clock(8, 30), endedAt: clock(8, 30), precheck: { ...quiet, exitCode: 4, stderrTail: "gh: not logged in" }, error: "The first check exited with status 4." }),
    ],
    d2: [run("d2", 1, { status: "skippedPrecheck", startedAt: clock(13, 15), endedAt: clock(13, 15), lastRepeatAt: clock(13, 15), precheck: quiet })],
    d3: [],
  };
  backend.answers.automation_runs = ({ automationId }) => runs[automationId] ?? [];
  backend.answers.bot_duties = { quietHours: { from: "22:00", to: "07:00" }, notes: { d1: { text: "Reported #1432 and #1435 at 13:00.", cut: false } }, home: "/home/.raccoon/bots/b1" };
`;

const box = (locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
});
const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
const disjoint = (boxes) => boxes.every((a, i) => boxes.every((b, j) => i >= j || !overlaps(a, b)));
// Whether text in each cell ends inside it: truncation keeps it there, overflow does not.
const cellsFit = (locator) => locator.evaluate((table) => [...table.querySelectorAll("td")].every((cell) => [...cell.children].every((child) => {
  const outer = cell.getBoundingClientRect();
  const rect = child.getBoundingClientRect();
  return rect.right <= outer.right + 0.5 && rect.left >= outer.left - 0.5;
})));

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    for (const colorScheme of ["dark", "light"]) {
      const name = `${viewport.width}×${viewport.height} ${colorScheme}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const view = await openSession(page, "bot-home", "Argus, Watcher");
      await view.getByRole("tab", { name: "Duties" }).click();
      const duties = view.getByTestId("bot-duties");
      const table = duties.getByTestId("duties-table");
      await table.getByTestId("duty-row").nth(2).waitFor();
      await duties.getByTestId("duties-log").waitFor();
      await duties.getByText(/22:00–07:00/).waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-duties-${viewport.width}-${colorScheme}.png` });
      const window_ = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
      const [viewBox, dutiesBox, tableBox, asideBox, tilesBox, addBox] = await Promise.all(
        [view, duties, duties.getByTestId("duties-table-scroll"), duties.getByTestId("duties-aside"), duties.getByTestId("duty-wakes"), duties.getByTestId("duty-add")].map(box),
      );
      const tileBoxes = await Promise.all((await duties.getByTestId("duty-wake").all()).map(box));
      const statBoxes = await Promise.all((await duties.getByTestId("duties-stat").all()).map(box));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      const tableChecks = {
        "the view fits the window": inside(viewBox, window_) && !overflow,
        "the tab fits the view": dutiesBox.left >= viewBox.left - 0.5 && dutiesBox.right <= viewBox.right + 0.5,
        "the table stands left of Today, the log and quiet hours": tableBox.right <= asideBox.left + 0.5 && !overlaps(tableBox, asideBox),
        "Add a duty is above the table, inside the tab": addBox.bottom <= tableBox.top + 0.5 && inside(addBox, dutiesBox),
        "the eight tiles sit below the table and do not overlap each other or Today": tileBoxes.length === 8 && tilesBox.top >= tableBox.bottom - 0.5 && disjoint(tileBoxes) && !overlaps(tilesBox, asideBox),
        "the three counts stand side by side inside the right column": statBoxes.length === 3 && disjoint(statBoxes) && statBoxes.every((stat) => inside(stat, asideBox)),
        "a long duty name stays in its cell": await cellsFit(table),
        "the table needs no sideways scroll": await duties.getByTestId("duties-table-scroll").evaluate((scroll) => scroll.scrollWidth <= scroll.clientWidth + 1),
        "the right column is inside the tab": asideBox.right <= dutiesBox.right + 0.5,
      };
      failed += report(`bot duties ${name}`, tableChecks, { viewBox, dutiesBox, tableBox, asideBox, tilesBox, addBox, errors });

      // A duty's page.
      await table.getByTestId("duty-row").first().click();
      const dutyPage = view.getByTestId("bot-duty");
      await dutyPage.getByTestId("duty-note").waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-duty-${viewport.width}-${colorScheme}.png` });
      const heading = dutyPage.getByRole("heading", { level: 2 });
      const [pageBox, backBox, actionsBox, headingBox, stepsBox, runsBox, sideBox] = await Promise.all(
        [dutyPage, dutyPage.getByTestId("duty-back"), dutyPage.getByTestId("duty-actions"), heading, dutyPage.getByTestId("duty-steps"), dutyPage.getByTestId("duty-runs"), dutyPage.getByTestId("duty-aside")].map(box),
      );
      const cardBoxes = await Promise.all((await dutyPage.getByTestId("duty-stat").all()).map(box));
      const stepBoxes = await Promise.all((await dutyPage.getByTestId("duty-step").all()).map(box));
      const buttons = await Promise.all((await dutyPage.getByTestId("duty-actions").getByRole("button").all()).map(box));
      const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      const dutyChecks = {
        "the page fits the view": inside({ ...pageBox, bottom: pageBox.top + 1 }, viewBox) && pageBox.right <= viewBox.right + 0.5 && !pageOverflow,
        "Back and the actions share one band above the title": !overlaps(backBox, actionsBox) && backBox.bottom <= headingBox.top + 0.5 && actionsBox.bottom <= headingBox.top + 0.5,
        "the actions do not overlap each other and stay inside the page": disjoint(buttons) && buttons.every((button) => button.right <= pageBox.right + 0.5),
        "Pause, Duplicate and Run now are there": (await dutyPage.getByRole("button", { name: "Pause" }).count()) === 1 && (await dutyPage.getByRole("button", { name: "Duplicate" }).count()) === 1 && (await dutyPage.getByTestId("duty-run").count()) === 1,
        "the title stays on one line inside the page": headingBox.height < 32 && headingBox.right <= pageBox.right + 0.5,
        "the four stat cards sit below the title without overlapping": cardBoxes.length === 4 && disjoint(cardBoxes) && cardBoxes.every((card) => card.top >= headingBox.bottom - 0.5 && card.right <= pageBox.right + 0.5),
        "the four steps stack, left of the right column": stepBoxes.length === 4 && disjoint(stepBoxes) && stepsBox.right <= sideBox.left + 0.5,
        "the runs are below the steps, left of the right column": runsBox.top >= stepsBox.bottom - 0.5 && runsBox.right <= sideBox.left + 0.5,
        "the right column is inside the page": sideBox.right <= pageBox.right + 0.5 && sideBox.top >= Math.max(...cardBoxes.map((card) => card.bottom)) - 0.5,
        "the runs' cells keep their text": await cellsFit(dutyPage.getByTestId("duty-runs")),
        "no page errors": errors.length === 0,
      };
      failed += report(`bot duty ${name}`, dutyChecks, { pageBox, backBox, actionsBox, headingBox, stepsBox, runsBox, sideBox, cardBoxes, errors });

      // The editor, from the first step's Edit.
      await dutyPage.getByTestId("duty-edit").click();
      const editor = view.getByTestId("duty-editor");
      await editor.getByTestId("duty-save").waitFor();
      const [editorBox, saveBox, reportsBox] = await Promise.all([editor, editor.getByTestId("duty-save"), editor.getByTestId("duty-reports-to")].map(box));
      const targets = await Promise.all((await editor.getByTestId("duty-reports-to").getByRole("radio").all()).map(box));
      failed += report(`bot duty editor ${name}`, {
        "the editor fits the view": editorBox.right <= viewBox.right + 0.5 && editorBox.left >= viewBox.left - 0.5,
        "the Reports to choices do not overlap": targets.length === 5 && disjoint(targets) && targets.every((target) => inside(target, reportsBox)),
        "Save is inside the editor": saveBox.right <= editorBox.right + 0.5,
        "no page errors": errors.length === 0,
      }, { editorBox, saveBox, reportsBox, errors });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
