#!/usr/bin/env node
// pnpm build && node scripts/webkit/permission-details.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launch, open, openConversation, serve, tab } from "./harness.mjs";

const command = `printf 'keep  two spaces\\n'\n# ${"long-command-argument".repeat(35)}\npnpm vitest run src/components/session/RecoveryBanner.test.tsx`;
// #775: why the card is up (the app's words) and what the agent says of the command, apart and both in view.
const reason = "Claude Code's safety check wants approval for this command. Bypass permissions doesn't cover commands it can't verify.";
const note = `Split the output into lines, ${"then count them ".repeat(12)}and print the total`;
const server = await serve();
const screenshots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
let browser;
try {
  browser = await launch();
  for (const floating of [false, true]) {
    const extra = `(() => {
      const load = window.__PW_STUB__.answers.load_tab_events;
      window.__PW_STUB__.answers.load_tab_events = args => load(args).map(event => event.payload.type !== "permission_requested" ? event : {
        ...event, payload: { ...event.payload, toolName: "Bash", input: { command: ${JSON.stringify(command)}, description: ${JSON.stringify(note)} },
          cwd: "/workspace/terminalx", reason: ${JSON.stringify(reason)}
        }
      });
    })();`;
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, floating }, { width: 1100, height: 800 }, { extra });
    if (!floating) {
      await openConversation(page, "Local long session");
      await tab(page, "gemini tab").click();
    }
    const detail = page.getByTestId("permission-detail").filter({ visible: true });
    await detail.waitFor();
    assert.equal(await detail.textContent(), command);
    // PRO-382: the header names the project; the session directory is not repeated under the request.
    assert.equal(await page.getByText(/Session directory:/).count(), 0);
    await page.getByText(reason, { exact: true }).filter({ visible: true }).waitFor();
    const agentNote = page.getByTestId("permission-agent-note").filter({ visible: true });
    assert.equal(await agentNote.textContent(), `Agent: ${note}`);
    for (const width of floating ? [640, 360] : [1100, 760]) {
      await page.setViewportSize({ width, height: 800 });
      const geometry = await detail.evaluate(el => {
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        return { contained: box.left >= 0 && box.right <= innerWidth,
          wrapped: [...range.getClientRects()].every(rect => rect.right <= box.right + 1),
          scrolls: el.scrollHeight > el.clientHeight };
      });
      assert.ok(geometry.contained && geometry.wrapped, JSON.stringify({ floating, width, ...geometry }));
      for (const text of [page.getByTestId("permission-reason").filter({ visible: true }), agentNote]) {
        const box = await text.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, scrolls: el.scrollWidth > el.clientWidth + 1 }; });
        assert.ok(box.left >= 0 && box.right <= width && !box.scrolls, JSON.stringify({ floating, width, ...box }));
      }
      const allow = page.getByRole("button", { name: /^Allow/ }).filter({ visible: true });
      await allow.scrollIntoViewIfNeeded();
      assert.ok(await allow.isEnabled());
      const label = `${floating ? "floating" : "main"}-${width}`;
      if (screenshots) await page.screenshot({ path: `${screenshots}/${label}.png` });
      console.log(`ok ${label}: full command, why it asks and the agent's note visible, long lines contained, approval reachable`);
    }
    await page.close();
  }

  // PRO-156: an edit approval shows the patch as a diff, its long lines wrapped and its height its own, the buttons in view.
  const longLine = `+const message = "${"a long added line that must wrap inside the card ".repeat(6)}";`;
  const longPath = `src/${"deeply-nested-folder/".repeat(8)}legacy.js`;
  const patch = ["*** Begin Patch", "*** Update File: /workspace/terminalx/src/slug.js", "@@ export function slugify(input) {", "-  return input.toLowerCase();", longLine, " }",
    "*** Add File: test/slug.test.js", ...Array.from({ length: 40 }, (_, i) => `+test("case ${i + 1}", () => {});`), `*** Delete File: ${longPath}`, "*** End Patch"].join("\n");
  for (const floating of [false, true]) {
    const extra = `(() => {
      const load = window.__PW_STUB__.answers.load_tab_events;
      window.__PW_STUB__.answers.load_tab_events = args => load(args).map(event => event.payload.type !== "permission_requested" ? event : {
        ...event, payload: { ...event.payload, toolName: "apply_patch", title: "apply_patch *** Begin Patch", input: { command: ${JSON.stringify(patch)} }, cwd: "/workspace/terminalx" }
      });
    })();`;
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, floating }, { width: 1100, height: 800 }, { extra });
    if (!floating) {
      await openConversation(page, "Local long session");
      await tab(page, "gemini tab").click();
    }
    const diff = page.getByTestId("permission-diff").filter({ visible: true });
    await diff.waitFor();
    assert.equal(await page.getByTestId("permission-title").filter({ visible: true }).textContent(), "Edit 3 files");
    assert.deepEqual(await diff.getByTestId("permission-diff-path").allTextContents(), ["src/slug.js", "test/slug.test.js", longPath]);
    // Later files are folded to their header (PRO-382); open the long one.
    await diff.getByRole("button", { name: /test\/slug\.test\.js/ }).click();
    const more = diff.getByRole("button", { name: "Show all 40 lines" });
    await more.click();
    for (const width of floating ? [640, 360] : [1100, 760]) {
      for (const height of [800, 520]) {
        await page.setViewportSize({ width, height });
        const geometry = await diff.evaluate(el => {
          const box = el.getBoundingClientRect();
          const rows = [...el.querySelectorAll("[data-kind], [data-testid=permission-diff-path]")];
          return { contained: box.left >= 0 && box.right <= innerWidth,
            // Inside the box and whole: a path cut short with an ellipsis would hide where the edit lands.
            wrapped: rows.every(row => row.getBoundingClientRect().right <= box.right + 1 && row.scrollWidth <= row.clientWidth + 1) && el.scrollWidth <= el.clientWidth + 1,
            scrolls: el.scrollHeight > el.clientHeight, bounded: box.height <= Math.min(352, innerHeight * 0.32) + 2, bottom: box.bottom };
        });
        assert.ok(geometry.contained && geometry.wrapped && geometry.scrolls && geometry.bounded, JSON.stringify({ floating, width, height, ...geometry }));
        const allow = page.getByRole("button", { name: /^Allow/ }).filter({ visible: true });
        const deny = page.getByRole("button", { name: /^Deny/ }).filter({ visible: true });
        await allow.scrollIntoViewIfNeeded();
        for (const button of [allow, deny]) {
          const box = await button.boundingBox();
          // In view together with the bottom of the diff: the actions sit under it, not behind it.
          const diffBottom = await diff.evaluate(el => el.getBoundingClientRect().bottom);
          assert.ok(box && box.y >= diffBottom && box.y + box.height <= height && await button.isEnabled(), JSON.stringify({ floating, width, height, box, diffBottom }));
        }
        const label = `diff-${floating ? "floating" : "main"}-${width}x${height}`;
        if (screenshots) await page.screenshot({ path: `${screenshots}/${label}.png` });
        console.log(`ok ${label}: files, counts and lines shown, long lines and paths wrapped, diff scrolls on its own, Allow and Deny in view`);
      }
    }
    await page.close();
  }

  // PRO-382: the card as designed, in dark and light at 1440 wide: one header line with the mode and project, inline
  // in the turn at the messages' width, the first file open with line numbers, the next folded, Deny [esc] first and
  // the primary Allow [⏎] last, file paths at 12px or more.
  const designed = ["*** Begin Patch", "*** Add File: src/slug.js", "+export function slugify(input) {", "+  return input", "+    .toLowerCase()",
    "+    .replace(/[^a-z0-9]+/g, \"-\");", "+}", "*** Add File: test/slug.test.js", ...Array.from({ length: 20 }, (_, i) => `+test("case ${i + 1}", () => {});`), "*** End Patch"].join("\n");
  for (const colorScheme of ["dark", "light"]) {
    const extra = `(() => {
      const load = window.__PW_STUB__.answers.load_tab_events;
      window.__PW_STUB__.answers.load_tab_events = args => load(args).map(event => event.payload.type !== "permission_requested" ? event : {
        ...event, payload: { ...event.payload, toolName: "apply_patch", title: "apply_patch *** Begin Patch", input: { command: ${JSON.stringify(designed)} }, cwd: "/workspace/terminalx",
          options: [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "terminalx:allow_session", label: "Allow for this session", kind: "allow_session" }, { id: "deny", label: "Deny", kind: "deny" }] }
      });
    })();`;
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, floating: false }, { width: 1440, height: 900 }, { extra, colorScheme });
    await openConversation(page, "Local long session");
    await tab(page, "gemini tab").click();
    const header = page.getByTestId("ask-header").filter({ visible: true });
    await header.waitFor();
    const facts = await header.evaluate(el => {
      const card = el.parentElement;
      const column = card.closest("[data-chat-scroller] > div");
      const style = getComputedStyle(column);
      const inner = { left: column.getBoundingClientRect().left + parseFloat(style.paddingLeft), right: column.getBoundingClientRect().right - parseFloat(style.paddingRight) };
      const box = card.getBoundingClientRect();
      const buttons = [...card.querySelectorAll("[data-ask-actions] button")].map(b => ({ text: b.textContent, x: b.getBoundingClientRect().left }));
      const paths = [...card.querySelectorAll("[data-testid=permission-diff-path]")].map(p => parseFloat(getComputedStyle(p).fontSize));
      return { oneLine: el.getBoundingClientRect().height < 44, header: el.textContent, meta: card.querySelector("[data-testid=ask-meta]")?.textContent ?? null,
        inline: !card.closest('[aria-label="Session recovery"]'), width: [box.left, box.right], column: [inner.left, inner.right],
        buttons, paths, numbers: [...card.querySelectorAll("[data-testid=permission-diff-line-no]")].map(n => n.textContent),
        folded: [...card.querySelectorAll("[data-testid=permission-diff-folded]")].map(f => f.textContent),
        directory: /Session directory/.test(card.textContent) };
    });
    const ok = facts.oneLine && facts.header.startsWith("ApprovalEdit 2 files+25") && facts.meta?.includes(" · ") && facts.inline
      && Math.abs(facts.width[0] - facts.column[0]) <= 1 && Math.abs(facts.width[1] - facts.column[1]) <= 1
      && facts.buttons.map(b => b.text).join("|") === "DenyEsc|Allow for this session|Allow⏎" && facts.buttons.every((b, i, all) => i === 0 || all[i - 1].x < b.x)
      && facts.paths.every(size => size >= 12) && facts.numbers.join(",") === "1,2,3,4,5" && facts.folded.join() === "Show 20 lines"
      && !facts.directory;
    assert.ok(ok, JSON.stringify({ colorScheme, ...facts }));
    if (screenshots) await page.screenshot({ path: `${screenshots}/approval-${colorScheme}-1440.png` });
    console.log(`ok approval-${colorScheme}-1440: one-line header with mode and project, inline at the column's width, first file numbered, next folded, Deny [esc] … Allow [⏎] last`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
