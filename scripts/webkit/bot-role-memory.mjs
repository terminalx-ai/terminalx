#!/usr/bin/env node
// WebKit layout check for a bot's Role and memory (PRO-470, design 23.06),
// with Settings → Experimental → Bots on. Opens it from a bot's row on the
// team page, and as the Role and memory tab of the bot's view, with a full fixture (a long role, three places with a long
// organisation name, topics, a line budget overrun and a change log), then
// measures it at the designed 1440×900 and at narrower windows: nothing
// spills past the main slot or sideways off the page, the role and memory
// columns do not overlap, and every change keeps its Undo inside its row.
//
//   pnpm build && node scripts/webkit/bot-role-memory.mjs
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const extra = `(() => {
  const stub = window.__PW_STUB__;
  const answers = stub.answers;
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false, bots: true };
  const ORG = "Kestrel Studio and a few more words for an organisation with a long name";
  const now = new Date().toISOString();
  const bot = (id, name, title, template, reportsTo, worksIn) => ({ id, slug: name.toLowerCase(), name, roleTitle: title, roleTemplateId: template, harness: "claude", model: "", access: "full",
    runsOn: "thisMac", reportsTo, worksIn, created: now, modified: now });
  const bots = [
    bot("bot-1", "Atlas", "CTO", "cto", "owner", [ORG, "personal"]),
    bot("bot-2", "Iris", "UX designer", "ux-designer", "bot-1", ["personal"]),
    bot("bot-3", "Sentry the very thorough reviewer of every pull request and upgrade", "Security auditor", "security-auditor", "bot-1", ["personal"]),
  ];
  answers.bot_list = () => ({ revision: 1, bots: structuredClone(bots), unreadable: 0 });
  // Atlas's home chat, so its view (PRO-468) opens with the Role and memory tab.
  const homeChat = { id: "atlas-home", kind: "quick", projectPath: "/scratch/atlas-home", cwd: "/home/bots/bot-1", title: "Home chat", created: now, modified: now,
    archived: false, pinned: false, worktreeRemoved: false, tabs: [{ id: "atlas-home-t", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: now, modified: now }],
    activeTab: "atlas-home-t", bot: { id: "bot-1", home: true } };
  answers.list_sessions = [homeChat];
  answers.load_tab_events = () => [];
  answers.bot_home_chat = () => homeChat;
  answers.bot_spent_today = { usd: 0, day: now.slice(0, 10) };
  answers.bot_templates = [];
  const role = ["You are Atlas, the CTO. You own engineering throughput: what gets built next, how it is split, and whether it is safe to merge.", "", "## You answer for", "",
    ...Array.from({ length: 30 }, (_, n) => "- A standing instruction that is long enough to wrap in the editor, number " + n + ", with a path like src-tauri/src/bots/memory.rs:120 in it.")].join("\\n") + "\\n";
  const note = (n, date) => "- " + date + " A dated note, number " + n + ", long enough to wrap on a narrow window: merges wait for the checks on the exact head of the branch.";
  const home = "/Users/someone/.terminalx/bots/0198b0c4-5a1e-7d2f-9a43-1f2e3d4c5b6a/";
  const orgDir = home + "orgs/kestrel-studio-and-a-few-more-words-for-an-organisation-with-a-long-name-1a2b3c4d/";
  const place = (key, path, lines, extra) => Object.assign({ key, path, lines, read: true, readLines: lines.length, notRead: 0, archiveLines: 0, bytes: 2048, overLimit: false }, extra);
  const change = (id, kind, text, source, by, extra) => Object.assign({ id, at: now, kind, text, source, by, undoneBy: null, notUndoable: null }, extra);
  const texts = { "h-9": role, "h-8": "An older role.\\n", "h-t": "You are a CTO.\\n" };
  answers.bot_memory = ({ operation, params }) => {
    if (operation === "memoryText") return texts[params.hash] ?? null;
    if (operation === "roleDiff") return role.split("\\n").map((text, n) => ({ kind: n % 7 === 3 ? "added" : "same", text }));
    if (operation === "memoryLook") return { found: 0 };
    if (operation !== "memoryView") return [];
    return {
      role: { path: home + "ROLE.md", text: role, hash: "h-9", editable: true, limit: 32768, bytes: role.length, overLimit: false, templateTitle: "CTO",
        versions: [
          { change: "c-9", at: now, by: "bot-1", kind: "outside", source: { kind: "outside" }, hash: "h-9" },
          { change: "c-8", at: now, by: "owner", kind: "role", source: { kind: "app" }, hash: "h-8" },
          { change: null, at: now, by: "owner", kind: "template", source: { kind: "template" }, hash: "h-t" },
        ] },
      memory: { off: false, budget: 200, readLimit: 65536, workingPlace: ORG, read: 200,
        places: [
          place("bot", home + "MEMORY.md", ["# Memory", "", ...Array.from({ length: 44 }, (_, n) => note(n, "2026-11-0" + (1 + (n % 9))))]),
          place(ORG, orgDir + "MEMORY.md", Array.from({ length: 170 }, (_, n) => note(n, "2026-10-1" + (n % 10))), { readLines: 154, notRead: 16, overLimit: true, bytes: 70000, archiveLines: 310 }),
          place("personal", home + "personal/MEMORY.md", [note(1, "2026-11-19")], { read: false, readLines: 0 }),
        ],
        topics: [
          { place: ORG, name: "merge-rules-for-the-release-branch-and-everything-around-it.md", path: orgDir + "memory/merge-rules.md", lines: 19, modified: now },
          { place: ORG, name: "archive.md", path: orgDir + "memory/archive.md", lines: 310, modified: now },
        ] },
      changes: [
        change("c-1", "learned", "Status updates go in a table, with what needs a decision at the top and every open pull request named with its next step.", { kind: "chat", session: "s1", title: "Home chat with a title long enough to need truncating in the row" }, "bot-1"),
        change("c-2", "archived", "Moved 3 older notes to the archive to stay within 200 lines", { kind: "budget" }, "owner"),
        change("c-3", "outside", "2 added, 1 removed in MEMORY.md, ROLE.md", { kind: "outside" }, "outside"),
        change("c-4", "forgot", "Windows CI must pass before merge.", { kind: "app" }, "owner", { undoneBy: "c-5", notUndoable: "This change was already undone." }),
        change("c-6", "standup", "A change a newer version made", { kind: "meeting" }, "bot-1", { notUndoable: "A newer version of TerminalX made this change; it cannot be undone here." }),
      ],
      totalChanges: 240, unreadableChanges: 1,
      secrets: [orgDir + "memory/merge-rules-for-the-release-branch-and-everything-around-it.md"],
    };
  };
})();`;

