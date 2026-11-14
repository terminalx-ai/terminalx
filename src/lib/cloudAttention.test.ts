import { describe, expect, it } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { reconcileCloudAttention, resolveCloudAttention } from "./cloudAttention";
import { deriveCloudActivity } from "./cloudRowState";

function item(fields: Record<string, unknown> = {}, operation: unknown = null): CloudWorkspaceListItem {
  return { workspace: { id: "w", orgId: "o", provider: "box", state: "ready", ...fields }, latestOperation: operation } as CloudWorkspaceListItem;
}
const failed = (category: string) => item({ launch: { phase: "failed", state: "failed", category } });

describe("shared attention and recovery", () => {
  it.each([
    ["agent-unavailable", "open-session"], ["repository-clone-failed", "open-session"],
    ["repository-access-denied", "check-github-access"], ["repository-branch-not-found", "open-session"],
    ["repository-clone-timed-out", "open-session"], ["repository-path-occupied", "open-session"],
    ["repository-empty", "open-session"], ["workspace-disk-full", "open-session"],
    ["repository-sync-failed", "open-session"], ["branch-create-failed", "open-session"],
    ["agent-start-failed", "open-session"], ["agent-model-unavailable", "open-session"],
    ["agent-sign-in-required", "open-agent-logins"], ["agent-credential-invalid", "open-agent-logins"],
    ["cloud_agent_credential_reauth_required", "open-agent-logins"],
    ["credential-missing", "open-agent-logins"], ["credential-expired", "open-agent-logins"],
    ["runtime-interrupted", "open-session"], ["runtime-storage-replaced", "open-session"],
    ["payload-invalid", "open-session"], ["launch-intent-unavailable", "open-session"],
    ["runtime-unsupported", "open-session"], ["future-failure", "open-session"],
  ])("explains %s with an actionable serializable recovery", (code, action) => {
    const attention = resolveCloudAttention(failed(code))!;
    expect(attention).toMatchObject({ code, message: expect.any(String), recovery: { action, label: expect.any(String), instructions: expect.any(String) } });
    expect(attention.message.length).toBeGreaterThan(15);
    expect(attention.recovery.instructions.length).toBeGreaterThan(30);
    expect(JSON.parse(JSON.stringify(attention))).toEqual(attention);
    expect(deriveCloudActivity(failed(code)).tone).toBe("attention");
  });

  it.each(["runtime-interrupted", "runtime-storage-replaced", "launch-intent-unavailable", "runtime-unsupported"])("requires explicit retry support for %s", (category) => {
    expect(resolveCloudAttention(failed(category), { canRetryFirstTask: true })?.recovery.action).toBe("retry-first-task");
    expect(resolveCloudAttention(failed(category))?.recovery.action).toBe("open-session");
  });

  it("keeps a failed first task until agent evidence, including when the runtime is merely online", () => {
    const row = failed("agent-sign-in-required");
    row.workspace.runtimeActivity = { online: true, reportedAt: 1, activeTurns: 0, pendingApprovals: 0 };
    expect(resolveCloudAttention(row)?.code).toBe("agent-sign-in-required");
    expect(resolveCloudAttention(row, { agentRan: true })?.code).toBe("agent-sign-in-required");
    expect(resolveCloudAttention(row, { tabs: [{ status: "idle" }] })?.code).toBe("agent-sign-in-required");
    row.workspace.runtimeActivity.activeTurns = 1;
    expect(resolveCloudAttention(row)).toBeNull();
    row.workspace.runtimeActivity.stale = true;
    expect(resolveCloudAttention(row)?.code).toBe("agent-sign-in-required");
  });

  it("uses a launch category ahead of a failed provisioning operation", () => {
    const row = failed("repository-access-denied");
    row.workspace.state = "attention-required";
    row.latestOperation = { state: "failed", action: null, errorCode: "cloud_workspace_runtime_bootstrap_failed" } as CloudWorkspaceListItem["latestOperation"];
    expect(resolveCloudAttention(row)?.recovery.action).toBe("check-github-access");
    row.workspace.launch!.category = null;
    expect(resolveCloudAttention(row)).toMatchObject({ code: "cloud_workspace_runtime_bootstrap_failed", recovery: { action: "create-workspace" } });
  });

  it("explains expired launches and server attention with no error details", () => {
    expect(resolveCloudAttention(item({ launch: { state: "expired", phase: "failed" } }))).toMatchObject({ code: "launch-expired", message: expect.stringContaining("expired") });
    expect(resolveCloudAttention(item({ state: "attention-required" }), { agentRan: true })?.code).toBe("cloud_workspace_attention_required");
  });

  it("offers update recovery and preserves deleting, archiving and archived precedence", () => {
    const input = { connection: "updateRequired" as const };
    expect(resolveCloudAttention(failed("agent-sign-in-required"), input)?.recovery.action).toBe("update-runtime");
    for (const state of ["archived", "destroyed"]) expect(resolveCloudAttention(item({ state }), input)).toBeNull();
    for (const action of ["delete", "archive"]) expect(resolveCloudAttention(item({}, { state: "running", action }), input)).toBeNull();
  });

  it("covers failed operations, provider repair, and deletes that only the provider can finish", () => {
    for (const action of ["suspend", "resume", "archive", "delete"]) {
      const row = item({ state: "attention-required" }, { state: "failed", action, errorCode: "cloud_provider_unavailable" });
      expect(resolveCloudAttention(row)).toMatchObject({ code: "cloud_provider_unavailable", recovery: { action: "retry-operation", operationAction: action } });
      expect(deriveCloudActivity(row).tone).toBe("attention");
    }
    expect(resolveCloudAttention(item({}, { state: "failed", action: "delete", detailCode: "box_deleted_sandbox_present" }))?.recovery.action).toBe("contact-provider");
    expect(resolveCloudAttention(item({}, { state: "failed", action: "delete", errorCode: "cloud_provider_credential_invalid" }))?.recovery.action).toBe("open-provider-settings");
    expect(resolveCloudAttention(item({ state: "attention-required", launch: { phase: "failed", state: "failed" } }, { state: "failed", action: null, errorCode: "cloud_workspace_provisioning_timeout" }))?.recovery.action).toBe("create-workspace");
  });

  it("exposes failed deletions in the archive, including when only the provider can finish", () => {
    const row = item({ state: "archived", archivedAt: 1 }, { state: "failed", action: "delete", errorCode: "cloud_provider_unavailable" });
    expect(resolveCloudAttention(row)).toMatchObject({ code: "cloud_provider_unavailable", recovery: { action: "retry-operation", operationAction: "delete" } });
    expect(deriveCloudActivity(row).label).toBe("Needs attention");
    row.latestOperation!.detailCode = "box_deleted_sandbox_present";
    expect(resolveCloudAttention(row)?.recovery.action).toBe("contact-provider");
    expect(resolveCloudAttention(row, { connection: "updateRequired" })?.recovery.action).toBe("contact-provider");
    row.workspace.state = "destroyed";
    expect(resolveCloudAttention(row)).toBeNull();
  });

  it("uses login recovery for service credential errors, even without a launch category", () => {
    for (const code of ["cloud_workspace_agent_credential_required", "cloud_agent_credential_reauth_required"]) {
      const operation = { state: "failed", action: null, errorCode: code };
      for (const launch of [null, { phase: "failed", state: "failed", category: null }]) {
        expect(resolveCloudAttention(item({ state: "attention-required", launch }, operation))).toMatchObject({ code, message: expect.stringContaining("Agent logins"), recovery: { action: "open-agent-logins" } });
      }
    }
  });

  it("does not offer retry for a provider that cannot permanently delete", () => {
    expect(resolveCloudAttention(item({ state: "archived" }, { state: "failed", action: "delete", errorCode: "provider_permanent_delete_unavailable" }))?.recovery).toMatchObject({ action: "contact-provider", instructions: expect.stringContaining("cannot delete") });
  });

  it("retains evidence only for the exact failed launch, without global workspace state", () => {
    const row = failed("agent-sign-in-required");
    row.workspace.launch!.launchId = "launch-1";
    row.workspace.runtimeActivity = { online: true, reportedAt: 20, activeTurns: 1, pendingApprovals: 0 };
    const recovered = reconcileCloudAttention(row);
    row.workspace.runtimeActivity = null;
    expect(resolveCloudAttention(recovered)).toBeNull();
    expect(resolveCloudAttention(row)?.code).toBe("agent-sign-in-required");
    const next = structuredClone(row);
    next.workspace.launch!.launchId = "launch-2";
    expect(resolveCloudAttention(reconcileCloudAttention(next, recovered))?.code).toBe("agent-sign-in-required");
  });

  it("does not accept runtime activity reported before failure, stale activity or a nonreporting runtime", () => {
    const row = failed("runtime-interrupted");
    row.workspace.launch!.timings = { failedAt: 10 } as NonNullable<typeof row.workspace.launch>["timings"];
    row.workspace.runtimeActivity = { online: true, reportedAt: 9, activeTurns: 1, pendingApprovals: 0 };
    expect(resolveCloudAttention(reconcileCloudAttention(row))?.code).toBe("runtime-interrupted");
    row.workspace.runtimeActivity.reportedAt = 11;
    row.workspace.runtimeActivity.reporting = false;
    expect(resolveCloudAttention(reconcileCloudAttention(row))?.code).toBe("runtime-interrupted");
    row.workspace.runtimeActivity.reporting = true;
    expect(resolveCloudAttention(reconcileCloudAttention(row))).toBeNull();
  });
});
