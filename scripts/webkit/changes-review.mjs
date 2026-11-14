#!/usr/bin/env node
// PRO-222: real review controls and file diffs, including narrow panels and reload.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sha = "a".repeat(40), parent = "b".repeat(40);
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChangesPanel } from '/src/components/changes/ChangesPanel.tsx';
import '/src/styles/app.css';
const files = ['src/deep/long-file-name.ts', 'src/another.ts', 'README.md'];
const commit = { sha: '${sha}', parent: '${parent}', tree: 'commit', shortSha: 'aaaaaaa', subject: 'Selected commit', author: 'Author', date: '2026-01-01', body: '' };
window.reviewRevision = 1;
const source = {
  key: 'webkit:changes-review', cloud: false, canWrite: false,
  branches: async () => [{ name: 'main' }, { name: 'origin/release' }],
  logCommits: async (from) => from === '${parent}' ? [{ ...commit, sha: '${parent}', tree: 'parent' }] : [commit],
  reviewRange: async (target) => ({ base: 'base', head: 'head-' + window.reviewRevision, target: target || 'main' }),
  changesBetween: async (_base, head) => (head === 'commit' ? ['committed.ts'] : files).map(path => ({ path, blobHash: path + ':' + (head === 'commit' ? 0 : window.reviewRevision), status: 'modified', additions: 1, deletions: 1 })),
  fileContentsAt: async (path, base, head) => ({ before: 'before: ' + base, after: 'after: ' + head }),
  errorMessage: String,
};
createRoot(document.getElementById('root')).render(<div style={{width:'100%',height:'100vh'}}><ChangesPanel source={source} events={[]} version={0} active live={false}/></div>);
`;

async function serve() {
  const { createServer, transformWithEsbuild } = await import("vite");
  const server = await createServer({ server: { host: process.env.CHANGES_REVIEW_SERVE_ONLY ? "0.0.0.0" : "127.0.0.1", port: 0 }, plugins: [{
    name: "changes-review-regression",
    resolveId(id) { if (id === "/changes-review.tsx") return "\0changes-review.tsx"; },
    async load(id) { if (id === "\0changes-review.tsx") return (await transformWithEsbuild(entry, "changes-review.tsx", { loader: "tsx", jsx: "automatic" })).code; },
    configureServer(server) {
      server.middlewares.use("/changes-review-runner", async (_request, response) => {
        response.setHeader("Content-Type", "text/javascript");
        response.end(await readFile(new URL(import.meta.url)));
      });
      server.middlewares.use("/changes-review-test", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml("/changes-review-test", '<div id="root"></div><script type="module" src="/changes-review.tsx"></script>'));
      });
    },
  }] });
  await server.listen();
  return server;
}

let server, browser;
try {
  let url = process.env.CHANGES_REVIEW_URL;
  if (!url) {
    server = await serve();
    url = `http://127.0.0.1:${server.httpServer.address().port}/changes-review-test`;
  }
  if (process.env.CHANGES_REVIEW_SERVE_ONLY) {
    console.log(url);
    await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  } else {
    const { launch } = await import("./harness.mjs");
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText("0 of 3 viewed").waitFor();
    assert.deepEqual(await page.locator("datalist option").evaluateAll((options) => options.map((option) => option.value)), ["main", "origin/release"]);
    await page.getByLabel("Comparison target").fill("origin/release");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.getByText(/Against origin\/release/).waitFor();
    await page.getByRole("radio", { name: "Folders" }).click();
    await page.getByRole("button", { name: "Folder src", exact: true }).click();
    await page.getByLabel("Filter changed files").fill("long-file");
    await page.getByRole("button", { name: /long-file-name.ts/ }).click();
    await page.locator(".cm-content").first().waitFor();
    const viewed = page.getByLabel("Viewed src/deep/long-file-name.ts", { exact: true });
    await viewed.check();
    await page.getByText("1 of 3 viewed · 1 matching").waitFor();
    assert.equal(await page.locator(".cm-content").count(), 1);
    await page.reload();
    await page.getByText("1 of 3 viewed").waitFor();
    assert.equal(await viewed.isChecked(), true);
    await page.evaluate(() => { window.reviewRevision = 2; window.dispatchEvent(new Event("focus")); });
    await page.getByText("Changed since viewed", { exact: true }).waitFor();
    assert.equal(await viewed.isChecked(), false);
    await page.getByRole("radio", { name: "Folders" }).click();
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`);
      assert(await viewed.evaluate((input) => {
        const box = input.getBoundingClientRect();
        return box.width > 0 && box.x >= 0 && box.right <= innerWidth;
      }), `viewed checkbox remains visible at ${width}px`);
    }
    await page.getByLabel("Changes scope").selectOption("commit");
    await page.getByLabel("Commit to review").selectOption(sha);
    await page.getByText("Commit changes · 1 file").waitFor();
    await page.getByRole("button", { name: /committed.ts/ }).click();
    await page.locator(".cm-content").first().waitFor();
    assert((await page.locator(".cm-content").allTextContents()).join("\n").includes("after: commit"));
    await page.getByRole("button", { name: "Back to all changes" }).click();
    await page.getByText(/Against origin\/release/).waitFor();
    assert.deepEqual(errors, []);
    console.log("ok branch suggestions, folder filtering, Viewed reload/invalidation, narrow layout, commit scope and return to all");
  }
} finally { await browser?.close(); await server?.close(); }
