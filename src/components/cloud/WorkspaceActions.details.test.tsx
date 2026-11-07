import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";

const mocks = vi.hoisted(() => ({ restart: vi.fn(), resume: vi.fn(), copy: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("@/lib/api")>(), api: { cloudWorkspaceLogOpen: mocks.log } }));
vi.mock("@/lib/cloudCatalog", async (original) => ({ ...await original<typeof import("@/lib/cloudCatalog")>(), resumeCloudWorkspace: mocks.resume }));
vi.mock("@/lib/cloudWorkspaceDetails", () => ({ restartCloudWorkspace: mocks.restart, workspaceInfo: () => "Workspace ID: ws" }));
vi.mock("@/lib/cloudSchedules", () => ({ useSchedulesOffer: () => "unavailable" }));
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/menu";
import { WorkspaceActionItems } from "./WorkspaceActions";

const item: CloudWorkspaceListItem = { workspace: { id: "ws", orgId: "org", name: "Website", provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null, you: { role: "manager", canApprove: true }, details: { machineId: "machine-123", environmentVersion: null, environmentVersionId: null } }, latestOperation: null };
const open = (value = item, archived = false) => render(<DropdownMenu open><DropdownMenuTrigger>Menu</DropdownMenuTrigger><DropdownMenuContent><WorkspaceActionItems item={value} archived={archived} run={(work) => void work()} onLifecycle={() => {}} /></DropdownMenuContent></DropdownMenu>);
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.copy.mockResolvedValue(undefined) } }); });
afterEach(cleanup);

it("offers restart to managers and calls it for this workspace", async () => {
  open();
  fireEvent.click(screen.getByText("Restart workspace"));
  await waitFor(() => expect(mocks.restart).toHaveBeenCalledWith(item));
});

it("copies the machine ID and support info, and opens this organization's log", async () => {
  open(); fireEvent.click(screen.getByText("Copy machine ID"));
  expect(mocks.copy).toHaveBeenCalledWith("machine-123");
  cleanup(); open(); fireEvent.click(screen.getByText("Copy workspace info"));
  expect(mocks.copy).toHaveBeenCalledWith("Workspace ID: ws");
  cleanup(); open(); fireEvent.click(screen.getByText("Open provisioning log"));
  expect(mocks.log).toHaveBeenCalledWith("ws", "org");
});

it("hides restart from viewers and stopped workspaces, and disables unknown machine IDs", () => {
  open({ ...item, workspace: { ...item.workspace, you: { role: "viewer", canApprove: false }, details: null } });
  expect(screen.queryByText("Restart workspace")).toBeNull();
  expect(screen.getByText("Copy machine ID").getAttribute("aria-disabled")).toBe("true");
  cleanup(); open({ ...item, workspace: { ...item.workspace, state: "suspended" } });
  expect(screen.queryByText("Restart workspace")).toBeNull();
});

const failedRestart: CloudWorkspaceListItem = {
  ...item,
  workspace: { ...item.workspace, state: "attention-required" },
  latestOperation: { id: "restart", workspaceId: "ws", type: "create", action: "restart", state: "failed", stage: "bootstrapping", cancelable: false, createdAt: 1, updatedAt: 2, lastProviderContactAt: 2, nextAttemptAt: null, retryReason: null, errorCode: "cloud_provider_unavailable", progress: null, events: null },
};

it.each(["restart", "resume"] as const)("offers non-destructive Resume after a failed %s, including a repeated recovery", async (action) => {
  const failed = { ...failedRestart, latestOperation: { ...failedRestart.latestOperation!, action } };
  open(failed);
  expect(screen.queryByText("Restart workspace")).toBeNull();
  fireEvent.click(screen.getByText("Resume"));
  await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(failed));
  expect(mocks.restart).not.toHaveBeenCalled();
});

it("never offers failed-restart recovery to viewers, archived/deleted rows, active operations or an unsupported runtime", () => {
  const blocked: CloudWorkspaceListItem[] = [
    { ...failedRestart, workspace: { ...failedRestart.workspace, you: { role: "viewer", canApprove: false } } },
    { ...failedRestart, workspace: { ...failedRestart.workspace, archivedAt: 2 } },
    { ...failedRestart, workspace: { ...failedRestart.workspace, deletedAt: 2 } },
    { ...failedRestart, latestOperation: { ...failedRestart.latestOperation!, state: "running" } },
    { ...failedRestart, latestOperation: { ...failedRestart.latestOperation!, errorCode: "cloud_workspace_runtime_unsupported" } },
  ];
  for (const value of blocked) {
    open(value);
    expect(screen.queryByText("Resume")).toBeNull();
    cleanup();
  }
  open(failedRestart, true);
  expect(screen.queryByText("Resume")).toBeNull();
});
