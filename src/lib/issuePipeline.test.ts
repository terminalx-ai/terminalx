import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssuePipeline } from "@/types/issuePipeline";
// A pipeline exactly as the Rust side writes it; a Rust test holds it to that.
import stored from "../../src-tauri/src/fixtures/issue_pipeline.json?raw";

const { list, start, setAutoMerge, act, notePipelineState, listeners } = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  setAutoMerge: vi.fn(),
  act: vi.fn(),
  notePipelineState: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
}));
vi.mock("@/lib/api", () => ({ issuePipelines: { list, start, setAutoMerge, act } }));
vi.mock("@/lib/notify", () => ({ notePipelineState }));

const C1 = "1111111111111111111111111111111111111111";

function pipeline(patch: Partial<IssuePipeline> = {}): IssuePipeline {
  return {
    id: "p1",
    projectPath: "/repo",
    issue: { provider: "github", id: "433", identifier: "#433", title: "Open a pull request", url: "https://github.com/acme/widgets/issues/433" },
    branch: "raccoon/433-open-a-pull-request",
    author: { sessionId: "author", tabId: "t1" },
    reviewer: null,
    autoMerge: false,
    stopped: false,
    stage: "work",
    state: "working",
    reason: null,
    note: "The author session is working on the issue.",
    pr: null,
    round: 0,
    maxRounds: 3,
    reviewCommit: null,
    verdict: null,
    securityAreas: [],
    merged: null,
    events: [],
    created: "2026-10-12T10:00:00.000Z",
    modified: "2026-10-12T10:00:00.000Z",
    ...patch,
  };
}

const pr = { number: 7, url: "https://github.com/acme/widgets/pull/7", base: "main" };
const verdict = (findings: number) => ({
  commit: C1,
  decision: findings ? ("changes" as const) : ("merge" as const),
  securityPass: "notNeeded" as const,
  findings: Array.from({ length: findings }, (_, index) => ({ severity: "high" as const, title: `Finding ${index + 1}`, security: false })),
  round: 1,
  at: "2026-10-12T10:05:00.000Z",
});

async function load() {
  return import("./issuePipeline");
}

beforeEach(() => {
  vi.resetModules();
  listeners.clear();
  for (const mock of [list, start, setAutoMerge, act, notePipelineState]) mock.mockReset();
});

