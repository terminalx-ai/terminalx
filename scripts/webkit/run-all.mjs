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
//   node scripts/webkit/run-all.mjs agent-dashboard:2      one entry of a script that runs as several (its name alone: all of them)
//   pnpm test:webkit-layout --jobs 1                        one at a time (or WEBKIT_JOBS=1)
//   node scripts/webkit/run-all.mjs --shard 2/4             the second of four parts (one CI job each)
//   node scripts/webkit/run-all.mjs --shard 2/4 --list      the names that part runs, one per line; nothing runs
//
//   node scripts/webkit/run-all.mjs --only mac-only        the checks in `macOnly` below and no other, on any host
//
// On Linux the checks in `macOnly` below are left out, and the output says so;
// WEBKIT_MAC_ONLY_TOO=1 runs them there as well (to see whether they still hold).
// `--only mac-only` is what a macOS job runs beside Linux jobs that leave them out:
// between them every check runs once. It reads the same list, so a check added to
// `macOnly` moves from the one to the other with no other change.
//
// Every check runs even when an earlier one fails. A check's output is printed
// in one piece when it ends; what failed is printed again at the end, and the
// exit status is 1.
//
// On Linux (the CI parts), a check that failed runs once more by itself after
// the part's other checks have ended (`reruns`, below). The part passes only if
// each of them passes then; one that passed only alone is printed as "FAILED
// under load, passed alone" with its first output, and listed in the job's
// summary, so it is still fixed. macOS and `--only mac-only` run each check once.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The checks CI requires, in the order they were added. */
export const checks = [
  "cloud-automations",
  "changes-review", "merge-conflicts", "diff-options", "settings-navigation", "settings-introductions", "orchestration", "run-limits", "run-sidebar",
  "orchestrate-start", "readable-panels", "layered-configuration", "sidebar-scroll", "sidebar-order", "sidebar-extras", "sidebar-quick-chats", "working-marks",
  "cloud-session", "cloud-outbox", "cloud-history", "cloud-sidebar", "cloud-attention", "cloud-sections", "workspace-sections", "local-sections",
  "session-status", "shortcuts", "start-from", "create-project", "terminal-search", "worktree-cleanup", "merged-cleanup",
  "dialog-lists",
  "account-row", "issue-session", "issue-work", "pipeline-checks", "agent-dashboard:1", "agent-dashboard:2", "agent-dashboard:3", "organization-visibility", "chat-links",
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
  "bot-message-cards",
  "bot-handoffs-page",
  "bot-calendar",
  "finished-toast",
  // These ran after the suite, one at a time, until 2026-11: team-presence-following from
  // `pnpm test:webkit-layout`, the four machine screens from CI's own step.
  "team-presence-following",
  "machines-pairing", "machine-connection", "machine-page", "machine-update",
  // Split from dictation-edits (2026-11): its Right Option case, which only a Mac can make.
  "dictation-hold-to-talk",
];

/**
 * An entry of `checks` is a script's name, or `<script>:<part>` for a script that runs as several entries: the
 * arguments each such entry gives its script are here. agent-dashboard's seven layouts are dealt over three entries
 * by its own --layouts, each layout in exactly one: together they took 470 s on a slow runner, against the 600 s
 * limit below for one check.
 */
const entryArguments = new Map([
  ["agent-dashboard:1", ["--layouts", "1/3"]],
  ["agent-dashboard:2", ["--layouts", "2/3"]],
  ["agent-dashboard:3", ["--layouts", "3/3"]],
]);

/**
 * The checks that are left out on a Linux host, each with why. CI runs them in its macOS job (`--only mac-only`) and
 * every other check in its Linux parts: infra/ci-runners/test_workflow_security.py fails when a check is in neither or
 * in both. The first five are judgements made on a Mac (2026-11), not seen failing on Linux; WEBKIT_MAC_ONLY_TOO=1 runs
 * them on Linux too, to find out. The others were moved here from what a Linux run showed, each reason from that run.
 */
