import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssuePipeline } from "@/types/issuePipeline";

// #433, the cloud half: a cloud workspace's pipeline on its issue's page. It
// has no switch to merge by itself; Merge is made here, with the reader's own
// gh, and everything else is asked of the workspace's runtime.

const { cloud, openCloudSession, workspaceState } = vi.hoisted(() => ({
  cloud: {
    actOnCloudPipeline: vi.fn(),
    lookAtCloudPipeline: vi.fn(),
    mergeCloudPipeline: vi.fn(),
  },
  openCloudSession: vi.fn(),
  workspaceState: { value: "ready" },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notePipelineState: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ selectSession: vi.fn(), useSessionStore: () => ({ projects: [], sessions: [] }) }));
vi.mock("@/lib/cloudDashboard", () => ({ openCloudSession }));
vi.mock("@/lib/cloudCatalog", () => ({
  useCloudCatalog: () => ({}),
  findCloudWorkspace: () => ({ workspace: { id: "ws-1", orgId: "org-a", state: workspaceState.value } }),
}));
vi.mock("@/lib/cloudPipelines", () => ({ ...cloud, getCloudPipelines: () => [], subscribeCloudPipelines: () => () => {} }));

const { IssuePipelinePanel } = await import("./IssuePipelinePanel");
const { setPrefs } = await import("@/lib/prefs");

const C1 = "1111111111111111111111111111111111111111";
const PROJECT = "cloud:org-a:github.com/acme/api";

function pipeline(patch: Partial<IssuePipeline> = {}): IssuePipeline {
  return {
    id: "p1", projectPath: PROJECT, cloud: true,
    place: { orgId: "org-a", workspaceId: "ws-1", projectKey: PROJECT, repository: "acme/api", readAt: Date.now() - 5 * 60 * 1000 },
    issue: { provider: "github", id: "433", identifier: "#433", title: "Carry issue sessions on", url: "https://github.com/acme/api/issues/433" },
    branch: "raccoon/433-carry",
    author: { sessionId: "cloud:org-a:ws-1:s1", tabId: "t1" }, reviewer: { sessionId: "cloud:org-a:ws-1:s2", tabId: "t2" },
    autoMerge: false, stopped: false, stage: "merge", state: "readyToMerge",
    reason: { kind: "cloudWorkspace" }, note: "Reviewed, checks passed. A cloud workspace does not merge by itself: merge it from the issue page, with your own GitHub sign-in, or on GitHub.",
    pr: { number: 7, url: "https://github.com/acme/api/pull/7", base: "main" },
    round: 1, maxRounds: 3, reviewCommit: C1,
    verdict: { commit: C1, decision: "merge", securityPass: "notNeeded", findings: [], round: 1, at: "2026-10-18T10:05:00.000Z" },
    securityAreas: [], merged: null,
    events: [{ at: "2026-10-18T10:00:00.000Z", stage: "work", kind: "started", message: "Session started on #433.", sessionId: "cloud:org-a:ws-1:s1" }],
    created: "2026-10-18T10:00:00.000Z", modified: "2026-10-18T10:05:00.000Z",
    ...patch,
  };
}

beforeEach(() => {
  for (const fn of Object.values(cloud)) fn.mockReset().mockResolvedValue(undefined);
  cloud.mergeCloudPipeline.mockResolvedValue(null);
  openCloudSession.mockReset();
  workspaceState.value = "ready";
  setPrefs({ cloudIssuePipelines: {} });
});

afterEach(cleanup);

describe("a cloud workspace's pipeline on its issue's page", () => {
  it("has no switch to merge by itself, and says who merges", () => {
    render(<IssuePipelinePanel pipeline={pipeline()} />);
    expect(screen.queryByRole("switch", { name: "Merge when green" })).toBeNull();
    expect(screen.getByTestId("pipeline-cloud-merge").textContent).toContain("Merge here uses your own GitHub sign-in");
    expect(screen.getByText("Ready to merge")).toBeTruthy();
  });

  it("merges here, with the project's own settings, and says why when nothing was merged", async () => {
    setPrefs({ cloudIssuePipelines: { [PROJECT]: { enabled: true, autoMerge: true, requirePerson: true, maxRounds: 2, mergeMethod: "squash", protected: { migrations: true, deploy: true, security: true, paths: [] }, ignoredChecks: ["flaky"] } } });
    render(<IssuePipelinePanel pipeline={pipeline()} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(cloud.mergeCloudPipeline).toHaveBeenCalledTimes(1));
    const [merged, settings] = cloud.mergeCloudPipeline.mock.calls[0];
    expect(merged.id).toBe("p1");
    // The switches that decide a merge by itself never apply to one.
    expect(settings).toMatchObject({ mergeMethod: "squash", ignoredChecks: ["flaky"], autoMerge: false, requirePerson: false });
    expect(cloud.actOnCloudPipeline).not.toHaveBeenCalled();

    cloud.mergeCloudPipeline.mockResolvedValue("Checks are still running on 1111111111: build.");
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(await screen.findByText("Checks are still running on 1111111111: build.")).toBeTruthy();
  });

  it("asks its runtime for everything else, and opens its sessions in the cloud", async () => {
    render(<IssuePipelinePanel pipeline={pipeline()} />);
    // Opening the issue looks at its pull request, in the runtime and only while it runs.
    await waitFor(() => expect(cloud.lookAtCloudPipeline).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(cloud.actOnCloudPipeline).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), "stop"));
    const panel = within(screen.getByTestId("issue-pipeline"));
    fireEvent.click(panel.getByRole("button", { name: "Author session" }));
    fireEvent.click(panel.getByRole("button", { name: "Reviewer session" }));
    expect(openCloudSession.mock.calls).toEqual([["cloud:org-a:ws-1:s1", "t1"], ["cloud:org-a:ws-1:s2", "t2"]]);
  });

  it("says when its workspace is asleep that what it shows is from the last read", () => {
    workspaceState.value = "suspended";
    render(<IssuePipelinePanel pipeline={pipeline({ stage: "review", state: "working", reason: null, note: "Review 1 of 3: the reviewer session is reading 1111111111." })} />);
    const asleep = screen.getByTestId("pipeline-asleep").textContent ?? "";
    expect(asleep).toContain("asleep");
    expect(asleep).toContain("5m ago");
    // Merged, there is nothing left to wait for.
    cleanup();
    render(<IssuePipelinePanel pipeline={pipeline({ state: "merged", merged: { commit: C1, at: "2026-10-18T11:00:00.000Z", by: "person" } })} />);
    expect(screen.queryByTestId("pipeline-asleep")).toBeNull();
    expect(screen.queryByTestId("pipeline-cloud-merge")).toBeNull();
  });
});
