#!/usr/bin/env node
// Orchestration benchmark (PRO-283, docs/ORCHESTRATION-BENCH.md).
//
// Compares ways of running a task (one top-model session, one large-model
// session, a lead with mid-model workers, a lead with low-effort workers that
// escalate) on score and cost, over tasks taken from this repository's history.
//
//   node scripts/orchestration-bench/cli.mjs check-task [--shape s] [--min n] [--task id,...]
//   node scripts/orchestration-bench/cli.mjs run [options]
//   node scripts/orchestration-bench/cli.mjs report [options]
//   pnpm bench:orchestration <subcommand> ...
//
// Each subcommand is a module beside this one exporting
// `async function main(argv, io)` that returns an exit code; `io` is
// `{ stdout, stderr, cwd, env }`. `run` and `report` are loaded only when asked
// for, so this file works before they exist.

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARRANGEMENTS, SHAPES } from "./schema.mjs";

/** Subcommands and the module each lives in. */
export const SUBCOMMANDS = {
  "check-task": { module: "check-task.mjs", summary: "prove each task's check fails at startCommit and passes at the solution" },
  run: { module: "run.mjs", summary: "run tasks under arrangements and append one result line per run" },
  report: { module: "report.mjs", summary: "compare results and name a winner per task shape" },
};

export const USAGE = `Usage: node scripts/orchestration-bench/cli.mjs <subcommand> [options]
       pnpm bench:orchestration <subcommand> [options]

Subcommands:
${Object.entries(SUBCOMMANDS).map(([name, { summary }]) => `  ${name.padEnd(11)} ${summary}`).join("\n")}

Shapes:       ${SHAPES.join(", ")}
Arrangements: ${ARRANGEMENTS.join(", ")}

'<subcommand> --help' shows a subcommand's options. Formats: docs/ORCHESTRATION-BENCH.md.`;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Runs one command line. `moduleDir` is where the subcommand modules are
 * looked for (this folder unless a test says otherwise). Returns the exit code.
 */
export async function dispatch(argv, io, { moduleDir = HERE } = {}) {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    (name === undefined ? io.stderr : io.stdout).write(`${USAGE}\n`);
    return name === undefined ? 2 : 0;
  }
  const subcommand = SUBCOMMANDS[name];
  if (!subcommand) {
    io.stderr.write(`orchestration-bench: unknown subcommand ${name}\n\n${USAGE}\n`);
    return 2;
  }
  const path = join(moduleDir, subcommand.module);
  if (!existsSync(path)) {
    io.stderr.write(`orchestration-bench: '${name}' is not built yet: ${subcommand.module} does not exist in scripts/orchestration-bench/\n`);
    return 1;
  }
  const module = await import(pathToFileURL(path).href);
  if (typeof module.main !== "function") {
    io.stderr.write(`orchestration-bench: ${subcommand.module} does not export main(argv, io)\n`);
    return 1;
  }
  const code = await module.main(rest, io);
  if (!Number.isInteger(code)) {
    io.stderr.write(`orchestration-bench: ${name} returned ${String(code)}, not an exit code\n`);
    return 1;
  }
  return code;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const io = { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd(), env: process.env };
  dispatch(process.argv.slice(2), io).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`orchestration-bench: ${error.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
