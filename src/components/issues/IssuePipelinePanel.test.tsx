import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrCheck } from "@/lib/api";
import type { IssuePipeline, IssuePipelineSettings } from "@/types/issuePipeline";
import type { Project } from "@/types/session";

const { invoke, openUrl, selectSession, sessionStore } = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
  selectSession: vi.fn(),
  sessionStore: { projects: [] as Project[], sessions: [] as { id: string; cwd?: string }[] },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@/lib/notify", () => ({ notePipelineState: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ selectSession, useSessionStore: () => sessionStore }));

const { IssuePipelinePanel } = await import("./IssuePipelinePanel");

const C1 = "1111111111111111111111111111111111111111";
const MERGE_SWITCH = "Merge when green";

function pipeline(patch: Partial<IssuePipeline> = {}): IssuePipeline {
  return {
    id: "p1", projectPath: "/repo",
    issue: { provider: "github", id: "433", identifier: "#433", title: "Open a pull request", url: "https://github.com/acme/widgets/issues/433" },
    branch: "raccoon/433-open-a-pull-request",
    author: { sessionId: "author", tabId: "t1" }, reviewer: { sessionId: "reviewer", tabId: "t1" },
    autoMerge: false, stopped: false, stage: "merge", state: "readyToMerge",
    reason: { kind: "autoMergeOff" }, note: "Reviewed, checks passed. Automatic merge is off for this issue.",
    pr: { number: 7, url: "https://github.com/acme/widgets/pull/7", base: "main" },
    round: 1, maxRounds: 3, reviewCommit: C1,
    verdict: { commit: C1, decision: "merge", securityPass: "notNeeded", findings: [], round: 1, at: "2026-10-12T10:05:00.000Z" },
    securityAreas: [], merged: null,
    events: [
      { at: "2026-10-12T10:00:00.000Z", stage: "work", kind: "started", message: "Session started on #433 Open a pull request.", sessionId: "author" },
      { at: "2026-10-12T10:02:00.000Z", stage: "pullRequest", kind: "pullRequest", message: "Opened pull request #7. Merging it closes #433.", url: "https://github.com/acme/widgets/pull/7" },
      { at: "2026-10-12T10:05:00.000Z", stage: "review", kind: "verdict", message: "Review 1 of 3 of 1111111111: merge, no findings.", commit: C1, sessionId: "gone" },
    ],
    created: "2026-10-12T10:00:00.000Z", modified: "2026-10-12T10:05:00.000Z",
    ...patch,
  };
}

const settings = (patch: Partial<IssuePipelineSettings>): IssuePipelineSettings => ({
  enabled: true, autoMerge: false, requirePerson: false, maxRounds: 3, mergeMethod: "merge",
  protected: { migrations: true, deploy: true, security: true, paths: [] }, ignoredChecks: [],
  ...patch,
});

/** The calls a reader's own click made: the look the panel takes on opening is not one. */
const acts = () => invoke.mock.calls.filter(([command, args]) => command !== "issue_pipeline_act" || (args as { action: string }).action !== "refresh");

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (_command: string, args: { id: string }) => pipeline({ id: args.id }));
  openUrl.mockReset();
  selectSession.mockReset();
  sessionStore.projects = [{ path: "/repo", name: "Widgets" }];
  sessionStore.sessions = [{ id: "author" }, { id: "reviewer" }];
});

afterEach(cleanup);

