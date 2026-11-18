import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceIdleSuspend, CloudWorkspaceListItem } from "@/lib/api";

// "Stop when idle" on an existing workspace (PRO-410): whoever manages it
// picks how long it may sit idle, Never included unless the organization caps
// idle time, in which case the menu says why Never is missing.

const mocks = vi.hoisted(() => ({
  cloudWorkspaceIdleSuspend: vi.fn(),
  cloudWorkspaceSetIdleSuspend: vi.fn(),
  cloudSchedules: vi.fn(),
  refreshCloudCatalog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    cloudWorkspaceIdleSuspend: mocks.cloudWorkspaceIdleSuspend,
    cloudWorkspaceSetIdleSuspend: mocks.cloudWorkspaceSetIdleSuspend,
    cloudSchedules: mocks.cloudSchedules,
    cloudScheduleEstimate: vi.fn(),
  },
}));
vi.mock("@/lib/cloudCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudCatalog")>()),
  refreshCloudCatalog: mocks.refreshCloudCatalog,
}));

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/menu";
import { resetSchedulesOffers } from "@/lib/cloudSchedules";
import { WorkspaceActionItems } from "./WorkspaceActions";

const item = (workspace: Partial<CloudWorkspaceListItem["workspace"]> = {}): CloudWorkspaceListItem =>
  ({
    workspace: {
      id: "ws-1",
      orgId: "org-1",
      name: "Docs site",
      provider: "box",
      state: "ready",
      accessMode: "organization",
      createdAt: 1,
      updatedAt: 1,
      releaseDisposition: null,
      you: { role: "manager", canApprove: true },
      idleSuspendMinutes: 15,
      ...workspace,
    },
    latestOperation: null,
  }) as CloudWorkspaceListItem;

const view = (overrides: Partial<CloudWorkspaceIdleSuspend> = {}): CloudWorkspaceIdleSuspend => ({
  workspaceId: "ws-1",
  idleSuspendMinutes: 15,
  allowedIdleSuspendMinutes: [5, 10, 15, 30, 60, 0],
  maxIdleSuspendMinutes: null,
  ...overrides,
});

let errors: unknown[] = [];
const menu = (workspace: CloudWorkspaceListItem) =>
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <WorkspaceActionItems item={workspace} onLifecycle={() => undefined} run={(work) => void work().catch((e: unknown) => errors.push(e))} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );

const openIdleMenu = async () => {
  fireEvent.click(screen.getByTestId("cloud-idle-menu"));
  await waitFor(() => expect(mocks.cloudWorkspaceIdleSuspend).toHaveBeenCalledWith("ws-1", null));
};

beforeEach(() => {
  resetSchedulesOffers();
  errors = [];
  mocks.cloudWorkspaceIdleSuspend.mockReset();
  mocks.cloudWorkspaceSetIdleSuspend.mockReset();
  mocks.refreshCloudCatalog.mockClear();
  // No scheduled tasks on this server: only the idle item is under test.
  mocks.cloudSchedules.mockReset().mockRejectedValue({ code: "cloud_workspace_unavailable", status: 404 });
});
afterEach(cleanup);

describe("the workspace menu's Stop when idle", () => {
  it("shows the window in force, offers each window then Never, and changes it to Never", async () => {
    mocks.cloudWorkspaceIdleSuspend.mockResolvedValue(view());
    mocks.cloudWorkspaceSetIdleSuspend.mockResolvedValue({ ...item().workspace, idleSuspendMinutes: 0 });
    menu(item());
    expect(screen.getByTestId("cloud-idle-menu").textContent).toContain("15 minutes");
    await openIdleMenu();
    const choices = await screen.findAllByRole("menuitemradio");
    expect(choices.map((choice) => choice.textContent)).toEqual(["5 minutes", "10 minutes", "15 minutes", "30 minutes", "1 hour", "Never"]);
    expect(screen.getByTestId("cloud-idle-choice-15").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/so Never is not offered/)).toBeNull();

    fireEvent.click(screen.getByTestId("cloud-idle-choice-0"));
    await waitFor(() => expect(mocks.cloudWorkspaceSetIdleSuspend).toHaveBeenCalledWith("ws-1", 0, null));
    await waitFor(() => expect(mocks.refreshCloudCatalog).toHaveBeenCalledWith("org-1"));
    expect(errors).toEqual([]);
  });

  it("leaves Never out under an organization cap and says why", async () => {
    mocks.cloudWorkspaceIdleSuspend.mockResolvedValue(view({ allowedIdleSuspendMinutes: [5, 10, 15, 30], maxIdleSuspendMinutes: 30 }));
    menu(item());
    await openIdleMenu();
    const choices = await screen.findAllByRole("menuitemradio");
    expect(choices.map((choice) => choice.textContent)).toEqual(["5 minutes", "10 minutes", "15 minutes", "30 minutes"]);
    expect(screen.getByText("Your organization stops idle workspaces after at most 30 minutes, so Never is not offered.")).toBeTruthy();
  });

  it("shows a window set before the cap as it is, without offering it again", async () => {
    mocks.cloudWorkspaceIdleSuspend.mockResolvedValue(view({ idleSuspendMinutes: 0, allowedIdleSuspendMinutes: [5, 10, 15, 30], maxIdleSuspendMinutes: 30 }));
    menu(item({ idleSuspendMinutes: 0 }));
    await openIdleMenu();
    const kept = await screen.findByText("Never (not allowed any more)");
    expect(kept.closest("[role=menuitemradio]")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the refusal of a change for the menu's caller to show, and reads the list again", async () => {
    mocks.cloudWorkspaceIdleSuspend.mockResolvedValue(view());
    mocks.cloudWorkspaceSetIdleSuspend.mockRejectedValue({ code: "cloud_workspace_policy_denied", status: 422 });
    menu(item());
    await openIdleMenu();
    fireEvent.click(await screen.findByTestId("cloud-idle-choice-60"));
    await waitFor(() => expect(errors).toEqual([{ code: "cloud_workspace_policy_denied", status: 422 }]));
    expect(mocks.refreshCloudCatalog).toHaveBeenCalledWith("org-1");
  });

  it("is not offered on an older server, a preparation workspace, to someone who cannot manage it, or once deleted", () => {
    for (const workspace of [
      item({ idleSuspendMinutes: undefined }),
      item({ preparation: { stopAfter: 2 } }),
      item({ you: { role: "driver", canApprove: false } }),
      item({ state: "destroyed" }),
    ]) {
      menu(workspace);
      expect(screen.queryByTestId("cloud-idle-menu")).toBeNull();
      cleanup();
    }
    menu(item());
    expect(screen.getByTestId("cloud-idle-menu")).toBeTruthy();
    expect(mocks.cloudWorkspaceIdleSuspend).not.toHaveBeenCalled();
  });
});
