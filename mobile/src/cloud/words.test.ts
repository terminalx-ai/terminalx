import { describe, expect, it } from "vitest";
import { codeText, leaseLine, outboxLine, presenceLine } from "./words";

const nameOf = (userId: string | null | undefined) => ({ "u-alice": "Alice", "u-bob": "Bob" })[userId ?? ""] ?? "Someone";
const lease = (holderId: string, expiresAt = 2_000) => ({ tabId: "t1", holderId, acquiredAt: 0, expiresAt });
const entry = (fields: Record<string, unknown>) => ({ clientCommandId: "c", tabId: "t1", kind: "send" as const, text: "hi", requestId: null, state: "rejected" as const, wake: null, category: null, receipt: null, createdAt: 1, updatedAt: 1, error: null, ...fields });

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
});
