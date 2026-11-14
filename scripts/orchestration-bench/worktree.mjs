// Clean worktrees for the orchestration benchmark (docs/ORCHESTRATION-BENCH.md).
//
// A check runs in a fresh `git worktree` at a task's commit, never in the
// checkout someone is working in. Dependencies come from
// `pnpm install --frozen-lockfile --prefer-offline`; when a worktree closes,
// its node_modules folders are moved into a cache keyed by the hash of
// pnpm-lock.yaml, and the next worktree with the same lockfile moves them back
// in instead of installing from nothing. The install still runs after a reuse,
// where it finds everything in place and finishes in seconds, so a cached tree
// that went stale is corrected rather than trusted.
//
// Nothing here builds Rust. A check that needs a Rust build asks for it in its
// own command and pays for it in its own timeout.

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

/** How long one git command may take. */
const GIT_TIMEOUT_MS = 120_000;
/** How long `pnpm install` may take, unless the caller says otherwise. */
export const INSTALL_TIMEOUT_SECONDS = 15 * 60;
/** Cached dependency trees kept for other lockfiles; the oldest beyond this are deleted. */
const CACHE_KEEP = 2;
/** Output kept from a command, from its end. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

/** The default folder for the benchmark's worktrees and dependency cache. */
export const defaultWorkRoot = () => join(tmpdir(), "terminalx-orchestration-bench");

/** Runs git in `cwd`; returns stdout (a string, or a Buffer with `{ buffer: true }`). Throws with git's stderr. */
export function git(cwd, args, { buffer = false, env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      encoding: buffer ? undefined : "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    const why = error.code === "ETIMEDOUT" || error.signal === "SIGKILL" ? `timed out after ${timeoutMs / 1000} s` : stderr || error.message;
    throw new Error(`git ${args.join(" ")}: ${why}`);
  }
}

/** The repository's top folder, for any path inside it. */
export const repoRoot = (cwd) => git(cwd, ["rev-parse", "--show-toplevel"]).trim();

/** Whether `rev` names a commit that exists in `repo`. */
export function commitExists(repo, rev) {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * The commit a task's solution stands for. A sha solution is itself; a patch
 * solution is applied to `startCommit` in a private index and written as a
 * commit object (no branch, no working tree touched), so the rest of the
 * benchmark handles both the same way.
 */
export function solutionCommit(repo, task) {
  if (!task.solutionPatch) {
    if (!commitExists(repo, task.solution)) throw new Error(`solution commit ${task.solution} is not in this repository`);
    return git(repo, ["rev-parse", `${task.solution}^{commit}`]).trim();
  }
  const scratch = mkdtempSync(join(tmpdir(), "orchestration-bench-index-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    git(repo, ["read-tree", task.startCommit], { env });
    try {
      git(repo, ["apply", "--cached", "--binary", task.solutionPatch], { env });
    } catch (error) {
      throw new Error(`solution patch ${task.solution} does not apply to ${task.startCommit.slice(0, 12)}: ${error.message}`);
    }
    const tree = git(repo, ["write-tree"], { env }).trim();
    const commitEnv = {
      GIT_AUTHOR_NAME: "orchestration-bench",
      GIT_AUTHOR_EMAIL: "orchestration-bench@invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "orchestration-bench",
      GIT_COMMITTER_EMAIL: "orchestration-bench@invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    return git(repo, ["commit-tree", tree, "-p", task.startCommit, "-m", `orchestration-bench solution for ${task.id}`], { env: commitEnv }).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Runs `command` through /bin/sh in `cwd` with a hard timeout. The command
 * gets its own process group, which is killed when the time runs out and
 * again once it exits, so nothing it started outlives it.
 *
 * Resolves `{ exitCode, signal, timedOut, seconds, output }`; `output` is the
 * end of stdout and stderr together.
 */
export function runCommand(command, { cwd, timeoutSeconds, env }) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("runCommand needs an explicit timeoutSeconds");
  const started = process.hrtime.bigint();
  return new Promise((done) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: { ...process.env, CI: "1", ...env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = Buffer.alloc(0);
    const keep = (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > OUTPUT_TAIL_BYTES * 2) output = output.subarray(output.length - OUTPUT_TAIL_BYTES);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutSeconds * 1000);
    let settled = false;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const tail = output.subarray(Math.max(0, output.length - OUTPUT_TAIL_BYTES)).toString("utf8");
      done({ exitCode, signal, timedOut, seconds, output: tail });
    };
    child.on("error", (error) => {
      keep(Buffer.from(`\n${error.message}\n`));
      finish(null, null);
    });
    child.on("exit", (exitCode, signal) => {
      // Give the pipes a moment to drain, but not forever: a grandchild that
      // escaped the group could hold them open.
      const drain = setTimeout(() => finish(exitCode, signal), 2000);
      child.on("close", () => {
        clearTimeout(drain);
        finish(exitCode, signal);
      });
    });
  });
}

/** sha256 of the worktree's pnpm-lock.yaml, or null when it has none. */
function lockHash(dir) {
  const lock = join(dir, "pnpm-lock.yaml");
  if (!existsSync(lock) || !existsSync(join(dir, "package.json"))) return null;
  return createHash("sha256").update(readFileSync(lock)).digest("hex");
}

/** node_modules folders of the worktree and its workspace packages, as paths relative to it. */
function nodeModulesDirs(dir) {
  const found = [];
  const walk = (folder, depth) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(folder, entry.name);
      if (entry.name === "node_modules") found.push(relative(dir, path));
      else if (depth < 3 && !entry.name.startsWith(".") && entry.name !== "target" && entry.name !== "dist") walk(path, depth + 1);
    }
  };
  walk(dir, 0);
  return found;
}

