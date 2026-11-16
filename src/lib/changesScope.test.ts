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

it("restores a checkpoint identity without persisting its trees or crossing workspace boundaries", () => {
  const choice = { scope: "checkpoint" as const, target: "release", commit: null, checkpoint: JSON.stringify(["session", "tab", 7]) };
  saveChangesChoice("repo", choice);
  expect(readChangesChoice("repo")).toEqual(choice);
  expect(readChangesChoice("another").scope).toBe("all");
});

it("numbers turns, names them by their prompt cut at a word, and keeps when each was taken (PRO-393)", async () => {
  const { checkpointChoices, turnName } = await import("./changesScope");
  const ev = (seq: number, payload: object, ts = "") => ({ id: `e${seq}`, sessionId: "s", tabId: "t", harness: "codex", seq, ts, payload }) as never;
  const choices = checkpointChoices([
    ev(1, { type: "user_message", text: "Publish   the layouts", queued: false }), ev(2, { type: "turn_checkpoint", seq: 1, base: "b1", head: "h1" }, "2026-11-16T10:00:00Z"),
    ev(3, { type: "user_message", text: "Group the overview table by status and let people sort by any column. Remember the sort.", queued: false }), ev(4, { type: "turn_checkpoint", seq: 3, base: "b2", head: "h2" }, "2026-11-16T10:20:00Z"),
    ev(5, { type: "user_message", text: "Hide the Agent column", queued: false }), ev(6, { type: "turn_checkpoint", seq: 5, base: "b3", head: "h3" }),
  ]);
  expect(choices.map((c) => c.label)).toEqual(["Latest turn · Hide the Agent column", "Turn 2 · Group the overview table by status and let…", "Turn 1 · Publish the layouts"]);
  expect(choices.map((c) => c.at)).toEqual([null, "2026-11-16T10:20:00Z", "2026-11-16T10:00:00Z"]);
  expect(choices[1].prompt).toBe("Group the overview table by status and let people sort by any column. Remember the sort.");
  expect(turnName("a".repeat(60))).toBe(`${"a".repeat(48)}…`);
});
