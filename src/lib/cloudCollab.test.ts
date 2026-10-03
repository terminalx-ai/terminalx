import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState, WorkspaceYou } from "@terminalx/portable/workspace";
import {
  ACCESS_GRACE_MS,
  APPROVE_BLOCKED_REASON,
  NOT_SHARED_REASON,
  VIEWER_REASON,
  accessLoss,
  accessLostReason,
  applyCollabEvent,
  canTypeInTerminals,
  clearCollabAccess,
  getCollab,
  inputRefusalText,
  listedYou,
  mayConfigure,
  onAccessChanged,
  resetCollab,
  roleBlockReason,
  setNotesOpen,
  tabGate,
  workspaceAuthority,
} from "./cloudCollab";
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

  it("never calls a lease someone else's while this person's own id is unknown (the list's role, before a connection)", () => {
    const fromList = listedYou({ role: "driver", canApprove: false })!;
    expect(tabGate(fromList, lease("u-me", now + 1), now, false, nameOf).blocked).toBeNull();
  });
});

describe("PRO-88: what the approval right guards beyond permission requests", () => {
  it("lets only a manager or an approving driver type in a terminal", () => {
    expect(canTypeInTerminals(you("manager"))).toBe(true);
    expect(canTypeInTerminals(you("driver", { canApprove: true }))).toBe(true);
    expect(canTypeInTerminals(you("driver"))).toBe(false);
    // Approving permission requests does not make a viewer a driver.
    expect(canTypeInTerminals(you("viewer", { canApprove: true }))).toBe(false);
    expect(canTypeInTerminals(you("none"))).toBe(false);
    expect(canTypeInTerminals(null)).toBe(false);
  });

  it("says what the runtime refused, in the runtime's words when the receipt can be read", () => {
    const message = "/model was not sent: only someone who can approve permissions may send it. Without that right you can send /clear, /compact.";
    expect(inputRefusalText("slash-command-forbidden", { command: "/model", message })).toBe(
      "Not sent: /model: only someone who can approve permissions may send it. Without that right you can send /clear, /compact.",
    );
    const shell = "Not sent: a message that starts with ! runs as a shell command in the agent's terminal, which needs someone who can approve permissions.";
    expect(inputRefusalText("shell-command-forbidden", { command: "!", message: shell })).toBe(shell);
    // A receipt that could not be read (its key is gone) still gives the reason.
    expect(inputRefusalText("slash-command-forbidden", null)).toBe("Not sent: that command needs someone who can approve permissions.");
    expect(inputRefusalText("shell-command-forbidden", null)).toMatch(/starts with ! runs as a shell command/);
    expect(inputRefusalText("file-mention-forbidden", {})).toMatch(/outside the project/);
    // An oversized or empty message is not shown; another category is not this function's.
    expect(inputRefusalText("slash-command-forbidden", { message: "x".repeat(500) })).toBe("Not sent: that command needs someone who can approve permissions.");
    // A command that would have waited behind a running turn (for everyone, not only plain drivers).
    expect(inputRefusalText("command-not-queued", { message: "A turn is running: send this command when it has ended." })).toBe(
      "Not sent: A turn is running: send this command when it has ended.",
    );
    expect(inputRefusalText("command-not-queued", null)).toBe("Not sent: a turn is running. Send this command when it has ended.");
    expect(inputRefusalText("lease-held", { message: "anything" })).toBeNull();
    expect(inputRefusalText(null, null)).toBeNull();
  });
});

describe("what the server lets a person do to a workspace", () => {
  it("keeps Stop, Archive and Delete for owners and admins, and share changes for them and the creator", () => {
    expect(workspaceAuthority({ you: { role: "manager", canApprove: true, canManageShares: true } })).toEqual({ lifecycle: true, viewShares: true, manageShares: true });
    // The creator (a member): manages shares, but the lifecycle is still an admin's.
    expect(workspaceAuthority({ you: { role: "driver", canApprove: true, canManageShares: true }, authority: "participate" })).toEqual({ lifecycle: false, viewShares: true, manageShares: true });
    expect(workspaceAuthority({ you: { role: "driver", canApprove: false } })).toEqual({ lifecycle: false, viewShares: true, manageShares: false });
    expect(workspaceAuthority({ you: { role: "viewer", canApprove: true } })).toEqual({ lifecycle: false, viewShares: true, manageShares: false });
    expect(workspaceAuthority({ you: { role: "none", canApprove: false } })).toEqual({ lifecycle: false, viewShares: true, manageShares: false });
  });

  it("follows the attachment on an older server that reports no role, and offers nothing about sharing", () => {
    expect(workspaceAuthority({ authority: "manage" })).toEqual({ lifecycle: true, viewShares: false, manageShares: false });
    expect(workspaceAuthority({ authority: "participate" })).toEqual({ lifecycle: false, viewShares: false, manageShares: false });
    expect(workspaceAuthority({})).toEqual({ lifecycle: true, viewShares: false, manageShares: false });
  });

  it("lets a manager or an approving driver change settings, and nobody the runtime would refuse", () => {
    expect(mayConfigure(you("manager"))).toBe(true);
    expect(mayConfigure(you("driver", { canApprove: true }))).toBe(true);
    expect(mayConfigure(you("driver"))).toBe(false);
    // An approving viewer cannot send, so nothing would carry the change.
    expect(mayConfigure(you("viewer", { canApprove: true }))).toBe(false);
    expect(mayConfigure(null)).toBe(true);
  });
});

