#!/usr/bin/env node
// The WebKit checks that passed only when run again, over the last CI runs (#1514 item 21).
//
// A Linux part reruns a failed check once, alone (run-all.mjs `reruns`), and passes when it passes then. Each such
// check gets a warning annotation whose title names it and its part (run-all.mjs `annotationTitle`). This reads those
// annotations back through GitHub's API, for every attempt of every Linux part, so no log is downloaded, and prints
// each check with how many runs it passed only when run again in, and which.
//
//   node scripts/webkit/rerun-tally.mjs              the last 30 completed CI runs, every branch
//   node scripts/webkit/rerun-tally.mjs --runs 100   the last 100 (at most 100)
//   node scripts/webkit/rerun-tally.mjs --branch main
//   node scripts/webkit/rerun-tally.mjs --json       the same, as JSON
//
// It runs `gh api` in this repository, so it needs `gh` signed in with read access to its Actions.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { annotationCheck } from "./run-all.mjs";

/** The Linux parts' job name, as ci.yml's matrix names each: "webkit-layout-linux (2)". */
const partJob = /^webkit-layout-linux \(\d+\)$/;

/** `gh api` over `path` with `jq`, one JSON value per line of what it prints. */
function api(path, jq, { paginate = false } = {}) {
  const out = execFileSync("gh", ["api", ...(paginate ? ["--paginate"] : []), path, "--jq", jq], { encoding: "utf8", maxBuffer: 256 * 2 ** 20 });
  return out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * From `runs` ([{ id, url, branch, sha, jobs: [{ id, name, attempt, annotations: [{ title, level }] }] }]), each check
 * that passed only when run again: { name, runs: [{ id, url, branch, sha, parts: ["2/4", …] }] }, most runs first.
 * A run counts once for a check however many of its attempts or parts said so.
 */
export function tally(runs) {
  const checks = new Map();
  for (const run of runs) {
    for (const job of run.jobs) {
      if (!partJob.test(job.name)) continue;
      for (const annotation of job.annotations) {
        const found = annotation.level === "warning" && annotationCheck(annotation.title);
        if (!found) continue;
        const seen = checks.get(found.name) ?? new Map();
        const entry = seen.get(run.id) ?? { id: run.id, url: run.url, branch: run.branch, sha: run.sha, parts: [] };
        const part = `${found.part ?? "?"}${job.attempt > 1 ? ` (attempt ${job.attempt})` : ""}`;
        if (!entry.parts.includes(part)) entry.parts.push(part);
        seen.set(run.id, entry);
        checks.set(found.name, seen);
      }
    }
  }
  return [...checks].map(([name, seen]) => ({ name, runs: [...seen.values()] })).sort((a, b) => b.runs.length - a.runs.length || a.name.localeCompare(b.name));
}

/** The last `count` completed CI runs (on `branch` if given), with each Linux part's jobs and their annotations. */
function readRuns(count, branch) {
  const query = new URLSearchParams({ status: "completed", per_page: String(count), ...(branch ? { branch } : {}) });
  const runs = api(`repos/{owner}/{repo}/actions/workflows/ci.yml/runs?${query}`, ".workflow_runs[] | {id, url: .html_url, branch: .head_branch, sha: .head_sha[0:9]}");
  return runs.map((run) => {
    // filter=all: the jobs of every attempt, so a part rerun by hand is read too.
    const jobs = api(`repos/{owner}/{repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`, ".jobs[] | {id, name, attempt: .run_attempt}", { paginate: true }).filter((job) => partJob.test(job.name));
    for (const job of jobs) job.annotations = api(`repos/{owner}/{repo}/check-runs/${job.id}/annotations?per_page=100`, ".[] | {title, level: .annotation_level}", { paginate: true });
    return { ...run, jobs };
  });
}

async function main() {
  const { values } = parseArgs({ options: { runs: { type: "string", default: "30" }, branch: { type: "string" }, json: { type: "boolean" } } });
  const count = Number(values.runs);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    console.error(`--runs takes a whole number from 1 to 100, not ${JSON.stringify(values.runs)}.`);
    process.exit(2);
  }
  const runs = readRuns(count, values.branch);
  const found = tally(runs);
  if (values.json) {
    console.log(JSON.stringify({ runsRead: runs.length, checks: found }, null, 2));
    return;
  }
  console.log(`${runs.length} completed CI runs read${values.branch ? ` on ${values.branch}` : ""}; ${found.length} WebKit checks passed only when run again:`);
  for (const check of found) {
    console.log(`\n${check.name}: ${check.runs.length} of ${runs.length} runs`);
    for (const run of check.runs) console.log(`  ${run.url}  ${run.branch} ${run.sha}  part ${run.parts.join(", ")}`);
  }
}

if (import.meta.main) await main();
