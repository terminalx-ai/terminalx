#!/usr/bin/env node
// WebKit layout check for a bot's settings (PRO-478, design 23.07), with
// Settings → Experimental → Bots on: Runs on, Access, Works in, Channels and
// Who can ask, reached from the team table. Measured with no organisation and
// with one, at the designed 1440×900, the scaled 1280×800 and narrower
// windows, dark and light: nothing spills past the main slot or sideways off
// the page, the choice cards and list rows stay inside their sections, no two
// controls overlap, and a long bot name truncates. Picking an access level
// saves it through the stubbed `bot_update`.
//
//   pnpm build && node scripts/webkit/bot-settings.mjs
//   BOT_SETTINGS_SHOTS=<dir> also saves a screenshot of each case.
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const LONG_NAME = "Kestrel the very thorough reviewer of every pull request and dependency upgrade x".slice(0, 80);

const extra = (orgs) => `(() => {
  const stub = window.__PW_STUB__;
  const answers = stub.answers;
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false, bots: true };
  if (answers.account_status.organizations) answers.account_status.organizations = answers.account_status.organizations.slice(0, ${orgs});
  answers.gh_connection_status = { state: "connected", details: null };
  answers.linear_status = { connected: true, viewer: "A person with a long name in Linear" };
  const at = new Date().toISOString();
  const bot = (id, name, extra) => ({ id, slug: id, name, roleTitle: "Security auditor", roleTemplateId: "security-auditor", harness: "claude", model: "", access: "full",
    runsOn: "thisMac", reportsTo: "owner", worksIn: ["personal"], created: at, modified: at, ...extra });
  const state = { revision: 1, bots: [
    bot("b1", ${JSON.stringify(LONG_NAME)}, { reportsTo: "b2", worksIn: ["personal", "org-a", "an-organisation-this-version-does-not-know"],
      whoCanAsk: [{ kind: "bot", id: "b2", may: "handOff" }, { kind: "person", id: "u1", name: "Someone with a rather long display name", may: "ask" }, { kind: "team", id: "t1", may: "triage" }] }),
    bot("b2", "Atlas", { roleTitle: "CTO", roleTemplateId: "cto" }),
  ] };
  const list = () => ({ revision: state.revision, bots: structuredClone(state.bots), unreadable: 0 });
  answers.bot_list = list;
  answers.bot_update = ({ id, patch }) => {
    const found = state.bots.find((value) => value.id === id);
    Object.assign(found, patch);
    state.revision++;
    setTimeout(() => stub.emit("bots_changed", list()), 0);
    return structuredClone(found);
  };
})();`;

const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 900, height: 640 },
  // The window's smallest size (tauri.conf.json minWidth × minHeight).
  { width: 760, height: 520 },
];

async function measure(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main").getBoundingClientRect();
    const problems = [];
    const rect = (element) => element.getBoundingClientRect();
    const visible = (element) => rect(element).width > 0 && rect(element).height > 0;
    const within = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
    const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const label = (element) => (element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 40);
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    const page = document.querySelector("[data-testid=bot-settings-page]");
    if (!page) return ["no settings page"];
    for (const element of page.querySelectorAll("button, h1, h2, li, [role=radio]")) {
      if (visible(element) && !within(rect(element), main)) problems.push(`${label(element)} spills out of the main slot`);
    }
    for (const section of page.querySelectorAll("[data-testid=bot-settings-section]")) {
      const box = rect(section);
      const title = section.querySelector("h2").textContent;
      for (const element of section.querySelectorAll("[role=radio], li, button, [role=switch]")) {
        if (visible(element) && !within(rect(element), box)) problems.push(`${title}: ${label(element)} spills out of its section`);
      }
      // The cards of a choice, and each row's parts, never overlap.
      const cards = [...section.querySelectorAll("[role=radio]")];
      for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) if (overlap(rect(cards[i]), rect(cards[j]))) problems.push(`${title}: cards ${i} and ${j} overlap`);
      for (const row of section.querySelectorAll("li")) {
        const parts = [...row.children].filter(visible);
        const rowBox = rect(row);
        for (const part of parts) if (!within(rect(part), rowBox)) problems.push(`${title}: "${label(part)}" spills out of its row`);
        for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (overlap(rect(parts[i]), rect(parts[j]))) problems.push(`${title}: "${label(parts[i])}" overlaps "${label(parts[j])}"`);
      }
    }
    const header = page.querySelector("header");
    const controls = [...header.querySelectorAll("button, h1")].filter(visible);
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
      if (overlap(rect(controls[i]), rect(controls[j]))) problems.push(`header: "${label(controls[i])}" overlaps "${label(controls[j])}"`);
    }
    const name = header.querySelector("h1 span");
    if (name && name.scrollWidth > name.clientWidth + 1 && getComputedStyle(name).textOverflow !== "ellipsis") problems.push("the bot's name does not truncate");
    return problems;
  });
}

const shots = process.env.BOT_SETTINGS_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const [orgs, scheme] of [[0, "dark"], [1, "light"], [1, "dark"]]) {
    const name = `${orgs ? "one organisation" : "no organisation"}, ${scheme}`;
    const page = await open(browser, server.url, { cloud: orgs > 0, localProjects: 1 }, viewports[0], { extra: extra(orgs), colorScheme: scheme });
    const rail = await sidebar(page);
    await rail.getByTestId("destination-list").getByRole("button", { name: "Bots", exact: true }).click();
    const main = page.locator("main");
    await main.locator("[data-testid=bots-table-row]").nth(1).waitFor();
    await main.getByRole("button", { name: `${LONG_NAME}'s settings` }).click();
    await main.getByTestId("bot-settings").waitFor();
    await main.getByTestId("bot-channel-linear-state").getByText("Connected").waitFor();
    failed += report(name, {
      "five sections": (await main.getByTestId("bot-settings-section").count()) === 5,
      "organisation rows": (await main.getByTestId("bot-works-in-org").count()) === orgs,
      "places it does not know are shown": (await main.getByTestId("bot-works-in-unknown").count()) === (orgs ? 1 : 2),
      "the owner and three askers": (await main.getByTestId("bot-asker").count()) === 3 && (await main.getByTestId("bot-asker-owner").count()) === 1,
    });
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(100);
      const problems = await measure(page);
      failed += report(`${name} ${viewport.width}x${viewport.height}`, { "fits, nothing overlaps": problems.length === 0 }, problems);
      if (shots) await page.screenshot({ path: `${shots}/bot-settings-${orgs}-${scheme}-${viewport.width}.png`, fullPage: true });
    }
    await page.setViewportSize(viewports[0]);
    await main.getByTestId("bot-access-readReport").click();
    await page.waitForFunction(() => document.querySelector("[data-testid=bot-access-readReport]")?.getAttribute("aria-checked") === "true");
    failed += report(`${name}: access`, { "Read and report is saved and shown": true });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
