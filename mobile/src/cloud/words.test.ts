import { describe, expect, it } from "vitest";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { codeText, connectionLine, leaseLine, listStatus, outboxLine, presenceLine, rolePhrase, whoCanStart } from "./words";

const nameOf = (userId: string | null | undefined) => ({ "u-alice": "Alice", "u-bob": "Bob" })[userId ?? ""] ?? "Someone";
const lease = (holderId: string, expiresAt = 2_000) => ({ tabId: "t1", holderId, acquiredAt: 0, expiresAt });
const entry = (fields: Record<string, unknown>) => ({ clientCommandId: "c", tabId: "t1", kind: "send" as const, text: "hi", requestId: null, state: "rejected" as const, wake: null, category: null, receipt: null, createdAt: 1, updatedAt: 1, error: null, asleep: false, ...fields });

describe("sharing, in words", () => {
  it("says who drives and what this person may do about it", () => {
    expect(leaseLine(null, "u-me", "driver", 1_000, nameOf)).toEqual({ text: "No one is driving", mine: false, heldByOther: false, canTake: true, canRelease: false, canTakeOver: false });
    expect(leaseLine(lease("u-me"), "u-me", "driver", 1_000, nameOf)).toMatchObject({ text: "You are driving", mine: true, canRelease: true, canTake: false });
    expect(leaseLine(lease("u-alice"), "u-me", "driver", 1_000, nameOf)).toMatchObject({ text: "Driving: Alice", heldByOther: true, canTake: false, canTakeOver: false });
    expect(leaseLine(lease("u-alice"), "u-me", "manager", 1_000, nameOf)).toMatchObject({ heldByOther: true, canTakeOver: true });
    // A viewer never takes the wheel; a lease past its expiry holds nothing.
    expect(leaseLine(null, "u-me", "viewer", 1_000, nameOf)).toMatchObject({ canTake: false });
    expect(leaseLine(lease("u-alice", 500), "u-me", "driver", 1_000, nameOf)).toMatchObject({ text: "No one is driving", heldByOther: false, canTake: true });
  });

  it("lists the other people here with what they are doing", () => {
    const person = (userId: string, fields: Record<string, unknown> = {}) => ({ userId, role: "driver" as const, canApprove: false, surfaces: 1, tabId: null, activity: "viewing" as const, since: 1, ...fields });
    expect(presenceLine([person("u-me")], "u-me", () => null, nameOf)).toBeNull();
    expect(presenceLine([person("u-me"), person("u-alice", { activity: "typing", tabId: "t1" }), person("u-bob", { role: "viewer" })], "u-me", (tabId) => (tabId === "t1" ? "Fix login" : null), nameOf)).toBe("Also here: Alice · typing · on Fix login, Bob (viewing only)");
  });

  it("never ends the presence line in the middle of a name: three in full, then a count", () => {
    const people = ["u-alice", "u-bob", "u-c", "u-d", "u-e"].map((userId) => ({ userId, role: "driver" as const, canApprove: false, surfaces: 1, tabId: null, activity: "viewing" as const, since: 1 }));
    expect(presenceLine(people, "u-me", () => null, nameOf)).toBe("Also here: Alice, Bob, Someone and 2 more");
  });

  it("has a sentence for every share and lease refusal, and shows no code", () => {
    for (const code of ["cloud_workspace_share_redundant", "cloud_workspace_share_requires_organization_access", "cloud_workspace_share_limit", "cloud_workspace_share_forbidden", "organization_member_not_found", "lease_cooldown"]) {
      const text = codeText(code)!;
      expect(text).not.toContain("_");
      expect(text).not.toBe(codeText("a_code_nobody_knows"));
    }
    expect(codeText("cloud_workspace_share_limit")).toContain("maximum number of people (64)");
    expect(codeText("lease_cooldown")).toBe("You drove this tab moments ago; others get the first chance. Try again in two minutes.");
  });

  it("puts a refusal because of sharing in words", () => {
    expect(outboxLine(entry({ category: "lease-held", receipt: { outcome: "rejected", holderId: "u-alice" } }), false, nameOf)).toEqual({ tone: "warn", text: "Alice is driving. Your message was not sent." });
    expect(outboxLine(entry({ category: "lease-held" }), false, nameOf)?.text).toBe("Someone else is driving. Your message was not sent.");
    expect(outboxLine(entry({ category: "access-revoked" }), false, nameOf)?.text).toBe("Not sent: your access changed.");
  });

  it("says a message the server holds for a stopped workspace has not started it", () => {
    expect(outboxLine(entry({ state: "queued", wake: "not-requested", asleep: true }), true, nameOf)).toEqual({ tone: "warn", text: "Not started. This workspace is stopped, and sending starts it." });
    expect(outboxLine(entry({ state: "queued", wake: "not-needed" }), false, nameOf)?.text).toBe("Sent. Waiting for the agent.");
  });
});

