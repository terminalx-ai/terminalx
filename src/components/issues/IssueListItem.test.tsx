import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue, WorkClaim } from "@/lib/api";
import { localWorkers, remoteWorkers, workKeyOf } from "@/lib/issueWork";
import type { IssuePipeline } from "@/types/issuePipeline";
import type { SessionEntry } from "@/types/session";
import { cloudSessionKey } from "@/types/target";
import { IssueListItem } from "./IssueListItem";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));
afterEach(cleanup);
const now = Date.parse("2026-10-18T12:00:00Z");
const issue: Issue = { provider: "github", id: "571", identifier: "#571", number: 571, title: "Work chip", url: "https://github.com/acme/widgets/issues/571", state: "OPEN", stateType: "open", updatedAt: "2026-10-18T12:00:00Z", labels: [] };
const author = cloudSessionKey("org", "ws", "author");
function pipeline(cloud = true): IssuePipeline {
  return { id: "p", projectPath: cloud ? "cloud:org:github.com/acme/widgets" : "/repo", issue, branch: "fix", author: { sessionId: cloud ? author : "author", tabId: "t" }, cloud, autoMerge: false, stopped: false, stage: "work", state: "working", round: 0, maxRounds: 3, securityAreas: [], events: [], created: "", modified: "" };
}
function local(id: string) {
  const session: SessionEntry = { id, projectPath: "/other-clone", cwd: "/other-clone", title: id, issue, created: new Date(now).toISOString(), modified: new Date(now).toISOString(), archived: false, pinned: false, worktreeRemoved: false, tabs: [] };
  return localWorkers([session], issue, now)[0];
}
function remote(title: string, patch: Partial<WorkClaim> = {}) {
  const claim: WorkClaim = { key: title, scope: "github.com/acme/widgets", issue, person: { name: "Me", you: true }, sessionId: author, title, branch: "fix", state: "working", cloud: true, live: true, since: now, lastActiveAt: now, refreshedAt: now, ...patch };
  return remoteWorkers({ available: true, now, liveForSeconds: 300, claims: [claim] }, now, now).get(workKeyOf(issue))![0];
}
function titles() {
  return screen.getAllByTestId("issue-worker").map((row) => row.textContent);
}

describe("pipeline row worker identity", () => {
  it.each([author, "cloud:ws:author"])("omits only its cloud author with claim session %s", (sessionId) => {
    const work = [remote("pipeline author", { sessionId }), local("author"), remote("other cloud", { sessionId: cloudSessionKey("org", "ws", "other") }), remote("other workspace", { sessionId: cloudSessionKey("org", "elsewhere", "author") }), remote("other organization", { sessionId: cloudSessionKey("elsewhere", "ws", "author") }), remote("teammate", { person: { name: "Alice", you: false }, sessionId }), remote("other Mac", { cloud: false, sessionId, device: { id: "mac", label: "Studio" } })];
    render(<IssueListItem issue={issue} pipeline={pipeline()} work={work} now={now} />);
    expect(titles()).toHaveLength(6);
    expect(titles().join(" ")).not.toContain("pipeline author");
    for (const title of ["other cloud", "other workspace", "other organization", "teammate", "other Mac"]) expect(titles().join(" ")).toContain(title);
    expect(screen.getByTestId("issue-work-chip").getAttribute("aria-label")).toContain("You · this Mac");
    expect(work[0].sessionId).toBeNull();
  });

  it("handles legacy claims without an opaque key", () => {
    render(<IssueListItem issue={issue} pipeline={pipeline()} work={[remote("author", { key: null, sessionId: "cloud:ws:author" })]} now={now} />);
    expect(screen.queryByTestId("issue-work-chip")).toBeNull();
  });

  it("keeps a cloud claim without identity even when title and branch match", () => {
    render(<IssueListItem issue={issue} pipeline={pipeline()} work={[remote("author", { sessionId: null })]} now={now} />);
    expect(titles()).toHaveLength(1);
  });

  it("omits only the local author, preserving other local sessions and remote ID collisions", () => {
    render(<IssueListItem issue={issue} pipeline={pipeline(false)} work={[local("author"), local("second"), remote("cloud collision", { sessionId: "author" }), remote("machine collision", { cloud: false, sessionId: "author" }), remote("team collision", { person: { name: "Alice", you: false }, sessionId: "author" })]} now={now} />);
    expect(titles()).toHaveLength(4);
    expect(titles()[0]).toContain("second");
    expect(screen.getByTestId("issue-work-chip").textContent).toContain("+3");
  });

  it("preserves all workers without a pipeline and the linked-session fallback", () => {
    const view = render(<IssueListItem issue={issue} work={[local("author"), remote("cloud author")]} now={now} />);
    expect(titles()).toHaveLength(2);
    view.rerender(<IssueListItem issue={issue} linked />);
    expect(screen.getByText("Session")).toBeTruthy();
    view.rerender(<IssueListItem issue={issue} linked pipeline={pipeline(false)} work={[local("author")]} />);
    expect(screen.queryByText("Session")).toBeNull();
    expect(screen.queryByTestId("issue-work-chip")).toBeNull();
  });
});

describe("pipeline chip (#725)", () => {
  const linear: Issue = { ...issue, provider: "linear", id: "uuid-114", identifier: "PRO-114", number: 114, url: "https://linear.app/acme/issue/PRO-114", state: "In Progress", stateType: "started" };

  it.each([issue, linear])("leaves Needs you as soon as a person answers the author of $identifier, and shows it again if the turn ends not done", (tracked) => {
    const stopped: IssuePipeline = { ...pipeline(false), issue: tracked, stage: "pullRequest", state: "needsYou", reason: { kind: "uncommittedChanges", files: ["notes.txt"] } };
    const view = render(<IssueListItem issue={tracked} pipeline={stopped} now={now} />);
    expect(screen.getByText("Needs you")).toBeTruthy();
    // The pipeline the engine announces when the answer reaches the author.
    view.rerender(<IssueListItem issue={tracked} pipeline={{ ...stopped, state: "working", reason: null, note: "Answered; waiting for the author session to report.", answered: stopped.reason }} now={now} />);
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(screen.getByText("Working")).toBeTruthy();
    view.rerender(<IssueListItem issue={tracked} pipeline={stopped} now={now} />);
    expect(screen.getByText("Needs you")).toBeTruthy();
  });
});
