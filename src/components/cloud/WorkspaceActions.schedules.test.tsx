import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";

// "Scheduled tasks…" is an owner's or admin's, on a server that has the
// feature turned on. Nobody else is shown an item that would only be refused.

const mocks = vi.hoisted(() => ({ cloudSchedules: vi.fn(), cloudScheduleEstimate: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { cloudSchedules: mocks.cloudSchedules, cloudScheduleEstimate: mocks.cloudScheduleEstimate },
}));
vi.mock("@/components/cloud/CloudSchedulesDialog", () => ({ openSchedulesDialog: mocks.open }));

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/menu";
import { resetSchedulesOffers } from "@/lib/cloudSchedules";
import { WorkspaceActionItems } from "./WorkspaceActions";

const item = (you: { role: string; canApprove: boolean }, state = "ready", accessMode = "organization"): CloudWorkspaceListItem =>
  ({
    workspace: { id: "ws-1", orgId: "org-1", name: "Docs site", provider: "box", state, accessMode, createdAt: 1, updatedAt: 1, releaseDisposition: null, you },
    latestOperation: null,
  }) as CloudWorkspaceListItem;

const menu = (workspace: CloudWorkspaceListItem) =>
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <WorkspaceActionItems item={workspace} onLifecycle={() => undefined} run={() => undefined} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );

beforeEach(() => {
  resetSchedulesOffers();
  mocks.cloudSchedules.mockReset();
  mocks.cloudScheduleEstimate.mockReset();
  mocks.open.mockReset();
});
afterEach(cleanup);

describe("the workspace menu's scheduled tasks", () => {
  it("is offered to a manager once the server has listed the organization's tasks", async () => {
    mocks.cloudSchedules.mockResolvedValue({ schedules: [] });
    menu(item({ role: "manager", canApprove: true }));
    // Not before the server has answered.
    expect(screen.queryByText("Scheduled tasks…")).toBeNull();
    fireEvent.click(await screen.findByText("Scheduled tasks…"));
    expect(mocks.open).toHaveBeenCalledWith({ orgId: "org-1", workspaceId: "ws-1", name: "Docs site" });
    // The question is a read of the list: it names no workspace and wakes none.
    expect(mocks.cloudSchedules).toHaveBeenCalledWith(null, "org-1");
  });

  it("is not shown when the server refuses the person or has the feature off", async () => {
    for (const refusal of [{ code: "organization_admin_required", status: 403 }, { code: "cloud_workspace_unavailable", status: 404 }]) {
      resetSchedulesOffers();
      mocks.cloudSchedules.mockReset().mockRejectedValue(refusal);
      menu(item({ role: "manager", canApprove: true }));
      await waitFor(() => expect(mocks.cloudSchedules).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(screen.queryByText("Scheduled tasks…")).toBeNull();
      cleanup();
    }
  });

  it("is not shown on a private workspace to an admin it is only shared with: its tasks are its creator's", async () => {
    mocks.cloudSchedules.mockResolvedValue({ schedules: [] });
    mocks.cloudScheduleEstimate.mockRejectedValue({ code: "cloud_workspace_not_found", status: 404 });
    menu(item({ role: "manager", canApprove: true }, "ready", "private"));
    await waitFor(() => expect(mocks.cloudScheduleEstimate).toHaveBeenCalledTimes(1));
    expect(mocks.cloudScheduleEstimate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }), "org-1");
    await Promise.resolve();
    expect(screen.queryByText("Scheduled tasks…")).toBeNull();
    cleanup();

    // Its creator is answered, and is offered them.
    resetSchedulesOffers();
    mocks.cloudScheduleEstimate.mockReset().mockResolvedValue({ supported: true });
    menu(item({ role: "manager", canApprove: true }, "ready", "private"));
    expect(await screen.findByText("Scheduled tasks…")).toBeTruthy();
    cleanup();

    // An organization-visible workspace needs no second question.
    resetSchedulesOffers();
    mocks.cloudScheduleEstimate.mockReset();
    menu(item({ role: "manager", canApprove: true }));
    expect(await screen.findByText("Scheduled tasks…")).toBeTruthy();
    expect(mocks.cloudScheduleEstimate).not.toHaveBeenCalled();
  });

  it("is not asked about for someone who does not manage the workspace, or for a deleted one", async () => {
    menu(item({ role: "viewer", canApprove: false }));
    cleanup();
    menu(item({ role: "manager", canApprove: true }, "destroyed"));
    await Promise.resolve();
    expect(mocks.cloudSchedules).not.toHaveBeenCalled();
    expect(screen.queryByText("Scheduled tasks…")).toBeNull();
  });
});
