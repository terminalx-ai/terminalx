import { describe, expect, it } from "vitest";
import type { PullRequest } from "@/lib/api";
import type { SourceStatus } from "@/lib/gitSource";
import { agentPrompt, branchPr, composeMachineSnapshot, isGithubRemote, machineActions, machineBranchBase, resolveMachineStep, sameBranchState } from "./machineBranchStep";

const HEAD = "1".repeat(40);
const REMOTE = "git@github.com:octo/app.git";

function work(patch: Partial<SourceStatus> = {}): SourceStatus {
  return { isRepo: true, dirty: false, branch: "feature", upstream: "origin/feature", ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: 2, head: HEAD, conflicted: [], operation: null, ...patch };
}

function pr(patch: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7, title: "Feature", url: "https://github.com/octo/app/pull/7", state: "OPEN", isDraft: false, base: "main", head: "feature",
    headSha: HEAD, additions: 3, deletions: 1, mergeable: "MERGEABLE", mergeState: "CLEAN", reviewDecision: "APPROVED",
    checks: [{ name: "test", state: "success" }], body: "", author: "octocat", ...patch,
  } as PullRequest;
}

describe("resolveMachineStep (branch_step::resolve over git/1)", () => {
  // The same cases as src-tauri/src/fixtures/branch_step_cases.json, in git/1's shape.
  const cases: [string, SourceStatus, PullRequest | null, boolean][] = [
    ["noPr", work(), null, false],
    ["agentWorking", work({ dirty: true }), pr(), true],
    ["uncommitted", work({ dirty: true }), pr(), false],
    ["behind", work({ behind: 2 }), pr(), false],
    ["ahead", work({ ahead: 2 }), pr(), false],
    ["diverged", work({ ahead: 2, behind: 1 }), pr(), false],
    ["conflicts", work({ conflicted: ["src/app.ts"] }), pr(), false],
    ["conflicts", work({ operation: "rebase" }), pr(), false],
    ["changesRequested", work(), pr({ reviewDecision: "CHANGES_REQUESTED" }), false],
    ["draft", work(), pr({ isDraft: true, mergeState: "DRAFT" }), false],
    ["checksFailing", work(), pr({ mergeState: "UNSTABLE", checks: [{ name: "test", state: "failure" }] }), false],
    ["checksPending", work(), pr({ checks: [{ name: "test", state: "in_progress" }] }), false],
    ["checksPending", work(), pr({ requiredChecks: ["build"] }), false],
    ["reviewRequired", work(), pr({ reviewDecision: "REVIEW_REQUIRED", mergeState: "BLOCKED" }), false],
    ["ready", work(), pr(), false],
    ["merged", work(), pr({ state: "MERGED" }), false],
    ["noPr", work(), pr({ state: "CLOSED" }), false],
  ];
  it.each(cases)("%s", (expected, status, request, working) => {
    expect(resolveMachineStep(status, request, working, status.aheadOfBase)).toBe(expected);
  });

  it("takes the published head's conflicts and BEHIND only while the machine has that head", () => {
    expect(resolveMachineStep(work(), pr({ mergeable: "CONFLICTING", mergeState: "DIRTY" }), false, 2)).toBe("conflicts");
    expect(resolveMachineStep(work(), pr({ mergeState: "BEHIND" }), false, 2)).toBe("behind");
    // A resolution committed on the machine but not pushed yet: push it, do not resolve again.
    expect(resolveMachineStep(work({ head: "2".repeat(40), ahead: 1 }), pr({ mergeable: "CONFLICTING", mergeState: "DIRTY" }), false, 2)).toBe("ahead");
  });

  it("never offers Merge for a head GitHub has not reported, or one it omitted", () => {
    expect(resolveMachineStep(work({ head: "2".repeat(40) }), pr(), false, 2)).toBe("checksPending");
    expect(resolveMachineStep(work(), pr({ headSha: "" }), false, 2)).toBe("checksPending");
    expect(resolveMachineStep(work(), pr({ mergeState: "UNKNOWN" }), false, 2)).toBe("checksPending");
  });

  it("asks to push a branch that was never pushed", () => {
    expect(resolveMachineStep(work({ upstream: null }), null, false, 2)).toBe("ahead");
  });
});

describe("machineActions (branch_step::actions)", () => {
  it("offers Create PR beside Push when there is no open PR", () => {
    expect(machineActions("ahead", null)).toEqual(["push", "createPr"]);
    expect(machineActions("ahead", pr())).toEqual(["push"]);
  });

  it("keeps Mark ready and Fix checks in the menu while another step leads", () => {
    const draftFailing = pr({ isDraft: true, checks: [{ name: "test", state: "failure" }] });
    expect(machineActions("draft", draftFailing)).toEqual(["markReady", "fixChecks"]);
    expect(machineActions("changesRequested", draftFailing)).toEqual(["addressReview", "markReady", "fixChecks"]);
    expect(machineActions("checksPending", pr())).toEqual([]);
  });
});

