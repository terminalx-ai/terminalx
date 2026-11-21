#!/usr/bin/env node
// WebKit layout check for the Bots screens (PRO-467): the sidebar's Bots
// section, the first-bot page (23.11), Hire a bot (23.03) and the team page
// (23.02), with Settings → Experimental → Bots on. Hires from 23.11 and from
// 23.03 through the stubbed `bot_create`, then measures each screen at the
// designed 1440×900 and at narrower windows: nothing spills past the main slot
// or sideways off the page, header buttons do not overlap, and the team table
// scrolls inside its own box. With the switch off, no Bots entry shows.
//
//   pnpm build && node scripts/webkit/bots-screens.mjs
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const extra = (on) => `(() => {
  const stub = window.__PW_STUB__;
  const answers = stub.answers;
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false, bots: ${on} };
  const duty = (id, title, wake) => ({ id, title, description: title + ".", wake, enabled: false });
  const role = (title) => "# " + title + "\\n\\n## What you do\\n\\n- Reads every change that lands and says what it found, with the lines, a severity and a proposed fix, in one short report.\\n- Follows up on what it reported until it is fixed or a person says to leave it.\\n";
  const templates = [
    ["cto", "CTO", "Plans the work, splits it into orchestration runs, checks what workers report, and brings you the decisions."],
    ["chief-of-staff", "Chief of staff", "Follows up on everything that waits."],
    ["ux-designer", "UX designer", "Checks UI against the designs and fixes what drifted."],
    ["qa-engineer", "QA engineer", "Writes missing tests and reproduces bugs."],
    ["release-manager", "Release manager", "Changelog, version bump, release checks."],
    ["docs-writer", "Docs writer", "Keeps docs in step with merged work."],
    ["security-auditor", "Security auditor", "Reads every pull request and dependency change for security problems and files what it finds."],
    ["watcher", "Watcher", "Watches CI, pull requests, runs and stalled sessions. Says nothing when nothing changed."],
  ].map(([id, title, description]) => ({ id, title, description, role: role(title), skills: ["code-review", "security-review", "dependency-advisories"],
    duties: [duty(id + "-1", "Review each pull request", { kind: "github", event: "pull_request" }), duty(id + "-2", "Weekly audit of the main branch", { kind: "schedule", cron: "0 9 * * 1" }), duty(id + "-3", "Read new security alerts", { kind: "github", event: "security_advisory" })] }));
  const state = { revision: 0, bots: [] };
  const list = () => ({ revision: state.revision, bots: structuredClone(state.bots), unreadable: 0 });
  const changed = () => { state.revision++; setTimeout(() => stub.emit("bots_changed", list()), 0); };
  answers.bot_list = list;
  answers.bot_templates = templates;
  answers.bot_create = ({ roleTemplateId, name }) => {
    const template = templates.find((value) => value.id === roleTemplateId);
    const bot = { id: "bot-" + (state.bots.length + 1), slug: name.toLowerCase(), name, roleTitle: template.title, roleTemplateId, harness: "claude", model: "", access: "full",
      runsOn: state.bots.length % 2 ? "a-cloud-workspace-with-a-long-name" : "thisMac", reportsTo: state.bots[0]?.id ?? "owner", worksIn: state.bots.length ? ["personal", "an-organisation-with-a-long-name"] : ["personal"],
      created: new Date().toISOString(), modified: new Date().toISOString() };
    state.bots.push(bot);
    changed();
    return structuredClone(bot);
  };
  // A pause as the runtime records it (PRO-474): where it came from and what it stopped, the first bot with a run's
  // workers finishing their step and an 80-character duty name, to see the paused page's rows and held list truncate.
  const today = new Date().toISOString().slice(0, 10);
  const pauseAll = (paused, from = "app") => {
    state.bots.forEach((bot, index) => {
      if (!paused) { delete bot.paused; return; }
      if (bot.paused) return;
      bot.paused = { at: new Date(Date.now() - 18 * 60_000).toISOString(), by: "owner", from,
        stopped: index === 0 ? { was: "was running 2 workers", workers: 2, spent: { day: today, usd: 4.1 } } : { was: index === 1 ? "was working on “" + LONG + "”" : "was quiet", spent: { day: today, usd: 1.2 } } };
    });
    changed();
    return list();
  };
  const LONG = "Review the relay key rotation and every dependency upgrade it pulls in with it";
  answers.bots_pause_all = ({ from } = {}) => pauseAll(true, from);
  answers.bots_resume_all = () => pauseAll(false);
  answers.bot_spent_today = ({ id }) => ({ usd: id === state.bots[0]?.id ? 6.4 : 1.2, day: today });
  answers.bots_pause_held = () => {
    const paused = state.bots.filter((bot) => bot.paused);
    const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
    const entries = paused.length === 0 ? [] : [
      { kind: "skipped", source: "duty", botId: paused[0].id, dutyId: "d1", name: "Stalled sessions and runs", at: at(15), count: 3 },
      { kind: "kept", source: "events", botId: paused[0].id, dutyId: "d2", name: LONG, at: at(18) },
      ...(paused[1] ? [{ kind: "kept", source: "handoff", botId: paused[1].id, fromId: paused[0].id, by: paused[0].id, number: 12, title: LONG, at: at(9) },
        { kind: "kept", source: "answer", botId: paused[1].id, number: 4, messageKind: "answer", at: at(4) }] : []),
    ];
    return { bots: state.bots.map((bot, index) => ({ id: bot.id, inTurn: bot.paused && index === 0 ? 1 : 0, needsYou: 0 })), entries, errors: [] };
  };
})();`;

