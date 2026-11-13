#!/usr/bin/env node
// PRO-234 (design 05.13 / 05.14 list): GitHub review threads in the built app,
// in headless WebKit, light and dark, behind a stubbed GitHub. The Checks
// section lists the PR's threads with counts; the Changes footer counts them;
// a row opens the thread inline in its centre diff; resolving it raises
// "Thread resolved on GitHub". Each of the three is checked for overlap.
// pnpm build && node scripts/webkit/review-threads.mjs
// Set REVIEW_THREADS_SHOTS to a directory to also save screenshots.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.REVIEW_THREADS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup() {
  const { answers } = window.__PW_STUB__;
  const session = answers.list_sessions[0];
  session.branch = "make-slugify";
  session.tabs.forEach((tab) => { tab.status = "idle"; });
  answers.load_tab_events = [];
  const pr = { number: 14, title: "Make slugify handle punctuation", url: "https://github.com/example/tx-review-lab/pull/14", state: "OPEN", isDraft: false, base: "main", head: "make-slugify", additions: 24, deletions: 1, mergeable: "MERGEABLE", reviewDecision: null, body: "", author: "paresh", checks: [
    { name: "test", state: "success", url: "https://ci.example.com/build/14" },
  ] };
  const before = 'export function slugify(input) {\n  return input.toLowerCase().replace(/ /g, "-");\n}\n';
  const after = 'export function slugify(input) {\n  return input\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n}\n';
  const hunk = '@@ -1,3 +1,6 @@\n export function slugify(input) {\n-  return input.toLowerCase().replace(/ /g, "-");\n+  return input\n+    .toLowerCase()\n+    .replace(/[^a-z0-9]+/g, "-")';
  const comment = (id, login, name, body) => ({ id, author: { login, name }, body, url: `${pr.url}#discussion_${id}`, createdAt: "2026-11-13T09:00:00Z", diffHunk: hunk });
  const thread = (id, extra) => ({ id, path: "src/slug.js", diffSide: "RIGHT", startDiffSide: "RIGHT", line: 4, startLine: 2, originalLine: 4, originalStartLine: 2,
    isOutdated: false, isResolved: false, viewerCanResolve: true, viewerCanUnresolve: true, viewerCanReply: true, ...extra });
  window.__threads = { resolved: [], threads: [
    thread("t-open", { comments: [
      comment("c1", "aisha", "Aisha Khan", "Does the new pattern keep letters from other alphabets? “Café” shouldn't become “caf”. A deliberately long comment so it wraps across several lines of the inline thread in a narrow column."),
      comment("c2", "sam", "Sam Rivera", "Same pattern in invoices.ts."),
      comment("c3", "paresh", null, "Good catch, will use \\p{L}."),
    ] }),
    thread("t-done", { path: "test/slug.test.js", line: 13, startLine: null, originalLine: 13, originalStartLine: null, isResolved: true, comments: [comment("c4", "sam", "Sam Rivera", "Add a case for input that is only punctuation.")] }),
  ] };
  Object.assign(answers, {
    gh_available: true,
    gh_connection_status: { state: "connected", details: null },
    git_has_remote: true,
    pr_list: [pr], pr_details: pr,
    pr_associations: [{ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd: session.cwd } }],
    pr_conversation: { url: pr.url, title: pr.title, body: "", author: "paresh", viewer: "paresh", state: "OPEN", canEdit: false, reviewers: [], unresolvedThreads: 1, activity: [] },
    pr_review_threads: () => ({ url: pr.url, headOid: "head", baseOid: "base", threads: window.__threads.threads }),
    pr_review_resolve: ({ threadId, resolved }) => {
      window.__threads.resolved.push(threadId);
      window.__threads.threads = window.__threads.threads.map((t) => t.id === threadId ? { ...t, isResolved: resolved } : t);
      return null;
    },
    work_status: { isRepo: true, dirty: false, branch: "make-slugify", defaultBranch: "main", aheadOfBase: 1, head: "a", ahead: 0, behind: 0 },
    branch_overview: { branch: "make-slugify", base: "origin/main", onBase: false, ahead: 1, behind: 0, commits: [], baseCommits: [], contributors: [], baseContributors: [], upstream: "origin/make-slugify", unpushed: 0, unpulled: 0, incoming: [], dirty: false, changed: 0, hasRemote: true, merge: { state: "clean", conflicted: [] } },
    git_identity: { name: "Developer", email: "dev@example.test" },
    review_range: () => ({ target: "main", base: "a".repeat(40), head: "head" }),
    changes_between: [{ path: "src/slug.js", status: "modified", additions: 4, deletions: 1 }, { path: "test/slug.test.js", status: "modified", additions: 20, deletions: 0 }],
    file_contents_at: ({ path }) => path === "src/slug.js" ? { before, after } : { before: "", after: "test" },
    unfinished_merge: null,
    review_comments: () => [],
  });
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: true, panelWidth: 420 }));
}

