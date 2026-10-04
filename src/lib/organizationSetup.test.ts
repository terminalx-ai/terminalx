import { beforeEach, describe, expect, it } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { forgetSetups, loadSetups, newSetup, reconcileSetup, resendable, saveSetup, setupFor, unfinishedCreation, unsettledRequest, type OrganizationSetupRecord, type SetupFacts } from "./organizationSetup";

const USER = "owner@example.test";
const record = (patch: Partial<OrganizationSetupRecord> = {}): OrganizationSetupRecord => ({ ...newSetup("Team", "request-1", 1), organizationId: "org-1", step: "compute", ...patch });
const facts = (patch: Partial<SetupFacts> = {}): SetupFacts => ({ activeOrganizationId: "org-1", compute: true, repository: true, workspaces: [], ...patch });
const workspace = (patch: Record<string, unknown> = {}): CloudWorkspaceListItem =>
  ({ workspace: { id: "ws-1", state: "ready", runtimeActivity: { online: true, reportedAt: 1, activeTurns: 0, pendingApprovals: 0 }, launch: { category: null, sessionId: "s-1" }, ...patch }, latestOperation: null }) as unknown as CloudWorkspaceListItem;
const withWorkspace = (patch: Partial<OrganizationSetupRecord> = {}) => record({ step: "runtime", workspace: { pending: null, id: "ws-1" }, ...patch });

beforeEach(() => localStorage.clear());

describe("the setup record", () => {
  it("is kept per user and per creation request, versioned, and carries the original request id", () => {
    saveSetup(USER, record());
    saveSetup(USER, record({ requestId: "request-2", organizationId: "org-2" }));
    saveSetup(USER, record({ step: "repository" }));
    expect(loadSetups(USER).map((r) => [r.requestId, r.organizationId, r.step])).toEqual([
      ["request-2", "org-2", "compute"],
      ["request-1", "org-1", "repository"],
    ]);
    expect(loadSetups("someone@else.test")).toEqual([]);
    expect(JSON.parse(localStorage.getItem("terminalx.organization-setup.v2.owner%40example%2Etest")!).v).toBe(2);
  });

  it("drops a record of another version or shape instead of guessing", () => {
    localStorage.setItem("terminalx.organization-setup.v2.owner%40example%2Etest", JSON.stringify({ v: 2, records: [record(), { ...record(), v: 3 }, { name: "x" }] }));
    expect(loadSetups(USER)).toHaveLength(1);
    localStorage.setItem("terminalx.organization-setup.v2.owner%40example%2Etest", JSON.stringify({ v: 9, records: [record()] }));
    expect(loadSetups(USER)).toEqual([]);
  });

  it("is found only by its own organization's id", () => {
    const records = [record(), record({ requestId: "request-2", organizationId: null, step: "create" })];
    expect(setupFor(records, "org-1")?.requestId).toBe("request-1");
    expect(setupFor(records, "org-other")).toBeNull();
    expect(setupFor(records, null)).toBeNull();
  });

  it("resumes a creation that is unconfirmed or unselected, not an organization the person switched away from", () => {
    expect(unfinishedCreation([record({ organizationId: null, step: "create" })], "org-other")?.requestId).toBe("request-1");
    expect(unfinishedCreation([record({ step: "select" })], "org-other")?.requestId).toBe("request-1");
    expect(unfinishedCreation([record({ step: "runtime" })], "org-other")).toBeNull();
    expect(unfinishedCreation([record({ step: "runtime" })], "org-1")).toBeNull();
    // Nothing is selected at all: an incomplete setup is offered again, a complete one is not.
    expect(unfinishedCreation([record({ step: "runtime" })], null)?.requestId).toBe("request-1");
    expect(unfinishedCreation([record({ step: "done", completedAt: 5 })], null)).toBeNull();
  });

  it("forgets the record of an organization the user left", () => {
    saveSetup(USER, record());
    saveSetup(USER, record({ requestId: "request-2", organizationId: "org-2" }));
    forgetSetups(USER, (organizationId) => organizationId === "org-1");
    expect(loadSetups(USER).map((r) => r.organizationId)).toEqual(["org-2"]);
  });
});

