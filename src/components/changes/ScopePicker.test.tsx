import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitSource } from "@/lib/gitSource";
import type { CommitInfo } from "@/types/session";
import { ScopePicker } from "./ScopePicker";

let cwd: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const commit = (subject: string) => git("commit", "--allow-empty", "-m", subject);
let source: GitSource;
const props = () => ({
  source, choice: { scope: "all" as const, target: null, commit: null }, onChoose: vi.fn(),
  checkpoints: [], showTurn: false, live: false, currentBranch: "feature",
  target: "main", onPickTarget: vi.fn(), hideWhitespace: false,
  open: true, onOpenChange: vi.fn(),
});

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "scope-picker-"));
  git("init", "-b", "main");
  git("config", "user.name", "Scope test");
  git("config", "user.email", "scope@example.test");
  git("config", "commit.gpgsign", "false");
  for (let i = 0; i < 4; i++) commit(`Main commit ${i}`);
  git("checkout", "-b", "feature");
  source = {
    key: cwd,
    reviewRange: vi.fn(async (target: string | null, uncommitted: boolean) => {
      const resolved = uncommitted ? "HEAD" : target ?? "main";
      const base = git("merge-base", "HEAD", resolved);
      return { target: resolved, base: git("rev-parse", `${base}^{tree}`), head: git("rev-parse", "HEAD^{tree}") };
    }),
    changesBetween: vi.fn(async () => []),
    // Exercise the real Git revision semantics at the caller boundary. In
    // particular, all these empty commits share a tree but have distinct IDs.
    logCommits: vi.fn(async (range: string | null, limit: number): Promise<CommitInfo[]> => {
      const output = git("log", `-n${limit}`, "--format=%H%x09%s", ...(range ? [range] : []), "--");
      return output ? output.split("\n").map((line) => {
        const [sha, subject] = line.split("\t");
        return { sha, shortSha: sha.slice(0, 7), subject, body: "", author: "Scope test", email: "scope@example.test", date: "", parent: null, tree: "" };
      }) : [];
    }),
  } as unknown as GitSource;
});
afterEach(() => { cleanup(); rmSync(cwd, { recursive: true, force: true }); });

it("lists only the one branch commit above several main commits and selects its full SHA", async () => {
  commit("Branch change");
  const p = props();
  render(<ScopePicker {...p} />);
  fireEvent.click(await screen.findByRole("button", { name: /Branch change/ }));
  expect(source.logCommits).toHaveBeenCalledWith("main..HEAD", 8);
  expect(screen.queryByText(/Main commit/)).toBeNull();
  expect(p.onChoose).toHaveBeenCalledWith({ scope: "commit", target: null, commit: git("rev-parse", "HEAD") });
});

it("shows an empty state when the branch has no commits beyond the target", async () => {
  render(<ScopePicker {...props()} />);
  expect(await screen.findByText("No commits ahead of main.")).toBeTruthy();
  expect(screen.queryByText(/Main commit/)).toBeNull();
  expect(screen.getByRole("button", { name: /All commits/ })).toBeTruthy();
});

it("limits a longer branch to its latest eight commits", async () => {
  for (let i = 0; i < 10; i++) commit(`Branch change ${i}`);
  render(<ScopePicker {...props()} />);
  await screen.findByText("Branch change 9");
  expect(screen.getAllByText(/Branch change/)).toHaveLength(8);
  expect(screen.getByText("Latest 8 commits")).toBeTruthy();
  expect(screen.queryByText("Branch change 1")).toBeNull();
  expect(screen.queryByText(/Main commit/)).toBeNull();
});

it("reloads for a selected base and clears the old list while resolving it", async () => {
  commit("Branch change");
  git("branch", "release");
  const p = props();
  const view = render(<ScopePicker {...p} />);
  await screen.findByText("Branch change");
  let resolve!: (range: { target: string; base: string; head: string }) => void;
  vi.mocked(source.reviewRange).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  view.rerender(<ScopePicker {...p} choice={{ scope: "all", target: "release", commit: null }} target="release" />);
  expect(screen.queryByText("Branch change")).toBeNull();
  expect(screen.getByText("Loading commits…")).toBeTruthy();
  await act(async () => resolve({ target: "release", base: "tree", head: "tree" }));
  expect(await screen.findByText("No commits ahead of release.")).toBeTruthy();
  expect(source.logCommits).toHaveBeenLastCalledWith("release..HEAD", 8);
});

it("reports an unresolved base without falling back to unbounded history", async () => {
  vi.mocked(source.reviewRange).mockRejectedValueOnce(new Error("Missing base"));
  render(<ScopePicker {...props()} />);
  expect(await screen.findByText("Could not load branch commits.")).toBeTruthy();
  expect(source.logCommits).not.toHaveBeenCalled();
});
