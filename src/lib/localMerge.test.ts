// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { localMergePrompt } from "./localMerge";

it("names the worktree, local base and main checkout, and keeps conflict reporting before abort", () => {
  const prompt = localMergePrompt("/repo/worktree", "feature", "develop", "/repo/main");
  expect(prompt).toContain('worktree "/repo/worktree" on branch "feature"');
  expect(prompt).toContain('local base branch "develop" in the main checkout "/repo/main"');
  expect(prompt).toContain("Commit only the worktree's changes");
  expect(prompt).toContain("including untracked files");
  expect(prompt).toContain("merge, rebase, cherry-pick or revert in progress");
  expect(prompt.indexOf("diff --name-only --diff-filter=U")).toBeLessThan(prompt.indexOf("merge --abort"));
  expect(prompt).toContain("list the conflicting files in chat");
  expect(prompt).toContain("Do not resolve conflicts, retry the merge, reset, or discard changes");
  expect(prompt).toContain("Leave the worktree and branch in place");
});

it("the prompt's commands protect local files, merge the named branch, and abort conflicts", () => {
  const root = mkdtempSync(join(tmpdir(), "pro204-"));
  const main = join(root, "main's $(false) checkout");
  const worktree = join(root, "worktree");
  const branch = "feature'quote";
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd: string, contents: string) => {
    writeFileSync(join(cwd, "conflict.txt"), contents);
    git(cwd, "add", ".");
    git(cwd, "-c", "commit.gpgsign=false", "commit", "-qm", contents);
  };
  try {
    execFileSync("git", ["init", "-q", "-b", "develop", main]);
    git(main, "config", "user.name", "Test");
    git(main, "config", "user.email", "test@example.com");
    git(main, "config", "commit.gpgsign", "false");
    commit(main, "initial\n");
    git(main, "branch", "parking");
    git(main, "worktree", "add", "-qb", branch, worktree);
    commit(worktree, "first\n");
    git(main, "tag", branch, "HEAD"); // A same-named tag must not replace the worktree branch.
    const prompt = localMergePrompt(worktree, branch, "develop", main);
    const merge = prompt.match(/\nRun (.+?)\. If the merge conflicts/)![1];
    const list = prompt.match(/record every conflicted file with (.+?), then run/)![1];
    const abort = prompt.match(/then run (.+?)\. Verify the abort/)![1];
    const switchBase = prompt.match(/local base branch with (.+?); if the branch/)![1];
    const shell = (command: string) => spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    expect(shell(merge).status).toBe(0);
    expect(git(main, "rev-parse", "HEAD")).toBe(git(worktree, "rev-parse", "HEAD"));
    // Ignored files look clean to Git but must not be overwritten by a merge.
    writeFileSync(join(main, ".git/info/exclude"), "local.env\n");
    writeFileSync(join(main, "local.env"), "keep local data\n");
    writeFileSync(join(worktree, "local.env"), "branch defaults\n");
    git(worktree, "add", "-f", "local.env");
    git(worktree, "commit", "-qm", "Add local defaults");
    const beforeIgnored = git(main, "rev-parse", "HEAD");
    expect(git(main, "status", "--porcelain")).toBe("");
    expect(shell(merge).status).not.toBe(0);
    expect(git(main, "rev-parse", "HEAD")).toBe(beforeIgnored);
    expect(readFileSync(join(main, "local.env"), "utf8")).toBe("keep local data\n");
    expect(readFileSync(join(worktree, "local.env"), "utf8")).toBe("branch defaults\n");
    rmSync(join(main, "local.env"));
    expect(shell(merge).status).toBe(0);
    commit(main, "base changes\n");
    commit(worktree, "worktree changes\n");
    const before = git(main, "rev-parse", "HEAD");
    expect(shell(merge).status).toBe(1);
    expect(shell(list).stdout.trim()).toBe("conflict.txt");
    expect(shell(abort).status).toBe(0);
    expect(git(main, "rev-parse", "HEAD")).toBe(before);
    expect(git(main, "status", "--porcelain")).toBe("");
    expect(git(worktree, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(main, "conflict.txt"), "utf8")).toBe("base changes\n");
    expect(readFileSync(join(worktree, "conflict.txt"), "utf8")).toBe("worktree changes\n");
    expect(spawnSync("git", ["-C", main, "rev-parse", "--verify", "MERGE_HEAD"]).status).not.toBe(0);
    // Switching to the base must protect ignored files before the merge, too.
    git(main, "switch", "-q", "parking");
    writeFileSync(join(main, "local.env"), "keep parked data\n");
    expect(shell(switchBase).status).not.toBe(0);
    expect(git(main, "branch", "--show-current")).toBe("parking");
    expect(readFileSync(join(main, "local.env"), "utf8")).toBe("keep parked data\n");
    rmSync(join(main, "local.env"));
    expect(shell(switchBase).status).toBe(0);
    expect(git(main, "branch", "--show-current")).toBe("develop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
