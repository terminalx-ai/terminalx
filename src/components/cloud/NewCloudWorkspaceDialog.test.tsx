import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import { chooseMode } from "@/lib/dialogs";
import { setPrefs } from "@/lib/prefs";
import { mouseClick } from "@/test/press";

// PRO-68: the full new-workspace form, once the top of the full-window cloud
// page, is a dialog any surface opens with `openNewCloudWorkspace`.

const mocks = vi.hoisted(() => ({
  status: null as unknown as AccountStatus,
  form: [] as { organizationId: string; onOpen: (item: CloudWorkspaceListItem) => void; onChanged?: () => void }[],
  refreshCloudCatalog: vi.fn(async () => undefined),
  applyCloudSnapshot: vi.fn(),
  applied: vi.fn(),
}));

vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: mocks.status, ready: true, busy: false }) }));
vi.mock("@/lib/cloudCatalog", () => ({ refreshCloudCatalog: mocks.refreshCloudCatalog, applyCloudSnapshot: mocks.applyCloudSnapshot }));
vi.mock("./CloudCreateWorkspace", () => ({
  CloudCreateWorkspace: (props: (typeof mocks.form)[number]) => {
    mocks.form.push(props);
    // The form's permission picker asks about bypass as every launch surface does.
    return (
      <div data-testid="cloud-create-stub">
        <button type="button" onClick={() => chooseMode("claude", "bypassPermissions", mocks.applied)}>
          Pick bypass
        </button>
      </div>
    );
  },
}));

const { NewCloudWorkspaceDialogHost, openNewCloudWorkspace } = await import("./NewCloudWorkspaceDialog");
const { BypassDialog } = await import("@/components/session/BypassDialog");
const sessions = await import("@/lib/sessions");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.form.length = 0;
  setPrefs({ bypassConfirmed: false });
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

  it("stays open while the bypass question asked from its form is put away, cancelled or agreed to", async () => {
    // Mounted beside it, as AppShell mounts both.
    render(
      <>
        <NewCloudWorkspaceDialogHost />
        <BypassDialog />
      </>,
    );
    act(() => openNewCloudWorkspace());
    const question = async () => {
      mouseClick(screen.getByRole("button", { name: "Pick bypass" }));
      return screen.findByRole("dialog", { name: /run without asking/ });
    };
    const answered = async () => {
      await waitFor(() => expect(screen.queryByRole("dialog", { name: /run without asking/ })).toBeNull());
      expect(screen.getByTestId("cloud-new-workspace-dialog")).toBeTruthy();
    };

    fireEvent.keyDown(await question(), { key: "Escape" });
    await answered();
    mouseClick(within(await question()).getByRole("button", { name: "Cancel" }));
    await answered();
    expect(mocks.applied).not.toHaveBeenCalled();
    mouseClick(within(await question()).getByRole("button", { name: "Bypass permissions" }));
    await answered();
    expect(mocks.applied).toHaveBeenCalledWith("bypassPermissions");
  });
});