const viewports = [
  { width: 1440, height: 900 },
  { width: 1100, height: 760 },
  { width: 900, height: 640 },
  // The window's smallest size (tauri.conf.json minWidth × minHeight).
  { width: 760, height: 520 },
];

/** An 80-character name, to see that every place showing it truncates. */
const LONG_NAME = "Kestrel the very thorough reviewer of every pull request and dependency upgrade x".slice(0, 80);

/** Every visible element of the main slot stays inside it; the page never scrolls sideways; header controls do not overlap. */
async function measure(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main").getBoundingClientRect();
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    const inScroller = (element) => {
      for (let parent = element.parentElement; parent && parent.tagName !== "MAIN"; parent = parent.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowX)) return true;
      }
      return false;
    };
    for (const element of document.querySelectorAll("main button, main h1, main h2, main h3, main input, main [data-testid=bots-stat], main [data-testid=bots-role-card]")) {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height || inScroller(element)) continue;
      if (box.left < main.left - 1 || box.right > main.right + 1) problems.push(`${element.textContent.trim().slice(0, 40) || element.tagName} spills out of the main slot`);
    }
    const header = document.querySelector("main [data-testid=bots-header]");
    if (header) {
      const controls = [...header.querySelectorAll("button, label, h1")].filter((element) => element.getBoundingClientRect().width > 0);
      for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
        if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
        const [a, b] = [controls[i].getBoundingClientRect(), controls[j].getBoundingClientRect()];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) problems.push(`header: "${controls[i].textContent.trim().slice(0, 30)}" overlaps "${controls[j].textContent.trim().slice(0, 30)}"`);
      }
    }
    // Team table: a bot's name stays inside its own cell, however long.
    for (const row of document.querySelectorAll("[data-testid=bots-table-row]")) {
      const cell = row.querySelector("td").getBoundingClientRect();
      const name = row.querySelector("td p").getBoundingClientRect();
      if (name.right > cell.right + 1) problems.push(`table row ${row.dataset.bot}: name spills out of its cell`);
    }
    // Hire a bot: the Hire button stays inside its column.
    const form = document.querySelector("[data-testid=bots-hire-form]");
    const submit = document.querySelector("[data-testid=bots-hire-submit]");
    if (form && submit && submit.getBoundingClientRect().right > form.getBoundingClientRect().right + 1) problems.push("Hire button spills out of its column");
    // Sidebar bot rows: name and avatar inside the row.
    for (const row of document.querySelectorAll("[data-testid=bot-row]")) {
      const box = row.getBoundingClientRect();
      for (const child of row.querySelectorAll("span")) {
        const inner = child.getBoundingClientRect();
        if (inner.width && (inner.top < box.top - 1 || inner.bottom > box.bottom + 1 || inner.right > box.right + 1)) problems.push(`sidebar row ${row.dataset.bot}: text spills out`);
      }
    }
    return problems;
  });
}

