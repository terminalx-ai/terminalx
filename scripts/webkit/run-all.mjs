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
//   node scripts/webkit/run-all.mjs --shard 2/4             the second of four parts (one CI job each)
//   node scripts/webkit/run-all.mjs --shard 2/4 --list      the names that part runs, one per line; nothing runs
//
// On Linux the checks in `macOnly` below are left out, and the output says so;
// WEBKIT_MAC_ONLY_TOO=1 runs them there as well (to see whether they still hold).
//
// Every check runs even when an earlier one fails. A check's output is printed
// in one piece when it ends; what failed is printed again at the end, and the
// exit status is 1.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The checks CI requires, in the order they were added. */
export const checks = [
  "cloud-automations",
  "changes-review", "merge-conflicts", "diff-options", "settings-navigation", "settings-introductions", "orchestration", "run-sidebar",
  "orchestrate-start", "readable-panels", "layered-configuration", "sidebar-scroll", "sidebar-order", "sidebar-extras", "sidebar-quick-chats", "working-marks",
  "cloud-session", "cloud-outbox", "cloud-history", "cloud-sidebar", "cloud-attention", "cloud-sections", "workspace-sections", "local-sections",
  "session-status", "shortcuts", "start-from", "create-project", "terminal-search", "worktree-cleanup", "merged-cleanup",
  "dialog-lists",
  "account-row", "issue-session", "issue-work", "pipeline-checks", "agent-dashboard", "organization-visibility", "chat-links",
  "chat-find", "chat-wrapping", "file-citations", "chat-controls", "link-chat", "app-resources", "usage-refresh",
  "dictation-edits", "environment", "environment-info", "agent-logins", "model-access", "tab-strip", "pane-split", "editor-toolbar", "file-tab", "dock-tabs",
  "machine-name", "account-settings", "star-reminder", "context-menus", "attention-approvals", "repository-settings", "sparse-checkout",
  "repository-scripts", "pr-conversation", "automatic-session-status", "runtime-start-failed", "session-cost",
  "helper-titles", "error-toast", "notifications-off", "pair-phone", "file-tree-filter", "quick-open", "tab-errors",
  "review-threads", "run-menu", "worktree-copy-step", "projects-settings", "branch-toasts", "composer-attachments",
  "organization-roster", "permission-details", "chat-tables", "command-palette", "machine-sidebar", "machine-session", "machine-ports",
  "sidebar-design", "chat-transcript", "changes-design", "sidebar-menus", "machines-screens", "review-tab", "checks-panel", "turn-details", "settings-design",
  "project-settings", "pr-panel-design", "settings-pro-377", "cloud-setup", "held-followups", "first-run", "confirm-dialogs",
  "attachment-preview", "session-start", "composer-controls", "session-menu", "chat-scrollbar", "settings-stats",
  "automation-sources",
  "bots-screens", "bot-role-memory",
  "bot-chat", "bot-settings",
  // bot-items, bot-handoffs, bot-runs and bot-suggestions, in one process (2026-11).
  "bot-pages",
  "bot-duties",
  "bot-calendar",
  // These ran after the suite, one at a time, until 2026-11: team-presence-following from
  // `pnpm test:webkit-layout`, the four machine screens from CI's own step.
  "team-presence-following",
  "machines-pairing", "machine-connection", "machine-page", "machine-update",
];

/**
 * The checks that are left out on a Linux host, each with why. They run on macOS as before. These are judgements made
 * on a Mac (2026-11), not seen failing on Linux: WEBKIT_MAC_ONLY_TOO=1 runs them on Linux too, to find out.
 */
export const macOnly = new Map([
  ["chat-scrollbar", "measures macOS's overlay scrollbars (they take no width and fade); WebKit on Linux draws GTK's own"],
  ["app-resources", "compares rendered pixels and WebGL output for equality, which Linux's software rendering does not reproduce"],
  ["run-sidebar", "part of it checks the Mac's glass sidebar (backdrop blur through the window), which WebKit on Linux does not composite the same"],
  ["readable-panels", "measures text contrast through the Mac's glass panels (backdrop blur), which WebKit on Linux does not composite the same"],
  ["pr-conversation", "samples frame times while a list scrolls, against the Mac runner's frame rate"],
]);

/**
 * What a check is given in its environment by this runner. The machine screens keep their pictures where CI uploads
 * them from (scripts/webkit/output/machines-screens/<name>); each script run by itself still takes MACHINES_SHOTS, or
 * its own default folder.
 */
const output = fileURLToPath(new URL("./output/", import.meta.url));
const machineScreens = ["machines-pairing", "machine-connection", "machine-page", "machine-update"];
const environment = (name) => (machineScreens.includes(name) ? { MACHINES_SHOTS: join(output, "machines-screens", name) } : {});

// Some checks start a Vite dev server instead of serving dist/. They share one
// setup (vite-page.mjs): one dependency cache, which is made once below before
// any of them starts, and a free port each, so they run beside the others. They
// are found by what they import, so a new one needs no entry here; the parts of
// --shard each take some of them.
const script = (name) => fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));
const startsVite = (name) => /(from\s+|import\()\s*["'](vite|\.\/vite-page\.mjs)["']/.test(readFileSync(script(name), "utf8"));

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
    const child = spawn(process.execPath, [script(name)], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...environment(name) } });
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

