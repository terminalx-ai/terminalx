import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { api } from "./api";
import { isMembershipRefusal, isRoleRefusal, noteListedOrgRole, refreshAccountRoles, registerAccountRoles, roleRefusedMessage } from "./accountRoles";
import { createErrorMessage } from "./cloudCreate";
import { lifecycleErrorMessage } from "./cloudLifecycle";

afterEach(() => registerAccountRoles(null));

describe("a refusal for lack of role or membership", () => {
  it("is told apart from every other failure", () => {
    expect(isRoleRefusal({ code: "organization_admin_required", status: 403 })).toBe(true);
    expect(isRoleRefusal({ code: "forbidden" })).toBe(true);
    expect(isRoleRefusal("forbidden")).toBe(true);
    // PRO-73: not this workspace's creator and not an owner or admin.
    expect(isRoleRefusal({ code: "cloud_workspace_manager_required", status: 403 })).toBe(true);
    expect(isRoleRefusal({ code: "cloud_workspace_quota_exceeded" })).toBe(false);
    expect(isRoleRefusal(new Error("forbidden"))).toBe(false);
    expect(isRoleRefusal(null)).toBe(false);
    expect(isMembershipRefusal({ code: "cloud_organization_unavailable" })).toBe(true);
    expect(isMembershipRefusal({ code: "active_organization_required" })).toBe(true);
    expect(isMembershipRefusal({ code: "cloud_workspace_archived" })).toBe(false);
  });

  it("from any native call reads the account's roles again at once", async () => {
    const refresh = vi.fn(async () => undefined);
    registerAccountRoles({ refresh, listed: vi.fn() });
    for (const code of ["organization_admin_required", "forbidden", "cloud_organization_unavailable"]) {
      refresh.mockClear();
      mocks.invoke.mockRejectedValueOnce({ code, status: 403 });
      // The caller still gets the refusal, to show it.
      await expect(api.cloudWorkspaceResume("ws-1", "org-a")).rejects.toMatchObject({ code });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
    }
    // Any other failure, and a success, ask nothing.
    refresh.mockClear();
    mocks.invoke.mockRejectedValueOnce({ code: "cloud_workspace_quota_exceeded", status: 409 });
    await expect(api.cloudWorkspaceResume("ws-1", "org-a")).rejects.toMatchObject({ code: "cloud_workspace_quota_exceeded" });
    mocks.invoke.mockResolvedValueOnce({ workspaces: [] });
    await api.cloudWorkspaces("org-a");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does nothing before the account store has registered", async () => {
    await expect(refreshAccountRoles(true)).resolves.toBeUndefined();
    expect(() => noteListedOrgRole("org-a", false, 1)).not.toThrow();
  });

  it("reads as who may do it and why it was offered, never as a bare code", () => {
    expect(roleRefusedMessage("start a new cloud session")).toBe("Only an organization owner or admin can start a new cloud session (your role changed).");
    for (const code of ["organization_admin_required", "forbidden"]) {
      expect(createErrorMessage(code)).toBe("Only an organization owner or admin can create a cloud workspace (your role changed).");
      expect(lifecycleErrorMessage(code)).toBe("Only an organization owner or admin can stop, resume, archive or delete a cloud workspace (your role changed).");
    // PRO-73: the refusal for a workspace names its creator too, and the cap per person says whose workspaces count.
    expect(lifecycleErrorMessage("cloud_workspace_manager_required")).toBe("Only this workspace's creator or an organization owner or admin can stop, resume, archive or delete it.");
    expect(lifecycleErrorMessage("cloud_workspace_member_concurrency_exceeded")).toBe("You already have as many cloud workspaces running as your organization allows one person. Stop one of yours to start another.");
      expect(createErrorMessage(code)).not.toContain(code);
    }
  });
});
