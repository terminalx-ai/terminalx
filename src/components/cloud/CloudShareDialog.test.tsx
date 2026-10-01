import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceShare, CloudWorkspaceShares } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  shares: vi.fn(),
  put: vi.fn(),
  revoke: vi.fn(),
  members: vi.fn(),
  access: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: { cloudWorkspaceShares: mocks.shares, cloudWorkspaceSharePut: mocks.put, cloudWorkspaceShareRevoke: mocks.revoke, cloudWorkspaceSetAccess: mocks.access },
}));
vi.mock("@/lib/organizationMembers", () => ({ organizationMembers: { list: mocks.members } }));
// The account's default organization decides whether the roster applies.
const account = vi.hoisted(() => ({ status: { identity: { organizationId: "org-1", email: "me@example.com" } } as unknown }));
vi.mock("@/lib/account", () => ({ useAccount: () => account }));

import { CloudShareDialog, CloudShareDialogHost, openShareDialog, shareErrorMessage } from "./CloudShareDialog";
import { personName, resetPeople } from "@/lib/cloudPeople";
import { onAccessChanged } from "@/lib/cloudCollab";

const share = (fields: Partial<CloudWorkspaceShare> = {}): CloudWorkspaceShare => ({
  userId: "u-alice",
  email: "alice@example.com",
  name: "Alice",
  role: "viewer",
  canApprove: false,
  createdBy: "u-me",
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

let listed: CloudWorkspaceShares;

beforeEach(() => {
  listed = { shares: [share()], you: { role: "manager", canApprove: true, canManageShares: true } };
  mocks.shares.mockReset().mockImplementation(async () => listed);
  mocks.put.mockReset().mockImplementation(async (_ws: string, userId: string, role: string, canApprove: boolean) => {
    const next = share({ userId, role: role as CloudWorkspaceShare["role"], canApprove, name: userId === "u-bob" ? "Bob" : "Alice", email: `${userId}@example.com` });
    listed = { ...listed, shares: [...listed.shares.filter((s) => s.userId !== userId), next] };
    return { share: next, created: true };
  });
  mocks.revoke.mockReset().mockImplementation(async (_ws: string, userId: string) => {
    const gone = listed.shares.find((s) => s.userId === userId)!;
    listed = { ...listed, shares: listed.shares.filter((s) => s.userId !== userId) };
    return { share: gone };
  });
  mocks.access.mockReset().mockImplementation(async (workspaceId: string, accessMode: string) => {
    // Going private revokes every share in the same transaction (saas §21.2).
    if (accessMode === "private") listed = { ...listed, shares: [] };
    return { id: workspaceId, orgId: "org-1", accessMode };
  });
  mocks.members.mockReset().mockResolvedValue({
    members: [
      { userId: "u-me", email: "me@example.com", displayName: "Me", role: "owner" },
      { userId: "u-alice", email: "alice@example.com", displayName: "Alice", role: "member" },
      { userId: "u-bob", email: "bob@example.com", displayName: "Bob", role: "member" },
      { userId: "u-admin", email: "carol@example.com", displayName: "Carol", role: "admin" },
    ],
    pendingInvites: [],
    viewerRole: "owner",
    canManageMembers: true,
    contextRevision: "r1",
  });
});

afterEach(() => {
  cleanup();
  resetPeople();
});

const dialog = () => render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" onClose={() => undefined} />);

describe("share dialog", () => {
  it("adds someone from the roster who is not shared yet", async () => {
    dialog();
    await screen.findByTestId("cloud-share-row");
    const picker = screen.getByLabelText("Add person") as HTMLSelectElement;
    await waitFor(() => expect(within(picker).queryByText(/Bob/)).toBeTruthy());
    // Already shared people are not offered again.
    expect(within(picker).queryByText(/Alice/)).toBeNull();
    fireEvent.change(picker, { target: { value: "u-bob" } });
    fireEvent.change(screen.getByLabelText("New person's role"), { target: { value: "driver" } });
    fireEvent.click(screen.getByRole("switch", { name: "New person can approve permissions" }));
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("ws-1", "u-bob", "driver", true, "org-1"));
    await waitFor(() => expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(2));
    // Their name is known wherever the workspace shows them now.
    expect(personName("u-bob")).toBe("Bob");
  });

  it("changes a share's role and approval, and revokes it", async () => {
    dialog();
    const row = await screen.findByTestId("cloud-share-row");
    fireEvent.change(within(row).getByLabelText("Role for Alice"), { target: { value: "driver" } });
    await waitFor(() => expect(mocks.put).toHaveBeenLastCalledWith("ws-1", "u-alice", "driver", false, "org-1"));
    fireEvent.click(within(await screen.findByTestId("cloud-share-row")).getByRole("switch", { name: "Can approve permissions: Alice" }));
    await waitFor(() => expect(mocks.put).toHaveBeenLastCalledWith("ws-1", "u-alice", "driver", true, "org-1"));
    fireEvent.click(within(await screen.findByTestId("cloud-share-row")).getByRole("button", { name: "Revoke Alice" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("ws-1", "u-alice", "org-1"));
    await waitFor(() => expect(screen.queryByTestId("cloud-share-row")).toBeNull());
  });

  it("says in words why a share was refused", async () => {
    mocks.put.mockRejectedValueOnce({ code: "cloud_workspace_share_redundant", status: 409 });
    dialog();
    await screen.findByTestId("cloud-share-row");
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Bob/)).toBeTruthy());
    // Owners and admins always have access, so they are not offered.
    expect(within(screen.getByLabelText("Add person")).queryByText(/Carol/)).toBeNull();
    expect(within(screen.getByLabelText("Add person")).queryByText(/^Me/)).toBeNull();
    // The server still refuses someone with access, such as a member who created the workspace.
    fireEvent.change(screen.getByLabelText("Add person"), { target: { value: "u-bob" } });
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect((await screen.findByTestId("cloud-share-error")).textContent).toBe("Bob already has access as owner/admin/creator.");

    mocks.put.mockRejectedValueOnce({ code: "cloud_workspace_share_requires_organization_access", status: 409 });
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    await waitFor(() => expect(screen.getByTestId("cloud-share-error").textContent).toBe("Make the workspace visible to the organization first."));

    expect(shareErrorMessage({ code: "cloud_workspace_share_limit" })).toMatch(/maximum number of people \(64\)/);
    expect(shareErrorMessage({ code: "cloud_workspace_share_forbidden" })).toBe(
      "Only organization admins and the workspace's creator can change who it is shared with.",
    );
  });

  it("shows a read-only list and their own role to someone who cannot manage shares", async () => {
    listed = { shares: [share({ role: "driver", canApprove: true })], you: { role: "viewer", canApprove: true, canManageShares: false } };
    dialog();
    const row = await screen.findByTestId("cloud-share-row");
    expect(row.textContent).toContain("Driver · can approve");
    expect(screen.getByTestId("cloud-share-you").textContent).toBe("Your access: Viewer (can read everything, not send), can approve permissions.");
    expect(screen.queryByLabelText("Add person")).toBeNull();
    expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();
    expect(within(row).queryByRole("combobox")).toBeNull();
  });

  it("manages a workspace in another organization by its own organization, without the default one's roster", async () => {
    render(<CloudShareDialog orgId="org-2" workspaceId="ws-1" name="Payments" onClose={() => undefined} />);
    const row = await screen.findByTestId("cloud-share-row");
    expect(mocks.shares).toHaveBeenCalledWith("ws-1", "org-2");
    // The default organization's members would be the wrong people to offer.
    expect(screen.queryByLabelText("Add person")).toBeNull();
    expect(screen.getByTestId("cloud-share-other-org")).toBeTruthy();
    expect(mocks.members).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Revoke Alice" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("ws-1", "u-alice", "org-2"));
  });

  it("opens from anywhere through the one mounted host", async () => {
    render(<CloudShareDialogHost />);
    expect(screen.queryByTestId("cloud-share-dialog")).toBeNull();
    act(() => openShareDialog({ orgId: "org-1", workspaceId: "ws-1", name: "Payments" }));
    await screen.findByTestId("cloud-share-dialog");
    expect(mocks.shares).toHaveBeenCalledWith("ws-1", "org-1");
    act(() => openShareDialog(null));
    await waitFor(() => expect(screen.queryByTestId("cloud-share-dialog")).toBeNull());
  });

  it("titles the read-only list \"Who has access\" with neutral copy for someone who cannot manage shares", async () => {
    listed = { shares: [share()], you: { role: "viewer", canApprove: false, canManageShares: false } };
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" canManage={false} onClose={() => undefined} />);
    await screen.findByTestId("cloud-share-row");
    expect(screen.getByRole("heading").textContent).toBe("Who has access");
    const text = screen.getByTestId("cloud-share-dialog").textContent ?? "";
    expect(text).toContain("People with access to Payments see its agent tabs, terminals, files and Git.");
    expect(text).not.toMatch(/People you share with|Share Payments/);
    expect(screen.queryByRole("button", { name: /Make private again/ })).toBeNull();
    // A manager keeps the owner's title.
    cleanup();
    listed = { shares: [share()], you: { role: "manager", canApprove: true, canManageShares: true } };
    dialog();
    await screen.findByTestId("cloud-share-row");
    expect(screen.getByRole("heading").textContent).toBe("Share Payments");
  });
});