describe("losing access", () => {
  const connected = (authority: "manage" | "participate" = "participate"): WorkspaceConnectionState => ({ state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: [], authority });
  const idle: WorkspaceConnectionState = { state: "idle" };

  it("reads only the attach's own refusal as lost access", () => {
    // What the desktop's attach reports when the API no longer lists the workspace for this person.
    for (const reason of ["cloud_workspace_not_found", "open failed: cloud_workspace_not_found"]) {
      expect(accessLostReason(reason), reason).toBe(true);
      expect(accessLoss({ state: { state: "reconnecting", attempt: 1, reason, retryInMs: 250 }, you: you("driver"), hadAccess: true })).toBe("removed");
      expect(accessLoss({ state: { state: "reconnecting", attempt: 1, reason, retryInMs: 250 }, you: you("driver"), hadAccess: false })).toBe("not-shared");
    }
    // Drops the next attempt may fix, and anything a proxy or the relay may say: an owner is never locked out by a 403 on the handshake.
    for (const reason of [
      "4104 relay restarting",
      "connection reset by peer",
      "4101 stale",
      "connection closed",
      "relay refused the attach",
      "403 Forbidden",
      "4403 forbidden",
      "forbidden",
      "access-revoked",
      "organization_member_not_found",
      "[redacted]",
      "",
      null,
      undefined,
    ]) {
      expect(accessLostReason(reason), String(reason)).toBe(false);
    }
    expect(accessLoss({ state: { state: "reconnecting", attempt: 1, reason: "403 Forbidden", retryInMs: 250 }, you: you("manager"), hadAccess: true })).toBeNull();
  });

  it("tells removed from never shared by whether this person had the session before", () => {
    expect(accessLoss({ state: connected(), you: you("none"), hadAccess: true })).toBe("removed");
    expect(accessLoss({ state: connected(), you: you("none"), hadAccess: false })).toBe("not-shared");
    // Not connected: the list's role decides the same way.
    expect(accessLoss({ state: idle, you: listedYou({ role: "none", canApprove: false }), hadAccess: true })).toBe("removed");
    expect(accessLoss({ state: idle, you: listedYou({ role: "none", canApprove: false }), hadAccess: false })).toBe("not-shared");
  });

  it("checks, then says not shared yet, while the list says shared and the runtime does not: never removed", () => {
    const disagreeing = (disagreeingMs: number, hadAccess = false) => accessLoss({ state: connected(), you: you("none"), hadAccess, listShared: true, disagreeingMs });
    expect(disagreeing(0)).toBe("checking");
    expect(disagreeing(ACCESS_GRACE_MS - 1)).toBe("checking");
    expect(disagreeing(ACCESS_GRACE_MS)).toBe("pending");
    expect(disagreeing(10 * 60_000)).toBe("pending");
    // Even with this desktop's cached conversation: the list says it is shared again.
    expect(disagreeing(0, true)).toBe("checking");
    // The list is not believed (this view watched the access end after it was asked for): removed.
    expect(accessLoss({ state: connected(), you: you("none"), hadAccess: true, listShared: false, disagreeingMs: 0 })).toBe("removed");
  });

  it("locks nobody who has a role, whose sharing is unknown, or whose runtime has no member list yet", () => {
    for (const role of ["viewer", "driver", "manager"] as const) expect(accessLoss({ state: connected(), you: you(role), hadAccess: true })).toBeNull();
    expect(accessLoss({ state: connected(), you: null, hadAccess: true })).toBeNull();
    expect(accessLoss({ state: connected(), you: you("none", { listed: false }), hadAccess: true })).toBeNull();
    expect(accessLoss({ state: idle, you: null, hadAccess: false })).toBeNull();
  });
});

