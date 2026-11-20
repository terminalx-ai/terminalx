// PRO-379: a finished turn's footer, its details popover, its "…" menu and
// the composer's context and usage popover, in real WebKit, dark and light,
// at 1440 wide. Run after pnpm build: node scripts/webkit/turn-details.mjs
// TURN_DETAILS_SHOTS=<dir> saves a screenshot of each.
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const shots = process.env.TURN_DETAILS_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;

const fixture = `
  const backend = window.__PW_STUB__;
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const session = {
    id: "td-s1", projectPath: "/repos/p0", cwd: "/repos/p0", branch: "dedupe-permission-cards", worktreeRemoved: false,
    title: "Fix duplicate permission cards", created: at(30), modified: at(1), archived: false, pinned: false, activeTab: "td-t1",
    tabs: [{ id: "td-t1", harness: "claude", title: "Fix duplicate permission cards", model: "claude-opus-5-5", effort: "high", permissionMode: "manual",
      status: "completed", created: at(30), modified: at(1), providerSessionId: "11111111-1111-4111-8111-111111111111" }],
  };
  backend.answers.list_sessions = [session];
  backend.answers.list_workspaces = [{ path: "/repos/p0", name: "main", branch: "dedupe-permission-cards", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }];
  backend.answers.list_harnesses = [{ id: "claude", name: "Claude", available: true }, { id: "codex", name: "Codex", available: true }];
  backend.answers.list_models = [{ harness: "claude", id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high"] }, { harness: "codex", id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }];
  let seq = 0;
  const event = (minutesAgo, payload, extra = {}) => ({ id: "e" + (++seq), seq, sessionId: "td-s1", tabId: "td-t1", harness: "claude", ts: at(minutesAgo), payload, ...extra });
  const usage = { inputTokens: 66, outputTokens: 1058, cacheReadTokens: 96065, cacheWriteTokens: 36895, costUsd: 0.38, model: "claude-opus-5-5", effort: "high", fast: false, contextUsed: 312000, contextMax: 1000000 };
  backend.answers.load_tab_events = () => [
    event(12, { type: "user_message", text: "Permission cards show up twice. Dedupe them by tool_use_id in AskCards and add a regression test.", queued: false }, { messageTs: at(12) }),
    event(12, { type: "turn_started" }),
    event(11, { type: "assistant_text", text: "Done. Permission cards are now keyed by \`tool_use_id\`, so the hook frame and the transcript line collapse into one card." }, { messageTs: at(11) }),
    event(11, { type: "turn_completed", status: "ok", durationMs: 72000, usage, authFailed: false }),
    event(3, { type: "user_message", text: "Commit it and open a PR using the template I attached.", queued: false }, { messageTs: at(3) }),
    event(3, { type: "turn_started" }),
    event(2, { type: "assistant_text", text: "Committed and opened a PR against main with the template's Summary, Test plan and Risk sections." }, { messageTs: at(2) }),
    event(2, { type: "turn_completed", status: "ok", durationMs: 38000, usage: { ...usage, costUsd: 0.21 }, authFailed: false }),
  ];
  backend.answers.check_agent_readiness = () => ({ state: "ready", checkedAt: at(0), version: "1", loginMethod: "Claude account", plan: "max", account: "alex@example.com" });
  const soon = now + 88 * 60_000;
  const saturday = new Date(); saturday.setDate(saturday.getDate() + ((6 - saturday.getDay()) % 7 || 7)); saturday.setHours(11, 0, 0, 0);
  // The weekly windows must reset more than a day out, or the popover shows "Resets at …" for them too (on Fridays).
  if (saturday.getTime() - now < 24 * 3600_000) saturday.setDate(saturday.getDate() + 7);
  backend.answers.status_resource_overview = { agentCount: 0, orphanCount: 0, rssBytes: 0, pressure: 0 };
  backend.answers.status_resource_sample = { totalRssBytes: 0, processes: [] };
  backend.answers.status_usage_refresh = () => backend.answers.status_usage_snapshot;
  backend.answers.status_usage_snapshot = { revision: 1, runtime: "r", windows: [
    { agent: "claude", key: "five_hour", label: "5-hour window", usedPercent: 86, resetsAt: soon, windowMinutes: 300, updatedAt: now, stale: false },
    { agent: "claude", key: "weekly", label: "Weekly", usedPercent: 41, resetsAt: saturday.getTime(), windowMinutes: 10080, updatedAt: now, stale: false },
    { agent: "claude", key: "weekly_opus", label: "Weekly · Opus", usedPercent: 22, resetsAt: saturday.getTime(), windowMinutes: 10080, updatedAt: now, stale: false },
  ] };
`;

/** Everything readable in `root`: no text under 12px, and nothing spilling out of the window or the popover. */
async function layout(root) {
  return root.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const texts = [...el.querySelectorAll("*")].filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()));
    const small = texts.filter((node) => parseFloat(getComputedStyle(node).fontSize) < 12).map((node) => node.textContent.trim());
    const spill = texts.filter((node) => { const r = node.getBoundingClientRect(); return r.width && (r.left < box.left - 1 || r.right > box.right + 1); }).map((node) => node.textContent.trim());
    return { width: Math.round(box.width), inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1, small, spill };
  });
}

