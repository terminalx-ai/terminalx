#!/usr/bin/env node
// #407: the usage timer, its Settings control and the popover's freshness line
// in a real WebKit, using only synthetic data and a controlled clock.
// pnpm build && node scripts/webkit/usage-refresh.mjs
// USAGE_REFRESH_SHOTS=docs/screenshots/issue-407 also saves rendered evidence.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, serve } from "./harness.mjs";

const stub = await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8");
const shots = process.env.USAGE_REFRESH_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const MINUTE = 60_000;

function setup() {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false }));
  const { answers, emit } = window.__PW_STUB__;
  const hour = 60 * 60_000;
  const settings = { visible: true, usage: true, resources: false, percent: "used", usageMode: "detailed", usageRefreshMinutes: 1 };
  const fixture = { refreshes: [], patches: [], used: 12, failing: false, revision: 0, lastSuccess: null, retryAt: null };
  const snapshot = () => {
    const now = Date.now();
    const window_ = (agent, key, label, usedPercent, minutes, reset) => ({ agent, key, label, usedPercent, resetsAt: now + reset, windowMinutes: minutes, updatedAt: fixture.lastSuccess ?? now, stale: false });
    return {
      revision: ++fixture.revision,
      claudeAccount: "synthetic",
      claude: { retryAt: null, revalidateAt: null, error: null, lastSuccessAt: fixture.lastSuccess },
      codexRefresh: { retryAt: fixture.retryAt, error: fixture.failing ? "read Codex rate limits: synthetic timeout" : null, lastSuccessAt: fixture.codexSuccess ?? fixture.lastSuccess },
      windows: [
        window_("claude", "five_hour", "5h", fixture.used, 300, 2 * hour),
        window_("claude", "seven_day", "7d", 41, 10_080, 100 * hour),
        window_("codex", "five_hour", "5h", 23, 300, 3 * hour),
      ],
    };
  };
  Object.assign(answers, {
    list_harnesses: [{ id: "claude", name: "Claude", available: true }, { id: "codex", name: "Codex", available: true }],
    status_bar_settings: () => ({ ...settings }),
    set_status_bar_settings: ({ patch }) => {
      fixture.patches.push(patch);
      Object.assign(settings, patch);
      emit("status_bar_settings", { ...settings });
      return { ...settings };
    },
    status_usage_snapshot: snapshot,
    status_usage_refresh: ({ manual }) => {
      fixture.refreshes.push({ at: Date.now(), manual });
      fixture.used += 1;
      if (fixture.failing) fixture.retryAt = Date.now() + 4 * 60_000;
      else { fixture.retryAt = null; fixture.codexSuccess = Date.now(); }
      fixture.lastSuccess = Date.now();
      return snapshot();
    },
    status_resource_overview: { agentCount: 0, orphanCount: 0, rssBytes: null, pressure: null },
    "plugin:window|is_focused": false,
    "plugin:window|is_minimized": false,
  });
  window.__USAGE_FIXTURE__ = fixture;
}

