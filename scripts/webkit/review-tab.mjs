#!/usr/bin/env node
// PRO-392 (designs 05.01, 05.13): the review tab and its comments in the built app, in headless WebKit, light and dark,
// 1440 wide. Opening a file from Changes keeps the panel on Changes and opens one "Review · <scope>" tab stacking every
// changed file under one toolbar row; the gutter numbers removed lines and marks only changed ones; a comment is
// drafted under its line, discarding it asks in the app, and saved ones carry their actions; the composer says how
// many wait to be sent; a resolved GitHub thread is one row and comment text is 13px.
// pnpm build && node scripts/webkit/review-tab.mjs
// Set REVIEW_TAB_SHOTS to a directory to also save screenshots.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.REVIEW_TAB_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup() {
  const { answers } = window.__PW_STUB__;
  const session = answers.list_sessions[0];
  session.branch = "make-slugify";
  session.tabs.forEach((tab) => { tab.status = "idle"; });
  answers.load_tab_events = [];
  const pr = { number: 14, title: "Make slugify handle punctuation", url: "https://github.com/example/tx-review-lab/pull/14", state: "OPEN", isDraft: false, base: "main", head: "make-slugify", additions: 24, deletions: 1, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED", checks: [] };
  const before = 'export function slugify(input) {\n  return input.toLowerCase().replace(/ /g, "-");\n}\n';
  const after = 'export function slugify(input) {\n  return input\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n}\n';
  const tests = 'import assert from "node:assert";\nimport { slugify } from "../src/slug.js";\n\ntest("lowercases", () => {\n  assert.equal(slugify("Hello"), "hello");\n});\n\n'
    + 'test("collapses punctuation", () => {\n  assert.equal(slugify("Hello, World!"), "hello-world");\n});\ntest("trims leading and trailing dashes", () => {\n  assert.equal(slugify("--Hello--"), "hello");\n});\n';
  const hunk = '@@ -1,3 +1,6 @@\n export function slugify(input) {\n-  return input.toLowerCase().replace(/ /g, "-");\n+  return input\n+    .toLowerCase()\n+    .replace(/[^a-z0-9]+/g, "-")\n+    .replace(/^-+|-+$/g, "");';
  const testHunk = '@@ -7,0 +8,6 @@\n+test("collapses punctuation", () => {\n+  assert.equal(slugify("Hello, World!"), "hello-world");\n+});\n+test("trims leading and trailing dashes", () => {\n+  assert.equal(slugify("--Hello--"), "hello");\n+});';
  const comment = (id, login, name, body, diffHunk = hunk) => ({ id, author: { login, name }, body, url: `${pr.url}#discussion_${id}`, createdAt: "2026-11-13T09:00:00Z", diffHunk });
  const thread = (id, extra) => ({ id, path: "src/slug.js", diffSide: "RIGHT", startDiffSide: "RIGHT", line: 4, startLine: 2, originalLine: 4, originalStartLine: 2,
    isOutdated: false, isResolved: false, viewerCanResolve: true, viewerCanUnresolve: true, viewerCanReply: true, ...extra });
  window.__threads = [
    thread("t-done", { line: 5, startLine: 3, originalLine: 5, originalStartLine: 3, isResolved: true, comments: [
      comment("c1", "aisha", "Aisha Khan", "Does the new pattern keep letters from other alphabets? “Café” shouldn't become “caf”."),
      comment("c2", "sam", "Sam Rivera", "Same pattern in `invoices.ts`."),
      comment("c3", "paresh", null, "Good catch, will use \\p{L}."),
    ] }),
    thread("t-open", { path: "test/slug.test.js", line: 13, startLine: null, originalLine: 13, originalStartLine: null, comments: [comment("c4", "sam", "Sam Rivera", "Add a case for input that is only punctuation, like `!!!`.", testHunk)] }),
  ];
  const long = (word) => Array.from({ length: 180 }, (_, i) => i % 3 ? `const keep${i} = ${i};` : `const ${word}${i} = "${word}";`).join("\n") + "\n";
  // The review comments store, kept in the page.
  window.__comments = [];
  let id = 0;
  const reviewComments = ({ action }) => {
    if (action.type === "save") {
      if (action.expected) window.__comments = window.__comments.map((c) => c.id === action.expected.id ? { ...c, note: action.note, revision: c.revision + 1 } : c);
      else window.__comments.push({ ...action.anchor, id: `r${++id}`, revision: 1, note: action.note, sent: false, outdated: false, author: { kind: "user" } });
    } else if (action.type === "delete") window.__comments = window.__comments.filter((c) => c.id !== action.expected.id);
    return window.__comments.map((c) => ({ ...c }));
  };
  Object.assign(answers, {
    gh_available: true,
    gh_connection_status: { state: "connected", details: null },
    git_has_remote: true,
    pr_list: [pr], pr_details: pr,
    pr_associations: [{ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd: session.cwd } }],
    pr_conversation: { url: pr.url, title: pr.title, body: "", author: "paresh", viewer: "paresh", state: "OPEN", canEdit: false, reviewers: [], unresolvedThreads: 1, activity: [] },
    pr_review_threads: () => ({ url: pr.url, headOid: "head", baseOid: "base", threads: window.__threads }),
    work_status: { isRepo: true, dirty: false, branch: "make-slugify", defaultBranch: "main", aheadOfBase: 1, head: "a", ahead: 0, behind: 0 },
    branch_overview: { branch: "make-slugify", base: "origin/main", onBase: false, ahead: 1, behind: 0, commits: [], baseCommits: [], contributors: [], baseContributors: [], upstream: "origin/make-slugify", unpushed: 0, unpulled: 0, incoming: [], dirty: false, changed: 0, hasRemote: true, merge: { state: "clean", conflicted: [] } },
    git_identity: { name: "Developer", email: "dev@example.test" },
    review_range: () => ({ target: "main", base: "a".repeat(40), head: "head" }),
    // Long files between the two: they load lazily and grow, and opening the tests must still land on them.
    changes_between: [{ path: "src/slug.js", blobHash: "s1", status: "modified", additions: 4, deletions: 1 },
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ path: `src/long-${n}.js`, blobHash: `l${n}`, status: "modified", additions: 60, deletions: 60 })),
      { path: "test/slug.test.js", blobHash: "t1", status: "modified", additions: 20, deletions: 0 }],
    file_contents_at: ({ path }) => path === "src/slug.js" ? { before, after }
      : path.startsWith("src/long-") ? { before: long("old"), after: long("new") }
      : { before: tests.split("\n").slice(0, 7).join("\n") + "\n", after: tests },
    unfinished_merge: null,
    review_comments: reviewComments,
  });
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: true, panelWidth: 420, diffMode: "unified", diffWrap: true }));
}

