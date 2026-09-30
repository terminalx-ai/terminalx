import { describe, expect, it } from "vitest";
import type { WorkspaceYou } from "@terminalx/portable/workspace";
import { APPROVE_BLOCKED_REASON, NOT_SHARED_REASON, VIEWER_REASON, listedYou, roleBlockReason, tabGate } from "./cloudCollab";
import { cloudReadOnlyReason } from "./sessionBackend";

// PRO-30 gating shared by the cloud workspace page and SessionView.
const you = (role: WorkspaceYou["role"], fields: Partial<WorkspaceYou> = {}): WorkspaceYou => ({ userId: "u-me", role, canApprove: role === "manager", ...fields });
const nameOf = (userId: string | null | undefined) => (userId === "u-alice" ? "Alice" : "Someone");
const lease = (holderId: string, expiresAt: number) => ({ tabId: "t-1", holderId, acquiredAt: 1, expiresAt });

describe("who may send to a cloud session", () => {
  it("lets a driver on a participate attachment send, and keeps viewers and the unshared read-only", () => {
    expect(cloudReadOnlyReason("participate", "ready", you("driver"))).toBeNull();
    expect(cloudReadOnlyReason("participate", "ready", you("viewer"))).toBe(VIEWER_REASON);
    expect(cloudReadOnlyReason("participate", "ready", you("none"))).toBe(NOT_SHARED_REASON);
    // A demoted admin's manage attachment has the role the runtime now gives it.
    expect(cloudReadOnlyReason("manage", "ready", you("viewer"))).toBe(VIEWER_REASON);
  });

  it("keeps the attachment rule when sharing says nothing (older server or runtime, or no member list yet)", () => {
    expect(cloudReadOnlyReason("participate", "ready", null)).toMatch(/^View only/);
    expect(cloudReadOnlyReason("manage", "ready", null)).toBeNull();
    expect(cloudReadOnlyReason("participate", "ready", you("none", { listed: false }))).toMatch(/^View only/);
    expect(roleBlockReason(you("none", { listed: false }))).toBeNull();
  });

  it("archived and deleted come first, whatever the role", () => {
    expect(cloudReadOnlyReason("manage", "archived", you("manager"))).toMatch(/^Archived/);
    expect(cloudReadOnlyReason("participate", "destroyed", you("driver"))).toBe("This workspace was deleted.");
  });

  it("reads the workspace list's role as a person with no known id", () => {
    expect(listedYou({ role: "viewer", canApprove: false })).toEqual({ userId: "", role: "viewer", canApprove: false });
    expect(listedYou(undefined)).toBeNull();
  });
});

describe("one agent tab's lease and approvals", () => {
  const now = 1_000_000;

  it("blocks a driver while someone else's lease is live, or held for their running turn", () => {
    expect(tabGate(you("driver"), lease("u-alice", now + 1), now, false, nameOf).blocked).toBe("Alice is driving this tab. You can send once they release it.");
    expect(tabGate(you("driver"), lease("u-alice", now - 1), now, true, nameOf).blocked).toBe("Alice is driving this tab. You can send once they release it.");
    // Expired and no turn running: free for the next driver (review finding 2's rule, seen from the client).
    expect(tabGate(you("driver"), lease("u-alice", now - 1), now, false, nameOf)).toMatchObject({ blocked: null, liveLease: null, mayStop: true });
    expect(tabGate(you("manager"), lease("u-alice", now + 1), now, false, nameOf).blocked).toBe("Alice is driving this tab. Take over to send.");
    expect(tabGate(you("driver"), lease("u-me", now + 1), now, false, nameOf)).toMatchObject({ blocked: null, mayStop: true });
  });

  it("lets only the holder or a manager stop, and only approvers answer", () => {
    expect(tabGate(you("driver"), lease("u-alice", now + 1), now, true, nameOf).mayStop).toBe(false);
    expect(tabGate(you("manager"), lease("u-alice", now + 1), now, true, nameOf).mayStop).toBe(true);
    expect(tabGate(you("driver"), null, now, false, nameOf).approveBlocked).toBe(APPROVE_BLOCKED_REASON);
    expect(tabGate(you("driver", { canApprove: true }), null, now, false, nameOf).approveBlocked).toBeNull();
    expect(tabGate(you("viewer"), null, now, false, nameOf)).toMatchObject({ blocked: VIEWER_REASON, mayStop: false });
    // Sharing does not apply: nothing is gated here.
    expect(tabGate(null, lease("u-alice", now + 1), now, true, nameOf)).toMatchObject({ blocked: null, mayStop: true, approveBlocked: null });
  });
});
