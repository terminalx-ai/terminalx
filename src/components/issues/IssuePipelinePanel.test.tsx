import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssuePipeline, IssuePipelineSettings } from "@/types/issuePipeline";
import type { Project } from "@/types/session";

const { invoke, openUrl, selectSession, sessionStore } = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
  selectSession: vi.fn(),
  sessionStore: { projects: [] as Project[], sessions: [] as { id: string }[] },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@/lib/notify", () => ({ notePipelineState: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ selectSession, useSessionStore: () => sessionStore }));

const { IssuePipelinePanel } = await import("./IssuePipelinePanel");

const C1 = "1111111111111111111111111111111111111111";
const MERGE_SWITCH = "Merge automatically when the review is addressed";

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