describe("the collaboration store", () => {
  const KEY = "cloud:org-1:ws-1";
  const note = (id: string, authorId: string, createdAt: number) => ({ id, tabId: "t-1", authorId, text: id, createdAt });
  afterEach(() => resetCollab());

  it("counts other people's notes as unread until the tab's drawer opens, and reads them as they arrive while it is open", () => {
    applyCollabEvent(KEY, { type: "you", you: you("driver") });
    applyCollabEvent(KEY, { type: "note", note: note("n1", "u-alice", 1) });
    applyCollabEvent(KEY, { type: "note", note: note("n2", "u-alice", 2) });
    // A repeat of the same note, and this person's own, add nothing.
    applyCollabEvent(KEY, { type: "note", note: note("n2", "u-alice", 2) });
    applyCollabEvent(KEY, { type: "note", note: note("n3", "u-me", 3) });
    expect(getCollab(KEY).unreadNotes).toEqual({ "t-1": 2 });
    setNotesOpen(KEY, "t-1", true);
    expect(getCollab(KEY).unreadNotes).toEqual({});
    applyCollabEvent(KEY, { type: "note", note: note("n4", "u-alice", 4) });
    expect(getCollab(KEY).unreadNotes).toEqual({});
    setNotesOpen(KEY, "t-1", false);
    applyCollabEvent(KEY, { type: "note", note: note("n5", "u-alice", 5) });
    expect(getCollab(KEY).unreadNotes).toEqual({ "t-1": 1 });
    expect(getCollab(KEY).notes["t-1"]!.notes.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
  });

  it("drops leases, people and notes the moment the runtime says this person's role is none", () => {
    applyCollabEvent(KEY, { type: "you", you: you("driver") });
    applyCollabEvent(KEY, { type: "presence", participants: [{ userId: "u-alice", role: "manager", canApprove: true, surfaces: 1, tabId: "t-1", activity: "viewing", since: 1 }] });
    applyCollabEvent(KEY, { type: "lease", tabId: "t-1", lease: lease("u-me", Date.now() + 60_000) });
    applyCollabEvent(KEY, { type: "note", note: note("n1", "u-alice", 1) });
    applyCollabEvent(KEY, { type: "you", you: you("none") });
    expect(getCollab(KEY)).toMatchObject({ participants: [], leases: {}, notes: {}, unreadNotes: {}, you: { role: "none" }, lastYou: { role: "none" } });
  });

  it("clears a workspace this person can no longer open, so reopening it starts locked", () => {
    applyCollabEvent(KEY, { type: "you", you: you("viewer") });
    applyCollabEvent(KEY, { type: "lease", tabId: "t-1", lease: lease("u-alice", Date.now() + 60_000) });
    clearCollabAccess(KEY);
    expect(getCollab(KEY)).toMatchObject({ leases: {}, participants: [], lastYou: { userId: "u-me", role: "none", canApprove: false } });
    // Doing it again changes nothing (no re-render loop).
    const snapshot = getCollab(KEY);
    clearCollabAccess(KEY);
    expect(getCollab(KEY)).toBe(snapshot);
  });

  it("says the organization's access changed when this person's role or the listed people change, not when someone only moves", () => {
    const changed = vi.fn();
    const stop = onAccessChanged(changed);
    const person = (role: "viewer" | "driver", tabId: string | null, activity: "viewing" | "typing" = "viewing") => ({ userId: "u-bob", role, canApprove: false, surfaces: 1, tabId, activity, since: 1 });
    applyCollabEvent(KEY, { type: "you", you: you("driver") });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith("org-1");
    // The same role again is not a change.
    applyCollabEvent(KEY, { type: "you", you: you("driver") });
    expect(changed).toHaveBeenCalledTimes(1);
    applyCollabEvent(KEY, { type: "presence", participants: [person("viewer", "t-1")] });
    expect(changed).toHaveBeenCalledTimes(2);
    // Typing, or switching tab: who has access did not change.
    applyCollabEvent(KEY, { type: "presence", participants: [person("viewer", "t-2", "typing")] });
    expect(changed).toHaveBeenCalledTimes(2);
    applyCollabEvent(KEY, { type: "presence", participants: [person("driver", "t-2")] });
    expect(changed).toHaveBeenCalledTimes(3);
    applyCollabEvent(KEY, { type: "you", you: you("none") });
    expect(changed).toHaveBeenCalledTimes(4);
    stop();
    applyCollabEvent(KEY, { type: "you", you: you("viewer") });
    expect(changed).toHaveBeenCalledTimes(4);
  });
});