describe("reconciling against the server", () => {
  const step = (r: OrganizationSetupRecord, f: SetupFacts) => reconcileSetup(r, f, 99).step;

  it("walks the steps in order from what the server says, whatever step was stored", () => {
    expect(step(record({ organizationId: null, step: "create" }), facts())).toBe("create");
    expect(step(record({ step: "agent" }), facts({ activeOrganizationId: "org-other" }))).toBe("select");
    expect(step(record({ step: "agent" }), facts({ compute: false }))).toBe("compute");
    expect(step(record(), facts({ repository: false }))).toBe("repository");
    expect(step(record(), facts())).toBe("workspace");
  });

  it("gates completion on a healthy runtime, a cloned repository and a working agent", () => {
    expect(step(withWorkspace(), facts({ workspaces: [workspace({ state: "provisioning" })] }))).toBe("runtime");
    expect(step(withWorkspace(), facts({ workspaces: [workspace({ runtimeActivity: { online: false } })] }))).toBe("runtime");
    expect(step(withWorkspace(), facts({ workspaces: [workspace({ launch: { category: "repository-sync-failed", sessionId: null } })] }))).toBe("runtime");
    for (const category of ["repository-clone-failed", "repository-access-denied", "repository-branch-not-found", "repository-clone-timed-out", "repository-path-occupied", "repository-empty", "workspace-disk-full"]) {
      expect(step(withWorkspace(), facts({ workspaces: [workspace({ launch: { category, sessionId: null } })] }))).toBe("runtime");
    }
    expect(step(withWorkspace(), facts({ workspaces: [workspace({ launch: { category: "agent-start-failed", sessionId: null } })] }))).toBe("agent");
    expect(step(withWorkspace(), facts({ workspaces: [workspace({ launch: { category: null, sessionId: null } })] }))).toBe("agent");
    const done = reconcileSetup(withWorkspace(), facts({ workspaces: [workspace()] }), 99);
    expect([done.step, done.completedAt]).toEqual(["done", 99]);
  });

  it("completes without an agent only when terminal-only was chosen, and still needs the runtime and the clone", () => {
    const terminalOnly = withWorkspace({ agent: "terminal-only" });
    expect(step(terminalOnly, facts({ workspaces: [workspace({ launch: null })] }))).toBe("done");
    expect(step(terminalOnly, facts({ workspaces: [workspace({ state: "provisioning", launch: null })] }))).toBe("runtime");
    expect(step(withWorkspace(), facts({ workspaces: [workspace({ launch: null })] }))).toBe("agent");
  });

  it("holds its place when the server cannot be read, and never advances on an unknown", () => {
    const unknown = facts({ compute: null, repository: null, workspaces: null });
    expect(reconcileSetup(withWorkspace({ step: "agent" }), unknown)).toEqual(withWorkspace({ step: "agent" }));
    expect(step(record({ step: "compute" }), unknown)).toBe("compute");
    expect(step(record({ step: "repository" }), facts({ repository: null }))).toBe("repository");
    expect(step(withWorkspace({ step: "workspace" }), facts({ workspaces: null }))).toBe("runtime");
  });

  it("asks for a workspace again only when the list is known and no longer has it, and forgets nothing by itself", () => {
    const gone = reconcileSetup(withWorkspace(), facts({ workspaces: [] }));
    expect([gone.step, gone.workspace]).toEqual(["workspace", { pending: null, id: "ws-1" }]);
    // Listed again (the list was only behind): the same workspace carries on.
    expect(reconcileSetup(gone, facts({ workspaces: [workspace()] })).step).toBe("done");
    // An unsent create request is kept: it is what makes the retry the same workspace.
    const pending = { idempotencyKey: "k", createdAt: 1, request: {} as never };
    const unsent = record({ step: "workspace", workspace: { pending, id: null } });
    expect(reconcileSetup(unsent, facts({ workspaces: [] }), 2)).toBe(unsent);
  });

  it("keeps a completed setup completed, and returns the same record when nothing changed", () => {
    const done = withWorkspace({ step: "done", completedAt: 7 });
    expect(reconcileSetup(done, facts({ compute: false, workspaces: [] }))).toBe(done);
    const same = record({ step: "workspace" });
    expect(reconcileSetup(same, facts())).toBe(same);
  });

  it("resends an unanswered create request only for a day, then adopts the workspace it made or drops the request", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const pending = { idempotencyKey: "k", createdAt: 1_000_000, request: { name: "Setup check" } as never };
    const unsent = record({ step: "workspace", workspace: { pending, id: null } });
    expect(resendable(unsent, 1_000_000 + DAY - 1)).toBe(pending);
    expect(resendable(unsent, 1_000_000 + DAY)).toBeNull();
    expect(resendable(withWorkspace(), 0)).toBeNull();
    // Still resendable: nothing is decided for it.
    expect(reconcileSetup(unsent, facts({ workspaces: [] }), 1_000_000 + 1)).toBe(unsent);
    // Too old, and the list is not known: kept, but no longer offered for resending.
    expect(reconcileSetup(unsent, facts({ workspaces: null }), 1_000_000 + DAY).workspace).toEqual({ pending, id: null });
    // ...and it stands in the way of a new request until the list says what it did.
    expect(unsettledRequest(unsent, 1_000_000 + DAY)).toBe(true);
    expect(unsettledRequest(unsent, 1_000_000 + 1)).toBe(false);
    expect(unsettledRequest(withWorkspace(), 1_000_000 + DAY)).toBe(false);
    expect(unsettledRequest(record(), 1_000_000 + DAY)).toBe(false);
    // Too old, and the workspace it asked for exists after all: that is the setup workspace.
    const made = workspace({ id: "ws-made", name: "Setup check", createdAt: 1_000_500 });
    const older = workspace({ id: "ws-old", name: "Setup check", createdAt: 1 });
    const adopted = reconcileSetup(unsent, facts({ workspaces: [older, made] }), 1_000_000 + DAY);
    expect([adopted.workspace, adopted.step]).toEqual([{ pending: null, id: "ws-made" }, "done"]);
    // Too old and nothing was made: the request is dropped, so a new one can be prepared.
    const dropped = reconcileSetup(unsent, facts({ workspaces: [older] }), 1_000_000 + DAY);
    expect([dropped.workspace, dropped.step]).toEqual([null, "workspace"]);
  });
});