/**
 * Part `index` (from 1) of `count` of `names`, each name in exactly one part. Each kind is dealt out in turn, in the
 * list's order: the Vite checks first, so every part gets its share of them (they start slowest); then the `alone`
 * ones, which still run alone, after the rest of their part; then the others. Which part a check is in does not
 * depend on the host: the checks left out on Linux are left out after the parts are dealt.
 */
export function shard(names, index, count) {
  const kinds = [names.filter((name) => startsVite(name) && !alone.has(name)), names.filter((name) => alone.has(name)), names.filter((name) => !startsVite(name) && !alone.has(name))];
  const parts = Array.from({ length: count }, () => []);
  let next = 0;
  for (const kind of kinds) for (const name of kind) parts[next++ % count].push(name);
  return names.filter((name) => parts[index - 1].includes(name));
}

/** The command line: run the checks it names, or list them. */
async function main() {
  const usage = (message) => {
    console.error(`${message}\nUsage: node scripts/webkit/run-all.mjs [--jobs <number>] [--shard <i>/<n>] [--list] [check ...]`);
    process.exit(2);
  };
  let parsed;
  try {
    parsed = parseArgs({ options: { jobs: { type: "string" }, shard: { type: "string" }, list: { type: "boolean" } }, allowPositionals: true });
  } catch (error) {
    usage(error.message);
  }
  const args = parsed.positionals;
  const jobsValue = parsed.values.jobs ?? process.env.WEBKIT_JOBS;
  const jobs = jobsValue === undefined ? Math.min(4, availableParallelism()) : Number(jobsValue);
  if (!Number.isInteger(jobs) || jobs < 1) usage(`The number of checks to run at once must be a whole number above 0, not ${JSON.stringify(jobsValue)}.`);
  const unknown = args.filter((name) => !checks.includes(name));
  if (unknown.length) usage(`Not a check of this suite: ${unknown.join(", ")}.`);
  const named = args.length ? checks.filter((name) => args.includes(name)) : checks;

  let selected = named;
  if (parsed.values.shard !== undefined) {
    const match = /^(\d+)\/(\d+)$/.exec(parsed.values.shard);
    const [index, count] = match ? [Number(match[1]), Number(match[2])] : [];
    if (!match || count < 1 || index < 1 || index > count) usage(`--shard takes <i>/<n> with 1 ≤ i ≤ n, not ${JSON.stringify(parsed.values.shard)}.`);
    selected = shard(named, index, count);
  }
  const leftOut = process.platform === "linux" && process.env.WEBKIT_MAC_ONLY_TOO !== "1" ? selected.filter((name) => macOnly.has(name)) : [];
  // Said on stderr, so that --list's stdout is the names alone.
  for (const name of leftOut) console.error(`left out on Linux: ${name}: ${macOnly.get(name)}`);
  selected = selected.filter((name) => !leftOut.includes(name));

  if (parsed.values.list) {
    for (const name of selected) console.log(name);
    process.exit(0);
  }

  const results = [];
  const failedSetup = [];
  const started = Date.now();
  console.log(`${selected.length} WebKit checks${parsed.values.shard ? ` (part ${parsed.values.shard})` : ""}, ${jobs} at once${leftOut.length ? `; ${leftOut.length} left out on Linux: ${leftOut.join(", ")}` : ""}`);
  if (selected.some((name) => machineScreens.includes(name))) {
    mkdirSync(join(output, "machines-screens"), { recursive: true });
    // As each machine script does for its own default folder: pictures are not part of the repository.
    try { writeFileSync(join(output, ".gitignore"), "*\n", { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (selected.some(startsVite)) {
    // Made here, once, so that the Vite checks starting at once only read it (vite-page.mjs).
    const warming = Date.now();
    try {
      const { warmViteDeps } = await import("./vite-page.mjs");
      await warmViteDeps();
      console.log(`Vite's dependency cache is ready (${seconds(Date.now() - warming)}).`);
    } catch (error) {
      // The Vite checks then make it themselves, at once; whatever that breaks fails them, and this run fails too.
      console.log(`FAILED: Vite's dependency cache could not be made: ${error.stack ?? error}`);
      failedSetup.push("Vite's dependency cache");
    }
  }
  const queue = selected.filter((name) => !alone.has(name));
  await Promise.all(Array.from({ length: jobs }, async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) results.push(await run(name));
  }));
  for (const name of selected.filter((name) => alone.has(name))) results.push(await run(name));

  const failed = results.filter((result) => !result.ok);
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 10);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed in ${seconds(Date.now() - started)} (${seconds(results.reduce((sum, result) => sum + result.ms, 0))} of checks).`);
  console.log(`Slowest: ${slowest.map((result) => `${result.name} ${seconds(result.ms)}`).join(", ")}`);
  if (leftOut.length) console.log(`Left out on Linux (run-all.mjs macOnly): ${leftOut.join(", ")}`);
  if (failed.length || failedSetup.length) {
    // Again, last: whoever reads only the end of the log finds the cause there.
    for (const result of failed) console.log(result.report);
    console.log(`\nFAILED: ${[...failedSetup, ...failed.map((result) => result.name)].join(", ")}`);
    process.exit(1);
  }
}

// Only as a script: importing this file (for `checks`, `macOnly` or `shard`) runs nothing. Both paths are real ones:
// Node resolves links in this module's URL but not in argv, and a run through a linked folder must still run.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await main();