// The live two-user test: a workspace made from the sidebar is private, and nothing could share it.
describe("sharing a private workspace", () => {
  const privateDialog = () => render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" accessMode="private" createdBy="u-me" canManage onClose={() => undefined} />);
  beforeEach(() => {
    listed = { shares: [], you: { role: "manager", canApprove: true, canManageShares: true } };
  });

  it("explains in plain words what sharing a private workspace does", async () => {
    privateDialog();
    const note = await screen.findByTestId("cloud-share-private");
    expect(note.textContent).toBe(
      "This workspace is private: only you can see it. Sharing it makes it visible in the organization's sidebar. The people you add here and organization admins can open it; other members see only that it exists.",
    );
    // Nothing to make private while it already is.
    expect(screen.queryByRole("button", { name: /Make private again/ })).toBeNull();
  });

  it("makes it visible to the organization only after an explicit confirmation, then shares", async () => {
    const changed = vi.fn();
    const stop = onAccessChanged(changed);
    privateDialog();
    const picker = (await screen.findByLabelText("Add person")) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).queryByText(/Bob/)).toBeTruthy());
    fireEvent.change(picker, { target: { value: "u-bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    // Asked first: nothing has changed yet.
    const confirm = await screen.findByTestId("cloud-share-confirm");
    expect(confirm.textContent).toContain("Share with Bob and make Payments visible to the organization?");
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();

    // Cancel leaves it private and unshared.
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("cloud-share-confirm")).toBeNull();
    expect(mocks.access).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(within(await screen.findByTestId("cloud-share-confirm")).getByRole("button", { name: "Make visible and share" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("ws-1", "u-bob", "viewer", false, "org-1"));
    // The access mode switches first, then the share.
    expect(mocks.access).toHaveBeenCalledWith("ws-1", "organization", "org-1");
    expect(mocks.access.mock.invocationCallOrder[0]).toBeLessThan(mocks.put.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(1));
    // No longer private: the note goes, "Make private again" appears, and the sidebar is told to list again.
    expect(screen.queryByTestId("cloud-share-private")).toBeNull();
    expect(screen.getByRole("button", { name: /Make private again/ })).toBeTruthy();
    expect(changed).toHaveBeenCalledWith("org-1");

    // The next person is shared without asking again or switching again.
    mocks.access.mockClear();
    fireEvent.change(screen.getByLabelText("Add person"), { target: { value: "u-alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(mocks.put).toHaveBeenLastCalledWith("ws-1", "u-alice", "viewer", false, "org-1"));
    expect(screen.queryByTestId("cloud-share-confirm")).toBeNull();
    expect(mocks.access).not.toHaveBeenCalled();
    stop();
  });

  it("says who may change visibility when a member (the creator) is refused, and shares nothing", async () => {
    mocks.access.mockRejectedValueOnce({ code: "organization_admin_required", status: 403 });
    privateDialog();
    const picker = (await screen.findByLabelText("Add person")) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).queryByText(/Bob/)).toBeTruthy());
    fireEvent.change(picker, { target: { value: "u-bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(within(await screen.findByTestId("cloud-share-confirm")).getByRole("button", { name: "Make visible and share" }));
    expect((await screen.findByTestId("cloud-share-error")).textContent).toBe(
      "Only an organization owner or admin can change whether a workspace is private or visible to the organization. Ask one to change it.",
    );
    expect(mocks.put).not.toHaveBeenCalled();
    expect(screen.getByTestId("cloud-share-private")).toBeTruthy();
  });

  it("makes a shared workspace private again, revoking everyone, only after a confirmation", async () => {
    listed = { shares: [share(), share({ userId: "u-bob", name: "Bob", email: "bob@example.com" })], you: { role: "manager", canApprove: true, canManageShares: true } };
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" accessMode="organization" createdBy="u-me" canManage onClose={() => undefined} />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Make private again/ }));
    const confirm = await screen.findByTestId("cloud-private-confirm");
    expect(confirm.textContent).toContain("Make Payments private again? All 2 people it is shared with lose access now and their open sessions close.");
    expect(confirm.textContent).toContain("Only you will still see it.");
    expect(mocks.access).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(mocks.access).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Make private again/ }));
    fireEvent.click(within(await screen.findByTestId("cloud-private-confirm")).getByRole("button", { name: "Revoke all and make private" }));
    await waitFor(() => expect(mocks.access).toHaveBeenCalledWith("ws-1", "private", "org-1"));
    await waitFor(() => expect(screen.queryByTestId("cloud-share-row")).toBeNull());
    expect(await screen.findByTestId("cloud-share-private")).toBeTruthy();
    // One call revokes every share on the server; none is revoked one by one.
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("warns an admin who did not create it that they stop seeing it too", async () => {
    listed = { shares: [share()], you: { role: "manager", canApprove: true, canManageShares: true } };
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" accessMode="organization" createdBy="u-bob" canManage onClose={() => undefined} />);
    await screen.findByTestId("cloud-share-row");
    // The roster says who this person is (by email).
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Bob/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Make private again/ }));
    const confirm = await screen.findByTestId("cloud-private-confirm");
    expect(confirm.textContent).toContain("The 1 person it is shared with loses access now");
    expect(confirm.textContent).toContain("You did not create it, so you will stop seeing it too: only its creator will.");
  });

  it("closes once a workspace someone else created is private, as there is nothing left for them to read", async () => {
    listed = { shares: [share()], you: { role: "manager", canApprove: true, canManageShares: true } };
    const onClose = vi.fn();
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" accessMode="organization" createdBy="u-bob" canManage onClose={onClose} />);
    await screen.findByTestId("cloud-share-row");
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Bob/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Make private again/ }));
    fireEvent.click(within(await screen.findByTestId("cloud-private-confirm")).getByRole("button", { name: "Revoke all and make private" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.access).toHaveBeenCalledWith("ws-1", "private", "org-1");
  });

  it("keeps the workspace as it was and says why when making it private is refused", async () => {
    mocks.access.mockRejectedValueOnce({ code: "organization_admin_required", status: 403 });
    listed = { shares: [share()], you: { role: "driver", canApprove: true, canManageShares: true } };
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" accessMode="organization" createdBy="u-me" canManage onClose={() => undefined} />);
    await screen.findByTestId("cloud-share-row");
    fireEvent.click(screen.getByRole("button", { name: /Make private again/ }));
    fireEvent.click(within(await screen.findByTestId("cloud-private-confirm")).getByRole("button", { name: "Revoke all and make private" }));
    expect((await screen.findByTestId("cloud-share-error")).textContent).toMatch(/^Only an organization owner or admin can change whether a workspace is private/);
    expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Make private again/ })).toBeTruthy();
  });
});
