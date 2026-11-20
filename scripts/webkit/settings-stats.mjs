#!/usr/bin/env node
// PRO-463, design 09.44: Stats & usage is a page of Settings, in Personal after
// Machines. Opened from its row in the Settings menu, it shows the page's title
// with Refresh at its top right, the activity totals, each account's usage
// limits and the usage analytics, wider than the other pages so the
// two-column cards fit, with nothing overlapping or spilling out of the
// column. In the light and the dark theme, at a wide and a narrow window.
//
// Set SETTINGS_STATS_SHOTS to a directory to also save a picture of each case.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/settings-stats.mjs
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.SETTINGS_STATS_SHOTS;

const fixture = `
  const answers = window.__PW_STUB__.answers;
  const now = Date.now();
  const day = (offset) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
  const snapshot = {
    app: { agentsSpawned: 1284, agentTimeMs: 412 * 3_600_000, prsCreated: 376, trackingSince: "2026-03-02T12:00:00Z" },
    totalTokens: 4_820_000_000, estimatedCostUsd: 14178.14, hasPartialCost: false, activeDays: 27, cacheShare: 0.93,
    newInputTokens: 190_000_000, outputTokens: 140_000_000, cacheTokens: 4_490_000_000, reasoningTokens: 9_700_000,
    daily: Array.from({ length: 30 }, (_, index) => ({ day: day(29 - index), totalTokens: (index * 7919) % 13 * 1e7, claudeTokens: 0, codexTokens: 0 })),
    providers: [
      { id: "claude", label: "Claude", enabled: true, hasData: true, lastModel: "claude-opus-5-5", lastProject: "ai/terminalx", totalTokens: 3_410_000_000, sessions: 156, activityCount: 20367, activityLabel: "turns", estimatedCostUsd: 4296.16, hasPartialCost: false },
      { id: "codex", label: "Codex", enabled: true, hasData: true, lastModel: "gpt-6-astra", lastProject: "ai/terminalx", totalTokens: 1_410_000_000, sessions: 267, activityCount: 58535, activityLabel: "events", estimatedCostUsd: 9881.98, hasPartialCost: false },
      { id: "opencode", label: "OpenCode", enabled: false, hasData: false, lastModel: null, lastProject: null, totalTokens: 0, sessions: 0, activityCount: 0, activityLabel: "events", estimatedCostUsd: null, hasPartialCost: false },
    ],
    updatedAt: now,
  };
  const state = { scope: "webkit", generation: 1, snapshot, refreshing: false, error: null };
  answers.stats_usage_snapshot = state;
  answers.stats_usage_refresh = state;
  answers.status_resource_overview = { agentCount: 0, orphanCount: 0, rssBytes: 0, pressure: 0 };
  answers.status_resource_sample = { totalRssBytes: 0, processes: [] };
  answers.status_usage_refresh = () => answers.status_usage_snapshot;
  answers.status_usage_snapshot = { revision: 1, runtime: "r", windows: [
    { agent: "claude", key: "five_hour", label: "5-hour", usedPercent: 38, resetsAt: now + 134 * 60_000, windowMinutes: 300, updatedAt: now, stale: false },
    { agent: "claude", key: "weekly", label: "Weekly", usedPercent: 61, resetsAt: now + 3 * 86_400_000, windowMinutes: 10080, updatedAt: now, stale: false },
    { agent: "codex", key: "five_hour", label: "5-hour", usedPercent: 12, resetsAt: now + 242 * 60_000, windowMinutes: 300, updatedAt: now, stale: false },
    { agent: "codex", key: "weekly", label: "Weekly", usedPercent: 27, resetsAt: now + 5 * 86_400_000, windowMinutes: 10080, updatedAt: now, stale: false },
  ] };
  // Two Claude logins, so the page lists usage limits by account (one login per agent shows none, as before).
  const claude = answers.status_usage_snapshot.windows.filter((window) => window.agent === "claude");
  answers.status_usage_snapshot.accounts = [
    { agent: "claude", accountId: "local", label: "Max · work account", windows: claude, error: null, unavailable: false },
    { agent: "claude", accountId: "personal", label: "Pro · personal account", windows: claude.map((window) => ({ ...window, usedPercent: window.usedPercent / 2 })), error: null, unavailable: false },
  ];
`;

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    for (const width of [1440, 900]) {
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width, height: 900 }, { extra: fixture, colorScheme });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: "Settings", exact: true }).first().click();
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      const nav = settings.getByRole("navigation", { name: "Settings sections" });
      await nav.getByRole("button", { name: "Stats & usage", exact: true }).click();
      await settings.getByRole("heading", { name: "Stats & usage", level: 2, exact: true }).waitFor();
      await settings.getByText("Agents spawned", { exact: true }).waitFor();
      await settings.getByText("Usage overview", { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
      const personal = await nav.getByRole("group", { name: "Personal" }).getByRole("button").allTextContents();
      const measured = await settings.locator('section[aria-labelledby="settings-section-title"]').evaluate((column) => {
        const box = column.getBoundingClientRect();
        const page = column.querySelector('[data-search-page="stats"]').getBoundingClientRect();
        const title = document.getElementById("settings-section-title").getBoundingClientRect();
        const refresh = column.querySelector('button[aria-label="Refresh local analytics"]').getBoundingClientRect();
        const spill = [...column.querySelectorAll("*")].filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width && (rect.right > box.right + 1 || rect.left < box.left - 1);
        }).map((element) => element.textContent?.slice(0, 80));
        // The cards of one row must not overlap each other.
        const cards = [...column.querySelectorAll("article, [data-setting-id] .rounded-xl")].map((element) => element.getBoundingClientRect());
        const overlaps = cards.some((a, i) => cards.some((b, j) => j > i && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
          && !(a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom) && !(b.left <= a.left && b.right >= a.right && b.top <= a.top && b.bottom >= a.bottom)));
        const order = ["stats.activity", "stats.accountLimits", "stats.analytics"].map((id) => column.querySelector(`[data-setting-id="${id}"]`)?.getBoundingClientRect().top ?? -1);
        return { pageWidth: page.width, columnWidth: column.clientWidth, scrollWidth: column.scrollWidth, refreshRight: refresh.right, pageRight: page.right, refreshTop: refresh.top, titleTop: title.top, titleBottom: title.bottom, spill, overlaps, order };
      });
      if (shots) await page.screenshot({ path: join(shots, `settings-stats-${colorScheme}-${width}.png`) });
      failed += report(`settings stats & usage ${colorScheme} ${width}`, {
        "listed in Personal right after Machines": personal.indexOf("Stats & usage") === personal.indexOf("Machines") + 1,
        "Refresh at the top right, beside the title": measured.refreshRight > measured.pageRight - 40 && measured.refreshTop < measured.titleBottom,
        "wider than the other pages where the window allows": width < 1200 || measured.pageWidth > 48 * 16 + 1,
        "activity, then usage limits, then analytics": measured.order.every((top, index) => top >= 0 && (index === 0 || top > measured.order[index - 1])),
        "both accounts' limits, side by side where they fit": (await settings.getByRole("heading", { name: "Usage limits by account" }).count()) === 1
          && (await settings.getByRole("article", { name: "Max · work account" }).count()) === 1 && (await settings.getByRole("article", { name: "Pro · personal account" }).count()) === 1,
        "nothing spills out of the column": measured.spill.length === 0 && measured.scrollWidth <= measured.columnWidth,
        "no cards overlap": !measured.overlaps,
        "no page errors": errors.length === 0,
      }, measured);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