describe("where a pipeline stands", () => {
  it("names the two states the issue page promises, and what it is doing otherwise", async () => {
    const { pipelineHeadline } = await load();
    expect(pipelineHeadline(pipeline({ state: "readyToMerge", stage: "merge" }))).toEqual({ label: "Ready to merge", tone: "add" });
    expect(pipelineHeadline(pipeline({ state: "needsYou", stage: "review" }))).toEqual({ label: "Needs you", tone: "warning" });
    expect(pipelineHeadline(pipeline({ state: "merged", stage: "merge" }))).toEqual({ label: "Merged", tone: "merged" });
    expect(pipelineHeadline(pipeline({ state: "stopped" }))).toEqual({ label: "Stopped", tone: "faint" });
    expect(pipelineHeadline(pipeline()).label).toBe("Working");
    expect(pipelineHeadline(pipeline({ stage: "review" })).label).toBe("In review");
    expect(pipelineHeadline(pipeline({ stage: "address" })).label).toBe("Addressing findings");
    expect(pipelineHeadline(pipeline({ stage: "merge", state: "waiting", note: "Waiting for checks on 1111111111: build." })).label).toBe("Waiting for checks");
    expect(pipelineHeadline(pipeline({ stage: "merge", state: "waiting", note: "Giving checks a moment to be reported on 1111111111." })).label).toBe("Waiting for checks");
    expect(pipelineHeadline(pipeline({ stage: "merge", state: "waiting", note: "GitHub accepted the merge and has not completed it yet." })).label).toBe("Waiting for GitHub");
    expect(pipelineHeadline(pipeline({ stage: "merge", state: "waiting", note: "Waiting for GitHub to work out whether the branch merges." })).label).toBe("Waiting for GitHub");
  });

  it("lays the five stages out with the one in hand marked", async () => {
    const { pipelineSteps } = await load();
    const statuses = (value: IssuePipeline) => pipelineSteps(value).map((step) => step.status);
    expect(pipelineSteps(pipeline()).map((step) => step.label)).toEqual(["Work", "Pull request", "Review", "Address", "Merge"]);
    expect(statuses(pipeline())).toEqual(["current", "pending", "pending", "pending", "pending"]);

    const reviewing = pipeline({ stage: "review", pr, round: 1 });
    expect(statuses(reviewing)).toEqual(["done", "done", "current", "pending", "pending"]);
    expect(pipelineSteps(reviewing).map((step) => step.detail)).toEqual([null, "#7", "Round 1 of 3", null, null]);

    // The second review: the fixes it follows are behind it.
    expect(statuses(pipeline({ stage: "review", pr, round: 2 }))).toEqual(["done", "done", "current", "done", "pending"]);
    expect(statuses(pipeline({ stage: "address", pr, round: 1, verdict: verdict(2) }))).toEqual(["done", "done", "done", "current", "pending"]);

    // Clean at the first review: nothing was sent back.
    const ready = pipeline({ stage: "merge", state: "readyToMerge", pr, round: 1, verdict: verdict(0) });
    expect(statuses(ready)).toEqual(["done", "done", "done", "skipped", "done"]);
    expect(pipelineSteps(ready).map((step) => step.detail)).toEqual([null, "#7", "No findings at 1111111", "Nothing to address", "Ready"]);

    const merged = pipeline({ stage: "merge", state: "merged", pr, round: 2, verdict: verdict(0), merged: { commit: C1, at: "", by: "pipeline" } });
    expect(statuses(merged)).toEqual(["done", "done", "done", "done", "done"]);
    expect(pipelineSteps(merged)[4].detail).toBe("1111111 into main");

    expect(statuses(pipeline({ stage: "review", state: "needsYou", pr, round: 3, verdict: verdict(1) }))).toEqual(["done", "done", "attention", "done", "pending"]);
    expect(pipelineSteps(pipeline({ stage: "review", state: "needsYou", pr, round: 3, verdict: verdict(1) }))[2].detail).toBe("1 finding at 1111111");
    expect(statuses(pipeline({ stage: "pullRequest", state: "stopped" }))).toEqual(["done", "stopped", "pending", "pending", "pending"]);
  });

  it("offers a merge by hand only where the pipeline says the change is ready", async () => {
    const { pipelineActions } = await load();
    const offered = (value: IssuePipeline) => {
      const { primary, secondary } = pipelineActions(value);
      return [primary?.action ?? null, ...secondary.map((button) => button.action)];
    };
    expect(offered(pipeline({ stage: "merge", state: "readyToMerge" }))).toEqual(["merge", "refresh", "stop"]);
    for (const value of [
      pipeline(),
      pipeline({ stage: "review" }),
      pipeline({ stage: "merge", state: "waiting" }),
      pipeline({ stage: "merge", state: "needsYou", reason: { kind: "checksFailed", names: ["test"] } }),
      pipeline({ stage: "merge", state: "needsYou", reason: { kind: "headMoved", reviewed: C1, head: "2222222" } }),
      pipeline({ stage: "review", state: "needsYou", reason: { kind: "roundLimit" } }),
      pipeline({ state: "stopped" }),
      pipeline({ stage: "merge", state: "merged" }),
    ]) {
      expect(offered(value)).not.toContain("merge");
    }
    expect(offered(pipeline({ stage: "merge", state: "merged" }))).toEqual([null]);
    expect(offered(pipeline({ state: "stopped" }))).toEqual(["resume"]);
  });

  it("words the way forward by the stage that is stuck", async () => {
    const { pipelineActions } = await load();
    const forward = (value: IssuePipeline) => pipelineActions(value).primary;
    expect(forward(pipeline({ state: "needsYou" }))).toEqual({ action: "advance", label: "Open pull request" });
    expect(forward(pipeline({ stage: "pullRequest", state: "needsYou" }))).toEqual({ action: "advance", label: "Try again" });
    expect(forward(pipeline({ stage: "review", state: "needsYou", reason: { kind: "noVerdict" } }))).toEqual({ action: "advance", label: "Review again" });
    expect(forward(pipeline({ stage: "review", state: "needsYou", reason: { kind: "roundLimit" } }))).toEqual({ action: "advance", label: "Review once more" });
    expect(forward(pipeline({ stage: "address", state: "needsYou" }))).toEqual({ action: "advance", label: "Review the changes" });
    expect(forward(pipeline({ stage: "merge", state: "needsYou", reason: { kind: "checksFailed" } }))).toEqual({ action: "advance", label: "Check again" });
    // A head nobody reviewed is fixed by a review, not by looking again.
    expect(forward(pipeline({ stage: "merge", state: "needsYou", reason: { kind: "headMoved" } }))).toEqual({ action: "review", label: "Review the new commit" });
    // A session that is done and has not said so can be taken at its word by the reader.
    expect(pipelineActions(pipeline()).secondary[0]).toEqual({ action: "advance", label: "Open pull request now" });
    expect(pipelineActions(pipeline({ stage: "address" })).secondary[0]).toEqual({ action: "advance", label: "Review the changes now" });
    expect(pipelineActions(pipeline({ stage: "review" })).secondary.map((button) => button.action)).toEqual(["stop"]);
  });

  it("finds an issue's newest pipeline and a session's part in one", async () => {
    const { pipelineForIssue, pipelineForSession } = await load();
    const first = pipeline({ id: "old", created: "2026-10-01T00:00:00.000Z" });
    const second = pipeline({ id: "new", created: "2026-10-12T00:00:00.000Z", author: { sessionId: "author-2", tabId: "t1" }, reviewer: { sessionId: "reviewer", tabId: "t1" } });
    const elsewhere = pipeline({ id: "other-project", projectPath: "/other", created: "2026-10-13T00:00:00.000Z" });
    const all = [first, second, elsewhere];
    expect(pipelineForIssue(all, "/repo", first.issue.url)?.id).toBe("new");
    expect(pipelineForIssue(all, "/repo", "https://github.com/acme/widgets/issues/1")).toBeNull();
    expect(pipelineForSession(all, "reviewer")).toEqual({ pipeline: second, role: "reviewer" });
    expect(pipelineForSession(all, "author-2")?.role).toBe("author");
    expect(pipelineForSession(all, "someone-else")).toBeNull();
  });

  it("fills a project's settings in with the defaults, which never merge", async () => {
    const { DEFAULT_PIPELINE_SETTINGS, pipelineSettings } = await load();
    expect(DEFAULT_PIPELINE_SETTINGS).toMatchObject({ enabled: true, autoMerge: false, requirePerson: false, maxRounds: 3, mergeMethod: "merge" });
    expect(DEFAULT_PIPELINE_SETTINGS.protected).toEqual({ migrations: true, deploy: true, security: true, paths: [] });
    expect(pipelineSettings(null)).toBe(DEFAULT_PIPELINE_SETTINGS);
    expect(pipelineSettings({ issuePipeline: null })).toBe(DEFAULT_PIPELINE_SETTINGS);
    const chosen = pipelineSettings({ issuePipeline: { ...DEFAULT_PIPELINE_SETTINGS, autoMerge: true, protected: { ...DEFAULT_PIPELINE_SETTINGS.protected, deploy: false } } });
    expect(chosen.autoMerge).toBe(true);
    expect(chosen.protected).toEqual({ migrations: true, deploy: false, security: true, paths: [] });
  });
});