export const macOnly = new Map([
  ["chat-scrollbar", "measures macOS's overlay scrollbars (they take no width and fade); WebKit on Linux draws GTK's own"],
  ["app-resources", "compares rendered pixels and WebGL output for equality, which Linux's software rendering does not reproduce"],
  ["run-sidebar", "part of it checks the Mac's glass sidebar (backdrop blur through the window), which WebKit on Linux does not composite the same"],
  ["readable-panels", "measures text contrast through the Mac's glass panels (backdrop blur), which WebKit on Linux does not composite the same"],
  ["pr-conversation", "samples frame times while a list scrolls, against the Mac runner's frame rate"],
  ["dictation-hold-to-talk", "holds Right Option (the Mac's key, hold:AltRight) and presses Option+Backspace to delete a word; WebKit on Linux has no editing key while Alt is held, so the edit is never made"],
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
const script = (name) => fileURLToPath(new URL(`./${name.split(":")[0]}.mjs`, import.meta.url));
const viteScripts = new Map();
const startsVite = (name) => {
  const path = script(name);
  if (!viteScripts.has(path)) viteScripts.set(path, /(from\s+|import\()\s*["'](vite|\.\/vite-page\.mjs)["']/.test(readFileSync(path, "utf8")));
  return viteScripts.get(path);
};
// At most this many Vite checks run at once, whatever --jobs is; the other workers take the checks that serve dist/
// meanwhile. The shared cache holds only the packages: each dev server still transforms the app's own modules when
// its page first loads, on the same cores as the others, inside its check's own limits (organization-roster allows
// its page 20 s). Unbounded, the first four in the list are all Vite checks and start together. Two is a choice, not
// a measurement against three: it halves that start, and with 13 Vite checks among 128 no worker is left without a
// check to run for it until only Vite checks remain.
const viteAtOnce = 2;

/**
 * The checks that run alone, each with why: they measure against the clock, so other checks competing for the
 * processor would be what they measured. They run after the rest of their part has ended, one at a time. Being here
 * does not move a check to another part (`dealtApart`, below).
 */
export const alone = new Map([
  ["pr-conversation", "samples frame times while a list scrolls"],
  ["cloud-history", "must see a loading line that its fixture replaces 2.5 s after the page subscribes"],
  // Step 2's Linux probe (run 45403430912, attempt 2): 124 ms with the runner at load 11.7 and 3 WebKit at once.
  ["machine-session", "a sent message must be drawn within 100 ms of the Enter key, timed in the page"],
]);

/**
 * The checks `shard` deals as a kind of their own: those `alone` held when the parts were dealt this way (2026-11).
 * One added to `alone` since keeps the part it had, so that a check moved to run alone changes no part's list.
 */
const dealtApart = new Set(["pr-conversation", "cloud-history"]);

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
// The slowest check takes about five minutes on a slow runner. Past this one
// is hung, and two hung in a row still end inside the job's own limit.
const limit = 10 * 60_000;

/**
 * The host's state, said at each check's start, so that a run that gets slower says what grew: the load average, free
 * memory (and on macOS the swap in use, since "free" is small there whatever the pressure), and how many WebKit and
 * node processes exist. On #1515's second run the same checks took 2.8 times as long from the eleventh minute on and
 * nothing in the log said why.
 */
function host() {
  const said = [`load ${loadavg()[0].toFixed(1)}`, `free ${Math.round(freemem() / 2 ** 20)} MB`];
  try {
    if (process.platform === "darwin") said.push(`swap ${/used = (\S+)/.exec(execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }))?.[1] ?? "?"}`);
    const names = execFileSync("ps", ["-axo", "comm="], { encoding: "utf8" }).split("\n");
    const count = (pattern) => names.filter((name) => pattern.test(name)).length;
    said.push(`${count(/WebKit|pw_run|MiniBrowser|Playwright/)} WebKit`, `${count(/(^|\/)node$/)} node`);
  } catch (error) {
    // The numbers are for the reader of a slow run; a host that cannot give them still runs the checks.
    said.push(`no process list: ${error.code ?? error.message}`);
  }
  return said.join(", ");
}

/** Run one check to its end. Its output is kept and printed in one piece. */
function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    // Said at once, so a log that stops short shows which checks never ended.
    console.log(`start ${name} (${host()})`);
    const child = spawn(process.execPath, [script(name), ...(entryArguments.get(name) ?? [])], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...environment(name) } });
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
 * list's order: the Vite checks first, so every part gets its share of them (they start slowest); then the
 * `dealtApart` ones, which run alone, after the rest of their part; then the others. Which part a check is in does not
 * depend on the host: the checks left out on Linux are left out after the parts are dealt.
 */
export function shard(names, index, count) {
  const kinds = [names.filter((name) => startsVite(name) && !dealtApart.has(name)), names.filter((name) => dealtApart.has(name)), names.filter((name) => !startsVite(name) && !dealtApart.has(name))];
  const parts = Array.from({ length: count }, () => []);
  let next = 0;
  for (const kind of kinds) for (const name of kind) parts[next++ % count].push(name);
  return names.filter((name) => parts[index - 1].includes(name));
}

/**
 * Run `start(name)` for every name, `jobs` at once, and at most `viteAtOnce` of the Vite checks at once. A free worker
 * takes the first name in the list's order that may start now, so none idles while a check that serves dist/ waits;
 * one that finds only Vite checks left, with `viteAtOnce` of them running, waits for one of those to end. The parts
 * of one split check (`name:part`) run one at a time.
 */
export async function pool(names, jobs, start) {
  const queue = [...names];
  let viteRunning = 0;
  // The scripts with a part running now. The parts of one split check take turns: each of agent-dashboard's opens
  // pages of 72 sessions a column (about 1.1 GB of WebKit processes at its peak, measured on a Mac), and the run
  // that got slower had all three going at once on a 7 GB runner for five minutes before it did.
  const partsRunning = new Set();
  const mayStart = (name) => (!startsVite(name) || viteRunning < viteAtOnce) && !(name.includes(":") && partsRunning.has(name.split(":")[0]));
  const waiting = [];
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (queue.length) {
      const index = queue.findIndex(mayStart);
      if (index < 0) {
        await new Promise((resolve) => waiting.push(resolve));
        continue;
      }
      const [name] = queue.splice(index, 1);
      const vite = startsVite(name);
      const part = name.includes(":") ? name.split(":")[0] : undefined;
      if (vite) viteRunning++;
      if (part) partsRunning.add(part);
      try {
        await start(name);
      } finally {
        if (vite) viteRunning--;
        if (part) partsRunning.delete(part);
        if (vite || part) for (const wake of waiting.splice(0)) wake();
      }
    }
  }));
}

