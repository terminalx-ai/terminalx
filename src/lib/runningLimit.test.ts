import { describe, expect, it } from "vitest";
import type { CloudCatalogState } from "@/lib/cloudCatalog";
import { createErrorMessage } from "@/lib/cloudCreate";
import { lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { effectiveRunningLimit } from "@/lib/organizationCompute";
import { RUNNING_LIMIT_CODE, atLimit, limitOf, runningLimitMessage, runningLimitReached, runningWorkspaces, workspaceUsage } from "@/lib/runningLimit";

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

  it("says how many run of how many in the organization's chip", () => {
    expect(workspaceUsage("org-a", catalog({ used: 2, limit: 2, running: { used: 2, limit: 2 }, total: { used: 7, limit: 20 } }))).toEqual({
      used: 2,
      limit: 2,
      atLimit: true,
      label: "2 of 2 running",
      card: "2 of 2 cloud workspaces running. Stop one to start another.\n7 of 20 workspaces in all, stopped ones included",
    });
    expect(workspaceUsage("org-a", catalog({ used: 1, limit: 2, running: { used: 1, limit: 2 } }))).toMatchObject({ atLimit: false, label: "1 of 2 running", card: "1 of 2 cloud workspaces running" });
    // A server before PRO-76 does not count running workspaces apart, and one before quotas sends none.
    expect(workspaceUsage("org-a", catalog({ used: 2, limit: 2 }))).toBeNull();
    expect(workspaceUsage("org-a", catalog(null))).toBeNull();
  });

  describe("an organization with no limit (PRO-371)", () => {
    // The server leaves `limit` out; a null means the same.
    const unlimited = { used: 3, running: { used: 3 }, total: { used: 60 } };
    const nulls = { used: 3, limit: null, running: { used: 3, limit: null }, total: { used: 60, limit: null } };

    it("reads a missing or null limit as no limit, never as a limit of nothing", () => {
      for (const usage of [{ used: 3 }, { used: 3, limit: null }, { used: 3, limit: undefined }, { used: 0 }]) {
        expect(limitOf(usage)).toBeNull();
        expect(atLimit(usage)).toBe(false);
      }
      expect(limitOf(null)).toBeNull();
      expect(atLimit(undefined)).toBe(false);
      expect([limitOf({ used: 3, limit: 5 }), atLimit({ used: 3, limit: 5 }), atLimit({ used: 5, limit: 5 }), atLimit({ used: 6, limit: 5 })]).toEqual([5, false, true, true]);
    });

    it("is never at its running limit", () => {
      for (const quota of [unlimited, nulls]) {
        expect(runningLimitReached("org-a", catalog(quota))).toBe(false);
        // A refusal the list cannot put a number to is said without one.
        expect(runningLimitMessage("org-a", catalog(quota))).toBe("Your organization is running as many cloud workspaces as its limit allows. Stop one to start another.");
      }
    });

    it("counts in the chip, with nothing \"of\" anything and no warning", () => {
      for (const quota of [unlimited, nulls]) {
        expect(workspaceUsage("org-a", catalog(quota))).toEqual({
          used: 3,
          limit: null,
          atLimit: false,
          label: "3 running",
          card: "3 cloud workspaces running\n60 workspaces in all, stopped ones included",
        });
      }
    });

    it("says each limit only where there is one", () => {
      // A running limit, and no limit on how many are kept.
      expect(workspaceUsage("org-a", catalog({ used: 100, limit: 100, running: { used: 100, limit: 100 }, total: { used: 500 } }))).toMatchObject({
        atLimit: true,
        label: "100 of 100 running",
        card: "100 of 100 cloud workspaces running. Stop one to start another.\n500 workspaces in all, stopped ones included",
      });
      // The other way about.
      expect(workspaceUsage("org-a", catalog({ used: 3, running: { used: 3 }, total: { used: 60, limit: 500 } }))).toMatchObject({
        atLimit: false,
        label: "3 running",
        card: "3 cloud workspaces running\n60 of 500 workspaces in all, stopped ones included",
      });
    });
  });

  it("works out the running limit in force", () => {
    const policy = { maxWorkspaces: 20, maxRunningWorkspaces: null as number | null };
    expect(effectiveRunningLimit({ policy: policy as never, workspaceCeiling: 50, runningWorkspaceCeiling: 2 })).toBe(2);
    expect(effectiveRunningLimit({ policy: { ...policy, maxRunningWorkspaces: 5 } as never, workspaceCeiling: 50, runningWorkspaceCeiling: 3 })).toBe(3);
    expect(effectiveRunningLimit({ policy: { maxWorkspaces: 2, maxRunningWorkspaces: 5 } as never, workspaceCeiling: 50, runningWorkspaceCeiling: 10 })).toBe(2);
    // An older server: blank means the workspace limit.
    expect(effectiveRunningLimit({ policy: { maxWorkspaces: 4, maxRunningWorkspaces: null } as never, workspaceCeiling: 10, runningWorkspaceCeiling: null })).toBe(4);
    // Since PRO-371: with no limit of its own and no operator cap, there is none.
    expect(effectiveRunningLimit({ policy: { maxWorkspaces: null, maxRunningWorkspaces: null } as never, workspaceCeiling: null, runningWorkspaceCeiling: null })).toBeNull();
  });
});
