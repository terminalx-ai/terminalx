import { afterEach, expect, it, vi } from "vitest";
import { commitRange, EMPTY_TREE, readChangesChoice, saveChangesChoice } from "./changesScope";
import type { GitSource } from "./gitSource";

const sha = "a".repeat(40), parent = "b".repeat(40);
const commit = { sha, parent, shortSha: sha.slice(0, 7), subject: "One change", tree: "commit-tree" };
afterEach(() => localStorage.clear());

it("persists commit scope and target by workspace and migrates previous scope preferences", () => {
  const choice = { scope: "commit" as const, target: "origin/main", commit: sha };
  saveChangesChoice("repo", choice);
  expect(readChangesChoice("repo")).toEqual(choice);
  expect(readChangesChoice("other")).toEqual({ scope: "all", target: null, commit: null });
  localStorage.setItem("changes-scope:repo", JSON.stringify({ scope: "turn", target: "release" }));
  expect(readChangesChoice("repo")).toEqual({ scope: "turn", target: "release", commit: null });
  localStorage.setItem("changes-scope:repo", JSON.stringify({ scope: "commit", commit: "--all" }));
  expect(readChangesChoice("repo").commit).toBeNull();
  localStorage.setItem("changes-scope:repo", "malformed");
  expect(readChangesChoice("repo").scope).toBe("all");
});

it("compares a commit's tree to its first parent's tree, never to the live workspace", async () => {
  const logCommits = vi.fn(async (id: string) => id === sha ? [commit] : [{ sha: parent, tree: "parent-tree" }]);
  const source = { logCommits } as unknown as GitSource;
  expect(await commitRange(source, sha)).toEqual({ base: "parent-tree", head: "commit-tree", target: `${sha.slice(0, 7)} · One change` });
  expect(logCommits.mock.calls).toEqual([[sha, 1], [parent, 1]]);
});

it("uses the empty tree for a root commit and fails visibly for missing history", async () => {
  const logCommits = vi.fn().mockResolvedValueOnce([{ ...commit, parent: null }]);
  const source = { logCommits } as unknown as GitSource;
  expect((await commitRange(source, sha)).base).toBe(EMPTY_TREE);
  logCommits.mockResolvedValueOnce([commit]).mockResolvedValueOnce([]);
  await expect(commitRange(source, sha)).rejects.toThrow("parent of this commit is unavailable");
  logCommits.mockResolvedValueOnce([]);
  await expect(commitRange(source, sha)).rejects.toThrow("commit is unavailable");
  logCommits.mockClear();
  await expect(commitRange(source, "--all")).rejects.toThrow("Invalid commit ID");
  expect(logCommits).not.toHaveBeenCalled();
});
