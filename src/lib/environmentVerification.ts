import type { EnvironmentProposal } from "@/lib/environmentProposal";
import { RECIPE_CHECK_KINDS, type RecipeCheck, type RecipeCheckKind, type RecipeObservations } from "@/lib/organizationEnvironment";

// Verification for "Configure with an agent" (PRO-20). The results a recipe
// carries are not taken from the agent's word: each command is run again here,
// in a fresh clone the agent never touched, and how it ended is recorded.
//
// For every repository: clone the agent's checkout, run the proposed setup
// steps, then lint, test, build and start, each on its own. A check that
// fails is run once more in a second clone with none of the recipe's setup;
// if it fails there too it is marked as already failing before the recipe.
// It is still a failure either way.
//
// This module only decides what to run and what each ending means. Running a
// script inside the workspace is the caller's (`RunScript`).

/** How one script ended. `exitCode` is null when it was cut off or its ending was not seen. */
export interface ScriptRun {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

/** Runs a bash script from the workspace root and reports how it ended. */
export type RunScript = (script: string, timeoutMs: number) => Promise<ScriptRun>;

export interface VerificationOptions {
  /** Workspace-relative directory of each repository's checkout, by `owner/name` in lower case. */
  directories: Record<string, string>;
  /** When to stop starting new commands (the preparation workspace's own limit, with a margin). */
  deadline: number;
  now?: () => number;
  /** Reads back a small file a script wrote under the scratch directory; null when it is not there. */
  readScratch?: (name: string) => Promise<string | null>;
  onProgress?: (step: string) => void;
  signal?: AbortSignal;
}

export const SCRATCH_DIRECTORY = ".terminalx-verify";
export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const MACHINE_TIMEOUT_MS = 15 * 60 * 1000;
/** An application that is still running after this long counts as started. */
export const START_SECONDS = 30;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const slug = (owner: string, name: string) => `${owner}-${name}`.replace(/[^A-Za-z0-9._-]/g, "_");

let delimiterSeq = 0;
// The body is written to a file through a quoted heredoc, so nothing in it is
// expanded or can end the outer script early.
function fileFrom(path: string, body: string): string {
  let delimiter = `TERMINALX_EOF_${++delimiterSeq}`;
  while (body.includes(delimiter)) delimiter = `TERMINALX_EOF_${++delimiterSeq}_${delimiter.length}`;
  return `cat > ${path} <<'${delimiter}'\n${body}\n${delimiter}`;
}

const PREAMBLE = `ROOT="$PWD"\nV="$ROOT/${SCRATCH_DIRECTORY}"\nmkdir -p "$V"`;

/** The machine install script, as root where the shell can become root without asking. */
export function machineScript(installScript: string): string {
  return `${PREAMBLE}
${fileFrom('"$V/machine.sh"', installScript)}
cd /
if [ "$(id -u)" = 0 ]; then bash -euo pipefail "$V/machine.sh"
elif sudo -n true 2>/dev/null; then sudo -n bash -euo pipefail "$V/machine.sh"
else bash -euo pipefail "$V/machine.sh"
fi`;
}

/** A fresh clone of the agent's checkout at its current commit, without its uncommitted files. */
export function cloneScript(directory: string, target: string): string {
  return `${PREAMBLE}
rm -rf "$V/${target}"
git clone --quiet --no-hardlinks "$ROOT"/${quote(directory)} "$V/${target}"`;
}

export function commitScript(directory: string, output: string): string {
  return `${PREAMBLE}\ngit -C "$ROOT"/${quote(directory)} rev-parse HEAD > "$V/${output}"`;
}

/** One command or setup step inside a clone. `seconds` bounds a command that is expected to keep running. */
export function commandScript(target: string, workingDirectory: string, command: string, seconds?: number): string {
  const run = seconds
    ? // Still running when the time is up means it started: that is the pass.
      `timeout ${seconds} bash -eo pipefail "$V/command.sh"\ncode=$?\nif [ "$code" = 124 ]; then exit 0; fi\nexit "$code"`
    : `bash -eo pipefail "$V/command.sh"`;
  return `${PREAMBLE}
${fileFrom('"$V/command.sh"', command)}
cd "$V/${target}"/${quote(workingDirectory)} || exit 97
${run}`;
}

type Outcome = Pick<RecipeCheck, "status" | "exitCode" | "durationMs">;

/** What an ending means. A non-zero exit is never anything but a failure. */
export function outcomeOf(run: ScriptRun): Outcome {
  const durationMs = Math.max(0, Math.round(run.durationMs));
  if (run.timedOut) return { status: "timed-out", exitCode: null, durationMs };
  // The terminal went away without saying how the command ended: not a pass, and not a known failure.
  if (run.exitCode === null) return { status: "not-run", exitCode: null, durationMs: null };
  return run.exitCode === 0 ? { status: "passed", exitCode: 0, durationMs } : { status: "failed", exitCode: Math.min(Math.max(run.exitCode, 1), 255), durationMs };
}

const failed = (outcome: Outcome) => outcome.status === "failed" || outcome.status === "timed-out";
const blank = (kind: RecipeCheckKind, command: string, status: "skipped" | "not-run"): RecipeCheck => ({ kind, command, status, exitCode: null, durationMs: null, preexisting: false });

/**
 * Runs the proposal and returns what was observed. It never throws for a
 * failing command; it throws only when it is aborted. Whatever it could not
 * get to before the deadline is reported `not-run`.
 */
export async function verifyProposal(proposal: EnvironmentProposal, run: RunScript, options: VerificationOptions): Promise<RecipeObservations> {
  const now = options.now ?? Date.now;
  const outOfTime = () => now() >= options.deadline;
  const guarded = async (script: string, timeoutMs: number): Promise<ScriptRun | null> => {
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (outOfTime()) return null;
    const result = await run(script, Math.max(1000, Math.min(timeoutMs, options.deadline - now())));
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return result;
  };

  let machine: RecipeObservations["machine"] = null;
  if (proposal.definition.installScript.trim()) {
    options.onProgress?.("Running the machine install script");
    const result = await guarded(machineScript(proposal.definition.installScript), MACHINE_TIMEOUT_MS);
    machine = result ? outcomeOf(result) : { status: "not-run", exitCode: null, durationMs: null };
  }

  const repositories: RecipeObservations["repositories"] = [];
  for (const [index, repository] of proposal.repositories.entries()) {
    const label = `${repository.owner}/${repository.name}`;
    const directory = options.directories[label.toLowerCase()];
    const definition = proposal.definition.repositories[index];
    const commands = repository.commands;
    const after = `after-${slug(repository.owner, repository.name)}`;
    const before = `before-${slug(repository.owner, repository.name)}`;
    const checks = new Map<RecipeCheckKind, RecipeCheck>();
    const notRun = () => {
      for (const kind of RECIPE_CHECK_KINDS) if (!checks.has(kind)) checks.set(kind, blank(kind, commands[kind], commands[kind] ? "not-run" : kind === "install" && definition.setup.length ? "not-run" : "skipped"));
    };
    const finish = (commit: string | null) => repositories.push({ owner: repository.owner, name: repository.name, commit, checks: RECIPE_CHECK_KINDS.map((kind) => checks.get(kind)!) });

    options.onProgress?.(`Cloning ${label}`);
    const cloned = directory === undefined ? null : await guarded(cloneScript(directory, after), CLONE_TIMEOUT_MS);
    if (!cloned || cloned.exitCode !== 0) {
      notRun();
      finish(null);
      continue;
    }
    let commit: string | null = null;
    if (options.readScratch && (await guarded(commitScript(directory!, `${after}.commit`), 60_000))?.exitCode === 0) {
      const head = (await options.readScratch(`${after}.commit`))?.trim() ?? "";
      commit = /^[a-f0-9]{40}$/.test(head) ? head : null;
    }

    // Install: the proposed setup steps, in order, then the install command
    // when it is not already one of them. The first failure is the result.
    const installSteps = [
      ...definition.setup.map((step) => ({ workingDirectory: step.workingDirectory, script: step.script })),
      ...(commands.install && !definition.setup.some((step) => step.script.trim() === commands.install) ? [{ workingDirectory: ".", script: commands.install }] : []),
    ];
    const installCommand = commands.install || definition.setup.map((step) => step.script.trim()).join(" && ").slice(0, 2000);
    if (!installSteps.length) checks.set("install", blank("install", "", "skipped"));
    else {
      options.onProgress?.(`Setting up ${label}`);
      let total = 0;
      let outcome: Outcome | null = null;
      for (const step of installSteps) {
        const result = await guarded(commandScript(after, step.workingDirectory, step.script), COMMAND_TIMEOUT_MS);
        if (!result) {
          outcome = null;
          break;
        }
        total += result.durationMs;
        outcome = outcomeOf({ ...result, durationMs: total });
        if (outcome.status !== "passed") break;
      }
      checks.set("install", outcome ? { kind: "install", command: installCommand, ...outcome, preexisting: false } : blank("install", installCommand, "not-run"));
    }

    for (const kind of ["lint", "test", "build", "start"] as const) {
      const command = commands[kind];
      if (!command) {
        checks.set(kind, blank(kind, "", "skipped"));
        continue;
      }
      options.onProgress?.(`${label}: ${kind}`);
      const seconds = kind === "start" ? START_SECONDS : undefined;
      const result = await guarded(commandScript(after, ".", command, seconds), COMMAND_TIMEOUT_MS);
      if (!result) {
        checks.set(kind, blank(kind, command, "not-run"));
        continue;
      }
      checks.set(kind, { kind, command, ...outcomeOf(result), preexisting: false });
    }

    // A failure is run again without any of the recipe's setup. Failing
    // there too, it was failing before the recipe.
    const failing = (["lint", "test", "build", "start"] as const).filter((kind) => failed(checks.get(kind)!));
    if (failing.length) {
      options.onProgress?.(`${label}: checking failures without the recipe`);
      const base = await guarded(cloneScript(directory!, before), CLONE_TIMEOUT_MS);
      if (base?.exitCode === 0)
        for (const kind of failing) {
          const result = await guarded(commandScript(before, ".", commands[kind], kind === "start" ? START_SECONDS : undefined), COMMAND_TIMEOUT_MS);
          if (result && failed(outcomeOf(result))) checks.set(kind, { ...checks.get(kind)!, preexisting: true });
        }
    }
    notRun();
    finish(commit);
  }
  return { observedBy: "verification", machine, repositories };
}

/** Removes what verification left in the workspace. */
export const cleanupScript = `rm -rf "$PWD/${SCRATCH_DIRECTORY}"`;