// BOTS_SHOTS=<dir> saves each screen at 1440×900, to compare with the designs.
const shot = (page, name) => (process.env.BOTS_SHOTS ? page.screenshot({ path: `${process.env.BOTS_SHOTS}/${name}.png` }) : null);

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  // Off: nothing of Bots shows.
  {
    const page = await open(browser, server.url, { cloud: false, localProjects: 2 }, { width: 1440, height: 900 }, { extra: extra(false) });
    const rail = await sidebar(page);
    await rail.getByRole("button", { name: "Automations" }).waitFor();
    await page.waitForTimeout(300);
    failed += report("bots off", {
      "no Bots destination": (await rail.getByRole("button", { name: "Bots", exact: true }).count()) === 0,
      "no Bots section": (await rail.locator("[data-testid=bots-sidebar-section]").count()) === 0,
    });
    await page.close();
  }

  const page = await open(browser, server.url, { cloud: false, localProjects: 2 }, viewports[0], { extra: extra(true) });
  const rail = await sidebar(page);
  await rail.getByTestId("destination-list").getByRole("button", { name: "Bots", exact: true }).click();
  const main = page.locator("main");

  // 23.11
  await main.getByText("Hire your first bot").waitFor();
  await main.locator("[data-testid=bots-role-card]").nth(2).waitFor();
  await rail.locator("[data-testid=bots-sidebar-empty]").waitFor();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const problems = await measure(page);
    failed += report(`first bot ${viewport.width}x${viewport.height}`, { "fits the main slot": problems.length === 0 }, problems);
  }
  await page.setViewportSize(viewports[0]);
  await shot(page, "2311-first");
  await main.getByRole("button", { name: "Hire CTO" }).click();
  await main.locator("[data-testid=bots-team]").waitFor();
  await rail.locator("[data-testid=bot-row]").first().waitFor();

  // 23.03
  await main.getByTestId("bots-hire").click();
  await main.getByRole("button", { name: /Security auditor/ }).click();
  await main.getByTestId("bots-hire-name").fill(LONG_NAME);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const problems = await measure(page);
    const submit = await main.getByTestId("bots-hire-submit").boundingBox();
    failed += report(`hire ${viewport.width}x${viewport.height}`, { "fits the main slot": problems.length === 0, "Hire button is on screen": !!submit && submit.width > 0 }, problems);
  }
  await page.setViewportSize(viewports[0]);
  await shot(page, "2303-hire");
  await main.getByTestId("bots-hire-submit").click();
  await main.locator("[data-testid=bots-team]").waitFor();
  for (const name of ["Iris", "Argus"]) {
    await main.getByTestId("bots-hire").click();
    await main.getByTestId("bots-hire-name").fill(name);
    await main.getByTestId("bots-hire-submit").click();
    await main.locator("[data-testid=bots-team]").waitFor();
  }

  // 23.02
  await main.locator("[data-testid=bots-table-row]").nth(3).waitFor();
  failed += report("team", {
    "four rows in the table": (await main.locator("[data-testid=bots-table-row]").count()) === 4,
    "four rows in the sidebar": (await rail.locator("[data-testid=bot-row]").count()) === 4,
  });
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const problems = await measure(page);
    const table = await main.getByTestId("bots-table-scroll").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const slot = element.closest("main").getBoundingClientRect();
      return { inside: box.left >= slot.left - 1 && box.right <= slot.right + 1, scrolls: element.scrollWidth > element.clientWidth };
    });
    failed += report(`team ${viewport.width}x${viewport.height}`, { "fits the main slot": problems.length === 0, "table box stays inside the main slot": table.inside }, { problems, table });
  }
  await page.setViewportSize(viewports[0]);
  await shot(page, "2302-team");
  await page.setViewportSize(viewports[1]);
  await main.getByTestId("bots-pause-all").click();
  await main.getByTestId("bots-all-paused").waitFor();
  const pausedProblems = await measure(page);
  failed += report("team, all paused", { "fits the main slot": pausedProblems.length === 0, "Resume all offered": (await main.getByTestId("bots-resume-all").count()) === 1 }, pausedProblems);
  // The paused page (23.12) at every size: banner, stats, rows with what is held, the held list, what pause does.
  await main.getByTestId("bots-held-entry").first().waitFor();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(150);
    const problems = await measure(page);
    const rows = await main.getByTestId("bots-paused-row").count();
    const held = await main.getByTestId("bots-held-entry").count();
    const banner = (await main.getByTestId("bots-paused-by").textContent()) ?? "";
    failed += report(`paused page ${viewport.width}x${viewport.height}`, {
      "fits the main slot": problems.length === 0,
      "a row per bot": rows > 0 && rows === (await main.getByTestId("bots-paused-resume").count()),
      "held list shows what was skipped and kept": held >= 2 && (await main.locator("[data-testid=bots-held-entry][data-kind=skipped]").count()) === 1,
      "banner says who paused them and when": /^You paused them in TerminalX at \d\d:\d\d, 18 minutes ago\./.test(banner),
      "names the Pause all shortcut": /⌥⇧⌘P|Alt\+Shift\+/.test((await main.getByTestId("bots-pause-where").textContent()) ?? ""),
    }, { problems, banner });
  }
  await page.setViewportSize(viewports[0]);
  await shot(page, "2312-paused");
  await page.setViewportSize(viewports[3]);
  await shot(page, "2312-paused-small");
  await main.getByTestId("bots-paused-resume-all").click();
  await main.getByTestId("bots-pause-all").waitFor();
  failed += report("resume all leaves the paused page", { "team is back": (await main.getByTestId("bots-paused").count()) === 0 }, {});
  await page.close();
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