/**
 * How many times a check that failed runs again, by itself, on a Linux part: once (the owner's decision, #1514 item
 * 21). Never more: a check that fails alone too fails its part, and a second try would hide a check that fails half
 * the time. infra/ci-runners/test_webkit_reruns.py fails when this or `rerunFailed` allows more.
 */
export const reruns = 1;

/** The reruns this host makes: Linux runs the CI parts, which rerun; macOS, and `--only mac-only` anywhere, do not. */
export function rerunsHere({ platform = process.platform, only } = {}) {
  return platform === "linux" && !only ? reruns : 0;
}

/**
 * Run each failed result's check again with `run`, one at a time, in the order they ended, when `times` is 1 (for 0
 * nothing runs). Called once the part's other checks have ended, so nothing else runs beside each one. Resolves with
 * every result as it now stands: a check that passed alone is ok, with `first` its failed result and `passedAlone`
 * set; one that failed alone too is not ok, with `first` as well. Results that passed are returned as they were.
 */
export async function rerunFailed(results, run, times = reruns) {
  if (times !== 0 && times !== reruns) throw new Error(`A failed WebKit check runs again ${reruns} time at most, not ${times}.`);
  const after = [];
  for (const first of results) {
    if (first.ok || !times) {
      after.push(first);
      continue;
    }
    console.log(`\nagain, alone: ${first.name} failed with others running; it runs once more, by itself`);
    const again = await run(first.name);
    if (again.ok) {
      // Said with what it printed the first time: that output is what has to be fixed.
      console.log(`\n── ${first.name} FAILED under load, passed alone; its first run:${first.report}`);
      after.push({ ...again, first, passedAlone: true });
    } else {
      after.push({ ...again, first });
    }
  }
  return after;
}

