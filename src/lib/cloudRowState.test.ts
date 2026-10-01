import { describe, expect, it } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { deriveCloudActivity, mostUrgent } from "./cloudRowState";

// The row-state table (PRO-23, CS-7): the first matching condition wins.

function item(fields: Record<string, unknown> = {}, latestOperation: unknown = null): CloudWorkspaceListItem {
  return {
    workspace: { id: "w", orgId: "o", name: "w", provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: 2, releaseDisposition: null, ...fields },
    latestOperation,
  } as CloudWorkspaceListItem;
}

const running = (action: string) => ({ id: "op", action, state: "running", type: "create", stage: "queued" });

describe("deriveCloudActivity", () => {
  it("1: archived, archiving and deleting come first", () => {
    expect(deriveCloudActivity(item({ state: "archived", archivedAt: 1 })).label).toBe("Archived");
    expect(deriveCloudActivity(item({}, running("archive"))).label).toBe("Archiving");
    expect(deriveCloudActivity(item({}, running("delete"))).label).toBe("Deleting");
  });

  it("2: attention, a failed launch, or a runtime needing an update", () => {
    expect(deriveCloudActivity(item({ state: "attention-required" })).label).toBe("Needs attention");
    expect(deriveCloudActivity(item({ launch: { phase: "failed", state: "failed" } })).label).toBe("Needs attention");
    expect(deriveCloudActivity(item(), { connection: "updateRequired" }).label).toBe("Needs attention");
  });

  it("3 and 4: operations, then starting phases", () => {
    expect(deriveCloudActivity(item({ state: "suspended" }, running("resume"))).label).toBe("Resuming");
    expect(deriveCloudActivity(item({}, running("suspend"))).label).toBe("Stopping");
    expect(deriveCloudActivity(item({ state: "provisioning", launch: { phase: "booting", state: "pending" } })).label).toBe("Starting: booting");
  });

  it("5: a stopped workspace with a cached in-progress tab reads Stopped, never Working", () => {
    const activity = deriveCloudActivity(item({ state: "suspended" }), { tabs: [{ status: "in_progress" }], fromCache: true });
    expect(activity.label).toBe("Stopped");
    expect(activity.status).toBe("idle");
    expect(activity.lastKnown).toBe(true);
  });

  it("6: opening or reconnecting reads Connecting", () => {
    expect(deriveCloudActivity(item(), { connection: "reconnecting", tabs: [{ status: "in_progress" }] }).label).toBe("Connecting");
    expect(deriveCloudActivity(item(), { connection: "opening" }).label).toBe("Connecting");
  });

  it("7: tab states in order: needs you, working, done, idle", () => {
    const connection = "connected" as const;
    expect(deriveCloudActivity(item(), { connection, tabs: [{ status: "in_progress" }, { status: "waiting" }] }).label).toBe("Needs you");
    expect(deriveCloudActivity(item(), { connection, tabs: [{ status: "idle", pendingApprovals: 1 }] }).label).toBe("Needs you");
    expect(deriveCloudActivity(item(), { connection, tabs: [{ status: "completed" }, { status: "in_progress" }] }).label).toBe("Working");
    expect(deriveCloudActivity(item(), { connection, tabs: [{ status: "completed", unread: true }] }).label).toBe("Done");
    expect(deriveCloudActivity(item(), { connection, tabs: [{ status: "completed", unread: false }] }).label).toBe("Idle");
    expect(deriveCloudActivity(item()).label).toBe("Ready");
  });

  it("7: the server's activity report shows working and needs-you without any attach", () => {
    expect(deriveCloudActivity(item({ runtimeActivity: { online: true, reportedAt: 1, activeTurns: 1, pendingApprovals: 0 } })).label).toBe("Working");
    expect(deriveCloudActivity(item({ runtimeActivity: { online: true, reportedAt: 1, activeTurns: 0, pendingApprovals: 2 } })).label).toBe("Needs you");
    // A cached in-progress tab without a connection or a report is not claimed as working.
    expect(deriveCloudActivity(item(), { tabs: [{ status: "in_progress" }], fromCache: true }).label).toBe("Idle");
  });

  it("picks the most urgent state for a parent row", () => {
    const states = [deriveCloudActivity(item({ state: "suspended" })), deriveCloudActivity(item(), { connection: "connected", tabs: [{ status: "waiting" }] })];
    expect(mostUrgent(states)?.label).toBe("Needs you");
  });
});
