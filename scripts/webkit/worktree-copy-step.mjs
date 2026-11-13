#!/usr/bin/env node
// PRO-131: a new worktree says what it copied. When a session is created with
// files copied into its worktree, the notice reads "Copied .env.local and 2
// other files" (one file: "Copied .env.local"), in WebKit, light and dark; the
// line sits inside the notice and the notice inside the window; nothing copied
// raises no notice.
// pnpm build && node scripts/webkit/worktree-copy-step.mjs
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 760 }, { colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await sidebar(page);
    const created = (id, fileCopy) => page.evaluate(({ id, fileCopy }) => {
      const source = window.__PW_STUB__.answers.list_sessions[0];
      window.__PW_STUB__.emit("session_created", { ...source, id, title: id, worktreeName: id, worktreeBase: { commit: "abcdef1234", fetched: false, warning: null, fileCopy } });
    }, { id, fileCopy });
    const report_ = (copiedCount, firstCopied) => ({ copiedCount, copiedBytes: 10, firstCopied, skippedCount: 0, warnings: [], skipped: [], error: null });
    await created("none", report_(0, null));
    await created("one", report_(1, ".env.local"));
    await created("many", report_(3, ".env.local"));
    await page.getByText("Copied .env.local and 2 other files", { exact: true }).waitFor();
    const text = await page.locator('[role="status"]', { hasText: "Workspace file copy" }).allTextContents();
    const layout = await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].filter((card) => card.textContent.includes("Workspace file copy")).map((card) => {
      const box = card.getBoundingClientRect();
      const inner = [...card.querySelectorAll("p, button")].every((node) => {
        const r = node.getBoundingClientRect();
        return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
      });
      return { inView: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, inner, box: [box.left, box.top, box.right, box.bottom] };
    }));
    const boxes = layout.map((item) => item.box);
    const overlap = boxes.some((a, i) => boxes.slice(i + 1).some((b) => a[1] < b[3] && b[1] < a[3] && a[0] < b[2] && b[0] < a[2]));
    failed += report(`copied step, ${colorScheme}`, {
      "three or more files read 'Copied .env.local and 2 other files'": text.some((value) => value.includes("Copied .env.local and 2 other files")),
      "one file reads 'Copied .env.local'": text.some((value) => /Copied \.env\.local(?! and)/.test(value)),
      "nothing copied raises no notice": !text.some((value) => value.includes("· none")),
      "notices sit inside the window, hold their text, and do not overlap": layout.length === 2 && layout.every((item) => item.inView && item.inner) && !overlap,
      "no browser errors": errors.length === 0,
    }, { text, layout, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