/** Moves a cached dependency tree into `dir`. True when one was there to take. */
function takeCachedTree(cacheRoot, hash, dir) {
  const cached = join(cacheRoot, hash);
  const claimed = join(cacheRoot, `.claimed-${hash}-${randomBytes(4).toString("hex")}`);
  try {
    // A rename is atomic, so two benchmark processes never take the same tree.
    renameSync(cached, claimed);
  } catch {
    return false;
  }
  try {
    for (const path of nodeModulesDirs(claimed)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      renameSync(join(claimed, path), join(dir, path));
    }
    return true;
  } catch {
    for (const path of nodeModulesDirs(dir)) rmSync(join(dir, path), { recursive: true, force: true });
    return false;
  } finally {
    rmSync(claimed, { recursive: true, force: true });
  }
}

/** Moves `dir`'s node_modules folders into the cache under `hash`; deletes them when that cannot be done. */
function keepTree(cacheRoot, hash, dir) {
  const dirs = nodeModulesDirs(dir);
  if (!dirs.length) return;
  mkdirSync(cacheRoot, { recursive: true });
  const staging = join(cacheRoot, `.staging-${randomBytes(4).toString("hex")}`);
  try {
    for (const path of dirs) {
      mkdirSync(dirname(join(staging, path)), { recursive: true });
      renameSync(join(dir, path), join(staging, path));
    }
    renameSync(staging, join(cacheRoot, hash));
  } catch {
    // Another worktree already cached this lockfile, or the cache is on another disk.
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  pruneCache(cacheRoot, hash);
}

function pruneCache(cacheRoot, current) {
  let entries;
  try {
    entries = readdirSync(cacheRoot).map((name) => ({ name, path: join(cacheRoot, name), mtime: statSync(join(cacheRoot, name)).mtimeMs }));
  } catch {
    return;
  }
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of entries) if (entry.name.startsWith(".") && entry.mtime < dayAgo) rmSync(entry.path, { recursive: true, force: true });
  const trees = entries.filter((entry) => !entry.name.startsWith(".") && entry.name !== current).sort((a, b) => b.mtime - a.mtime);
  for (const entry of trees.slice(CACHE_KEEP - 1)) rmSync(entry.path, { recursive: true, force: true });
}

/**
 * Installs the worktree's dependencies when it has a pnpm lockfile. Returns
 * `{ install: "none" | "fresh" | "reused", seconds }`; throws when the install
 * fails or runs out of time.
 */
