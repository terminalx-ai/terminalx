#!/usr/bin/env node
// pnpm build && node scripts/webkit/permission-details.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { webkit } from "playwright";
import { open, openConversation, serve, tab } from "./harness.mjs";

const command = `printf 'keep  two spaces\\n'\n# ${"long-command-argument".repeat(35)}\npnpm vitest run src/components/session/RecoveryBanner.test.tsx`;
// #775: why the card is up (the app's words) and what the agent says of the command, apart and both in view.
const reason = "Claude Code's safety check wants approval for this command. Bypass permissions doesn't cover commands it can't verify.";
const note = `Split the output into lines, ${"then count them ".repeat(12)}and print the total`;
const server = await serve();
const screenshots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
let browser;
try {
  browser = await webkit.launch();
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
    await page.getByText("/workspace/terminalx", { exact: true }).filter({ visible: true }).waitFor();
    await page.getByText(/Session directory:/).filter({ visible: true }).waitFor();
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
    await page.getByText("Waiting for permission to edit 3 files").filter({ visible: true }).waitFor();
    assert.deepEqual(await diff.getByTestId("permission-diff-path").allTextContents(), ["src/slug.js", "test/slug.test.js", longPath]);
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
        const deny = page.getByRole("button", { name: "Deny" }).filter({ visible: true });
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
} finally {
  await browser?.close();
  server.close();
}