describe("composeMachineSnapshot (branch_step::compose)", () => {
  it("shows nothing on the default branch, without commits, or for an origin that is not GitHub", () => {
    expect(composeMachineSnapshot({ work: work({ branch: "main" }), remote: REMOTE, pr: null, known: true, working: false })).toBeNull();
    expect(composeMachineSnapshot({ work: work({ head: null }), remote: REMOTE, pr: null, known: true, working: false })).toBeNull();
    expect(composeMachineSnapshot({ work: work({ dirty: true }), remote: "git@gitlab.com:octo/app.git", pr: null, known: true, working: false })).toBeNull();
    expect(composeMachineSnapshot({ work: work({ dirty: true }), remote: null, pr: null, known: true, working: false })).toBeNull();
  });

  it("hides Create PR for a branch with nothing on it", () => {
    expect(composeMachineSnapshot({ work: work({ aheadOfBase: 0 }), remote: REMOTE, pr: null, known: true, working: false })).toBeNull();
    const snapshot = composeMachineSnapshot({ work: work(), remote: REMOTE, pr: null, known: true, working: false });
    expect(snapshot).toMatchObject({ state: "noPr", actions: ["createPr"], base: "main", branch: "feature", head: HEAD });
  });

  it("keeps the local steps when GitHub could not be read, and never claims there is no PR", () => {
    expect(composeMachineSnapshot({ work: work({ ahead: 1 }), remote: REMOTE, pr: null, known: false, working: false })).toMatchObject({ state: "ahead", actions: ["push"] });
    expect(composeMachineSnapshot({ work: work(), remote: REMOTE, pr: null, known: false, working: false })).toBeNull();
  });

  it("reads the base from the open PR, else the default branch", () => {
    expect(composeMachineSnapshot({ work: work(), remote: REMOTE, pr: pr({ base: "develop" }), known: true, working: false })?.base).toBe("develop");
    expect(composeMachineSnapshot({ work: work(), remote: REMOTE, pr: pr({ state: "CLOSED", base: "develop" }), known: true, working: false })?.base).toBe("main");
  });

  it("sends Pull to the agent when work must be kept or the base must be merged in", () => {
    // The machine's git.pull only fast-forwards from the upstream.
    expect(composeMachineSnapshot({ work: work({ behind: 1 }), remote: REMOTE, pr: pr(), known: true, working: false })).toMatchObject({ state: "behind", pullNeedsAgent: false, behindUpstream: true });
    expect(composeMachineSnapshot({ work: work({ behind: 1, dirty: true }), remote: REMOTE, pr: pr(), known: true, working: false })).toMatchObject({ pullNeedsAgent: true });
    expect(composeMachineSnapshot({ work: work(), remote: REMOTE, pr: pr({ mergeState: "BEHIND" }), known: true, working: false })).toMatchObject({ state: "behind", pullNeedsAgent: true, behindUpstream: false });
  });
});

describe("isGithubRemote (github_identity::classify_remote_host)", () => {
  it.each([
    ["git@github.com:octo/app.git", true],
    ["https://github.com/octo/app.git", true],
    ["ssh://git@github.com/octo/app.git", true],
    ["git@github-work:octo/app.git", true],
    ["https://github.example.com/octo/app.git", true],
    ["git@gitlab.com:octo/app.git", false],
    ["https://github.gitlab.example.com/octo/app.git", false],
    ["https://codeberg.org/octo/app.git", false],
    ["git@my-forge:octo/app.git", false],
    ["file:///srv/app.git", false],
    ["/srv/app.git", false],
    ["https://github.com.evil.example/octo/app.git", false],
  ])("%s", (url, expected) => {
    expect(isGithubRemote(url)).toBe(expected);
  });
});

describe("branchPr", () => {
  it("prefers the branch's open PR over an older closed one", () => {
    const closed = pr({ number: 3, state: "CLOSED" });
    const open = pr({ number: 9 });
    expect(branchPr([closed, open], "feature")?.number).toBe(9);
    expect(branchPr([closed], "feature")?.number).toBe(3);
    expect(branchPr([pr({ head: "other" })], "feature")).toBeNull();
  });
});

describe("agentPrompt", () => {
  it("names the branch, base and PR, and forbids publishing", () => {
    const snapshot = composeMachineSnapshot({ work: work(), remote: REMOTE, pr: pr({ checks: [{ name: "test", state: "failure" }] }), known: true, working: false })!;
    const text = agentPrompt("fixChecks", snapshot);
    expect(text).toContain("failing checks");
    expect(text).toContain('Branch: "feature". Base: "main". Pull request: "https://github.com/octo/app/pull/7".');
    expect(text).toContain("Do not push, merge a pull request or open a new pull request.");
  });

  it("asks a base merge for a PR that is behind its base", () => {
    const snapshot = composeMachineSnapshot({ work: work(), remote: REMOTE, pr: pr({ mergeState: "BEHIND" }), known: true, working: false })!;
    expect(agentPrompt("pull", snapshot)).toMatch(/^Merge the latest "main" into branch "feature"/);
  });
});

describe("sameBranchState", () => {
  it("refuses an action prepared on a head or PR that has since moved", () => {
    const at = (patch: Partial<SourceStatus>, request: PullRequest | null) => composeMachineSnapshot({ work: work(patch), remote: REMOTE, pr: request, known: true, working: false });
    const expected = at({}, pr())!;
    expect(sameBranchState(expected, at({}, pr()))).toBe(true);
    expect(sameBranchState(expected, at({ head: "2".repeat(40) }, pr({ headSha: "2".repeat(40) })))).toBe(false);
    expect(sameBranchState(expected, at({}, pr({ number: 8 })))).toBe(false);
    expect(sameBranchState(expected, null)).toBe(false);
  });
});

describe("machineBranchBase", () => {
  it("uses the selected branch before a PR exists and follows the base of an open PR", () => {
    expect(machineBranchBase(work(), null, "refs/remotes/origin/release/2.x")).toBe("release/2.x");
    expect(machineBranchBase(work(), pr({ base: "develop" }), "origin/release/2.x")).toBe("develop");
    expect(machineBranchBase(work(), pr({ state: "CLOSED" }), "refs/heads/release/2.x")).toBe("release/2.x");
    expect(machineBranchBase(work(), null, "HEAD")).toBe("main");
  });
});