const server = await serve();
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => console.error(error.message));
  await page.clock.install({ time: new Date("2026-10-01T12:00:00Z") });
  await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: false, localProjects: 1, localSession: true };\n${stub}\n(${setup})();`);
  await page.goto(server.url);
  const refreshes = () => page.evaluate(() => window.__USAGE_FIXTURE__.refreshes.length);
  const bar = page.locator("[data-status-bar]");
  await bar.locator('[data-usage-agent="claude"]').waitFor();
  await page.waitForFunction(() => window.__USAGE_FIXTURE__.refreshes.length === 1);

  // Default interval: a refresh a minute with the popover closed and no input.
  for (let tick = 2; tick <= 4; tick += 1) {
    await page.clock.runFor(MINUTE - 1_000);
    assert.equal(await refreshes(), tick - 1, `no early refresh before tick ${tick}`);
    await page.clock.runFor(1_000);
    await page.waitForFunction((count) => window.__USAGE_FIXTURE__.refreshes.length === count, tick);
  }
  await bar.getByText("16% used", { exact: true }).waitFor();
  assert.ok((await page.evaluate(() => window.__USAGE_FIXTURE__.refreshes)).every((entry) => entry.manual === false));
  console.log("ok  default: usage in the bar follows a refresh every minute, popover closed");

  // The details say when each provider last answered, and that a paused one is last known.
  await page.evaluate(() => { window.__USAGE_FIXTURE__.failing = true; });
  await page.clock.runFor(MINUTE);
  await page.waitForFunction(() => window.__USAGE_FIXTURE__.refreshes.length === 5);
  await page.clock.runFor(2 * MINUTE);
  await bar.getByRole("button", { name: /Claude 5h/ }).click();
  const popover = page.locator("[data-usage-popover]");
  await popover.getByRole("status").getByText(/Codex refresh paused; retry in \dm\. read Codex rate limits: synthetic timeout/).waitFor();
  await popover.getByRole("button", { name: /^Codex, / }).click();
  const detail = page.locator('[data-usage-detail="codex"]');
  const freshness = detail.locator("[data-usage-freshness]");
  await freshness.getByText("Last refreshed 3m ago", { exact: true }).waitFor();
  await freshness.getByText(/Refresh paused; retry in \dm\. Showing last known usage\./).waitFor();
  await detail.getByText("23% used", { exact: true }).waitFor();
  const fits = async (inner, outer, name) => {
    const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
    assert.ok(a.x >= b.x - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y >= b.y - 0.5 && a.y + a.height <= b.y + b.height + 0.5, `${name}: stays inside its container`);
    assert.ok(await inner.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${name}: no clipped text`);
  };
  await fits(freshness, detail, "freshness line");
  await fits(popover.getByRole("status"), popover, "popover notice");
  const viewport = page.viewportSize();
  const box = await detail.boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, "detail panel is fully on screen");
  if (shots) await page.screenshot({ path: join(shots, "usage-detail-paused.png"), animations: "disabled" });

  // Recovery: the next answer clears the pause and the stale wording.
  await page.evaluate(() => { window.__USAGE_FIXTURE__.failing = false; });
  await popover.getByRole("button", { name: "Refresh usage", exact: true }).click();
  await freshness.getByText("Last refreshed just now", { exact: true }).waitFor();
  assert.equal(await freshness.getByText(/last known/).count(), 0);
  assert.equal(await popover.getByRole("status").count(), 0);
  assert.equal((await page.evaluate(() => window.__USAGE_FIXTURE__.refreshes.at(-1))).manual, true);
  if (shots) await page.screenshot({ path: join(shots, "usage-detail-fresh.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  console.log("ok  details: last refresh time, paused/last-known wording, and recovery");

  // Settings → Appearance: the control, laid out at a wide and a narrow window.
  await page.locator('[data-testid="sidebar-rail"]').getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const group = page.getByRole("radiogroup", { name: "Usage auto-refresh interval" });
  await group.scrollIntoViewIfNeeded();
  assert.deepEqual(await group.getByRole("radio").allTextContents(), ["Off", "1 min", "2 min", "5 min", "15 min"]);
  assert.equal(await group.getByRole("radio", { name: "1 min", exact: true }).getAttribute("aria-checked"), "true");
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await group.scrollIntoViewIfNeeded();
    const g = await group.boundingBox();
    assert.ok(g.x >= 0 && g.x + g.width <= width, `interval control fits a ${width}px window`);
    const label = await page.getByText("Usage auto-refresh interval", { exact: true }).boundingBox();
    assert.ok(label.x + label.width <= g.x || label.y + label.height <= g.y, `label and control do not overlap at ${width}px`);
    for (const radio of await group.getByRole("radio").all()) {
      assert.ok(await radio.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `option text is not clipped at ${width}px`);
    }
    if (shots) await page.screenshot({ path: join(shots, `settings-interval-${width}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // Choosing a value saves it and re-times the one timer at once.
  let count = await refreshes();
  await page.clock.runFor(MINUTE);
  await page.waitForFunction((n) => window.__USAGE_FIXTURE__.refreshes.length === n, ++count);
  await group.getByRole("radio", { name: "5 min", exact: true }).click();
  await page.waitForFunction(() => window.__USAGE_FIXTURE__.patches.at(-1)?.usageRefreshMinutes === 5);
  assert.equal(await group.getByRole("radio", { name: "5 min", exact: true }).getAttribute("aria-checked"), "true");
  await page.clock.runFor(4 * MINUTE - 1_000);
  assert.equal(await refreshes(), count, "five minutes means no refresh in the first four");
  await page.clock.runFor(MINUTE + 1_000);
  await page.waitForFunction((n) => window.__USAGE_FIXTURE__.refreshes.length === n, ++count);

  await group.getByRole("radio", { name: "Off", exact: true }).click();
  await page.waitForFunction(() => window.__USAGE_FIXTURE__.patches.at(-1)?.usageRefreshMinutes === 0);
  await page.clock.runFor(30 * MINUTE);
  assert.equal(await refreshes(), count, "Off stops the timer");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction((n) => window.__USAGE_FIXTURE__.refreshes.length === n, ++count);

  // The choice is what a restart reads back.
  await group.getByRole("radio", { name: "2 min", exact: true }).click();
  await page.waitForFunction(() => window.__USAGE_FIXTURE__.patches.at(-1)?.usageRefreshMinutes === 2);
  assert.deepEqual(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("status_bar_settings").then((s) => s.usageRefreshMinutes)), 2);
  console.log("ok  settings: five choices, no overlap at 1280/760px, saved and applied without a restart");
  await page.close();
} finally {
  await browser.close();
  server.close();
}