describe("an issue's pipeline on its page", () => {
  it("says where it stands, with the stages, the pull request and both sessions", () => {
    render(<IssuePipelinePanel pipeline={pipeline()} />);
    const panel = within(screen.getByTestId("issue-pipeline"));
    expect(panel.getByText("Ready to merge")).toBeTruthy();
    expect(panel.getByRole("status").textContent).toBe("Reviewed, checks passed. Automatic merge is off for this issue.");
    const stages = within(panel.getByRole("list", { name: "Stages" })).getAllByRole("listitem").map((item) => item.textContent);
    // The stage that was passed over keeps its dot: nothing was done there.
    expect(stages).toEqual(["Work", "Pull request#7", "ReviewNo findings at 1111111", "·AddressNothing to address", "MergeReady"]);

    fireEvent.click(panel.getByRole("button", { name: /Pull request #7/ }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/widgets/pull/7");
    fireEvent.click(panel.getByRole("button", { name: "Author session" }));
    fireEvent.click(panel.getByRole("button", { name: "Reviewer session" }));
    expect(selectSession.mock.calls).toEqual([["author"], ["reviewer"]]);
  });

  it("turns the issue's switch on and off through the app", async () => {
    render(<IssuePipelinePanel pipeline={pipeline()} />);
    const toggle = screen.getByRole("switch", { name: MERGE_SWITCH });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(acts()).toEqual([["issue_pipeline_set_auto_merge", { id: "p1", value: true }]]));
    cleanup();
    invoke.mockClear();
    render(<IssuePipelinePanel pipeline={pipeline({ autoMerge: true, stage: "review", state: "working" })} />);
    fireEvent.click(screen.getByRole("switch", { name: MERGE_SWITCH }));
    await waitFor(() => expect(acts()).toEqual([["issue_pipeline_set_auto_merge", { id: "p1", value: false }]]));
  });

  it("holds the switch off in a project that has a person do the merge", () => {
    sessionStore.projects = [{ path: "/repo", name: "Widgets", issuePipeline: settings({ requirePerson: true }) }];
    render(<IssuePipelinePanel pipeline={pipeline({ reason: { kind: "personRequired" } })} />);
    expect(screen.getByRole("switch", { name: MERGE_SWITCH }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("This project has a person do the merge, whatever this is set to.")).toBeTruthy();
    // The person it waits for can still merge here.
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
  });

  it("merges by hand only from Ready to merge", async () => {
    render(<IssuePipelinePanel pipeline={pipeline()} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(acts()).toEqual([["issue_pipeline_act", { id: "p1", action: "merge" }]]));
    cleanup();
    for (const patch of [
      { state: "needsYou" as const, reason: { kind: "checksFailed", names: ["test"] }, note: "A check failed on the reviewed commit: test." },
      { state: "waiting" as const, reason: null, note: "Waiting for checks on 1111111111: build." },
      { stage: "review" as const, state: "working" as const, reason: null },
    ]) {
      render(<IssuePipelinePanel pipeline={pipeline(patch)} />);
      expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
      cleanup();
    }
  });

  it("lists the open findings worst first, with where they are, and offers the way forward", async () => {
    const stuck = pipeline({
      stage: "review", state: "needsYou", round: 3,
      reason: { kind: "roundLimit", rounds: 3, count: 1, worst: "high" },
      note: "Still not clean after 3 reviews: 1 finding of medium severity or higher remains (worst: high).",
      verdict: {
        commit: C1, decision: "changes", securityPass: "flagged", round: 3, at: "2026-10-12T10:05:00.000Z",
        findings: [
          { severity: "low", title: "Name could be clearer", security: false },
          { severity: "high", title: "Token is logged", detail: "The bearer token reaches the log.", file: "src/auth.rs", line: 42, security: true },
        ],
      },
    });
    render(<IssuePipelinePanel pipeline={stuck} />);
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText(/2 open findings · review 3 of/)).toBeTruthy();
    const findings = screen.getAllByRole("listitem").filter((item) => /Token is logged|Name could be clearer/.test(item.textContent ?? ""));
    expect(findings.map((item) => item.textContent)).toEqual(["high · securityToken is loggedsrc/auth.rs:42The bearer token reaches the log.", "lowName could be clearer"]);
    fireEvent.click(screen.getByRole("button", { name: "Review once more" }));
    await waitFor(() => expect(acts()).toEqual([["issue_pipeline_act", { id: "p1", action: "advance" }]]));
  });

  it("says when the review was by reading only, and nothing for a verdict that did not say", () => {
    const reading = pipeline({ verdict: { commit: C1, decision: "merge", securityPass: "notNeeded", findings: [], checks: "notRun", checksNote: "the build waits on a file lock", round: 1, at: "2026-10-12T10:05:00.000Z" } });
    render(<IssuePipelinePanel pipeline={reading} />);
    expect(screen.getByTestId("pipeline-review-checks").textContent).toBe("Reviewed by reading only, tests not run: the build waits on a file lock.");
    cleanup();
    render(<IssuePipelinePanel pipeline={pipeline()} />);
    expect(screen.queryByTestId("pipeline-review-checks")).toBeNull();
  });

  it("keeps the record behind a toggle, with its links to the pull request and the sessions that still exist", () => {
    render(<IssuePipelinePanel pipeline={pipeline()} />);
    expect(screen.queryByRole("list", { name: "Record" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Record · 3 entries/ }));
    const record = within(screen.getByRole("list", { name: "Record" }));
    expect(record.getAllByRole("listitem")).toHaveLength(3);
    expect(record.getByText("Opened pull request #7. Merging it closes #433.")).toBeTruthy();
    fireEvent.click(record.getByRole("button", { name: "Open on the web" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/widgets/pull/7");
    // The verdict names a session that was since deleted: no link to nowhere.
    expect(record.getAllByRole("button", { name: "Open the session" })).toHaveLength(1);
    fireEvent.click(record.getByRole("button", { name: "Open the session" }));
    expect(selectSession).toHaveBeenCalledWith("author");
  });

  it("has nothing left to offer once merged", () => {
    render(<IssuePipelinePanel pipeline={pipeline({ state: "merged", reason: null, note: "TerminalX merged pull request #7 at 1111111111 into main.", merged: { commit: C1, at: "2026-10-12T10:06:00.000Z", by: "pipeline" } })} />);
    expect(screen.getByText("Merged")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["Pull request #7", "Author session", "Reviewer session", "Record · 3 entries"]);
    // And nothing to look at again.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("says why an action did not work", async () => {
    invoke.mockImplementation(async (command: string, args: { action?: string }) => {
      if (command === "issue_pipeline_act" && args.action === "merge") throw "GitHub is not reachable.";
      return pipeline();
    });
    render(<IssuePipelinePanel pipeline={pipeline()} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(await screen.findByText("GitHub is not reachable.")).toBeTruthy();
    // And the buttons come back.
    expect(screen.getByRole("button", { name: "Merge" }).hasAttribute("disabled")).toBe(false);
  });

  it("looks at the pull request when the issue is opened, once, and only while there is one to watch", async () => {
    const view = render(<IssuePipelinePanel pipeline={pipeline()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("issue_pipeline_act", { id: "p1", action: "refresh" }));
    view.rerender(<IssuePipelinePanel pipeline={pipeline({ note: "Changed." })} />);
    expect(invoke).toHaveBeenCalledTimes(1);
    cleanup();
    invoke.mockClear();
    render(<IssuePipelinePanel pipeline={pipeline({ stage: "work", state: "working", pr: null, verdict: null, round: 0 })} />);
    render(<IssuePipelinePanel pipeline={pipeline({ state: "stopped", stopped: true })} />);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("the checks a merge waits on (#881)", () => {
  const NOW = Date.parse("2026-11-11T10:23:30.000Z");
  const RUN = (job: number) => `https://github.com/acme/widgets/actions/runs/90/job/${job}`;
  const check = (name: string, state: string, patch: Partial<PrCheck> = {}): PrCheck => ({ name, state, url: RUN(name.length), ...patch });
  const waiting = (checks: PrCheck[], required: string[], patch: Partial<IssuePipeline> = {}) => pipeline({
    state: "waiting", reason: null, note: `Waiting for checks on 1111111111: ${required.join(" and ")}.`,
    waitingSince: "2026-11-11T10:00:00.000Z",
    checks: { commit: C1, checks, required, since: "2026-11-11T10:00:00.000Z", limitMinutes: 60 },
    ...patch,
  });
  const rows = (list: string) => within(screen.getByRole("list", { name: list })).getAllByRole("listitem").map((item) => item.textContent);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    sessionStore.sessions = [{ id: "author", cwd: "/repo/.worktrees/433" }, { id: "reviewer" }];
  });
  afterEach(() => vi.useRealTimers());

  it("reads a queued check as queued and a running one as running, with its time and its run", () => {
    render(<IssuePipelinePanel pipeline={waiting([
      check("check", "in_progress", { startedAt: "2026-11-11T10:00:00Z", summary: "macOS · tests, clippy, Swift", actions: { runId: 90, jobId: 5 } }),
      check("desktop-platforms", "queued", { startedAt: null }),
    ], ["check", "desktop-platforms"])} />);
    const panel = within(screen.getByTestId("issue-pipeline"));
    expect(panel.getByText("Waiting for checks")).toBeTruthy();
    expect(panel.getByTestId("pipeline-checks-count").textContent).toBe("· 0 of 2 passed");
    expect(rows("Required")).toEqual(["checkmacOS · tests, clippy, SwiftRunning23 min", "desktop-platformsQueued"]);
    expect(panel.getByTestId("pipeline-checks-clock").textContent).toBe("Waiting 23 min · asks you at 60 min");
    expect(panel.getByRole("list", { name: "Stages" }).textContent).toContain("Mergewaiting for checks");
    // The list says it: the sentence is not said again.
    expect(panel.queryByText(/Waiting for checks on/)).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "Open the run: check" }));
    expect(openUrl).toHaveBeenCalledWith(RUN(5));
    // The clocks move with the time, without a read of GitHub.
    invoke.mockClear();
    act(() => { vi.advanceTimersByTime(4 * 60_000); });
    expect(panel.getByTestId("pipeline-checks-clock").textContent).toBe("Waiting 27 min · asks you at 60 min");
    expect(rows("Required")[0]).toContain("27 min");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("counts only required checks, folding the optional ones away", () => {
    render(<IssuePipelinePanel pipeline={waiting([
      check("check", "in_progress", { startedAt: "2026-11-11T10:00:00Z" }),
      check("headless-serve", "success", { startedAt: "2026-11-11T10:00:00Z", completedAt: "2026-11-11T10:04:10Z" }),
      check("desktop-platforms", "success", { startedAt: "2026-11-11T10:00:00Z", completedAt: "2026-11-11T10:09:00Z", summary: "instabox-medium" }),
      check("lint", "failure", { startedAt: "2026-11-11T10:00:00Z", completedAt: "2026-11-11T10:01:00Z" }),
      check("docs", "success"),
    ], ["check", "desktop-platforms", "headless-serve"])} />);
    const panel = within(screen.getByTestId("issue-pipeline"));
    // A failing optional check changes neither the headline nor the count.
    expect(panel.getByText("Waiting for checks")).toBeTruthy();
    expect(panel.getByTestId("pipeline-checks-count").textContent).toBe("· 2 of 3 passed");
    expect(rows("Required")).toEqual(["checkRunning23 min", "headless-servePassed4 min", "desktop-platformsinstabox-mediumPassed9 min"]);
    expect(panel.queryByRole("list", { name: "Optional" })).toBeNull();
    const fold = panel.getByRole("button", { name: /Optional/ });
    expect(fold.textContent).toBe("Optional1 of 2 failed");
    fireEvent.click(fold);
    expect(rows("Optional")).toEqual(["lintFailed1 min", "docsPassed"]);
  });

  it("names and links a failed required check, and offers to send it to the author, run it again, or open it", async () => {
    const failed = waiting([
      check("check", "failure", { startedAt: "2026-11-11T10:00:00Z", completedAt: "2026-11-11T10:41:00Z", summary: "cargo test · exit 101", actions: { runId: 90, jobId: 5 } }),
      check("headless-serve", "success", { startedAt: "2026-11-11T10:00:00Z", completedAt: "2026-11-11T10:04:00Z" }),
      check("desktop-platforms", "success", { startedAt: "2026-11-11T10:00:00Z", completedAt: "2026-11-11T10:09:00Z" }),
    ], ["check", "desktop-platforms", "headless-serve"], {
      state: "needsYou", reason: { kind: "checksFailed", names: ["check"] }, note: "A check failed on the reviewed commit: check.", waitingSince: null,
    });
    failed.checks!.until = "2026-11-11T10:41:00.000Z";
    invoke.mockImplementation(async (command: string) => {
      if (command === "pr_check_fix_attachment") return { path: "/tmp/logs/check.log", truncated: false };
      if (command === "send_message") return { queued: false, events: [] };
      if (command === "pr_check_rerun") return undefined;
      return failed;
    });
    render(<IssuePipelinePanel pipeline={failed} />);
    const panel = within(screen.getByTestId("issue-pipeline"));
    expect(panel.getByText("A required check failed")).toBeTruthy();
    expect(panel.getByTestId("pipeline-checks-count").textContent).toBe("· 2 of 3 passed");
    expect(panel.getByTestId("pipeline-check-failed").textContent).toBe("check failed on 1111111. Nothing is merged. The failure goes back to the author session, or you can run the check again.");
    expect(panel.getByTestId("pipeline-checks-clock").textContent).toBe("Waited 41 min");
    expect(rows("Required")[0]).toBe("checkcargo test · exit 101Failed41 min");
    expect(panel.getByRole("list", { name: "Stages" }).textContent).toContain("Mergea required check failed");

    fireEvent.click(panel.getByRole("button", { name: "Open the run" }));
    expect(openUrl).toHaveBeenCalledWith(RUN(5));

    fireEvent.click(panel.getByRole("button", { name: "Send the failure to the author" }));
    await waitFor(() => expect(panel.getByText("Sent the failure to the author session.")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("pr_check_fix_attachment", { sessionId: "author", tabId: "t1", prUrl: "https://github.com/acme/widgets/pull/7" });
    const sent = invoke.mock.calls.find(([command]) => command === "send_message")![1] as { sessionId: string; tabId: string; text: string };
    expect([sent.sessionId, sent.tabId]).toEqual(["author", "t1"]);
    expect(sent.text).toContain("/tmp/logs/check.log");

    fireEvent.click(panel.getByRole("button", { name: "Re-run check" }));
    await waitFor(() => expect(panel.getByText(/Re-run requested for 1 Actions run\./)).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("pr_check_rerun", { cwd: "/repo/.worktrees/433", prUrl: "https://github.com/acme/widgets/pull/7", checkUrl: RUN(5), failed: true });
  });

  it("offers only the run where the author session is not here, or the failure is not an Actions run", () => {
    sessionStore.sessions = [];
    const failed = waiting([check("ci/legacy", "failure", { url: "https://ci.example.com/3" })], ["ci/legacy"], { state: "needsYou", reason: { kind: "checksFailed", names: ["ci/legacy"] } });
    render(<IssuePipelinePanel pipeline={failed} />);
    const panel = within(screen.getByTestId("issue-pipeline"));
    expect((panel.getByRole("button", { name: "Send the failure to the author" }) as HTMLButtonElement).disabled).toBe(true);
    expect((panel.getByRole("button", { name: "Re-run check" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(panel.getByRole("button", { name: "Open the run" }));
    expect(openUrl).toHaveBeenCalledWith("https://ci.example.com/3");
  });

  it("says the note, not an empty failure, when what failed is a workflow behind passing checks", () => {
    render(<IssuePipelinePanel pipeline={waiting([check("check", "success")], ["check"], {
      state: "needsYou", reason: { kind: "checksFailed", names: ["CI (check_suites #9)"] }, note: "A check failed on the reviewed commit: CI (check_suites #9).",
    })} />);
    const panel = within(screen.getByTestId("issue-pipeline"));
    expect(panel.getByText("Needs you")).toBeTruthy();
    expect(panel.getByText("A check failed on the reviewed commit: CI (check_suites #9).")).toBeTruthy();
    expect(panel.queryByTestId("pipeline-check-failed")).toBeNull();
    expect(panel.queryByTestId("pipeline-checks")).toBeNull();
  });

  it("keeps the sentence beside the list once the wait ran out", () => {
    const stalled = waiting([check("check", "queued")], ["check"], {
      state: "needsYou", reason: { kind: "checksStalled", names: ["check"], minutes: 60 }, note: "Checks have not finished after 60 minutes: check.",
    });
    stalled.checks!.until = "2026-11-11T11:00:00.000Z";
    render(<IssuePipelinePanel pipeline={stalled} />);
    const panel = within(screen.getByTestId("issue-pipeline"));
    expect(panel.getByText("Needs you")).toBeTruthy();
    expect(panel.getByTestId("pipeline-checks-clock").textContent).toBe("Waited 60 min");
    expect(panel.getByText("Checks have not finished after 60 minutes: check.")).toBeTruthy();
  });

  it("says today's sentence when the checks could not be read", () => {
    render(<IssuePipelinePanel pipeline={waiting([], [], { checks: null, note: "Waiting for checks on 1111111111: check." })} />);
    const panel = within(screen.getByTestId("issue-pipeline"));
    expect(panel.getByText("Waiting for checks")).toBeTruthy();
    expect(panel.getByRole("status").textContent).toBe("Waiting for checks on 1111111111: check.");
    expect(panel.queryByTestId("pipeline-checks")).toBeNull();
    expect(panel.queryByTestId("pipeline-checks-count")).toBeNull();
  });
});
