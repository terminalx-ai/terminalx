import { describe, expect, it } from "vitest";
import type { Issue, WorkClaim, WorkClaimsAnswer } from "@/lib/api";
import type { SessionEntry } from "@/types/session";
import {
  FORGET_MS,
  RECENT_MS,
  issueScope,
  issueWorkKey,
  localWorkers,
  mine,
  remoteWorkers,
  taken,
  unavailableText,
  warningText,
  workToWarnAbout,
  workerLabel,
  workKeyOf,
  workersByIssue,
} from "@/lib/issueWork";

const NOW = Date.parse("2026-10-18T12:00:00Z");
/** acme/widgets#441, as every map below is keyed. */
const K = "github:github.com/acme/widgets:#441";
const MIN = 60 * 1000;

function session(patch: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: "s1",
    projectPath: "/repo",
    cwd: "/repo",
    branch: "raccoon/441-work",
    worktreeRemoved: false,
    issue: { provider: "github", id: "441", identifier: "#441", title: "Work status", url: "https://github.com/acme/widgets/issues/441" },
    title: "#441 Work status",
    created: new Date(NOW - 60 * MIN).toISOString(),
    modified: new Date(NOW - 5 * MIN).toISOString(),
    archived: false,
    pinned: false,
    tabs: [],
    ...patch,
  };
}

function issue(patch: Partial<Issue> = {}): Issue {
  return { provider: "github", id: "441", identifier: "#441", number: 441, title: "Work status", url: "https://github.com/acme/widgets/issues/441", state: "OPEN", stateType: "open", labels: [], updatedAt: "2026-10-18T10:00:00Z", ...patch };
}

function claim(patch: Partial<WorkClaim> = {}): WorkClaim {
  return {
    scope: "github.com/acme/widgets",
    issue: { provider: "github", id: "441", identifier: "#441" },
    person: { name: "Alice", you: false },
    title: "Alice's session",
    branch: "alice/441",
    state: "working",
    cloud: false,
    live: true,
    since: NOW - 90 * MIN,
    lastActiveAt: NOW - 2 * MIN,
    refreshedAt: NOW - 30 * 1000,
    ...patch,
  };
}

/** An answer read just now, on a server whose clock is `skew` ahead of this Mac's. */
function answer(claims: WorkClaim[], skew = 0): WorkClaimsAnswer {
  return { available: true, now: NOW + skew, liveForSeconds: 300, claims: claims.map((each) => ({ ...each, since: each.since + skew, lastActiveAt: each.lastActiveAt + skew, refreshedAt: each.refreshedAt + skew })) };
}

