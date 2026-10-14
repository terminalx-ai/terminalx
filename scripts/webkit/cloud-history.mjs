#!/usr/bin/env node
// WebKit check for a shared cloud session opened by someone who has never
// read it (the acceptance pass's "Nothing here yet" for 20 s): while the
// runtime's replay is on its way the chat says it is loading, never that
// nothing was said, and the history shows once the replay comes.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/cloud-history.mjs [screenshot-dir]
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.argv[2];
const server = await serve();
const browser = await launch();
const page = await open(browser, server.url, { cloud: true, localProjects: 0, session: { role: "driver", lines: 25, replayDelayMs: 2500 } }, { width: 1280, height: 760 });
const title = await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle);
const row = page.locator('[data-testid="cloud-session-node"]');
await row.waitFor();
await row.getByRole("button", { name: title, exact: true }).click();
await page.locator("[data-chat-scroller]").waitFor();
await page.waitForTimeout(800);
const waiting = {
  loading: await page.getByText("Loading the conversation…").isVisible(),
  empty: await page.getByText("Nothing here yet. Ask for something below.").isVisible(),
};
if (shots) await page.screenshot({ path: `${shots}/history-loading.png` });
const arrived = await page.getByText("chunk 25 of 25", { exact: true }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
const failed = report("a shared session opened for the first time", {
  "says it is loading while the replay is on its way": waiting.loading,
  "never says nothing is here meanwhile": !waiting.empty,
  "shows the history once it comes": arrived,
  "no longer says it is loading": arrived && !(await page.getByText("Loading the conversation…").isVisible()),
}, waiting);
await browser.close();
server.close();
process.exitCode = failed ? 1 : 0;
