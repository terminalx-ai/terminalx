import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
import type { CloudProject } from "@/types/target";
import { takeAgentLoginsRequest, takeOrganizationRequest } from "@/lib/settingsLinks";
import { reconcileCloudAttention, resolveCloudAttention } from "@/lib/cloudAttention";
import { buildCloudSessions, type CloudSessionRow } from "@/lib/cloudSessions";
import type { CloudAgentTab } from "@/lib/cloudAgents";
import { CloudProjectGroup } from "./CloudProjectRows";

const checkpointRows = vi.hoisted(() => ({ value: [] as CloudSessionRow[] }));

vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: { state: "signed-out" } }), getAccount: () => ({ status: { state: "signed-out" } }), subscribeAccount: () => () => undefined }));
vi.mock("@/lib/cloudSessions", async (original) => ({ ...await original<typeof import("@/lib/cloudSessions")>(), useCloudAgentRan: () => false, useCloudWorkspaceSessions: (node: { item: CloudWorkspaceListItem }) => ({ sessions: node.item.workspace.id === "one" ? checkpointRows.value : [], capabilities: null, manage: false, known: false }) }));
vi.mock("@/lib/cloudDashboard", async (original) => ({ ...await original<typeof import("@/lib/cloudDashboard")>(), useCloudDashboard: () => [] }));
vi.mock("@/lib/sidebarFilter", () => ({ useSidebarFilter: () => ({ active: false }) }));
vi.mock("@/components/issues/IssuePipelineSettingsDialog", () => ({ CloudIssuePipelineSettingsDialog: () => null }));

function project(grouped: boolean): CloudProject {
  const item = { workspace: { id: "one", orgId: "workspace-org", name: "One", state: "ready", provider: "box", authority: "participate", launch: { state: "failed", phase: "failed", category: "agent-sign-in-required", timings: { failedAt: 10 } } }, latestOperation: null } as unknown as CloudWorkspaceListItem;
  return { key: "cloud:workspace-org:github.com/acme/api", orgId: "workspace-org", identity: "github.com/acme/api", fullName: "acme/api", selected: true, pinned: false, blank: false, workspaces: [{ key: "cloud:workspace-org:one", item, placedBy: "server" }, ...(grouped ? [{ key: "cloud:workspace-org:two" as const, item: { workspace: { ...item.workspace, id: "two", name: "Two", launch: null }, latestOperation: null }, placedBy: "server" as const }] : [])] };
}
afterEach(() => { checkpointRows.value = []; cleanup(); takeOrganizationRequest(); takeAgentLoginsRequest("workspace-org"); });
describe("attention under the workspace's sidebar row", () => {
  it.each([false, true])("shows a visible reason and separate accessible button (grouped=%s)", (grouped) => {
    render(<CloudProjectGroup project={project(grouped)} onLifecycle={() => undefined} />);
    const row = screen.getByTestId("cloud-row-attention");
    expect(row.textContent).toContain("The agent needs a working login.");
    expect(screen.getAllByText("Needs attention")[0]).toBeTruthy();
    const expanded = screen.getByRole("button", { name: "Collapse acme/api" });
    fireEvent.click(within(row).getByRole("button", { name: "Open Agent logins" }));
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
    expect(takeOrganizationRequest()).toBe("workspace-org");
    expect(takeAgentLoginsRequest("workspace-org")).toBe(true);
    expect(row.closest("button")).toBeNull();
  });
});

const categories = ["agent-unavailable", "repository-clone-failed", "repository-access-denied", "repository-branch-not-found", "repository-clone-timed-out", "repository-path-occupied", "repository-empty", "workspace-disk-full", "repository-sync-failed", "branch-create-failed", "agent-start-failed", "agent-model-unavailable", "agent-sign-in-required", "runtime-interrupted", "runtime-storage-replaced", "payload-invalid", "launch-intent-unavailable", "runtime-unsupported", "launch-expired", "unknown-category", "credential-expired", "cloud_workspace_agent_credential_required"];
for (const grouped of [false, true]) describe(`launch failures on ${grouped ? "grouped" : "single"} workspace rows`, () => {
it.each(categories)("renders launch category %s on the actual sidebar row", (category) => {
  const value = project(grouped);
  value.workspaces[0].item.workspace.launch!.category = category;
  const attention = resolveCloudAttention(value.workspaces[0].item)!;
  render(<CloudProjectGroup project={value} onLifecycle={() => undefined} />);
  const row = screen.getByTestId("cloud-row-attention");
  expect(row.textContent).toContain(attention.recovery.action === "open-agent-logins" ? "The agent needs a working login." : attention.message.split(/(?<=\.)\s/)[0]);
  expect(within(row).getByRole("button", { name: attention.recovery.label })).toBeTruthy();
});
});