describe("a pipeline as the app stores it", () => {
  const fixture = JSON.parse(stored) as IssuePipeline;

  it("is read by the page without translation", async () => {
    const { pipelineHeadline, pipelineSteps, pipelineActions, pipelineForIssue, pipelineForSession } = await load();
    expect(pipelineHeadline(fixture)).toEqual({ label: "Needs you", tone: "warning" });
    expect(pipelineSteps(fixture).map((step) => [step.stage, step.status, step.detail])).toEqual([
      ["work", "done", null],
      ["pullRequest", "done", "#7"],
      ["review", "attention", "3 findings at 3333333"],
      ["address", "done", null],
      ["merge", "pending", null],
    ]);
    expect(pipelineActions(fixture).primary).toEqual({ action: "advance", label: "Review once more" });
    expect(pipelineForIssue([fixture], "/repo", "https://github.com/acme/widgets/issues/433")).toBe(fixture);
    expect(pipelineForSession([fixture], "reviewer-1")?.role).toBe("reviewer");
    expect(fixture.verdict?.findings.map((finding) => [finding.severity, finding.security, finding.file ?? null, finding.line ?? null])).toEqual([
      ["high", true, "src/auth.rs", 42],
      ["medium", false, "src/lib/format.ts", null],
      ["nit", false, null, null],
    ]);
    expect(fixture.verdict?.securityPass).toBe("flagged");
    expect(fixture.reason?.kind).toBe("roundLimit");
    expect(fixture.events.map((event) => [event.kind, event.stage, event.sessionId ?? null, event.url ?? null, event.commit?.slice(0, 7) ?? null])).toEqual([
      ["started", "work", "author", null, null],
      ["autoMerge", "work", null, null, null],
      ["pullRequest", "pullRequest", null, "https://github.com/acme/widgets/pull/7", null],
      ["verdict", "review", "reviewer-1", null, "3333333"],
      ["needsYou", "review", null, null, null],
    ]);
  });

  it("has no field the page's type has not been told about", () => {
    // Every key the app writes is either one `IssuePipeline` declares, or one
    // only the app's own state machine uses. A new one belongs in a list here.
    const declared: (keyof IssuePipeline)[] = [
      "id", "projectPath", "issue", "branch", "author", "reviewer", "autoMerge", "stopped", "stage", "state", "reason", "note", "pr",
      "round", "maxRounds", "reviewCommit", "verdict", "securityAreas", "merged", "events", "created", "modified",
    ];
    const engineOnly = ["summary", "reminded", "reviewRequestedAt", "findingsSentRound", "waitingSince", "mergeRequested", "mergeRefused"];
    expect(Object.keys(fixture).filter((key) => !(declared as string[]).includes(key) && !engineOnly.includes(key))).toEqual([]);
    expect(Object.keys(fixture.verdict!).sort()).toEqual(["at", "commit", "decision", "findings", "round", "securityPass"]);
    expect(Object.keys(fixture.pr!).sort()).toEqual(["base", "number", "url"]);
    expect(Object.keys(fixture.author).sort()).toEqual(["sessionId", "tabId"]);
  });
});