/** A check's output for the job summary: no terminal colours, its last `lines` lines, in a fence it cannot close. */
function fenced(report, lines = 120) {
  const text = report.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n");
  const kept = text.length > lines ? [`(the last ${lines} of ${text.length} lines)`, ...text.slice(-lines)] : text;
  const longest = Math.max(2, ...[...kept.join("\n").matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${kept.join("\n")}\n${fence}`;
}

/**
 * The job summary's words for these results (GitHub Actions' GITHUB_STEP_SUMMARY, in Markdown), or "" when every
 * check passed the first time: the checks that passed only alone under their own heading, each with its first
 * output, then those that failed alone too.
 */
export function stepSummary(results, part) {
  const title = `WebKit checks${part ? `, part ${part}` : ""}`;
  const passedAlone = results.filter((result) => result.passedAlone);
  const failed = results.filter((result) => !result.ok);
  const said = [];
  if (passedAlone.length) {
    said.push(`### ${title}: FAILED under load, passed alone`, "", "Each failed with the part's other checks running, then passed when run again by itself. The part passed, but each is still to be fixed: its first output is below.", "");
    for (const result of passedAlone) said.push(`<details><summary><code>${result.name}</code>: failed in ${seconds(result.first.ms)}, passed alone in ${seconds(result.ms)}</summary>`, "", fenced(result.first.report), "", "</details>", "");
  }
  if (failed.length) {
    said.push(`### ${title}: failed`, "");
    for (const result of failed) said.push(`- <code>${result.name}</code>${result.first ? ", and again alone" : ""}`);
    said.push("");
  }
  return said.join("\n");
}

/** The command line: run the checks it names, or list them. */
async function main() {
  const usage = (message) => {
    console.error(`${message}\nUsage: node scripts/webkit/run-all.mjs [--jobs <number>] [--shard <i>/<n>] [--list] [--only mac-only | check ...]`);
    process.exit(2);
  };
  let parsed;
  try {
    parsed = parseArgs({ options: { jobs: { type: "string" }, shard: { type: "string" }, list: { type: "boolean" }, only: { type: "string" } }, allowPositionals: true });
  } catch (error) {
    usage(error.message);
  }
  const args = parsed.positionals;
  const jobsValue = parsed.values.jobs ?? process.env.WEBKIT_JOBS;
  const jobs = jobsValue === undefined ? Math.min(4, availableParallelism()) : Number(jobsValue);
  if (!Number.isInteger(jobs) || jobs < 1) usage(`The number of checks to run at once must be a whole number above 0, not ${JSON.stringify(jobsValue)}.`);
  // A script that runs as several entries is named whole (`agent-dashboard`) or by one entry (`agent-dashboard:2`).
  const names = (arg) => checks.filter((name) => name === arg || name.split(":")[0] === arg);
  const unknown = args.filter((arg) => !names(arg).length);
  if (unknown.length) usage(`Not a check of this suite: ${unknown.join(", ")}.`);
  const wanted = new Set(args.flatMap(names));
  const only = parsed.values.only;
  if (only !== undefined && only !== "mac-only") usage(`--only takes mac-only, not ${JSON.stringify(only)}.`);
  if (only && args.length) usage(`--only mac-only names its own checks (${[...macOnly.keys()].join(", ")}); it cannot be given others: ${args.join(", ")}.`);
  const strangers = [...macOnly.keys()].filter((name) => !checks.includes(name));
  if (strangers.length) usage(`In macOnly but not a check of this suite: ${strangers.join(", ")}.`);
  const named = only ? checks.filter((name) => macOnly.has(name)) : args.length ? checks.filter((name) => wanted.has(name)) : checks;

  let selected = named;
  if (parsed.values.shard !== undefined) {
    const match = /^(\d+)\/(\d+)$/.exec(parsed.values.shard);
    const [index, count] = match ? [Number(match[1]), Number(match[2])] : [];
    if (!match || count < 1 || index < 1 || index > count) usage(`--shard takes <i>/<n> with 1 ≤ i ≤ n, not ${JSON.stringify(parsed.values.shard)}.`);
    selected = shard(named, index, count);
  }
  // Asked for by name with --only, they run wherever this is.
  const leftOut = !only && process.platform === "linux" && process.env.WEBKIT_MAC_ONLY_TOO !== "1" ? selected.filter((name) => macOnly.has(name)) : [];
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
  console.log(`${selected.length} WebKit checks${only ? " (only the Mac-only ones)" : ""}${parsed.values.shard ? ` (part ${parsed.values.shard})` : ""}, ${jobs} at once${leftOut.length ? `; ${leftOut.length} left out on Linux: ${leftOut.join(", ")}` : ""}`);
  if (selected.some((name) => machineScreens.includes(name))) {
    mkdirSync(join(output, "machines-screens"), { recursive: true });
    // As each machine script does for its own default folder: pictures are not part of the repository.
    try { writeFileSync(join(output, ".gitignore"), "*\n", { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (selected.some(startsVite)) {
    // Made here, once, so that the Vite checks starting at once only read it (vite-page.mjs).
    const warming = Date.now();
    try {
      const { warmViteDeps, WARMED } = await import("./vite-page.mjs");
      await warmViteDeps();
      // From here a Vite check that makes the cache again has a different idea of it from the others, and fails.
      process.env[WARMED] = "1";
      console.log(`Vite's dependency cache is ready (${seconds(Date.now() - warming)}).`);
    } catch (error) {
      // The Vite checks then make it themselves, at once; whatever that breaks fails them, and this run fails too.
      console.log(`FAILED: Vite's dependency cache could not be made: ${error.stack ?? error}`);
      failedSetup.push("Vite's dependency cache");
    }
  }
  await pool(selected.filter((name) => !alone.has(name)), jobs, async (name) => { results.push(await run(name)); });
  for (const name of selected.filter((name) => alone.has(name))) {
    console.log(`alone, after the others: ${name}: ${alone.get(name)}`);
    results.push(await run(name));
  }
  const firstRuns = results.splice(0);
  results.push(...await rerunFailed(firstRuns, run, rerunsHere({ only })));

  const failed = results.filter((result) => !result.ok);
  const passedAlone = results.filter((result) => result.passedAlone);
  const slowest = [...firstRuns].sort((a, b) => b.ms - a.ms).slice(0, 10);
  const checkTime = results.reduce((sum, result) => sum + result.ms + (result.first?.ms ?? 0), 0);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed${passedAlone.length ? ` (${passedAlone.length} only when run again alone)` : ""} in ${seconds(Date.now() - started)} (${seconds(checkTime)} of checks).`);
  console.log(`Slowest: ${slowest.map((result) => `${result.name} ${seconds(result.ms)}`).join(", ")}`);
  if (leftOut.length) console.log(`Left out on Linux (run-all.mjs macOnly): ${leftOut.join(", ")}`);
  if (passedAlone.length) console.log(`FAILED under load, passed alone (still to be fixed; first output above): ${passedAlone.map((result) => result.name).join(", ")}`);
  const summary = stepSummary(results, parsed.values.shard);
  if (summary && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (failed.length || failedSetup.length) {
    // Again, last: whoever reads only the end of the log finds the cause there.
    for (const result of failed) console.log(`${result.first ? `${result.first.report}\n(and alone:)` : ""}${result.report}`);
    console.log(`\nFAILED: ${[...failedSetup, ...failed.map((result) => result.name)].join(", ")}`);
    process.exit(1);
  }
}

// Only as a script: importing this file (for `checks`, `macOnly` or `shard`) runs nothing. Node says which it is
// (import.meta.main, since Node 24.2; .nvmrc's "24" is the newest 24), also through a linked folder. A Node without it
// cannot tell, and to guess "imported" would be a run of the suite that ran nothing and passed: it is an error instead.
if (typeof import.meta.main !== "boolean") {
  throw new Error(`run-all.mjs needs Node 24.2 or newer (import.meta.main) to know whether it was run or imported; this is ${process.version}.`);
}
if (import.meta.main) await main();
