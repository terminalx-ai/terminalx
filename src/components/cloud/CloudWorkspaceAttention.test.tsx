import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { reconcileCloudAttention, resolveCloudAttention } from "@/lib/cloudAttention";
import { takeAgentLoginsRequest, takeOrganizationRequest } from "@/lib/settingsLinks";
import { CloudWorkspaceAttention } from "./CloudWorkspaceAttention";

const mocks = vi.hoisted(() => ({ resume: vi.fn(), refresh: vi.fn(), select: vi.fn(), start: vi.fn(), setting: vi.fn() }));
vi.mock("@/lib/cloudCatalog", () => ({ resumeCloudWorkspace: mocks.resume, refreshCloudCatalog: mocks.refresh, getCloudCatalog: () => ({ createMemory: {} }), repositoryOf: () => null, blankIdentity: (name: string) => `blank/${name}` }));
vi.mock("@/lib/sessions", () => ({ selectCloudWorkspace: mocks.select, startCloudSessionIn: mocks.start }));
vi.mock("@/lib/settingsLinks", async (original) => ({ ...await original<typeof import("@/lib/settingsLinks")>(), openSettingRow: mocks.setting }));
vi.mock("./WorkspaceActions", () => ({ WorkspaceLifecycleDialog: ({ request }: { request: { action: string } }) => <div role="dialog">Confirm {request.action}</div> }));

const categories = ["agent-unavailable", "repository-clone-failed", "repository-access-denied", "repository-branch-not-found", "repository-clone-timed-out", "repository-path-occupied", "repository-empty", "workspace-disk-full", "repository-sync-failed", "branch-create-failed", "agent-start-failed", "agent-model-unavailable", "agent-sign-in-required", "runtime-interrupted", "runtime-storage-replaced", "payload-invalid", "launch-intent-unavailable", "runtime-unsupported", "launch-expired", "unknown-category", "credential-expired", "cloud_workspace_agent_credential_required"];
function item(category = "runtime-interrupted"): CloudWorkspaceListItem {
  return { workspace: { id: "ws", orgId: "workspace-org", name: "Work", state: "ready", authority: "manage", you: { role: "manager", canApprove: true }, launch: { launchId: "launch", state: category === "launch-expired" ? "expired" : "failed", phase: "failed", category: category === "launch-expired" ? null : category, timings: { failedAt: 10 } } }, latestOperation: null } as unknown as CloudWorkspaceListItem;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); takeOrganizationRequest(); takeAgentLoginsRequest("workspace-org"); });

for (const compact of [true, false]) describe(compact ? "sidebar recovery" : "pane recovery", () => {
  it.each(categories)("shows the reason and working recovery for %s", (category) => {
    const row = item(category);
    const attention = resolveCloudAttention(row)!;
    const parent = vi.fn();
    render(<div onClick={parent}><CloudWorkspaceAttention item={row} compact={compact} /></div>);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(compact && attention.recovery.action === "open-agent-logins" ? "The agent needs a working login." : compact ? attention.message.split(/(?<=\.)\s/)[0] : attention.message);
    const button = screen.getByRole("button", { name: attention.recovery.label });
    expect(button.closest("button")?.parentElement?.closest("button")).toBeNull();
    fireEvent.click(button);
    expect(parent).not.toHaveBeenCalled();
    if (attention.recovery.action === "open-agent-logins") {
      expect(takeOrganizationRequest()).toBe("workspace-org");
      expect(takeAgentLoginsRequest("other-org")).toBe(false);
      expect(takeAgentLoginsRequest("workspace-org")).toBe(true);
    } else if (attention.recovery.action === "check-github-access") expect(takeOrganizationRequest()).toBe("workspace-org");
    else expect(mocks.select).toHaveBeenCalledExactlyOnceWith("cloud:workspace-org:ws");
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("shows an attention-required operation error and retries once with the existing resume path", async () => {
    const row = item();
    row.workspace.state = "attention-required";
    row.workspace.launch = null;
    row.latestOperation = { id: "op", action: "resume", state: "failed", errorCode: "cloud_provider_unavailable" } as never;
    let finish!: () => void;
    mocks.resume.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    mocks.refresh.mockResolvedValue(undefined);
    render(<CloudWorkspaceAttention item={row} compact={compact} />);
    expect(screen.getByRole("status").textContent).toContain("The provider did not answer.");
    const retry = screen.getByRole("button", { name: "Retry resume" });
    fireEvent.click(retry); fireEvent.click(retry);
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith(row);
    finish();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("workspace-org"));
  });
  it("keeps lifecycle recovery unavailable to a viewer", () => {
    const row = item(); row.workspace.launch = null; row.workspace.state = "attention-required";
    row.workspace.you = { role: "viewer", canApprove: false }; row.workspace.authority = "participate";
    row.latestOperation = { action: "resume", state: "failed", errorCode: "cloud_provider_unavailable" } as never;
    render(<CloudWorkspaceAttention item={row} compact={compact} />);
    const button = screen.getByRole("button", { name: "Retry resume" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button); expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("clears after authoritative refresh and after agent activity", () => {
    const row = item();
    const { rerender } = render(<CloudWorkspaceAttention item={row} compact={compact} />);
    rerender(<CloudWorkspaceAttention item={row} compact={compact} input={{ agentRan: true }} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CloudWorkspaceAttention item={row} compact={compact} />);
    const recovered = reconcileCloudAttention(row, row, [{ created: new Date(20).toISOString(), tabs: [{ created: new Date(20).toISOString() }] }] as never);
    rerender(<CloudWorkspaceAttention item={recovered} compact={compact} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

it.each([true, false])("routes runtime updates to the existing app update settings (compact=%s)", (compact) => {
  render(<CloudWorkspaceAttention item={item()} compact={compact} input={{ connection: "updateRequired" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Update runtime" }));
  expect(mocks.setting).toHaveBeenCalledExactlyOnceWith("about.checkUpdates");
});
it("opens the existing lifecycle confirmation for a failed archive", () => {
  const row = item(); row.latestOperation = { action: "archive", state: "failed", errorCode: "cloud_provider_unavailable" } as never;
  render(<CloudWorkspaceAttention item={row} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry archive" }));
  expect(screen.getByRole("dialog").textContent).toBe("Confirm archive");
});

it("never substitutes Archive when the lifecycle dialog cannot retry a failed suspend", () => {
  const row = item(); row.workspace.launch = null; row.workspace.state = "attention-required";
  row.latestOperation = { action: "suspend", state: "failed", errorCode: "cloud_provider_unavailable" } as never;
  render(<CloudWorkspaceAttention item={row} />);
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  expect(mocks.select).toHaveBeenCalledExactlyOnceWith("cloud:workspace-org:ws");
  expect(screen.queryByRole("dialog")).toBeNull();
});
