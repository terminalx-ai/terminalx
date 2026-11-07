import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";

const mocks = vi.hoisted(() => ({ restart: vi.fn(), copy: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("@/lib/api")>(), api: { cloudWorkspaceLogOpen: mocks.log } }));
vi.mock("@/lib/cloudWorkspaceDetails", () => ({ restartCloudWorkspace: mocks.restart, workspaceInfo: () => "Workspace ID: ws" }));
vi.mock("@/lib/cloudSchedules", () => ({ useSchedulesOffer: () => "unavailable" }));
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/menu";
import { WorkspaceActionItems } from "./WorkspaceActions";

const item: CloudWorkspaceListItem = { workspace: { id: "ws", orgId: "org", name: "Website", provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null, you: { role: "manager", canApprove: true }, details: { machineId: "machine-123", environmentVersion: null, environmentVersionId: null } }, latestOperation: null };
const open = (value = item) => render(<DropdownMenu open><DropdownMenuTrigger>Menu</DropdownMenuTrigger><DropdownMenuContent><WorkspaceActionItems item={value} run={(work) => void work()} onLifecycle={() => {}} /></DropdownMenuContent></DropdownMenu>);
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
