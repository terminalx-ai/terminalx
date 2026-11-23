#!/usr/bin/env node
// WebKit layout check for messages a cloud workspace did not deliver (the
// acceptance pass's "Not sent" refusals), drawn since #1291 as the Queued
// cards a local session draws, at the end of the transcript: with three long
// refusals, at 1280 and 900 px wide, each is a card in the transcript's
// column, its reason wraps instead of running off the pane, and no bar above
// the transcript repeats them.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/cloud-outbox.mjs [screenshot-dir]
import { launch, open, openCloudSession, report, serve } from "./harness.mjs";

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
  const name = `refused messages at ${width} px`;
  const page = await open(browser, server.url, { cloud: true, localProjects: 0, session: { role: "driver", lines: 25, outbox } }, { width, height: 760 });
  // The session is reached through the command palette (the sidebar lists no cloud sessions since #484).
  await openCloudSession(page, await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle));
  await page.getByText("chunk 25 of 25", { exact: true }).waitFor();
  await page.locator('[data-testid="cloud-pending-messages"]').waitFor();
  await page.waitForTimeout(400);
  const layout = await page.evaluate(() => {
    const scroller = document.querySelector("[data-chat-scroller]");
    const pane = scroller.getBoundingClientRect();
    const list = document.querySelector('[data-testid="cloud-pending-messages"]');
    const cards = [...list.querySelectorAll('[data-testid="queued-message"]')];
    const lines = cards.map((card) => card.querySelector('[data-testid="queued-status"]'));
    const parts = cards.flatMap((card) => [...card.querySelectorAll("span, p, button")]);
    const lastTurn = [...scroller.querySelectorAll(".transcript-turn")].at(-1);
    return {
      pane: { left: Math.round(pane.left), right: Math.round(pane.right) },
      cards: cards.length,
      failed: cards.filter((card) => card.dataset.phase === "failed").length,
      inScroller: scroller.contains(list),
      afterLastTurn: !lastTurn || lastTurn.getBoundingClientRect().bottom <= list.getBoundingClientRect().top + 1,
      lines: lines.map((line) => line?.textContent?.slice(0, 40) ?? null),
      wrapped: lines.some((line) => line && line.getBoundingClientRect().height > 24),
      overflowing: parts.filter((part) => part.getBoundingClientRect().right > pane.right + 1).map((part) => part.textContent.slice(0, 40)),
      bar: !!document.querySelector('[data-testid="cloud-agent-outbox"]'),
    };
  });
  failed += report(name, {
    "all three refusals are cards": layout.cards === 3 && layout.failed === 3,
    "each says why under it": layout.lines.every((line) => line?.startsWith("Not sent")),
    "the cards are in the transcript, after its last turn": layout.inScroller && layout.afterLastTurn,
    "no part of a card runs past the transcript": layout.overflowing.length === 0,
    "a long reason wraps": layout.wrapped,
    "no bar above the transcript repeats them": !layout.bar,
  }, layout);
  if (shots) await page.screenshot({ path: `${shots}/outbox-${width}.png` });
  await page.close();
}
await browser.close();
server.close();
process.exitCode = failed ? 1 : 0;
