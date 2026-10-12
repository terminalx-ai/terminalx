import type { EnvironmentProposal } from "@/lib/environmentProposal";
import { RECIPE_CHECK_KINDS, type RecipeCheck, type RecipeCheckKind, type RecipeObservations } from "@/lib/organizationEnvironment";

// Verification for "Configure with an agent" (PRO-20). The results a recipe
// carries are not taken from the agent's word: each command is run again here
// and how it ended is recorded.
//
// For every repository the branch is fetched fresh from GitHub into a new
// directory. Nothing is taken from the agent's own checkout, so a commit the
// agent made and did not push, or a file it edited, is not in what is checked;
// whether its checkout differs from the remote is recorded and shown. Then
// the proposed setup steps run, then lint, test, build and start, each on its
// own. A check that fails is run once more in a second copy with none of the
// recipe's setup; whether it fails there too is recorded as observed. It is a
// failure either way.
//
// What this is not: independent of the agent. It runs on the machine the
// agent has just worked on, as the same user, so tools the agent installed by
// hand are there too. A result that owes nothing to the agent comes only
// from building a version. The screen says so.
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
  /** Workspace-relative directory of the agent's checkout of each repository, by `owner/name` in lower case. Only compared with the remote, never built from. */
  directories: Record<string, string>;
  /** Where a repository is fetched from. GitHub, except in tests. */
  remoteUrl?: (owner: string, name: string) => string;
  /** When to stop starting new commands (the preparation workspace's own limit, with a margin). */
  deadline: number;
  now?: () => number;
  /** Reads back a small file a script wrote under the scratch directory; null when it is not there. */
  readScratch: (name: string) => Promise<string | null>;
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

const BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;

/**
 * The branch as GitHub has it now, fetched into a new directory, and the
 * commit that was fetched written to `<target>.commit`. The agent's checkout
 * is not read: neither its objects, its refs nor its remote configuration.
 */
export function fetchScript(url: string, branch: string, target: string): string {
  return `${PREAMBLE}
rm -rf "$V/${target}" "$V/${target}.commit"
git init --quiet "$V/${target}" || exit 96
cd "$V/${target}" || exit 96
GIT_TERMINAL_PROMPT=0 git fetch --quiet --depth 1 ${quote(url)} ${quote(`refs/heads/${branch}`)} || exit 95
git checkout --quiet --detach FETCH_HEAD || exit 96
git rev-parse HEAD > "$V/${target}.commit"`;
}

/** A second copy of what was fetched, for running a failed check without the recipe's setup. */
export function copyScript(source: string, target: string): string {
  return `${PREAMBLE}\nrm -rf "$V/${target}"\ncp -R "$V/${source}" "$V/${target}"`;
}

/**
 * What the agent's own checkout looks like, written to `<output>`: its HEAD,
 * then how many files differ from it. The agent's proposal file is its to
 * write and is not counted.
 */
