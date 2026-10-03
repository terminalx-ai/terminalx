import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// PRO-68: the full new-workspace form, once the top of the full-window cloud
// page, is a dialog any surface opens with `openNewCloudWorkspace`.

const mocks = vi.hoisted(() => ({
  status: null as unknown as AccountStatus,
  form: [] as { organizationId: string; onOpen: (item: CloudWorkspaceListItem) => void; onChanged?: () => void }[],
  refreshCloudCatalog: vi.fn(async () => undefined),
  applyCloudSnapshot: vi.fn(),
}));

vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: mocks.status, ready: true, busy: false }) }));
vi.mock("@/lib/cloudCatalog", () => ({ refreshCloudCatalog: mocks.refreshCloudCatalog, applyCloudSnapshot: mocks.applyCloudSnapshot }));
vi.mock("./CloudCreateWorkspace", () => ({
  CloudCreateWorkspace: (props: (typeof mocks.form)[number]) => {
    mocks.form.push(props);
    return <div data-testid="cloud-create-stub" />;
  },
}));

const { NewCloudWorkspaceDialogHost, openNewCloudWorkspace } = await import("./NewCloudWorkspaceDialog");
const sessions = await import("@/lib/sessions");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.form.length = 0;
  mocks.status = { state: "signed-in", identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: "org-a" }, expiresAt: null, lastError: null, context: { scope: "s", revision: "s:1" } } as AccountStatus;
});

afterEach(() => {
  act(() => openNewCloudWorkspace(false));
  cleanup();
  act(() => sessions.selectCloudWorkspace(null));
});

describe("the new cloud workspace dialog", () => {
  it("shows nothing until it is opened, and creates nothing by opening", () => {
    render(<NewCloudWorkspaceDialogHost />);
    expect(screen.queryByTestId("cloud-new-workspace-dialog")).toBeNull();
    act(() => openNewCloudWorkspace());
    expect(screen.getByTestId("cloud-new-workspace-dialog").textContent).toContain("A new machine in Acme");
    expect(screen.getByTestId("cloud-create-stub")).toBeTruthy();
    expect(mocks.form.at(-1)!.organizationId).toBe("s");
  });

  it("opens the created workspace in the main slot and closes", () => {
    render(<NewCloudWorkspaceDialogHost />);
    act(() => openNewCloudWorkspace());
    act(() => mocks.form.at(-1)!.onOpen({ workspace: { id: "ws-new", orgId: "org-a" } } as CloudWorkspaceListItem));
    expect(screen.queryByTestId("cloud-new-workspace-dialog")).toBeNull();
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe("cloud:org-a:ws-new");
    // The sidebar's list is read again, so the new row shows.
    expect(mocks.refreshCloudCatalog).toHaveBeenCalled();
  });

  it("is not shown while signed out", () => {
    mocks.status = { state: "signed-out", identity: null, expiresAt: null, lastError: null } as unknown as AccountStatus;
    render(<NewCloudWorkspaceDialogHost />);
    act(() => openNewCloudWorkspace());
    expect(screen.queryByTestId("cloud-new-workspace-dialog")).toBeNull();
  });
});
