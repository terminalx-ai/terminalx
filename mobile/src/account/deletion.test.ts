import { describe, expect, it } from "vitest";
import { accountDeletionText as T, blockerRows, consoleOrganizationUrl, deletionDate, emailConfirmed, goneRows, refusalSentence, stoppedAtConfirm } from "./deletion";
import { plainRead } from "./fixtures";

describe("the design's sentences", () => {
  it("says them as board 26.01 does, with the phone's word", () => {
    expect(T.lede(14)).toBe("Your account is deleted 14 days after you confirm. Until then, signing in again cancels the deletion.");
    expect(T.kept(90)).toBe("A record of the deletion, billing and usage records, and audit logs are kept for 90 days after your account is deleted, then removed.");
    expect(T.stopping).toBe("Stopping cloud workspaces…");
    expect(T.doneStopped(2, "9 December 2026")).toBe("Your 2 running cloud workspaces were stopped. They are deleted with your account on 9 December 2026.");
    expect(T.doneStopped(1, "9 December 2026")).toBe("Your running cloud workspace was stopped. It is deleted with your account on 9 December 2026.");
    expect(T.failStop("Boat", "scratch", "the provider is not answering")).toBe("Your account was not deleted and nothing was scheduled: Boat did not stop scratch (the provider is not answering). Try again.");
    expect(T.failStopKept(["checkout-redesign"])).toBe("Your cloud workspace checkout-redesign stopped and stays stopped; start it again when you need it.");
    expect(T.failStopKept(["a", "b"])).toBe("Your cloud workspaces a and b stopped and stay stopped; start them again when you need them.");
    expect(T.signOutNote("9 December 2026")).toBe("You will be signed out on every device. You can still cancel by signing in again before 9 December 2026.");
  });

  it("writes the day as the boards do", () => {
    expect(deletionDate(new Date(2026, 11, 9, 12))).toBe("9 December 2026");
  });
});

describe("what is deleted", () => {
  it("is built from the account", () => {
    expect(goneRows(plainRead(), "alex@example.com")).toEqual([
      ["Your profile and your sign-in", "alex@example.com, with Google and emailed codes"],
      ["Your personal organization, Alex Rivera", "With its stopped cloud workspaces"],
      ["Keys and connections you saved", "Compute keys, agent logins and the GitHub connection"],
      ["Machines and phones paired to your account", "Every signed-in session ends"],
      ["Your place in other organizations", "You leave Contoso Labs; it keeps its work"],
    ]);
  });

  it("names running cloud workspaces with their organizations, never as something in the way", () => {
    const read = plainRead();
    read.deleted.runningWorkspaces = [
      { id: "ws_1", name: "checkout-redesign", provider: "box", organizationId: "org_2" },
      { id: "ws_2", name: "scratch", provider: "box", organizationId: "org_p" },
    ];
    expect(goneRows(read, "alex@example.com")[1]).toEqual(["Your 2 running cloud workspaces", "checkout-redesign in Contoso Labs, scratch in Alex Rivera: stopped when you confirm, deleted after the 14 days"]);
    expect(blockerRows(read.blockers)).toEqual([]);
  });

  it("names an organization that goes with the account, and several it leaves", () => {
    const read = plainRead();
    read.deleted.organizations.push({ id: "org_t", name: "Side project", isPersonal: false, workspaces: 0 });
    read.deleted.leftOrganizations.push({ id: "org_n", name: "Northwind" });
    const rows = goneRows(read, "alex@example.com");
    expect(rows).toContainEqual(["Your organization, Side project", "You are its only member"]);
    expect(rows).toContainEqual(["Your place in other organizations", "You leave Contoso Labs and Northwind; they keep their work"]);
  });

  it("leaves out what the account does not have", () => {
    const read = plainRead();
    Object.assign(read.deleted, { computeKeys: 0, agentLogins: 0, githubConnections: 0, leftOrganizations: [] });
    const titles = goneRows(read, "alex@example.com").map(([title]) => title);
    expect(titles).not.toContain("Keys and connections you saved");
    expect(titles).not.toContain("Your place in other organizations");
  });
});

