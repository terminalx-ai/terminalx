import { describe, expect, it } from "vitest";
import type { CloudCatalogState } from "@/lib/cloudCatalog";
import { createErrorMessage } from "@/lib/cloudCreate";
import { lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { effectiveRunningLimit } from "@/lib/organizationCompute";
import { RUNNING_LIMIT_CODE, runningLimitMessage, runningLimitReached, runningWorkspaces } from "@/lib/runningLimit";

const item = (id: string, state: string, archivedAt: number | null = null) => ({ workspace: { id, orgId: "org-a", name: id, state, archivedAt }, latestOperation: null });

const catalog = (quota: unknown, workspaces = [item("a", "ready"), item("b", "suspended"), item("c", "provisioning"), item("d", "attention-required"), item("e", "provisioning", 5)]) =>
  ({ orgs: { "org-a": { workspaces, quota } } }) as unknown as CloudCatalogState;

describe("running limit (saas PRO-76)", () => {
  it("says how many run and to stop one, with the list's limit when it has one", () => {
    expect(runningLimitMessage("org-a", catalog({ used: 2, limit: 2, running: { used: 2, limit: 2 }, total: { used: 7, limit: 20 } }))).toBe(
      "Your organization is running 2 of 2 cloud workspaces. Stop one to start another.",
    );
    // The refusal is fresher than a list that still counted a free slot.
    expect(runningLimitMessage("org-a", catalog({ used: 1, limit: 3 }))).toContain("running 3 of 3");
    expect(runningLimitMessage("org-a", catalog(null))).toBe(
      "Your organization is running as many cloud workspaces as its limit allows. Stop one to start another.",
    );
    expect(runningLimitMessage(null, catalog(null))).toContain("Stop one to start another.");
  });

  it("reads the running limit as reached only from a server that reports running", () => {
    expect(runningLimitReached("org-a", catalog({ used: 2, limit: 2, running: { used: 2, limit: 2 } }))).toBe(true);
    expect(runningLimitReached("org-a", catalog({ used: 1, limit: 2, running: { used: 1, limit: 2 } }))).toBe(false);
    // An older server's pair is the total, which a wake does not need.
    expect(runningLimitReached("org-a", catalog({ used: 2, limit: 2 }))).toBe(false);
    expect(runningLimitReached("org-b", catalog(null))).toBe(false);
  });

  it("lists the workspaces holding a running slot, from the catalog", () => {
    expect(runningWorkspaces("org-a", catalog(null)).map((entry) => entry.workspace.id)).toEqual(["a", "c", "d"]);
    expect(runningWorkspaces("org-a", catalog(null), "a").map((entry) => entry.workspace.id)).toEqual(["c", "d"]);
  });

  it("is worded, not generic, on create and on resume", () => {
    expect(createErrorMessage(RUNNING_LIMIT_CODE)).toContain("Stop one to start another.");
    expect(lifecycleErrorMessage(RUNNING_LIMIT_CODE)).toContain("Stop one to start another.");
  });

  it("works out the running limit in force", () => {
    const policy = { maxWorkspaces: 20, maxRunningWorkspaces: null as number | null };
    expect(effectiveRunningLimit({ policy: policy as never, workspaceCeiling: 50, runningWorkspaceCeiling: 2 })).toBe(2);
    expect(effectiveRunningLimit({ policy: { ...policy, maxRunningWorkspaces: 5 } as never, workspaceCeiling: 50, runningWorkspaceCeiling: 3 })).toBe(3);
    expect(effectiveRunningLimit({ policy: { maxWorkspaces: 2, maxRunningWorkspaces: 5 } as never, workspaceCeiling: 50, runningWorkspaceCeiling: 10 })).toBe(2);
    // An older server: blank means the workspace limit.
    expect(effectiveRunningLimit({ policy: { maxWorkspaces: 4, maxRunningWorkspaces: null } as never, workspaceCeiling: 10, runningWorkspaceCeiling: null })).toBe(4);
  });
});
