#!/usr/bin/env node
// #1009: a wide Markdown table keeps its columns and scrolls sideways inside its
// own container, in the transcript and in the full-screen viewer, instead of
// squeezing every column to the transcript's width. A narrow table still fills
// the width.
//
// pnpm build && pnpm exec playwright install webkit && pnpm test:webkit-chat-tables
import assert from "node:assert/strict";
import { launch, open, openConversation, serve, tab } from "./harness.mjs";

const prose = "Moves the session's launch settings into one component, so New Session, issue start and handoff agree on the model.";
const hash = "9f29b53a".repeat(16);
const wide = [
  "| Ticket | What | PR | Status | Next | ETA |",
  "|---|---|---|---|---|---|",
  `| PRO-342 | ${prose} | #1002 | In review | ${prose} | ~1–1.5 h |`,
  `| PRO-343 | ${prose} | #1007 | Blocked | Rebase on \`src/components/chat/MarkdownTable.tsx\` then ${hash} | After #1007 |`,
].join("\n");
const narrow = "| Name | Value |\n|---|---|\n| one | 1 |\n| two | 2 |";
// Columns 0, 2, 3 and 5 hold short values; 1 and 4 hold prose.
const shortColumns = [0, 2, 3, 5];
const proseColumns = [1, 4];

const server = await serve();
let browser;
try {
  browser = await launch();
  for (const floating of [true, false]) {
    const extra = `(() => {
      window.__PW_STUB__.answers.load_tab_events = ({ tabId }) => {
        const payloads = [
          { type: "user_message", text: "Status?", queued: false },
          { type: "turn_started" },
          { type: "assistant_text", text: ${JSON.stringify(`Here it is:\n\n${wide}\n\nAnd a small one:\n\n${narrow}\n`)} },
          { type: "turn_completed", status: "ok", durationMs: 1000 },
        ];
        return payloads.map((payload, i) => ({ id: "table-" + i, seq: i + 1, sessionId: "local-s1", tabId, harness: "gemini", ts: "2026-11-15T00:00:00Z", payload }));
      };
    })();`;
    // Main windows have a native minimum width of 760px; floating windows can be narrower.
    const width = floating ? 480 : 760;
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, floating }, { width, height: 800 }, { extra });
    if (!floating) {
      await openConversation(page, "Local long session");
      await tab(page, "gemini tab").click();
    }
    await page.locator("[data-chat-scroller] table:visible").first().waitFor();
    await page.evaluate(() => document.fonts.ready);

    const measure = (scope) => page.evaluate((scope) => {
      const visible = (el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility === "visible";
      const root = scope === "fullscreen"
        ? document.querySelector('[data-streamdown="table-fullscreen"]')
        : [...document.querySelectorAll("[data-chat-scroller]")].find(visible);
      const lines = (el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
      };
      const tables = [...root.querySelectorAll('table[data-streamdown="table"]')].map((table) => {
        const scroll = table.closest("[data-chat-table-scroll]");
        const rows = [...table.rows].map((row) => [...row.cells]);
        return {
          scrollWidth: scroll.scrollWidth,
          clientWidth: scroll.clientWidth,
          tableWidth: table.getBoundingClientRect().width,
          lines: rows.map((cells) => cells.map(lines)),
          widths: rows[0].map((cell) => cell.getBoundingClientRect().width),
          em: parseFloat(getComputedStyle(table).fontSize),
        };
      });
      return { tables, transcriptOverflow: root.scrollWidth - root.clientWidth, pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    }, scope);

    const check = (label, result, { narrowToo }) => {
      const [table, small] = result.tables;
      assert.ok(table.scrollWidth > table.clientWidth, `${label}: the wide table scrolls sideways ${JSON.stringify(table)}`);
      for (const [r, row] of table.lines.entries()) {
        for (const c of shortColumns) assert.equal(row[c], 1, `${label}: row ${r} column ${c} stays on one line ${JSON.stringify(table.lines)}`);
      }
      for (const c of proseColumns) {
        assert.ok(table.widths[c] >= 12 * table.em, `${label}: prose column ${c} is at least 12em ${JSON.stringify(table.widths)}`);
        // 22em and its padding.
        assert.ok(table.widths[c] <= 24 * table.em, `${label}: prose column ${c} is held to a measure ${JSON.stringify(table.widths)}`);
        assert.ok(table.lines.slice(1).some((row) => row[c] > 1), `${label}: prose column ${c} wraps`);
      }
      assert.ok(result.transcriptOverflow <= 1, `${label}: the transcript does not scroll sideways (${result.transcriptOverflow})`);
      assert.ok(result.pageOverflow <= 1, `${label}: the page does not scroll sideways (${result.pageOverflow})`);
      if (narrowToo) {
        assert.ok(small.scrollWidth <= small.clientWidth, `${label}: the two-column table does not scroll ${JSON.stringify(small)}`);
        assert.ok(Math.abs(small.tableWidth - small.clientWidth) <= 1, `${label}: the two-column table fills the width ${JSON.stringify(small)}`);
      }
    };

    const where = floating ? "floating 480px" : "main 760px";
    if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/${floating ? "floating" : "main"}-transcript.png` });
    check(`${where} transcript`, await measure("transcript"), { narrowToo: true });
    console.log(`ok  ${where} transcript: wide table scrolls with short columns on one line; two-column table fills the width`);

    await page.locator("[data-chat-scroller] [data-streamdown=\"table-wrapper\"]:visible").first().getByRole("button", { name: "View fullscreen" }).evaluate((button) => button.click());
    await page.locator('[data-streamdown="table-fullscreen"] table').waitFor();
    check(`${where} fullscreen`, await measure("fullscreen"), { narrowToo: false });
    console.log(`ok  ${where} fullscreen: wide table scrolls with short columns on one line`);
    await page.keyboard.press("Escape");
    await page.locator('[data-streamdown="table-fullscreen"]').waitFor({ state: "detached" });
    // The two-column table in the full-screen viewer fills the viewer.
    await page.locator("[data-chat-scroller] [data-streamdown=\"table-wrapper\"]:visible").nth(1).getByRole("button", { name: "View fullscreen" }).evaluate((button) => button.click());
    await page.locator('[data-streamdown="table-fullscreen"] table').waitFor();
    const viewer = await measure("fullscreen");
    const [small] = viewer.tables;
    assert.ok(small.scrollWidth <= small.clientWidth && Math.abs(small.tableWidth - small.clientWidth) <= 1, `${where} fullscreen: the two-column table fills the viewer ${JSON.stringify(small)}`);
    console.log(`ok  ${where} fullscreen: two-column table fills the viewer`);
    if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/${floating ? "floating" : "main"}-fullscreen-narrow.png` });
    await page.keyboard.press("Escape");
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