describe("what the window knows of the pipelines", () => {
  it("keeps what it heard while the list was on its way", async () => {
    const { bootIssuePipelines, getIssuePipelines } = await load();
    let answer: (value: IssuePipeline[]) => void = () => {};
    list.mockReturnValue(new Promise<IssuePipeline[]>((resolve) => (answer = resolve)));
    const booting = bootIssuePipelines();
    await vi.waitFor(() => expect(listeners.has("issue_pipeline")).toBe(true));
    // An announcement lands before the list does, and is newer than it.
    listeners.get("issue_pipeline")!({ payload: pipeline({ id: "p1", stage: "review" }) });
    answer([pipeline({ id: "p1", stage: "work" }), pipeline({ id: "p2" })]);
    await booting;
    expect(getIssuePipelines().map((value) => [value.id, value.stage])).toEqual([["p2", "work"], ["p1", "review"]]);
    // Booting twice subscribes once.
    await bootIssuePipelines();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("raises a notice when a pipeline comes to rest, not on every line of its record", async () => {
    const { upsertPipeline, getIssuePipelines } = await load();
    // First heard of: not news, wherever it stands.
    upsertPipeline(pipeline({ state: "needsYou" }));
    expect(notePipelineState).not.toHaveBeenCalled();
    upsertPipeline(pipeline({ state: "needsYou", note: "Another line." }));
    expect(notePipelineState).not.toHaveBeenCalled();
    const ready = pipeline({ stage: "merge", state: "readyToMerge" });
    upsertPipeline(ready);
    expect(notePipelineState).toHaveBeenCalledExactlyOnceWith(ready);
    expect(getIssuePipelines()).toEqual([ready]);
  });

  it("starts, switches and acts through the app and keeps the answer", async () => {
    const { startPipeline, setPipelineAutoMerge, actOnPipeline, getIssuePipelines } = await load();
    start.mockResolvedValue({ pipeline: pipeline({ autoMerge: true }), authorBrief: "End every reply with a status block." });
    const started = await startPipeline("author", "t1", true);
    expect(start).toHaveBeenCalledWith("author", "t1", true);
    expect(started.authorBrief).toBe("End every reply with a status block.");
    expect(getIssuePipelines()[0].autoMerge).toBe(true);

    setAutoMerge.mockResolvedValue(pipeline({ autoMerge: false }));
    await setPipelineAutoMerge("p1", false);
    expect(setAutoMerge).toHaveBeenCalledWith("p1", false);
    expect(getIssuePipelines()[0].autoMerge).toBe(false);

    act.mockResolvedValue(pipeline({ state: "stopped", stopped: true }));
    await actOnPipeline("p1", "stop");
    expect(act).toHaveBeenCalledWith("p1", "stop");
    expect(getIssuePipelines()).toHaveLength(1);
    expect(getIssuePipelines()[0].state).toBe("stopped");
  });
});