export function inspectScript(directory: string, output: string): string {
  return `${PREAMBLE}
cd "$ROOT"/${quote(directory)} || exit 97
{ git rev-parse HEAD; git status --porcelain --untracked-files=all | grep -v -c -F ' .terminalx/environment-recipe.json'; } > "$V/${output}"
exit 0`;
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

/** Where the checked copy of a repository came from, and whether the agent's own copy matches it. */
export interface VerifiedSource {
  owner: string;
  name: string;
  branch: string;
  /** The commit GitHub had on the branch, which is what was checked. Null when it could not be fetched. */
  commit: string | null;
  /**
   * `same`: the agent's checkout is at that commit with no changed files.
   * `differs`: it has commits or changes of its own; they were not checked.
   * `unknown`: its checkout could not be read.
   */
  agentCheckout: "same" | "differs" | "unknown";
}

export interface Verification {
  observations: RecipeObservations;
  sources: VerifiedSource[];
}
const blank = (kind: RecipeCheckKind, command: string, status: "skipped" | "not-run"): RecipeCheck => ({ kind, command, status, exitCode: null, durationMs: null, preexisting: false });

/**
 * Runs the proposal and returns what was observed. It never throws for a
 * failing command; it throws only when it is aborted. Whatever it could not
 * get to before the deadline is reported `not-run`.
 */
export async function verifyProposal(proposal: EnvironmentProposal, run: RunScript, options: VerificationOptions): Promise<Verification> {
  const remoteUrl = options.remoteUrl ?? ((owner: string, name: string) => `https://github.com/${owner}/${name}.git`);
  const sources: VerifiedSource[] = [];
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
    const fetched = `source-${slug(repository.owner, repository.name)}`;
    const after = `after-${slug(repository.owner, repository.name)}`;
    const before = `before-${slug(repository.owner, repository.name)}`;
    const checks = new Map<RecipeCheckKind, RecipeCheck>();
    const notRun = () => {
      for (const kind of RECIPE_CHECK_KINDS) if (!checks.has(kind)) checks.set(kind, blank(kind, commands[kind], commands[kind] ? "not-run" : kind === "install" && definition.setup.length ? "not-run" : "skipped"));
    };
    const finish = (commit: string | null) => repositories.push({ owner: repository.owner, name: repository.name, commit, checks: RECIPE_CHECK_KINDS.map((kind) => checks.get(kind)!) });

    options.onProgress?.(`Fetching ${label} from GitHub`);
    const source: VerifiedSource = { owner: repository.owner, name: repository.name, branch: definition.defaultBranch, commit: null, agentCheckout: "unknown" };
    sources.push(source);
    const fetchedRun = BRANCH.test(definition.defaultBranch) ? await guarded(fetchScript(remoteUrl(repository.owner, repository.name), definition.defaultBranch, fetched), CLONE_TIMEOUT_MS) : null;
    const head = fetchedRun?.exitCode === 0 ? ((await options.readScratch(`${fetched}.commit`))?.trim() ?? "") : "";
    const commit = /^[a-f0-9]{40}$/.test(head) ? head : null;
    // Without the commit GitHub served there is nothing trustworthy to check.
    if (!commit || (await guarded(copyScript(fetched, after), CLONE_TIMEOUT_MS))?.exitCode !== 0) {
      notRun();
      finish(null);
      continue;
    }
    source.commit = commit;
    if (directory !== undefined && (await guarded(inspectScript(directory, `${fetched}.agent`), 60_000))?.exitCode === 0) {
      const [agentHead, changed] = ((await options.readScratch(`${fetched}.agent`)) ?? "").trim().split("\n");
      if (/^[a-f0-9]{40}$/.test(agentHead ?? "") && /^\d+$/.test(changed ?? "")) source.agentCheckout = agentHead === commit && changed === "0" ? "same" : "differs";
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

    // A failure is run again without any of the recipe's setup, and whether
    // it fails there too is recorded. That is an observation, not a verdict
    // on whose fault it is.
    const failing = (["lint", "test", "build", "start"] as const).filter((kind) => failed(checks.get(kind)!));
    if (failing.length) {
      options.onProgress?.(`${label}: checking failures without the recipe`);
      const base = await guarded(copyScript(fetched, before), CLONE_TIMEOUT_MS);
      if (base?.exitCode === 0)
        for (const kind of failing) {
          const result = await guarded(commandScript(before, ".", commands[kind], kind === "start" ? START_SECONDS : undefined), COMMAND_TIMEOUT_MS);
          if (result && failed(outcomeOf(result))) checks.set(kind, { ...checks.get(kind)!, preexisting: true });
        }
    }
    notRun();
    finish(commit);
  }
  return { observations: { observedBy: "verification", machine, repositories }, sources };
}

/** Removes what verification left in the workspace. */
export const cleanupScript = `rm -rf "$PWD/${SCRATCH_DIRECTORY}"`;