it("removes the row reason after recovery and shows a later failure again", () => {
  const value = project(false);
  const { rerender } = render(<CloudProjectGroup project={value} onLifecycle={() => undefined} />);
  expect(screen.getByTestId("cloud-row-attention")).toBeTruthy();
  const previous = value.workspaces[0].item;
  const recovered = reconcileCloudAttention({ ...previous, workspace: { ...previous.workspace,
    runtimeActivity: { online: true, reporting: true, stale: false, activeTurns: 1, pendingApprovals: 0, reportedAt: 20 },
  } }, previous);
  rerender(<CloudProjectGroup project={{ ...value, workspaces: [{ ...value.workspaces[0], item: recovered }] }} onLifecycle={() => undefined} />);
  expect(screen.queryByTestId("cloud-row-attention")).toBeNull();
  const newer = { ...previous, workspace: { ...previous.workspace, launch: { ...previous.workspace.launch!, timings: { ...previous.workspace.launch!.timings, failedAt: 30 } } } };
  rerender(<CloudProjectGroup project={{ ...value, workspaces: [{ ...value.workspaces[0], item: newer }] }} onLifecycle={() => undefined} />);
  expect(screen.getByTestId("cloud-row-attention")).toBeTruthy();
});

it("renders the operation failure beneath Needs attention", () => {
  const value = project(false);
  const row = value.workspaces[0].item;
  row.workspace.launch = null;
  row.workspace.state = "attention-required";
  row.latestOperation = { action: "resume", state: "failed", errorCode: "cloud_provider_unavailable" } as never;
  render(<CloudProjectGroup project={value} onLifecycle={() => undefined} />);
  expect(screen.getByTestId("cloud-row-attention").textContent).toContain("The provider did not answer.");
  expect(screen.getByRole("button", { name: "Retry resume" })).toBeTruthy();
});

// Exercise the actual row builder: mocked prebuilt tabs would hide lost checkpoint dates.
it.each(["created", "lastMessageAt"] as const)("clears grouped-row attention from a checkpoint's later %s", (field) => {
  const value = project(true);
  const item = value.workspaces[0].item;
  const early = new Date(5).toISOString();
  const later = new Date(20).toISOString();
  const checkpoint = { tabId: "checkpoint-tab", live: false, unread: false, info: {
    sessionId: "checkpoint-session", harness: "claude", title: "Recovered task", status: "idle",
    pendingPermissions: [], created: early, lastMessageAt: early,
  } } as unknown as CloudAgentTab;
  checkpointRows.value = buildCloudSessions({ item, agentTabs: [checkpoint] });
  const { rerender } = render(<CloudProjectGroup project={value} onLifecycle={() => undefined} />);
  const group = screen.getAllByTestId("cloud-workspace-group").find((row) => row.getAttribute("data-workspace") === "one")!;
  expect(within(group).getByTestId("cloud-workspace-row-state").textContent).toContain("Needs attention");
  expect(within(group).getByTestId("cloud-row-attention")).toBeTruthy();

  checkpointRows.value = buildCloudSessions({ item, agentTabs: [{ ...checkpoint, info: { ...checkpoint.info, [field]: later } }] });
  expect(checkpointRows.value[0].tabs[0][field]).toBe(later);
  // The catalog item is unchanged and has no recovery marker; only the checkpoint proves recovery.
  expect(resolveCloudAttention(item)).not.toBeNull();
  rerender(<CloudProjectGroup project={value} onLifecycle={() => undefined} />);
  expect(within(group).queryByTestId("cloud-row-attention")).toBeNull();
  expect(within(group).getByTestId("cloud-workspace-row-state").textContent).not.toContain("Needs attention");
});