describe("who works on an issue", () => {
  it("names an issue the same way from every machine: where it lives, then its number", () => {
    expect(issueScope("github", "https://github.com/Acme/Widgets/issues/441")).toBe("github.com/acme/widgets");
    expect(issueScope("linear", "https://linear.app/Acme/issue/ENG-42/fix-login")).toBe("linear.app/acme");
    expect(issueScope("github", "https://github.com/acme/widgets/pull/12")).toBe(null);
    expect(issueScope("github", "https://ghe.example.com/acme/widgets/issues/1")).toBe(null);
    expect(issueWorkKey("github", "github.com/acme/widgets", "441")).toBe(K);
    expect(workKeyOf({ provider: "github", identifier: "#441", url: "https://github.com/Acme/Widgets/issues/441" })).toBe(K);
    expect(workKeyOf({ provider: "linear", identifier: "eng-42", url: "https://linear.app/acme/issue/ENG-42" })).toBe("linear:linear.app/acme:ENG-42");
  });

  it("never takes another repository's issue of the same number for this one", () => {
    const elsewhere = session({ id: "other", projectPath: "/other", issue: { provider: "github", id: "441", identifier: "#441", title: "Another", url: "https://github.com/other/repo/issues/441" } });
    expect(localWorkers([elsewhere], issue(), NOW)).toEqual([]);
    expect(workersByIssue([issue()], [elsewhere], new Map(), NOW).size).toBe(0);
    const remote = remoteWorkers(answer([claim({ scope: "github.com/other/repo" })]), NOW, NOW);
    expect(workersByIssue([issue()], [], remote, NOW).size).toBe(0);
    // The same repository spelled in another case is the same issue.
    expect(localWorkers([session({ issue: { ...session().issue!, url: "https://github.com/Acme/Widgets/issues/441" } })], issue(), NOW)).toHaveLength(1);
  });

  it("shows this Mac's linked sessions, working now or a while ago", () => {
    const working = localWorkers([session({ tabs: [{ id: "t", harness: "claude", status: "in_progress", created: "", modified: "" } as never] })], issue(), NOW);
    expect(working.map((worker) => [worker.place, worker.state, worker.phase, worker.sessionId])).toEqual([["this", "working", "now", "s1"]]);
    const idle = localWorkers([session({ modified: new Date(NOW - RECENT_MS - MIN).toISOString() })], issue(), NOW);
    expect(idle[0].phase).toBe("faded");
    expect(localWorkers([session({ archived: true }), session({ kind: "quick" }), session({ issue: null })], issue(), NOW)).toEqual([]);
  });

  it("measures a claim's age on the server's clock, so a skewed Mac clock does not age it", () => {
    const workers = remoteWorkers(answer([claim({ state: "idle", lastActiveAt: NOW - 10 * MIN })], 3 * 60 * MIN), NOW, NOW).get(K)!;
    expect(workers[0].lastActive).toBe(NOW - 10 * MIN);
    expect(workers[0].phase).toBe("now");
  });

  it("fades work idle for half an hour, never shows an offline machine as working now, and forgets it after a day", () => {
    const read = (each: WorkClaim) => remoteWorkers(answer([each]), NOW, NOW).get(K)?.[0]?.phase ?? null;
    expect(read(claim())).toBe("now");
    expect(read(claim({ state: "idle", lastActiveAt: NOW - RECENT_MS - MIN }))).toBe("faded");
    // Offline: its last state was "working", and it shows only as "was working".
    expect(read(claim({ live: false }))).toBe("faded");
    expect(read(claim({ state: "idle", live: false, lastActiveAt: NOW - FORGET_MS - MIN }))).toBe(null);
  });

  it("says where the reader's own work is, and never a teammate's machine", () => {
    const workers = remoteWorkers(
      answer([
        claim({ person: { name: "Me", you: true }, device: { id: "studio", label: "Studio" }, sessionId: "s9" }),
        claim({ person: { name: "Me", you: true }, cloud: true, sessionId: "cloud:ws:c1" }),
        claim(),
      ]),
      NOW,
      NOW,
    ).get(K)!;
    expect(workers.map((worker) => workerLabel(worker, NOW))).toEqual(["You · on Studio", "You · in the cloud", "Alice · working"]);
    expect(workers[2].machine).toBe(null);
  });

  it("shows a teammate's cloud session once though each of their machines publishes it", () => {
    const cloud = { cloud: true, key: "same-session" };
    const workers = remoteWorkers(answer([claim({ ...cloud, since: NOW - 50 * MIN, lastActiveAt: NOW - 5 * MIN }), claim({ ...cloud, since: NOW - 40 * MIN, lastActiveAt: NOW - MIN }), claim({ key: "another-session" })]), NOW, NOW).get(K)!;
    expect(workers.map((worker) => worker.lastActive)).toEqual([NOW - MIN, NOW - 2 * MIN]);
  });

  it("shows a cloud session once though each of the reader's machines publishes it", () => {
    const cloud = { person: { name: "Me", you: true }, cloud: true, sessionId: "cloud:ws:c1" };
    const workers = remoteWorkers(answer([claim({ ...cloud, device: { id: "a", label: "A" }, lastActiveAt: NOW - 9 * MIN }), claim({ ...cloud, device: { id: "b", label: "B" }, lastActiveAt: NOW - MIN })]), NOW, NOW).get(K)!;
    expect(workers).toHaveLength(1);
    expect(workers[0].lastActive).toBe(NOW - MIN);
  });

  it("reads an unknown state as idle and an unavailable answer as nothing", () => {
    expect(remoteWorkers(answer([claim({ state: "reviewing" })]), NOW, NOW).get(K)![0].state).toBe("idle");
    expect(remoteWorkers({ available: false, reason: "signed_out", now: NOW, liveForSeconds: 300, claims: [claim()] }, NOW, NOW).size).toBe(0);
  });

  it("puts work now before work a while ago, and others before this Mac; a closed issue shows nobody", () => {
    const remote = remoteWorkers(answer([claim(), claim({ person: { name: "Bob", you: false }, state: "idle", live: false, since: NOW - 300 * MIN })]), NOW, NOW);
    const byIssue = workersByIssue([issue(), issue({ id: "12", identifier: "#12", url: "https://github.com/acme/widgets/issues/12" })], [session()], remote, NOW);
    expect(byIssue.get(K)!.map((worker) => worker.person)).toEqual(["Alice", "You", "Bob"]);
    expect(byIssue.has("github:#12")).toBe(false);
    expect(workersByIssue([issue({ state: "Closed", stateType: "completed" })], [session()], remote, NOW).size).toBe(0);
  });

  it("filters by whether anyone works on an issue now, and whether the reader does", () => {
    const remote = remoteWorkers(answer([claim()]), NOW, NOW);
    const alice = workersByIssue([issue()], [], remote, NOW).get(K);
    expect([taken(alice), mine(alice)]).toEqual([true, false]);
    const mineOnly = workersByIssue([issue()], [session({ modified: new Date(NOW - 2 * 60 * MIN).toISOString() })], new Map(), NOW).get(K);
    expect([taken(mineOnly), mine(mineOnly)]).toEqual([false, true]);
    expect(taken(undefined)).toBe(false);
  });

  it("warns, before a session starts, about who works on it, where and since when", () => {
    const remote = remoteWorkers(answer([claim(), claim({ person: { name: "Me", you: true }, device: { id: "d", label: "Studio" }, branch: null, state: "idle", lastActiveAt: NOW - 3 * 60 * MIN })]), NOW, NOW);
    const warned = workToWarnAbout(workersByIssue([issue()], [], remote, NOW).get(K));
    expect(warned.map((worker) => worker.person)).toEqual(["Alice"]);
    expect(warningText(warned[0], NOW)).toMatch(/^Alice has been working on this since .+, on branch alice\/441\.$/);
    const own = remoteWorkers(answer([claim({ person: { name: "Me", you: true }, device: { id: "d", label: "Studio" }, branch: null })]), NOW, NOW).get(K)![0];
    expect(warningText(own, NOW)).toMatch(/^You have been working on this on Studio since [^,]+\.$/);
  });

  it("says why only this Mac is shown", () => {
    expect(unavailableText(null)).toBe(null);
    expect(unavailableText(answer([]))).toBe(null);
    expect(unavailableText({ available: false, reason: "signed_out", now: NOW, liveForSeconds: 300, claims: [] })).toMatch(/^Sign in/);
    expect(unavailableText({ available: false, reason: "offline", now: NOW, liveForSeconds: 300, claims: [] })).toMatch(/offline/);
    expect(unavailableText({ available: false, reason: "unsupported", now: NOW, liveForSeconds: 300, claims: [] })).toMatch(/unavailable/);
  });
});