/** Text-bearing parts of `root` whose boxes overlap one another (not counting a part and what it holds), and parts cut off at its sides. */
function layout(root) {
  const box = root.getBoundingClientRect();
  const parts = [...root.querySelectorAll("button, span, time, h4, p, label")].filter((node) => {
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden" && node.textContent.trim();
  });
  const overlaps = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i], b = parts[j];
    if (a.contains(b) || b.contains(a)) continue;
    const p = a.getBoundingClientRect(), q = b.getBoundingClientRect();
    const x = Math.min(p.right, q.right) - Math.max(p.left, q.left), y = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
    if (x > 1 && y > 1) overlaps.push(`${a.textContent.trim().slice(0, 30)} × ${b.textContent.trim().slice(0, 30)}`);
  }
  const outside = parts.filter((node) => { const r = node.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1; }).map((node) => node.textContent.trim().slice(0, 30));
  return { overlaps, outside, fits: root.scrollWidth <= root.clientWidth + 1, width: box.width, height: box.height };
}
const clean = (l) => l.overlaps.length === 0 && l.outside.length === 0 && l.fits && l.width > 0 && l.height > 0;

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1400, height: 900 },
      { extra: `(${setup})(); localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});`, colorScheme: mode });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /make-slugify|Local long session/ }).first().click();

    // Checks section: the list with its counts and Add all.
    const list = page.locator('[data-testid="review-threads"]:visible');
    await list.getByTestId("review-thread-counts").filter({ hasText: "1 open · 1 resolved" }).waitFor();
    const listLayout = await list.evaluate(layout);
    const rows = await list.getByRole("list", { name: "Threads" }).getByRole("button").allTextContents();
    const addAll = await list.getByRole("button", { name: "Add all 1 to chat", exact: true }).count();
    if (shots) await page.screenshot({ path: join(shots, `review-threads-checks-${mode}.png`) });

    // Changes: the footer counts the PR's threads under the file list.
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    const footer = page.locator('[data-testid="changes-review-threads"]:visible');
    await footer.waitFor();
    const footerText = await footer.textContent();
    const footerLayout = await footer.evaluate(layout);
    const footerClear = await footer.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const above = node.previousElementSibling?.getBoundingClientRect();
      return !!above && above.bottom <= box.top + 1 && box.bottom <= innerHeight + 1;
    });
    if (shots) await page.screenshot({ path: join(shots, `review-threads-footer-${mode}.png`) });

    // A row opens its file's centre diff with the thread inline on its lines.
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await list.getByRole("button", { name: "Go to review thread src/slug.js:2-4 (head)", exact: true }).click();
    const card = page.locator('.diff-pane article[data-review-thread="t-open"]:visible');
    await card.waitFor();
    await card.getByText("on GitHub · lines 2–4", { exact: true }).waitFor();
    await card.getByRole("button", { name: "2 replies", exact: true }).click();
    await card.getByText("Same pattern in invoices.ts.").waitFor();
    const cardLayout = await card.evaluate(layout);
    const placement = await card.evaluate((node) => {
      const editor = node.closest(".cm-editor")?.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const lines = [...node.closest(".cm-content").querySelectorAll(".cm-line")];
      const line = lines.find((el) => el.textContent.includes('.replace(/[^a-z0-9]+/g, "-")'));
      const next = lines.find((el) => el.textContent.includes(".replace(/^-+|-+$/g"));
      const l = line?.getBoundingClientRect(), n = next?.getBoundingClientRect();
      return { inEditor: !!editor && box.left >= editor.left - 1 && box.right <= editor.right + 1, betweenLines: !!l && !!n && l.bottom <= box.top + 1 && box.bottom <= n.top + 1, focused: document.activeElement === node };
    });
    if (shots) await page.screenshot({ path: join(shots, `review-threads-inline-${mode}.png`) });

    // Resolve: GitHub's state, the inline badge, and the toast with View on GitHub.
    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    const toast = page.locator('[data-error-toast]').filter({ hasText: "Thread resolved on GitHub" });
    await toast.waitFor();
    await card.getByRole("button", { name: "Unresolve", exact: true }).waitFor();
    await card.getByText("Resolved", { exact: true }).waitFor();
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    const toastText = await toast.textContent();
    const toastLayout = await toast.evaluate(layout);
    const toastInView = await toast.evaluate((node) => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
    const resolvedCardLayout = await card.evaluate(layout);
    if (shots) await page.screenshot({ path: join(shots, `review-threads-resolved-${mode}.png`) });
    const resolved = await page.evaluate(() => window.__threads.resolved);

    failed += report(mode, {
      "Checks list counts open and resolved threads": rows.length === 2 && addAll === 1,
      "Checks list rows name file, line and comment": rows[0].includes("slug.js:4") && rows[0].includes("Does the new pattern") && rows[1].includes("Resolved"),
      "Checks list has no overlap": clean(listLayout),
      "Changes footer counts the PR's threads": footerText === "PR #14 review threads1 open · 1 resolved",
      "Changes footer has no overlap and sits under the file list": clean(footerLayout) && footerClear,
      "a row opens the thread inline, focused, between its lines": placement.inEditor && placement.betweenLines && placement.focused,
      "inline thread has no overlap": clean(cardLayout) && clean(resolvedCardLayout),
      "resolving writes to GitHub once": resolved.length === 1 && resolved[0] === "t-open",
      "toast says it and offers View on GitHub": toastText.includes("Thread resolved on GitHub") && toastText.includes("Aisha's comment on src/slug.js · lines 2–4 · PR #14") && (await toast.getByRole("button", { name: "View on GitHub" }).count()) === 1,
      "toast is a success, not an error": (await toast.getAttribute("data-toast-tone")) === "success" && (await toast.getAttribute("role")) === "status" && (await toast.getByRole("button", { name: "Copy error" }).count()) === 0,
      "toast has no overlap and is in view": clean(toastLayout) && toastInView,
      "no browser errors": errors.length === 0,
    }, { listLayout, footerText, footerLayout, footerClear, placement, cardLayout, resolvedCardLayout, toastText, toastLayout, toastInView, resolved, errors, rows });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
