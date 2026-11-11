// PRO-273: the session header's estimated cost and its usage popover, in real
// WebKit. Run after pnpm build: node scripts/webkit/session-cost.mjs
// SESSION_COST_SHOTS=<dir> saves screenshots of the header and the popover.
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const shots = process.env.SESSION_COST_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;

// Two tabs on different agents and models. The costs are what the runtime's
// price table gives for these tokens: GPT-5.6 Sol at $4 / $0.40 cached / $20
// a million, Sonnet 5.5 at $2 / $0.10 read / $2.50 written / $10.
const fixture = (sessionCost) => `
  const backend = window.__PW_STUB__;
  const at = new Date().toISOString();
  const row = (model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd) => ({ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd });
  const tab = (id, harness, title, model, models) => ({ id, harness, title, model, permissionMode: "default", status: "completed", created: at, modified: at, providerSessionId: id + "-conversation", usage: { models, updated: at } });
  const session = {
    id: "cost-s1", projectPath: "/repos/p0", cwd: "/repos/p0", branch: "make-slugify", worktreeRemoved: false,
    title: "Make slugify handle punctuation", created: at, modified: at, archived: false, pinned: false, activeTab: "cost-t1",
    tabs: [
      tab("cost-t1", "codex", "Make slugify handle punctuation", "gpt-5.6-sol", [row("gpt-5.6-sol", 38000, 21000, 412000, 0, 0.7368)]),
      tab("cost-t2", "claude", "Review the regex", "claude-sonnet-5-5", [row("claude-sonnet-5-5", 9000, 6000, 86000, 2000, 0.0916)]),
    ],
  };
  backend.answers.list_sessions = [session];
  backend.answers.list_workspaces = [{ path: "/repos/p0", name: "main", branch: "make-slugify", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }];
  backend.answers.list_harnesses = [{ id: "claude", name: "Claude", available: true }, { id: "codex", name: "Codex", available: true }];
  backend.answers.list_models = [
    { harness: "codex", id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { harness: "claude", id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  ];
  backend.answers.load_tab_events = () => [];
  backend.answers.experimental_settings = { nativeCodex: false, sessionCost: ${sessionCost} };
  window.__PW_USAGE_READS__ = 0;
  backend.answers.session_usage = () => { window.__PW_USAGE_READS__++; return { usage: null, session }; };
  backend.answers.check_agent_readiness = ({ harness }) => ({ state: "ready", checkedAt: at, version: "1", loginMethod: harness === "claude" ? "Claude account" : "ChatGPT account", plan: "max" });
  const today = new Date(); today.setHours(16, 10, 0, 0); if (today.getTime() < Date.now()) today.setTime(Date.now() + 3 * 3600_000);
  const later = new Date(today.getTime() + 95 * 60_000);
  const monday = new Date(); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7)); monday.setHours(9, 0, 0, 0);
  // The status store reads these together before it shows any window.
  backend.answers.status_resource_overview = { agentCount: 0, orphanCount: 0, rssBytes: 0, pressure: 0 };
  backend.answers.status_resource_sample = { totalRssBytes: 0, processes: [] };
  backend.answers.status_usage_refresh = () => backend.answers.status_usage_snapshot;
  backend.answers.status_usage_snapshot = { revision: 1, runtime: "r", windows: [
    { agent: "codex", key: "five_hour", label: "5h", usedPercent: 41, resetsAt: today.getTime(), windowMinutes: 300, updatedAt: Date.now(), stale: false },
    { agent: "codex", key: "weekly", label: "Weekly", usedPercent: 23, resetsAt: monday.getTime(), windowMinutes: 10080, updatedAt: Date.now(), stale: false },
    { agent: "claude", key: "five_hour", label: "5h", usedPercent: 12, resetsAt: later.getTime(), windowMinutes: 300, updatedAt: Date.now(), stale: false },
  ] };
`;

try {
  // Off (the default): the header has no cost.
  {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: fixture(false), colorScheme: "dark" });
    await openConversation(page, "Make slugify handle punctuation");
    await page.waitForTimeout(500);
    failed += report("session cost off", { "no cost in the header": (await page.getByTestId("session-cost").count()) === 0 });
    await page.close();
  }
  // On: the chip, then the popover.
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: fixture(true), colorScheme });
    await openConversation(page, "Make slugify handle punctuation");
    const chip = page.getByTestId("session-cost");
    await chip.waitFor();
    const header = page.locator("main header").first();
    if (shots) await header.screenshot({ path: `${shots}/session-cost-header-${colorScheme}.png` });
    const chipText = await chip.textContent();
    await chip.click();
    const popover = page.getByRole("dialog", { name: "Session usage" });
    await popover.waitFor();
    await popover.getByText("subscriptions · nothing billed per token").waitFor();
    await popover.getByTestId("session-usage-window").first().waitFor();
    const models = await popover.getByTestId("session-usage-model").allTextContents();
    const tabs = await popover.getByTestId("session-usage-tab").allTextContents();
    const total = await popover.getByTestId("session-usage-total").textContent();
    const text = await popover.textContent();
    if (shots) await page.screenshot({ path: `${shots}/session-cost-popover-${colorScheme}.png` });
    const box = await popover.boundingBox();
    failed += report(`session cost on (${colorScheme})`, {
      "the chip shows the estimate": chipText === "≈ $0.83",
      "a row per model, costliest first": JSON.stringify(models) === JSON.stringify(["GPT-5.6 Sol38k21k412k$0.74", "Sonnet 5.59k6k88k$0.09"]),
      "each tab's cost": JSON.stringify(tabs) === JSON.stringify(["Tab “Make slugify handle punctuation”$0.74", "Tab “Review the regex”$0.09"]),
      "the session total": total === "$0.83",
      "labelled API-equivalent on subscriptions": text.includes("API-equivalent"),
      "usage windows beside it": (await popover.getByTestId("session-usage-window").count()) === 3,
      "opening it reads the totals again": (await page.evaluate(() => window.__PW_USAGE_READS__)) >= 1,
      "the popover is the design's width and on screen": !!box && Math.round(box.width) === 400 && box.x >= 0 && box.x + box.width <= 1440,
    }, { chipText, models, tabs, total, box });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
