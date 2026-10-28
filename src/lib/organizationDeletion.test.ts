import { describe, expect, it } from "vitest";
import { organizationDeletionError } from "./organizationDeletion";

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