describe("connectionLine reflects the role, not only the socket (#475)", () => {
  const connected: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 1, runtimeVersion: "", capabilities: [], authority: "participate" };
  it("says Live only for someone with a role", () => {
    expect(connectionLine(connected, "ready", null, false, { role: "driver", checking: false })).toEqual({ tone: "live", text: "Live · end-to-end encrypted", short: "Live" });
    expect(connectionLine(connected, "ready", null, false, { role: "viewer", checking: false }).tone).toBe("live");
  });
  it("says there is no access when the runtime gives none, whatever the socket", () => {
    expect(connectionLine(connected, "ready", null, false, { role: "none", checking: false })).toEqual({ tone: "warn", text: "No access: this workspace is not shared with you.", short: "No access" });
  });
  it("says access is being checked while the runtime has no member list", () => {
    expect(connectionLine(connected, "ready", null, false, { role: "driver", checking: true })).toEqual({ tone: "idle", text: "Checking your access…", short: "Checking access…" });
  });
  it("says a refused open in words, not Live", () => {
    const line = connectionLine({ state: "stopped" }, "ready", { kind: "api", code: "cloud_workspace_not_found", unreachable: false }, false, { role: "none", checking: false });
    expect(line.tone).toBe("warn");
    expect(line.text).not.toMatch(/Live/);
  });
});

describe("a stopped workspace, in words (#988)", () => {
  it("never says what the conversation holds: the body says that", () => {
    const stopped = connectionLine({ state: "suspended" }, "suspended", null);
    expect(stopped).toEqual({ tone: "idle", text: "Stopped", short: "Stopped" });
    expect(connectionLine({ state: "suspended" }, "archived", null).text).toBe("Archived");
    for (const state of ["suspended", "archived", "resuming", "suspending", "ready"]) {
      const line = connectionLine({ state: "suspended" }, state, null);
      expect(`${line.text} ${line.short}`).not.toMatch(/saved|conversation|nothing/i);
    }
    expect(connectionLine({ state: "suspended" }, "resuming", null).short).toBe("Starting…");
  });

  it("puts the role as a phrase for the line under the title, and says who may start it", () => {
    expect(rolePhrase("manager")).toBe("You are a manager");
    expect(rolePhrase("driver")).toBe("You can send");
    expect(rolePhrase("viewer")).toBe("You can view");
    expect(rolePhrase("none")).toBeNull();
    expect(rolePhrase(null)).toBeNull();
    expect(whoCanStart("Alice")).toBe("Alice, its creator, or an organization owner or admin can start it. Anyone who can send to it starts it by sending a message.");
    expect(whoCanStart(null)).toBe("Its creator or an organization owner or admin can start it. Anyone who can send to it starts it by sending a message.");
  });

  it("says a workspace in the list as the Sessions list says a session", () => {
    expect(listStatus({ state: "ready", runtimeActivity: { activeTurns: 1 } })).toEqual({ words: "Working", mark: "working" });
    expect(listStatus({ state: "ready", runtimeActivity: { activeTurns: 1, pendingApprovals: 1 } })).toEqual({ words: "Needs your answer", mark: "needs" });
    expect(listStatus({ state: "ready", runtimeActivity: { pendingApprovals: 3 } }).words).toBe("3 waiting for an answer");
    expect(listStatus({ state: "ready" })).toEqual({ words: "Running", mark: "running" });
    expect(listStatus({ state: "suspended" })).toEqual({ words: "Stopped", mark: "idle" });
    expect(listStatus({ state: "resuming" })).toEqual({ words: "Starting", mark: "changing" });
    expect(listStatus({ state: "attention-required" })).toEqual({ words: "Needs attention", mark: "attention" });
    // A stopped workspace's last report of work is not work now.
    expect(listStatus({ state: "suspended", runtimeActivity: { activeTurns: 2, pendingApprovals: 1 } }).words).toBe("Stopped");
  });
});