const viewports = [
  { width: 1440, height: 900 },
  { width: 1100, height: 760 },
  { width: 900, height: 640 },
  // The window's smallest size (tauri.conf.json minWidth × minHeight).
  { width: 760, height: 520 },
];

async function measure(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main").getBoundingClientRect();
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    const screen = document.querySelector("[data-testid=bot-role-memory]");
    if (!screen) return ["the screen is not shown"];
    const inScroller = (element) => {
      for (let parent = element.parentElement; parent && parent.tagName !== "MAIN"; parent = parent.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowX) && parent.scrollWidth > parent.clientWidth) return true;
      }
      return false;
    };
    for (const element of document.querySelectorAll("main button, main h1, main h2, main h3, main input, main select, main textarea, main [data-testid=bot-change], main [data-testid=bot-memory-place]")) {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height || inScroller(element)) continue;
      if (box.left < main.left - 1 || box.right > main.right + 1) problems.push(`${(element.textContent || element.getAttribute("aria-label") || element.tagName).trim().slice(0, 40)} spills out of the main slot`);
    }
    // The role column and the memory column never overlap.
    const role = document.querySelector("[data-testid=bot-role-editor]")?.getBoundingClientRect();
    const memory = document.querySelector("[data-testid=bot-memory]")?.getBoundingClientRect();
    if (role && memory && role.left < memory.right - 1 && memory.left < role.right - 1 && role.top < memory.bottom - 1 && memory.top < role.bottom - 1) problems.push("the role editor overlaps the memory column");
    // Each change keeps its time, text and action inside its row, side by side.
    for (const row of document.querySelectorAll("[data-testid=bot-change]")) {
      const box = row.getBoundingClientRect();
      for (const child of row.children) {
        const inner = child.getBoundingClientRect();
        if (inner.width && (inner.right > box.right + 1 || inner.left < box.left - 1)) problems.push(`change ${row.dataset.kind}: ${child.textContent.trim().slice(0, 30)} spills out of its row`);
      }
    }
    // A place card's line count stays on its card.
    for (const card of document.querySelectorAll("[data-testid=bot-memory-place]")) {
      const box = card.getBoundingClientRect();
      for (const child of card.querySelectorAll("span")) {
        const inner = child.getBoundingClientRect();
        if (inner.width && inner.right > box.right + 1) problems.push(`place ${card.dataset.place}: text spills out`);
      }
    }
    return problems;
  });
}