try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: fixture, colorScheme });
    await openConversation(page, "Fix duplicate permission cards");
    const footers = page.getByTestId("turn-footer");
    await footers.first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const first = footers.first();

    // The footer: the duration and time chip, then copy, read aloud, "…" and Second opinion.
    await first.hover();
    const chip = first.getByRole("button", { name: /^Turn details: 1m 12s · / });
    failed += report(`footer ${colorScheme}`, {
      "the chip says how long and when": /^1m 12s · /.test(await chip.textContent()),
      "no Reset to here button": (await first.getByRole("button", { name: "Reset to here" }).count()) === 0,
      "a turn menu": (await first.getByRole("button", { name: "Turn actions" }).count()) === 1,
      "Second opinion with its icon": (await first.getByRole("button", { name: /Second opinion/ }).locator("svg").count()) === 1,
    });

    // Turn details, opened from the chip, which is highlighted while open.
    await chip.click();
    const details = page.getByRole("dialog", { name: "Turn details" });
    await details.waitFor();
    const text = await details.textContent();
    const geometry = await layout(details);
    failed += report(`turn details ${colorScheme}`, {
      "headed Claude Code · Opus 5.5": text.startsWith("Claude Code · Opus 5.5"),
      "no raw model id as the label": !/Modelclaude-opus/.test(text),
      "settings rows": ["EffortHigh", "Fast modeOff", "Permission modeAsk every time"].every((row) => text.includes(row)),
      "tokens and tiles": ["Tokens this turn", "Input66", "Cache read96,065", "72%cache hit", "15/soutput tokens", "$0.38estimated"].every((row) => text.includes(row)),
      "cost footnote": text.includes("Cost is an estimate at API prices, not your bill."),
      "chip highlighted while open": (await chip.getAttribute("data-state")) === "open",
      "inside the window": geometry.inside,
      "nothing under 12px": geometry.small.length === 0,
      "nothing spills": geometry.spill.length === 0,
    }, geometry);
    const range = await details.locator("p.font-mono").first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    failed += report(`turn details ${colorScheme}`, { "time range fits on its line": range });
    await page.waitForTimeout(400);
    if (shots) await page.screenshot({ path: `${shots}/turn-details-${colorScheme}.png` });
    await page.keyboard.press("Escape");

    // The "…" menu.
    await first.hover();
    await first.getByRole("button", { name: "Turn actions" }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const items = await menu.getByRole("menuitem").allTextContents();
    const menuGeometry = await layout(menu);
    failed += report(`turn menu ${colorScheme}`, {
      "fork, reset, copy, snippet, second opinion": ["Fork to new tab", "Fork to new session", "Reset chat to here…", "Copy answer as Markdown", "Save the prompt as a snippet…", "Second opinion from Codex"]
        .every((label, i) => items[i]?.startsWith(label)),
      "reset says what it does": items[2]?.includes("Removes later turns; can reset files too"),
      "every hint on one line": await menu.getByRole("menuitem").evaluateAll((rows) => rows.every((row) => [...row.querySelectorAll("span.block")].every((line) => { const range = document.createRange(); range.selectNodeContents(line); return range.getClientRects().length <= 1; }))),
      "inside the window": menuGeometry.inside,
      "nothing under 12px": menuGeometry.small.length === 0,
      "nothing spills": menuGeometry.spill.length === 0,
    }, { items, menuGeometry });
    await page.waitForTimeout(400); // past the menu's opening fade
    if (shots) await page.screenshot({ path: `${shots}/turn-menu-${colorScheme}.png` });
    await page.keyboard.press("Escape");

    // The composer's ring with its percentage, and the context and usage popover.
    const ring = page.getByRole("button", { name: "Context 31% used" });
    await ring.waitFor();
    const ringText = await ring.textContent();
    await ring.click();
    const context = page.getByRole("dialog", { name: "Context and session details" });
    await context.getByText("Claude Max", { exact: false }).first().waitFor();
    const contextText = await context.textContent();
    const contextGeometry = await layout(context);
    failed += report(`context popover ${colorScheme}`, {
      "ring shows 31%": ringText === "31%",
      "ring highlighted while open": (await ring.getAttribute("data-state")) === "open",
      "no title, leads with Context 312K of 1M · 31%": contextText.startsWith("Context312K of 1M · 31%"),
      "a context bar": (await context.getByRole("meter", { name: "Context used" }).count()) === 1,
      "Compact now under the bar with its hint": contextText.indexOf("Compact now") < contextText.indexOf("Claude usage") && contextText.includes("Types /compact into Claude Code"),
      "usage header with plan and refresh": /Claude usageMax plan · refreshed /.test(contextText),
      "a bar per window": (await context.getByRole("meter").count()) === 4,
      "absolute reset times": /Resets at .+ · in 1h 2[78]m/.test(contextText) && /Resets [A-Z][a-z]{2} /.test(contextText),
      "amber when high": (await context.getByText("86%", { exact: true }).evaluate((el) => getComputedStyle(el).color)) !== (await context.getByText("41%", { exact: true }).evaluate((el) => getComputedStyle(el).color)),
      "close-to-limit warning": contextText.includes("You're close to your 5-hour limit."),
      "account rows by name": ["Signed inalex@example.com · Claude Max", "ProviderAnthropic", "ModelOpus 5.5claude-opus-5-5", "Effort · FastHigh · Off", "This session so far$0.59 estimated"].every((row) => contextText.includes(row)),
      "about 390px wide": Math.abs(contextGeometry.width - 390) <= 2,
      "inside the window": contextGeometry.inside,
      "nothing under 12px": contextGeometry.small.length === 0,
      "nothing spills": contextGeometry.spill.length === 0,
    }, { contextText, contextGeometry });
    await page.waitForTimeout(400);
    if (shots) await page.screenshot({ path: `${shots}/context-${colorScheme}.png` });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
