#!/usr/bin/env node
// #776: Codex's :codex-file-citation{…} markers in a reply, in real WebKit. A
// file the agent handed over is a chip on its own line that stays inside the
// reply at every width, truncating a long name; a cited source is a link that
// wraps inside its sentence. No marker text is left, and the chip's context
// menu offers the file's actions.
// pnpm build && pnpm exec playwright install webkit && node scripts/webkit/file-citations.mjs
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { open, openConversation, serve, tab } from "./harness.mjs";

const longName = `Quarterly revenue model with every regional breakdown and the full ${"assumptions ".repeat(4)}appendix.xlsx`;
const reply = [
  "Here is the summary workbook.",
  `:codex-file-citation{path="/repos/p0/out/${longName}" artifact_kind="workbook" purpose="output"}`,
  `The totals come from :codex-file-citation{path="/repos/p0/out/report.xlsx" sheet="Revenue Model" range="C27" purpose="source"}, and the review of :codex-file-citation{path="/repos/p0/docs/Board review with a rather long file name.pdf" page_number="3" purpose="source"} is due on Friday.`,
  ':codex-file-citation{path="https://docs.google.com/spreadsheets/d/1AbC_dEf/edit#gid=0" purpose="output"}',
  "That is everything.",
].join("\n\n");

const server = await serve();
let browser;
try {
  browser = await webkit.launch();
  for (const floating of [false, true]) {
    const extra = `(() => {
      window.__PW_FILE_ACTIONS__ = [];
      const answers = window.__PW_STUB__.answers;
      answers.load_tab_events = ({ tabId }) => [
        { type: "user_message", text: "Make the workbook", queued: false },
        { type: "turn_started" },
        { type: "assistant_text", text: ${JSON.stringify(reply)} },
      ].map((payload, i) => ({ id: "cite-" + i, seq: i + 1, sessionId: "local-s1", tabId, harness: "codex", ts: "2026-11-06T00:00:00Z", payload }));
      answers.inspect_local_path = ({ path }) => ({ path, root: path.slice(0, path.lastIndexOf("/")), rel: path.slice(path.lastIndexOf("/") + 1), kind: "file", text: false });
      answers.open_local_path = ({ path }) => { window.__PW_FILE_ACTIONS__.push(["open", path]); };
      answers["plugin:opener|reveal_item_in_dir"] = ({ paths }) => { window.__PW_FILE_ACTIONS__.push(["reveal", ...paths]); };
    })();`;
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, floating }, { width: 1100, height: 800 }, { extra });
    if (!floating) {
      await openConversation(page, "claude tab");
      await tab(page, "gemini tab").click();
    }
    const chip = page.locator("[data-chat-scroller] a[data-file-chip]:visible").first();
    await chip.waitFor();
    await page.evaluate(() => document.fonts.ready);
    // Main windows have a native minimum width of 760px; floating windows can be narrower.
    const sizes = floating ? [[640, 1], [360, 1], [360, 1.5]] : [[1100, 1], [760, 1], [760, 1.5]];
    for (const [width, zoom] of sizes) {
      for (const colorScheme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme });
        await page.evaluate((zoom) => { document.documentElement.style.zoom = String(zoom); }, zoom);
        const result = await page.evaluate(() => {
          const root = [...document.querySelectorAll("[data-chat-scroller]")].find((el) => el.getBoundingClientRect().width > 0);
          const prose = root.querySelector(".prose-chat");
          const box = prose.getBoundingClientRect();
          const inside = (r) => r.left >= box.left - 1 && r.right <= box.right + 1;
          const chips = [...prose.querySelectorAll("a[data-file-chip]")].map((a) => {
            const r = a.getBoundingClientRect();
            const label = a.querySelector(".truncate");
            const style = getComputedStyle(a);
            const paragraph = a.closest("p");
            const neighbours = [paragraph.previousElementSibling, paragraph.nextElementSibling].filter(Boolean).map((p) => p.getBoundingClientRect());
            return {
              text: a.textContent, title: a.title, contained: inside(r), height: r.height, lines: a.getClientRects().length,
              truncated: label.scrollWidth > label.clientWidth + 1, underlined: style.textDecorationLine !== "none",
              accent: style.color === getComputedStyle(prose.querySelector("a:not([data-file-chip])")).color,
              overlaps: neighbours.some((n) => n.bottom > r.top + 1 && n.top < r.bottom - 1),
            };
          });
          const sources = [...prose.querySelectorAll("a:not([data-file-chip])")].map((a) => ({ text: a.textContent, contained: [...a.getClientRects()].every(inside) }));
          return { chips, sources, raw: prose.textContent.includes("codex-file-citation"), overflow: root.scrollWidth - root.clientWidth, chipText: getComputedStyle(prose).color };
        });
        const label = `${floating ? "floating" : "main"} ${width}px zoom ${zoom} ${colorScheme}`;
        const detail = JSON.stringify(result);
        assert.equal(result.raw, false, `${label}: marker text remains ${detail}`);
        assert.deepEqual(result.chips.map((c) => c.text), [longName, "Google Sheets file"], `${label}: ${detail}`);
        assert.deepEqual(result.sources.map((s) => s.text), ["report.xlsx · Revenue Model!C27", "Board review with a rather long file name.pdf · p. 3"], `${label}: ${detail}`);
        for (const c of result.chips) {
          assert.ok(c.contained, `${label}: chip "${c.text}" leaves the reply ${detail}`);
          assert.equal(c.lines, 1, `${label}: chip "${c.text}" wraps ${detail}`);
          // Rects are in zoomed pixels: a 28px chip measures 42px at 150%.
          assert.ok(c.height / zoom >= 24 && c.height / zoom <= 32, `${label}: chip "${c.text}" is ${c.height / zoom}px tall`);
          assert.ok(!c.overlaps, `${label}: chip "${c.text}" overlaps the paragraph next to it ${detail}`);
          assert.ok(!c.underlined && !c.accent, `${label}: chip "${c.text}" is drawn as a plain link ${detail}`);
        }
        assert.ok(result.chips[0].truncated, `${label}: a long file name is truncated ${detail}`);
        assert.ok(result.chips[0].title.endsWith(longName), `${label}: hover shows the full path`);
        for (const s of result.sources) assert.ok(s.contained, `${label}: source "${s.text}" leaves the reply ${detail}`);
        assert.ok(result.overflow <= 1, `${label}: conversation scrolls sideways ${detail}`);
        if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) {
          await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/file-citations-${floating ? "floating" : "main"}-${width}-${zoom}-${colorScheme}.png` });
        }
        console.log(`ok  ${label}: two file chips on one line each inside the reply, two source links wrapped in their sentence, no marker text`);
      }
    }
    await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
    await page.emulateMedia({ colorScheme: "light" });
    await chip.click();
    await page.waitForFunction(() => window.__PW_FILE_ACTIONS__.length === 1);
    await chip.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reveal in file manager", exact: true }).click();
    await page.waitForFunction(() => window.__PW_FILE_ACTIONS__.length === 2);
    const path = `/repos/p0/out/${longName}`;
    assert.deepEqual(await page.evaluate(() => window.__PW_FILE_ACTIONS__), [["open", path], ["reveal", path]]);
    console.log(`ok  ${floating ? "floating" : "main"}: clicking the chip opens the workbook with its app; its menu reveals it in the file manager`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