async function installDependencies(worktree) {
  const hash = lockHash(worktree.dir);
  worktree.lockHash = hash;
  if (!hash) return { install: "none", seconds: 0 };
  const reused = takeCachedTree(worktree.cacheRoot, hash, worktree.dir);
  const result = await runCommand("pnpm install --frozen-lockfile --prefer-offline", { cwd: worktree.dir, timeoutSeconds: worktree.installTimeoutSeconds });
  if (result.timedOut) throw new Error(`pnpm install did not finish in ${worktree.installTimeoutSeconds} s`);
  if (result.exitCode !== 0) throw new Error(`pnpm install failed (exit ${result.exitCode ?? result.signal}):\n${result.output.slice(-4000)}`);
  return { install: reused ? "reused" : "fresh", seconds: result.seconds };
}

/**
 * A detached worktree of `repo` at `commit`, with its dependencies installed
 * unless `install` is false. Close it with `closeWorktree`, or use
 * `withWorktree`, which always does.
 *
 * Returns `{ dir, commit, install, installSeconds, ... }`.
 */
export async function openWorktree({ repo, commit, label = "task", workRoot = defaultWorkRoot(), install = true, installTimeoutSeconds = INSTALL_TIMEOUT_SECONDS }) {
  const worktreesRoot = join(workRoot, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  const holder = mkdtempSync(join(worktreesRoot, `${label}-`));
  const worktree = { repo, holder, dir: join(holder, "repo"), commit, cacheRoot: join(workRoot, "node-modules"), installTimeoutSeconds, install: "none", installSeconds: 0, lockHash: null };
  try {
    git(repo, ["worktree", "add", "--detach", "--quiet", worktree.dir, commit]);
    if (install) {
      const done = await installDependencies(worktree);
      worktree.install = done.install;
      worktree.installSeconds = done.seconds;
    }
    return worktree;
  } catch (error) {
    closeWorktree(worktree);
    throw error;
  }
}

/**
 * Moves the worktree to `commit`, dropping everything the last check left
 * behind except ignored files (such as node_modules), and reinstalls when the
 * lockfile changed. Returns how long any reinstall took, in seconds.
 */
export async function moveWorktree(worktree, commit, { install = true } = {}) {
  git(worktree.dir, ["reset", "--hard", "--quiet", "HEAD"]);
  git(worktree.dir, ["clean", "-fdq"]);
  git(worktree.dir, ["checkout", "--quiet", "--detach", commit]);
  worktree.commit = commit;
  if (!install || lockHash(worktree.dir) === worktree.lockHash) return 0;
  const done = await installDependencies(worktree);
  return done.seconds;
}

/** Removes the worktree, keeping its dependency tree in the cache. Safe to call twice and after a failed open. */
export function closeWorktree(worktree) {
  if (worktree.closed) return;
  worktree.closed = true;
  try {
    if (worktree.lockHash && existsSync(worktree.dir) && lockHash(worktree.dir) === worktree.lockHash) keepTree(worktree.cacheRoot, worktree.lockHash, worktree.dir);
  } finally {
    try {
      git(worktree.repo, ["worktree", "remove", "--force", "--force", worktree.dir]);
    } catch {
      // Removed below; prune drops git's record of it.
    }
    rmSync(worktree.holder, { recursive: true, force: true });
    try {
      git(worktree.repo, ["worktree", "prune"]);
    } catch {
      // Nothing to prune.
    }
  }
}

/** Opens a worktree, passes it to `fn`, and closes it whatever `fn` does. */
export async function withWorktree(options, fn) {
  const worktree = await openWorktree(options);
  try {
    return await fn(worktree);
  } finally {
    closeWorktree(worktree);
  }
}

/**
 * Writes a task's check files into the worktree from `commit` (the solution),
 * with their file modes, so a check sees the tests the agent never did.
 */
export function copyCheckFiles(worktree, commit, files) {
  for (const file of files) {
    const listed = git(worktree.repo, ["ls-tree", commit, "--", file]).trim();
    const match = /^(\d{6}) blob [0-9a-f]+\t/.exec(listed);
    if (!match || match[1] === "120000") throw new Error(`check file ${file} is not a file in the solution ${commit.slice(0, 12)}`);
    const target = join(worktree.dir, file);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    writeFileSync(target, git(worktree.repo, ["cat-file", "blob", `${commit}:${file}`], { buffer: true }));
    chmodSync(target, match[1] === "100755" ? 0o755 : 0o644);
  }
}