/** Text-bearing parts of `root` whose boxes overlap one another (not counting a part and what it holds), and parts cut off at its sides. */
function layout(root) {
  const box = root.getBoundingClientRect();
  const parts = [...root.querySelectorAll("button, span, time, h4, p, label")].filter((node) => {
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).opacity !== "0" && node.textContent.trim();
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
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 },
      { extra: `(${setup})(); localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});`, colorScheme: mode });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `review-tab-${name}-${mode}.png`) }); };
    await page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /make-slugify|Local long session/ }).first().click();

    // Changes: opening a file must leave the panel there, on its scope.
    await page.getByRole("button", { name: /^Changes(\s*\d+)?$/ }).click();
    const scope = page.getByRole("button", { name: "Changes scope", exact: true });
    await page.getByText("slug.js", { exact: true }).first().click();
    const stack = page.getByTestId("review-stack").filter({ visible: true });
    await stack.waitFor();
    await stack.locator(".cm-content").first().waitFor();
    await page.waitForTimeout(300);
    const panel = {
      changesSelected: (await page.getByRole("button", { name: /^Changes(\s*\d+)?$/ }).getAttribute("aria-pressed")) === "true",
      // PRO-393: the scope is a button naming the scope it shows, not a select.
      scope: (await scope.innerText()).trim(),
      noTurnError: (await page.getByText("No turn snapshots are available").count()) === 0,
    };
    // One review tab, stacking both files under one toolbar row.
    const tabTitle = await page.getByRole("tab", { name: /^Review · All changes/ }).count();
    await page.getByText("slug.test.js", { exact: true }).first().click();
    await page.waitForTimeout(2500);
    const reviewTabs = await page.getByRole("tab", { name: /^Review · / }).count();
    // The files just above it have loaded and grown by now; the tests' header is still at the top.
    const landed = await stack.evaluate((root) => {
      const scroller = root.children[1];
      const section = root.querySelector('[data-review-file="test/slug.test.js"]');
      const loadedAbove = [...root.querySelectorAll("[data-review-file^='src/long-']")].filter((s) => !!s.querySelector(".cm-content")).length;
      // The last file may be too short to reach the top: then the tab is scrolled to its end instead.
      const atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2;
      return { offset: Math.round(section.getBoundingClientRect().top - scroller.getBoundingClientRect().top), loadedAbove, scrolled: Math.round(scroller.scrollTop), atEnd };
    });
    await stack.locator('[data-review-file="src/slug.js"]').scrollIntoViewIfNeeded();
    const shape = await stack.evaluate((root) => {
      const top = root.getBoundingClientRect().top;
      const sections = [...root.querySelectorAll("[data-review-file]")];
      const header = sections[0]?.querySelector("header");
      const firstLine = sections[0]?.querySelector(".cm-line")?.getBoundingClientRect();
      const toolbar = root.firstElementChild;
      const gutter = sections[0]?.querySelector(".cm-change-gutter");
      const markers = [...(gutter?.querySelectorAll(".cm-gutterElement") ?? [])].map((el) => el.textContent).filter(Boolean);
      const plus = [...sections[0].querySelectorAll(".cm-review-gutter .cm-review-add")];
      return {
        files: sections.map((s) => s.dataset.reviewFile).filter((f) => !f.startsWith("src/long-")),
        header: header?.textContent,
        viewed: sections.every((s) => !!s.querySelector('header input[type="checkbox"]')),
        toolbar: toolbar?.textContent, toolbarHeight: toolbar?.getBoundingClientRect().height,
        codeOffset: firstLine ? firstLine.top - top : -1,
        markers,
        removedNumber: sections[0].querySelector(".cm-deleted-number")?.textContent,
        plusHidden: plus.length > 0 && plus.every((b) => getComputedStyle(b).opacity === "0"),
        underlined: sections[0].querySelectorAll(".cm-changedText").length,
      };
    });
    const toolbarLayout = await stack.locator("> div").first().evaluate(layout);
    await shot("stack");

    // Hover line 4: only its + shows. Click it: the draft opens under line 4.
    const slug = stack.locator('[data-review-file="src/slug.js"]');
    const line4 = slug.locator(".cm-line").filter({ hasText: ".replace(/[^a-z0-9]+/g" }).first();
    await line4.hover();
    const hoverPlus = await slug.locator(".cm-review-gutter .cm-review-add").evaluateAll((buttons) => buttons.filter((b) => getComputedStyle(b).opacity !== "0").map((b) => b.dataset.line));
    await slug.locator('.cm-review-gutter .cm-review-add[data-line="4"]').click();
    const draft = stack.locator('form[aria-label="Review comment draft"]');
    await draft.waitFor();
    await draft.getByRole("textbox", { name: "Review comment" }).fill("This drops non-ASCII letters, so “Café” becomes “caf”. Keep letters from other alphabets, and add a test for it.");
    const draftPlace = await draft.evaluate((node) => {
      const lines = [...node.closest(".cm-content").querySelectorAll(".cm-line")];
      const at = lines.find((el) => el.textContent.includes(".replace(/[^a-z0-9]+/g"))?.getBoundingClientRect();
      const next = lines.find((el) => el.textContent.includes(".replace(/^-+|-+$/g"))?.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return { under: !!at && !!next && at.bottom <= box.top + 2 && box.bottom <= next.top + 2, text: node.textContent };
    });
    const draftLayout = await draft.evaluate(layout);
    await shot("draft");
    // Escape asks in the app, anchored to the draft; Keep editing keeps the note.
    await draft.getByRole("textbox", { name: "Review comment" }).press("Escape");
    const ask = page.getByRole("alertdialog", { name: "Discard this comment?" });
    await ask.waitFor();
    const askLayout = await ask.evaluate(layout);
    const askPlace = await ask.evaluate((node) => {
      const r = node.getBoundingClientRect(), card = node.closest("form").getBoundingClientRect();
      return { inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, belowCard: r.top >= card.bottom - 1, text: node.textContent };
    });
    await shot("discard");
    await ask.getByRole("button", { name: "Keep editing" }).click();
    await draft.getByRole("button", { name: "Comment", exact: true }).click();
    const saved = slug.locator('article[aria-label^="Comment on src/slug.js"]');
    await saved.waitFor();
    // A second comment, on the tests: the cards offer Add all 2.
    const testFile = stack.locator('[data-review-file="test/slug.test.js"]');
    await testFile.locator(".cm-line").filter({ hasText: "trims leading" }).first().hover();
    await testFile.locator('.cm-review-gutter .cm-review-add[data-line="11"]').click();
    await stack.locator('form[aria-label="Review comment draft"]').getByRole("textbox").fill("Add a case for input that is only punctuation.");
    await stack.locator('form[aria-label="Review comment draft"]').getByRole("button", { name: "Comment", exact: true }).click();
    await testFile.locator("article").filter({ hasText: "only punctuation." }).first().waitFor();
    await saved.scrollIntoViewIfNeeded();
    const card = await saved.evaluate((node) => {
      const add = [...node.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add to chat");
      const all = [...node.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add all 2 comments");
      const edit = [...node.querySelectorAll("button")].find((b) => b.textContent.trim() === "Edit");
      return {
        text: node.textContent,
        quote: !!node.querySelector("blockquote"),
        filled: !!add && getComputedStyle(add).backgroundColor !== "rgba(0, 0, 0, 0)",
        outlined: !!all && getComputedStyle(all).borderTopWidth !== "0px" && getComputedStyle(all).borderTopColor !== "rgba(0, 0, 0, 0)",
        quietEdit: !!edit && getComputedStyle(edit).backgroundColor === "rgba(0, 0, 0, 0)",
      };
    });
    const cardLayout = await saved.evaluate(layout);
    await shot("comments");

    // The resolved thread is one row; the open one's text is 13px, with its reply box and helper line.
    const resolved = slug.locator('article[data-review-thread="t-done"]');
    await resolved.scrollIntoViewIfNeeded();
    const resolvedShape = await resolved.evaluate((node) => ({ height: node.getBoundingClientRect().height, text: node.textContent }));
    const resolvedLayout = await resolved.evaluate(layout);
    const openThread = testFile.locator('article[data-review-thread="t-open"]');
    await openThread.scrollIntoViewIfNeeded();
    const openShape = await openThread.evaluate((node) => ({
      body: getComputedStyle(node.querySelector(".prose-chat p") ?? node).fontSize,
      code: getComputedStyle(node.querySelector(".prose-chat code") ?? node).fontFamily,
      text: node.textContent,
      reply: !!node.querySelector('textarea[placeholder="Reply on GitHub…"]'),
    }));
    const openLayout = await openThread.evaluate(layout);
    await shot("threads");

    // Add to chat: the agent tab's composer says what waits to be sent.
    await saved.getByRole("button", { name: "Add all 2 comments" }).click();
    const strip = page.getByTestId("review-comments-ready").filter({ visible: true });
    await strip.waitFor();
    const stripText = await strip.textContent();
    const stripLayout = await strip.evaluate(layout);
    await shot("composer");

    failed += report(mode, {
      "opening a file keeps the panel on Changes with its scope": panel.changesSelected && panel.scope === "All changes" && panel.noTurnError,
      "one Review tab stacks every file": tabTitle === 1 && reviewTabs === 1 && shape.files.join() === "src/slug.js,test/slug.test.js",
      "opening a file further down lands on it once the files above have loaded": landed.loadedAbove >= 1 && (Math.abs(landed.offset) <= 2 || (landed.atEnd && landed.offset >= 0)) && landed.scrolled > 1000,
      "file headers carry path, +/− and Viewed": shape.header?.includes("src/slug.js") && shape.header.includes("+4") && shape.header.includes("−1") && shape.viewed,
      "one toolbar row: Unified, Split, Hide whitespace": shape.toolbar === "UnifiedSplitHide whitespace" && shape.toolbarHeight <= 35 && clean(toolbarLayout),
      "code starts right under the toolbar and file header": shape.codeOffset > 0 && shape.codeOffset <= 100,
      "gutter marks only changed lines and numbers the removed one": shape.markers.length === 4 && shape.markers.every((m) => m === "+") && shape.removedNumber === "2",
      "comment + shows on the hovered line only": shape.plusHidden && hoverPlus.length === 1 && hoverPlus[0] === "4",
      "changed text is a flat tint, not underlined": shape.underlined === 0,
      "draft opens under its line with author, line and Draft state": draftPlace.under && draftPlace.text.includes("Developer") && draftPlace.text.includes("line 4 · comment for the agent") && draftPlace.text.includes("Draft · not saved") && draftPlace.text.includes("Cancel") && draftPlace.text.includes("esc") && draftPlace.text.includes("⌘↵") && clean(draftLayout),
      "discard asks in an in-app popover under the draft": askPlace.inView && askPlace.belowCard && askPlace.text.includes("What you wrote on line 4 will be lost") && clean(askLayout),
      "saved card: author, on line N, Draft, no quote": card.text.includes("Developer") && card.text.includes("on line 4") && card.text.includes("Draft") && !card.quote && clean(cardLayout),
      "card actions: filled Add to chat, outlined Add all 2, quiet Edit · Delete": card.filled && card.outlined && card.quietEdit,
      "resolved thread collapses to one row": resolvedShape.height < 90 && resolvedShape.text.includes("Resolved") && resolvedShape.text.includes("Unresolve") && resolvedShape.text.includes("· 2 replies") && clean(resolvedLayout),
      "thread text is 13px with the reply box and Send to agent helper": openShape.body === "13px" && /mono/i.test(openShape.code) && openShape.reply && openShape.text.includes("Send to agent adds the comment") && clean(openLayout),
      "composer says the comments are ready to send": stripText.includes("2 review comments ready to send") && stripText.includes("they go to the agent as one message") && clean(stripLayout),
      "no browser errors": errors.length === 0,
    }, { panel, tabTitle, reviewTabs, landed, shape, toolbarLayout, hoverPlus, draftPlace, draftLayout, askPlace, askLayout, card, cardLayout, resolvedShape, resolvedLayout, openShape, openLayout, stripText, stripLayout, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