const shot = (page, name) => (process.env.BOTS_SHOTS ? page.screenshot({ path: `${process.env.BOTS_SHOTS}/${name}.png`, fullPage: true }) : null);

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  const page = await open(browser, server.url, { cloud: false, localProjects: 2 }, viewports[0], { extra });
  const rail = await sidebar(page);
  await rail.getByTestId("destination-list").getByRole("button", { name: "Bots", exact: true }).click();
  const main = page.locator("main");
  await main.locator("[data-testid=bots-table-row]").nth(2).waitFor();
  await main.locator("[data-testid=bots-table-row][data-bot=bot-1] [data-testid=bot-role-memory-open]").click();
  await main.locator("[data-testid=bot-role-text]").waitFor();
  await main.locator("[data-testid=bot-change]").nth(4).waitFor();

  failed += report("role and memory", {
    "three places": (await main.locator("[data-testid=bot-memory-place]").count()) === 3,
    "the organisation's notes are picked": (await main.locator("[data-testid=bot-memory-place][aria-checked=true]").getAttribute("data-place")).startsWith("Kestrel"),
    "five changes": (await main.locator("[data-testid=bot-change]").count()) === 5,
    "lines not read are named": (await main.getByTestId("bot-memory-not-read").count()) === 1,
  });
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const problems = await measure(page);
    failed += report(`role and memory ${viewport.width}x${viewport.height}`, { "fits the main slot": problems.length === 0 }, problems);
  }
  await page.setViewportSize(viewports[0]);
  await shot(page, "2306-role-memory");

  // History and the template's changes open under the editor and still fit.
  await main.getByTestId("bot-role-history-toggle").click();
  await main.locator("[data-testid=bot-role-version]").nth(2).waitFor();
  // A version's text, read when shown, opens under it and still fits.
  await main.locator("[data-testid=bot-role-version]").nth(0).getByTestId("bot-role-version-show").click();
  await main.getByTestId("bot-role-version-text").waitFor();
  for (const viewport of [viewports[0], viewports[3]]) {
    await page.setViewportSize(viewport);
    const problems = await measure(page);
    failed += report(`role history ${viewport.width}x${viewport.height}`, { "fits the main slot": problems.length === 0 }, problems);
  }
  await main.getByTestId("bot-role-template-toggle").click();
  await main.getByTestId("bot-role-template-diff").waitFor();
  const diffProblems = await measure(page);
  failed += report("template changes 760x520", { "fits the main slot": diffProblems.length === 0 }, diffProblems);

  // The same screen as the bot's own Role and memory tab, in its view (PRO-468).
  await page.setViewportSize(viewports[0]);
  await page.evaluate(() => window.__PW_STUB__.emit("open_session", { sessionId: "atlas-home" }));
  const view = page.getByRole("main", { name: "Atlas, CTO" });
  await view.waitFor();
  await view.getByRole("tab", { name: "Role and memory" }).click();
  await view.locator("[data-testid=bot-role-text]").waitFor();
  await view.locator("[data-testid=bot-change]").nth(4).waitFor();
  failed += report("bot view's Role and memory tab", {
    "the tab is selected": (await view.getByRole("tab", { name: "Role and memory" }).getAttribute("aria-selected")) === "true",
    "three places": (await view.locator("[data-testid=bot-memory-place]").count()) === 3,
    "below the tabs": (await view.getByRole("tabpanel", { name: "Role and memory" }).boundingBox()).y >= (await view.getByRole("tablist").boundingBox()).y,
  });
  for (const viewport of [viewports[0], viewports[3]]) {
    await page.setViewportSize(viewport);
    const problems = await measure(page);
    failed += report(`bot view's Role and memory ${viewport.width}x${viewport.height}`, { "fits the main slot": problems.length === 0 }, problems);
  }
  await shot(page, "2306-role-memory-in-bot-view");
  await page.close();
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