describe("before you can delete", () => {
  it("hands over an organization in the web console, which the phone cannot do", () => {
    expect(blockerRows([{ code: "sole_owner_with_members", organizationId: "org 1", organizationName: "Northwind", otherMembers: 4 }])).toEqual([{
      key: "sole_owner_with_members:org 1",
      title: "Hand over Northwind",
      detail: "You are its only owner and it has 4 other members. Make another member the owner, or remove the members. The phone cannot change owners yet. Open the web console to do it.",
      consoleUrl: "https://console.terminalx.ai/organizations/org%201",
    }]);
  });

  it("says one other member as one", () => {
    expect(blockerRows([{ code: "sole_owner_with_members", organizationId: "o", organizationName: "Northwind", otherMembers: 1 }])[0]!.detail)
      .toBe("You are its only owner and it has 1 other member. Make that member the owner, or remove them. The phone cannot change owners yet. Open the web console to do it.");
  });

  it("names the only admin account", () => {
    expect(blockerRows([{ code: "last_admin" }])).toEqual([{ key: "last_admin:0", title: "The only admin account", detail: "This is the only admin account, so it cannot be deleted.", consoleUrl: null }]);
  });

  it("has the final words for the clean-up refusals and none for a code it does not know", () => {
    const rows = blockerRows([
      { code: "cloud_cleanup_required", organizationId: "org_1", organizationName: "Northwind" },
      { code: "session_runtime_cleanup_required", organizationId: "org_1", organizationName: "Northwind" },
      { code: "something_new", organizationId: "org_1", organizationName: "<b>raw</b>" },
    ]);
    expect(rows.map(({ title, detail }) => [title, detail])).toEqual([
      ["Clean up Northwind", "It still holds runtime builds, environment images or other resources at the provider. Remove them on its page in the web console."],
      ["Agent sessions still running in Northwind", "An agent session in Northwind has not shut down yet. Wait for it to end, then confirm again."],
    ]);
    expect(rows.every((row) => row.consoleUrl === consoleOrganizationUrl("org_1"))).toBe(true);
    // What is drawn: the titles and details (the key only tells rows apart).
    expect(JSON.stringify(rows.map(({ title, detail }) => [title, detail]))).not.toMatch(/cleanup_required|something_new|raw/);
  });
});

describe("confirming", () => {
  it("ignores case and spaces at either end, and nothing else", () => {
    expect(emailConfirmed("  ALEX@example.com ", "alex@example.com")).toBe(true);
    expect(emailConfirmed("alex@example.co", "alex@example.com")).toBe(false);
    expect(emailConfirmed("", "")).toBe(false);
  });

  it("says which workspace did not stop, and which stopped and stay stopped", () => {
    const sentence = refusalSentence(
      { code: "workspace_stop_failed", provider: "box", workspaceId: "ws_2", workspaceName: "scratch", reason: "provider_timed_out", stopped: [{ workspaceId: "ws_1", workspaceName: "checkout-redesign" }] },
      (id) => (id === "box" ? "Boat" : id),
      () => null,
    );
    expect(sentence).toEqual({ tone: "danger", blocked: false, text: "Your account was not deleted and nothing was scheduled: Boat did not stop scratch (the provider is not answering). Try again. Your cloud workspace checkout-redesign stopped and stays stopped; start it again when you need it." });
  });

  it("never shows a reason code it does not know", () => {
    const sentence = refusalSentence({ code: "workspace_stop_failed", provider: "box", workspaceId: "ws_2", workspaceName: "scratch", reason: "provider_said_<script>" }, () => "Boat", () => null);
    expect(sentence.text).toContain("(the reason is not known)");
    expect(sentence.text).not.toContain("script");
  });

  it("uses the web's reason table, and stand-ins for a missing provider or workspace name", () => {
    const say = (reason: string) => refusalSentence({ code: "workspace_stop_failed", provider: "box", workspaceId: "w", workspaceName: "scratch", reason }, () => "Boat", () => null).text;
    expect(say("provider_retry_exhausted")).toContain("(the provider kept failing)");
    expect(say("service_unavailable")).toContain("(TerminalX could not reach the provider)");
    expect(say("provider_credential_invalid")).toContain("(the organization's key for the provider is no longer valid)");
    expect(say("workspace_needs_attention")).toContain("(the cloud workspace needs attention)");
    expect(say("workspace_busy")).toContain("(the cloud workspace is busy with another change)");
    expect(refusalSentence({ code: "workspace_stop_failed", reason: "provider_refused" }, () => "Boat", () => null).text)
      .toBe("Your account was not deleted and nothing was scheduled: the provider did not stop a cloud workspace (the provider refused). Try again.");
  });

  it("says something changed when a blocker appeared after confirming, and not deleted otherwise", () => {
    expect(refusalSentence({ code: "sole_owner_with_members" }, String, () => null)).toEqual({ tone: "warning", text: T.failBlocked, blocked: true });
    expect(refusalSentence({ code: "sign_out_failed" }, String, () => null)).toEqual({ tone: "danger", text: T.failRefused, blocked: false });
    expect(refusalSentence(null, String, () => null).text).toBe(T.failRefused);
  });

  it("counts the cloud workspaces stopped at confirm", () => {
    expect(stoppedAtConfirm({ id: "d", kind: "self", state: "cancelled", requestedAt: "", workspaces: [
      { workspaceId: "a", action: "stop", state: "stopped" },
      { workspaceId: "b", action: "stop", state: "failed" },
      { workspaceId: "c", action: "delete", state: "stopped" },
    ] })).toBe(1);
  });
});
