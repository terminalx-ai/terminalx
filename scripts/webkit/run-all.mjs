#!/usr/bin/env node
// Runs the WebKit layout checks (`pnpm test:webkit-layout`), several at once.
//
// Each check is its own script and its own process: it serves the built app on
// a free port, launches its own WebKit and sets its own fixture. Nothing is
// shared between two of them except the cases named below, so they do not have
// to wait for each other.
//
//   pnpm build && pnpm exec playwright install webkit && pnpm test:webkit-layout
//   node scripts/webkit/run-all.mjs chat-find run-menu     only these checks
//   pnpm test:webkit-layout --jobs 1                        one at a time (or WEBKIT_JOBS=1)
//
// Every check runs even when an earlier one fails. A check's output is printed
// in one piece when it ends; what failed is printed again at the end, and the
// exit status is 1.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The checks CI requires, in the order they were added. */
const checks = [
  "changes-review", "merge-conflicts", "diff-options", "settings-navigation", "orchestration", "run-limits", "run-sidebar",
  "orchestrate-start", "readable-panels", "layered-configuration", "sidebar-scroll", "sidebar-order", "sidebar-extras",
  "cloud-session", "cloud-outbox", "cloud-history", "cloud-sidebar", "cloud-sections", "local-sections", "session-status",
  "shortcuts", "start-from", "create-project", "terminal-search", "worktree-cleanup", "merged-cleanup", "dialog-lists",
  "account-row", "issue-session", "issue-work", "pipeline-checks", "agent-dashboard", "organization-visibility", "chat-links",
  "chat-find", "chat-wrapping", "file-citations", "chat-controls", "link-chat", "app-resources", "usage-refresh",
  "dictation-edits", "environment", "agent-logins", "model-access", "tab-strip", "pane-split", "editor-toolbar",
  "machine-name", "star-reminder", "context-menus", "attention-approvals", "repository-settings", "sparse-checkout",
  "repository-scripts", "pr-conversation", "automatic-session-status", "runtime-start-failed", "session-cost",
  "helper-titles", "error-toast", "notifications-off", "pair-phone", "file-tree-filter", "quick-open", "tab-errors",
  "review-threads", "run-menu", "worktree-copy-step", "projects-settings", "branch-toasts", "composer-attachments",
  "permission-details",
];

// Some checks start a Vite dev server instead of serving dist/. Vite's
// dependency optimiser rewrites node_modules/.vite when it starts, and two of
// them end up asking for Vite's default port, so those take turns. They are
// found by what they import, so a new one needs no entry here.
const script = (name) => fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));
const startsVite = (name) => /(from\s+|import\()\s*["']vite["']/.test(readFileSync(script(name), "utf8"));

// These measure against the clock, so other checks competing for the processor
// would be what they measured: they run after the rest, one at a time.
// pr-conversation samples frame times while a list scrolls. cloud-history must
// see a loading line that its fixture replaces 2.5 s after the page subscribes.
const alone = new Set(["pr-conversation", "cloud-history"]);

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
// The slowest check takes about five minutes on a slow runner. Past this one
// is hung, and two hung in a row still end inside the job's own limit.
const limit = 10 * 60_000;

/** Run one check to its end. Its output is kept and printed in one piece. */
function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    // Said at once, so a log that stops short shows which checks never ended.
    console.log(`start ${name}`);
    const child = spawn(process.execPath, [script(name)], { stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    child.stdout?.on("data", (chunk) => output.push(chunk));
    child.stderr?.on("data", (chunk) => output.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, limit);
    let finished = false;
    // A check that cannot start gives both "error" and "close": report it once.
    const finish = (status) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const ms = Date.now() - started;
      const ok = status === 0 && !timedOut;
      const state = ok ? "ok" : timedOut ? `FAILED: no result after ${seconds(limit)}` : `FAILED: ${status}`;
      const text = Buffer.concat(output).toString("utf8").trimEnd();
      const report = `\n── ${name} (${seconds(ms)}) ${state}${text ? `\n${text}` : ""}`;
      console.log(report);
      resolve({ name, ms, ok, report });
    };
    child.on("error", (error) => { output.push(Buffer.from(`${error.stack ?? error}\n`)); finish("could not start"); });
    child.on("close", (code, signal) => finish(code ?? signal));
  });
}

const usage = (message) => {
  console.error(`${message}\nUsage: node scripts/webkit/run-all.mjs [--jobs <number>] [check ...]`);
  process.exit(2);
};
let parsed;
try {
  parsed = parseArgs({ options: { jobs: { type: "string" } }, allowPositionals: true });
} catch (error) {
  usage(error.message);
}
const args = parsed.positionals;
const jobsValue = parsed.values.jobs ?? process.env.WEBKIT_JOBS;
const jobs = jobsValue === undefined ? Math.min(4, availableParallelism()) : Number(jobsValue);
if (!Number.isInteger(jobs) || jobs < 1) usage(`The number of checks to run at once must be a whole number above 0, not ${JSON.stringify(jobsValue)}.`);
const unknown = args.filter((name) => !checks.includes(name));
if (unknown.length) usage(`Not a check of this suite: ${unknown.join(", ")}.`);
const selected = args.length ? checks.filter((name) => args.includes(name)) : checks;

// A queue entry is one check, or a list of checks that take turns.
const turns = selected.filter((name) => startsVite(name) && !alone.has(name));
const queue = [...(turns.length ? [turns] : []), ...selected.filter((name) => !turns.includes(name) && !alone.has(name))];
const results = [];
const started = Date.now();
console.log(`${selected.length} WebKit checks, ${jobs} at once`);
await Promise.all(Array.from({ length: jobs }, async () => {
  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    for (const name of [entry].flat()) results.push(await run(name));
  }
}));
for (const name of selected.filter((name) => alone.has(name))) results.push(await run(name));

const failed = results.filter((result) => !result.ok);
const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 10);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed in ${seconds(Date.now() - started)} (${seconds(results.reduce((sum, result) => sum + result.ms, 0))} of checks).`);
console.log(`Slowest: ${slowest.map((result) => `${result.name} ${seconds(result.ms)}`).join(", ")}`);
if (failed.length) {
  // Again, last: whoever reads only the end of the log finds the cause there.
  for (const result of failed) console.log(result.report);
  console.log(`\nFAILED: ${failed.map((result) => result.name).join(", ")}`);
  process.exit(1);
}
