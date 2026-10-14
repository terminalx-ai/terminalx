#!/usr/bin/env node
// WebKit layout check for the rows of refused commands above a cloud
// transcript (the acceptance pass's "Not sent" rows): with three long
// refusals, at 1280 and 900 px wide, the rows stay inside the session pane,
// their words wrap instead of running off its edge, they take a bounded
// height, and they read as their own bar above the transcript.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/cloud-outbox.mjs [screenshot-dir]
import { launch, open, report, serve } from "./harness.mjs";

const SLASH = "/model: only someone who can approve permissions may send it. Without that right you can send /clear, /compact, /help.";
const SHELL = "a message that starts with ! runs as a shell command in the agent's terminal, which needs someone who can approve permissions.";
const outbox = [
  { text: "/model opus", category: "slash-command-forbidden", receipt: { message: SLASH } },
  { text: "!ls", category: "shell-command-forbidden", receipt: { message: SHELL } },
  { text: "/model opus", category: "slash-command-forbidden", receipt: { message: SLASH } },
];
const shots = process.argv[2];

const server = await serve();
const browser = await launch();
let failed = 0;
for (const width of [1280, 900]) {
  const name = `refused commands at ${width} px`;
  const page = await open(browser, server.url, { cloud: true, localProjects: 0, session: { role: "driver", lines: 25, outbox } }, { width, height: 760 });
  const title = await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle);
  const row = page.locator('[data-testid="cloud-session-node"]');
  await row.waitFor();
  await row.getByRole("button", { name: title, exact: true }).click();
  await page.getByText("chunk 25 of 25", { exact: true }).waitFor();
  await page.locator('[data-testid="cloud-agent-outbox"]').waitFor();
  await page.waitForTimeout(400);
  const layout = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="cloud-agent-outbox"]');
    const pane = list.parentElement.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    const scroller = document.querySelector("[data-chat-scroller]").getBoundingClientRect();
    const rows = [...list.querySelectorAll('[data-testid="cloud-agent-command"]')];
    const parts = rows.flatMap((row) => [...row.children]);
    const background = getComputedStyle(list).backgroundColor;
    return {
      pane: { left: Math.round(pane.left), right: Math.round(pane.right) },
      list: { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height), right: Math.round(box.right), scrollWidth: list.scrollWidth, clientWidth: list.clientWidth },
      scrollerTop: Math.round(scroller.top),
      rows: rows.length,
      overflowing: parts.filter((part) => part.getBoundingClientRect().right > pane.right + 1).map((part) => part.textContent.slice(0, 40)),
      background,
    };
  });
  failed += report(name, {
    "all three refusals are listed": layout.rows === 3,
    "no part of a row runs past the session pane": layout.overflowing.length === 0 && layout.list.scrollWidth <= layout.list.clientWidth + 1,
    "the rows end above the transcript": layout.list.bottom <= layout.scrollerTop + 1,
    "they take at most a quarter of the window": layout.list.height <= 760 / 4,
    "they sit on their own background": layout.background !== "rgba(0, 0, 0, 0)" && layout.background !== "transparent",
  }, layout);
  if (shots) await page.screenshot({ path: `${shots}/outbox-${width}.png` });
  await page.close();
}
await browser.close();
server.close();
process.exitCode = failed ? 1 : 0;
