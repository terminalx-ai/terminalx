import { describe, expect, it } from "vitest";
import { organizationDeletionBlockers, organizationDeletionError, organizationDeletionOffered, organizationNameConfirmed } from "./organizationDeletion";

describe("organization deletion error boundary", () => {
  it.each([
    ["organization_owner_required", "Only the current organization owner"],
    ["organization_personal_protected", "Personal/default"],
    ["organization_delete_blocked", "Finish cloud cleanup"],
    ["organization_confirmation_invalid", "current name exactly"],
    ["organization_delete_busy", "dependent resources"],
    ["organization_not_found", "no longer exists"],
    ["account_context_changed_after_send", "may have completed"],
  ])("maps %s to actionable guidance", (code, message) => {
    expect(organizationDeletionError({ code })).toContain(message);
  });
  it.each([null, "secret payload", { code: "internal secret", cleanupPath: "https://evil.invalid" }, new Error("secret")])("never renders arbitrary failures", (failure) => {
    const message = organizationDeletionError(failure);
    expect(message).toContain("could not be confirmed");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("evil.invalid");
  });
});

it("explains only recognized resource blockers", () => {
  const message = organizationDeletionError({ code: "organization_delete_blocked", blockers: ["teardown_in_progress", "github_disconnect_required", "private secret"] });
  expect(message).toContain("Wait for the existing cloud cleanup");
  expect(message).toContain("do not uninstall a shared installation");
  expect(message).not.toContain("private secret");
});

describe("organization name confirmation", () => {
  it.each([
    ["Test organization", true],
    ["  Test organization\t", true],
    ["test organization", false],
    ["Test  organization", false],
    ["Test organizatio", false],
    ["", false],
    ["   ", false],
  ])("%j confirms \"Test organization\": %s", (typed, expected) => {
    expect(organizationNameConfirmed(typed, "Test organization")).toBe(expected);
  });
  it("never confirms an organization without a name", () => {
    expect(organizationNameConfirmed("", "")).toBe(false);
    expect(organizationNameConfirmed(" ", " ")).toBe(false);
  });
});

describe("who is offered deletion", () => {
  it.each([
    [{ role: "owner", isPersonal: false, name: "Acme" }, true],
    [{ role: "owner", name: "Acme" }, true],
    [{ role: "owner", isPersonal: true, name: "Acme" }, false],
    [{ role: "admin", isPersonal: false, name: "Acme" }, false],
    [{ role: "member", isPersonal: false, name: "Acme" }, false],
    [{ role: "owner", isPersonal: false, name: " " }, false],
  ])("%j: %s", (organization, expected) => {
    expect(organizationDeletionOffered(organization)).toBe(expected);
  });
});

it("reads only known blocker codes from a server refusal", () => {
  expect(organizationDeletionBlockers({ error: "organization_delete_blocked", cleanupPath: "https://evil.invalid", blockers: [{ code: "cloud_cleanup_required" }, { code: "arbitrary server text" }, "x", null] }))
    .toEqual(["cloud_cleanup_required"]);
  expect(organizationDeletionBlockers(null)).toEqual([]);
});
