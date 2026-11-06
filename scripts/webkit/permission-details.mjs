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
      await openConversation(page, "claude tab");
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
} finally {
  await browser?.close();
  server.close();
}
