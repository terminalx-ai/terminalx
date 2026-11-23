import { describe, expect, it } from "vitest";
import type { RuntimeSession } from "@terminalx/portable/workspace";
import type { Issue, WorkClaimsAnswer } from "@/lib/api";
import { projectCloudSessions } from "@/lib/cloudDashboard";
import { cloudPipelineView } from "@/lib/cloudPipelines";
import type { CloudCatalogState } from "@/lib/cloudCatalog";
import { cloudWorkers, mine, remoteWorkers, taken, unavailableText, workersByIssue, workKeyOf, workToWarnAbout, type CloudWorkInput } from "./issueWork";

const now = Date.parse("2026-10-23T10:00:00Z");
const projectPath = "cloud:org:github.com/acme/api";
const key = "cloud:org:ws:author";
const issue: Issue = { provider: "github", id: "12", identifier: "#12", number: 12, title: "Fix", url: "https://github.com/acme/api/issues/12", state: "OPEN", stateType: "open", labels: [], updatedAt: new Date(now).toISOString() };
const session: RuntimeSession = { id: "author", projectPath: "/repo", cwd: "/repo", title: "Fix", created: new Date(now).toISOString(), modified: new Date(now).toISOString(), archived: false, pinned: false, tabs: [], issue };
function world(): CloudWorkInput {
  const catalog = {
    owner: "me@example.com", revision: "r", loaded: true, createMemory: {}, notices: [],
    orgs: { org: { orgId: "org", source: "live", workspaces: [{ workspace: { id: "ws", orgId: "org", name: "API", state: "ready", createdBy: "me", repositories: [{ identity: "github.com/acme/api", fullName: "acme/api", primary: true }] } }], sessions: { ws: { sessions: [session], at: now, capabilities: [] } } } },
  } as unknown as CloudCatalogState;
  const input: CloudWorkInput = { projectPath, windowStartedAt: now - 1000, catalog, organizations: ["org"], sessions: [], pipelines: [], reviewers: new Set(), started: [], liveSessions: () => null, readerId: () => "me" };
  input.sessions = projectCloudSessions({ orgs: [{ id: "org", name: "Org" }], catalog, liveSessions: () => null, agentTabs: () => [], connected: () => true });
  return input;
}
function pipeline() {
  return cloudPipelineView({ id: "p", issue, author: { sessionId: "author", tabId: "a" }, reviewer: { sessionId: "reviewer", tabId: "r" }, state: "working", stage: "work", created: session.created, modified: session.modified, branch: "fix", events: [] } as never, { orgId: "org", workspaceId: "ws", identity: "github.com/acme/api", readAt: now });
}
const workers = (input: CloudWorkInput, at = now) => cloudWorkers(input, at).get(workKeyOf(issue)) ?? [];

describe("known cloud issue authors", () => {
  it("counts one author across dashboard, pipeline and arriving claims, with filters and warnings agreeing", () => {
    const input = world();
    input.pipelines = [pipeline()];
    const cloud = cloudWorkers(input, now);
    const answer: WorkClaimsAnswer = { available: true, now, liveForSeconds: 300, claims: [{ key: "opaque", scope: "github.com/acme/api", issue, person: { you: true, name: "Me" }, cloud: true, sessionId: "cloud:ws:author", title: "Fix", state: "working", live: true, since: now, lastActiveAt: now, refreshedAt: now }] };
    for (const remote of [new Map(), remoteWorkers(answer, now, now)]) {
      const found = workersByIssue([issue], [], remote, now, cloud).get(workKeyOf(issue));
      expect(found).toHaveLength(1);
      expect(mine(found)).toBe(true);
      expect(taken(found)).toBe(true);
      expect(workToWarnAbout(found)).toHaveLength(1);
      expect(found![0]).toMatchObject({ sessionId: null, cloudSession: { key, tabId: "a" } });
    }
    expect(unavailableText({ ...answer, available: false }, true)).toContain("this computer and your known cloud sessions");
  });

  it.each(["cloud:ws:author", key])("keeps live account evidence and cloud navigation when deduplicating %s", (sessionId) => {
    const input = world();
    input.pipelines = [pipeline()];
    input.sessions = input.sessions.map((row) => ({ ...row, connected: false, fresh: false, reportedAt: null }));
    const cloud = cloudWorkers(input, now);
    expect(taken(cloud.get(workKeyOf(issue)))).toBe(false);
    const answer: WorkClaimsAnswer = { available: true, now, liveForSeconds: 300, claims: [{ key: "opaque", scope: "github.com/acme/api", issue, person: { you: true, name: "Me" }, cloud: true, sessionId, title: "Fix", state: "working", live: true, since: now - 1000, lastActiveAt: now + 1000, refreshedAt: now + 1000 }] };
    const found = workersByIssue([issue], [], remoteWorkers(answer, now, now), now, cloud).get(workKeyOf(issue));
    expect(found).toHaveLength(1);
    expect(found![0]).toMatchObject({ state: "working", phase: "now", lastActive: now + 1000, sessionId: null, cloudSession: { key, tabId: "a" } });
    expect(mine(found)).toBe(true);
    expect(taken(found)).toBe(true);
    expect(workToWarnAbout(found)).toHaveLength(1);
    expect(taken(cloud.get(workKeyOf(issue)))).toBe(false); // Merging leaves the source projection untouched.

    // A live claim still matters when its last activity predates the faded cache.
    answer.claims[0].lastActiveAt = now - 1000;
    expect(taken(workersByIssue([issue], [], remoteWorkers(answer, now, now), now, cloud).get(workKeyOf(issue)))).toBe(true);
    // Conversely, an offline claim cannot erase live window evidence.
    answer.claims[0].live = false;
    answer.claims[0].lastActiveAt = now + 1000;
    const live = cloudWorkers(world(), now);
    expect(taken(workersByIssue([issue], [], remoteWorkers(answer, now, now), now, live).get(workKeyOf(issue)))).toBe(true);
    // When both sources are live, preserve the newer window state.
    answer.claims[0].live = true;
    answer.claims[0].lastActiveAt = now - 1000;
    expect(workersByIssue([issue], [], remoteWorkers(answer, now, now), now, live).get(workKeyOf(issue))![0].state).toBe("idle");
  });

  it("does not resurrect an observed deleted author when the workspace pipeline cache advances", () => {
    const input = world();
    input.pipelines = [pipeline()];
    input.observed = new Set([key]);
    expect(workers(input)).toHaveLength(1);
    // The live list overrides even a stale dashboard row and cached session.
    input.liveSessions = () => [];
    expect(workers(input)).toEqual([]);
    input.sessions = [];
    input.catalog.orgs.org.sessions.ws = { sessions: [], at: now + 1, capabilities: [] };
    for (const readAt of [now + 2, now + 1000, now + 10000]) {
      input.pipelines = [{ ...pipeline(), place: { ...pipeline().place!, readAt } }];
      // Pipeline updates elsewhere advance readAt, but identical empty lists
      // retain their original cache timestamp.
      const found = workers(input, readAt);
      expect(found).toEqual([]);
      expect(mine(found)).toBe(false);
      expect(taken(found)).toBe(false);
      expect(workToWarnAbout(found)).toEqual([]);
    }
    input.liveSessions = () => null; // The last authoritative list still says gone after disconnect.
    expect(workers(input, now + 10000)).toEqual([]);
    input.liveSessions = () => [session]; // Only actual session evidence can restore the author.
    expect(workers(input, now + 10000)).toHaveLength(1);
  });

  it("excludes an author deleted before Issues opens despite later workspace pipeline refreshes", () => {
    const input = world();
    // No prior projection or observed set: deletion happened with Issues closed.
    input.sessions = [];
    input.liveSessions = () => [];
    input.catalog.orgs.org.sessions.ws = { sessions: [], at: now - 1000, capabilities: [] };
    const deleted = { ...pipeline(), created: new Date(now - 60000).toISOString() };
    for (const readAt of [now, now + 1000, now + 60000, now + 120000]) {
      input.pipelines = [{ ...deleted, modified: new Date(readAt).toISOString(), place: { ...deleted.place!, readAt } }];
      const found = workers(input, readAt);
      expect(found).toEqual([]);
      expect(mine(found)).toBe(false);
      expect(taken(found)).toBe(false);
      expect(workToWarnAbout(found)).toEqual([]);
    }
    input.liveSessions = () => null; // The same authoritative cached absence survives disconnect.
    expect(workers(input, now + 120000)).toEqual([]);
  });

  it("bounds unseen pending authors by their start rather than shared pipeline refreshes", () => {
    const input = world();
    input.sessions = [];
    input.liveSessions = () => [];
    input.catalog.orgs.org.sessions.ws = { sessions: [], at: now - 1000, capabilities: [] };
    input.pipelines = [pipeline()];
    expect(workers(input)).toHaveLength(1); // A new author can precede its index entry.
    for (const readAt of [now + 45000, now + 90000]) {
      input.pipelines = [{ ...pipeline(), modified: new Date(readAt).toISOString(), place: { ...pipeline().place!, readAt } }];
      expect(workers(input, readAt)).toEqual([]);
    }
    input.liveSessions = () => [session];
    expect(workers(input, now + 90000)).toHaveLength(1);
  });

  it("keeps a pending visible pipeline author until a newer session list removes it", () => {
    const input = world();
    input.sessions = [];
    input.catalog.orgs.org.sessions.ws.sessions = [];
    input.catalog.orgs.org.sessions.ws.at = now - 1;
    input.pipelines = [pipeline()];
    expect(workers(input)).toHaveLength(1);
    input.windowStartedAt = now + 1;
    expect(taken(workers(input))).toBe(false); // Saved pipeline state from a previous launch.
    input.windowStartedAt = now - 1000;
    input.catalog.orgs.org.sessions.ws.at = now + 1;
    expect(workers(input)).toHaveLength(1); // A newer index can still be settling.
    input.observed = new Set([key]);
    expect(workers(input)).toEqual([]);
  });

  it("counts a successful start before dashboard and pipeline publication, then removes deleted or archived starts", () => {
    const input = world();
    input.readerId = () => null;
    input.sessions = [];
    input.catalog.orgs.org.sessions.ws.sessions = [];
    input.catalog.orgs.org.sessions.ws.at = now - 1;
    expect(workers(input)).toEqual([]); // A rejected start records nothing.
    input.started = [{ key, issue, projectPath, at: now }];
    expect(mine(workers(input))).toBe(true);
    expect(taken(workers(input))).toBe(true);
    input.catalog.orgs.org.sessions.ws = { sessions: [{ ...session, archived: true }], at: now + 1, capabilities: [] };
    expect(workers(input)).toEqual([]);
    input.catalog.orgs.org.sessions.ws.sessions = [];
    input.observed = new Set([key]);
    expect(workers(input)).toEqual([]);
  });

  it("never counts reviewers, teammates, signed-out organizations or stale cached working as live work", () => {
    const input = world();
    input.reviewers = new Set([key]);
    expect(workers(input)).toEqual([]);
    input.reviewers = new Set();
    input.readerId = () => "teammate";
    expect(workers(input)).toEqual([]);
    input.readerId = () => "me";
    input.organizations = [];
    expect(workers(input)).toEqual([]);
    input.organizations = ["org"];
    input.sessions = input.sessions.map((row) => ({ ...row, connected: false, reportedAt: null, fresh: false, tabs: [{ tabId: "a", harness: "claude", title: null, status: "in_progress", requestIds: [], waitingOn: null, from: "cache" }] }));
    expect(taken(workers(input))).toBe(false);
    input.sessions = input.sessions.map((row) => ({ ...row, fresh: true, tabs: row.tabs.map((tab) => ({ ...tab, status: "waiting" })) }));
    expect(taken(workers(input))).toBe(false); // A new catalog fetch cannot revive cached waits.
  });

  it("keeps equal session IDs in two organizations distinct when both catalogs are populated", () => {
    const input = world();
    input.organizations = ["org", "other"];
    input.catalog.orgs.other = {
      ...input.catalog.orgs.org,
      orgId: "other",
      workspaces: input.catalog.orgs.org.workspaces.map((item) => ({ ...item, workspace: { ...item.workspace, orgId: "other" } })),
    };
    input.sessions = [...input.sessions, ...input.sessions.map((row) => ({ ...row, orgId: "other", key: "cloud:other:ws:author", projectKey: "cloud:other:github.com/acme/api" }))];
    expect(workers(input).map((worker) => worker.cloudSession?.key)).toEqual([key]);
    expect(workers(input)[0].legacyCloudClaimId).toBeUndefined(); // An org-less claim is ambiguous here.
    input.projectPath = "cloud:other:github.com/acme/api";
    expect(workers(input).map((worker) => worker.cloudSession?.key)).toEqual(["cloud:other:ws:author"]);
  });

  it("keeps organization, workspace, provider and repository identities separate", () => {
    const input = world();
    input.started = [{ key: "cloud:other:ws:author", projectPath: "cloud:other:github.com/acme/api", issue, at: now }];
    expect(workers(input)).toHaveLength(1);
    input.projectPath = "cloud:other:github.com/acme/api";
    expect(workers(input)).toEqual([]);
    input.projectPath = projectPath;
    input.catalog.orgs.org.sessions.ws.sessions = [{ ...session, issue: { ...issue, url: "https://github.com/other/api/issues/12" } }];
    expect(workers(input)).toEqual([]);
    input.catalog.orgs.org.sessions.ws.sessions = [{ ...session, issue: { ...issue, provider: "linear", url: "https://linear.app/acme/issue/ENG-12", identifier: "ENG-12" } }];
    expect(workers(input)).toEqual([]);
  });
});
