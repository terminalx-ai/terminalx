import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceShare, CloudWorkspaceShares } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  shares: vi.fn(),
  put: vi.fn(),
  revoke: vi.fn(),
  members: vi.fn(),
  access: vi.fn(),
  membersIn: vi.fn(),
  workspaces: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: {
    cloudWorkspaceShares: mocks.shares,
    cloudWorkspaceSharePut: mocks.put,
    cloudWorkspaceShareRevoke: mocks.revoke,
    cloudWorkspaceSetAccess: mocks.access,
    cloudWorkspaces: mocks.workspaces,
  },
}));
vi.mock("@/lib/organizationMembers", () => ({ organizationMembers: { list: mocks.members, listIn: mocks.membersIn } }));
// The account's default organization decides whether the roster applies.
const account = vi.hoisted(() => ({ status: { identity: { organizationId: "org-1", email: "me@example.com" } } as unknown }));
vi.mock("@/lib/account", () => ({ useAccount: () => account }));

import { CloudShareDialog, CloudShareDialogHost, openShareDialog, shareErrorMessage, yourAccessText } from "./CloudShareDialog";
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
  // What the server says the workspace's visibility is, when the dialog reads it back.
  mocks.workspaces.mockReset().mockResolvedValue({ workspaces: [{ workspace: { id: "ws-1", accessMode: "private" } }] });
  mocks.membersIn.mockReset().mockResolvedValue({
    members: [
      { userId: "u-me", email: "me@example.com", displayName: "Me", role: "admin" },
      { userId: "u-dana", email: "dana@example.com", displayName: "Dana", role: "member" },
    ],
    pendingInvites: [],
    viewerRole: "admin",
    canManageMembers: true,
    contextRevision: "",
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

  it("tells the organization's owner they are the Owner, and an admin that they are an Admin", async () => {
    // The API's role for both is `manager`; the roster (or the account) says which.
    dialog();
    await waitFor(() => expect(screen.getByTestId("cloud-share-you").textContent).toBe("Your access: Owner (the organization's owner: manages this workspace and who it is shared with)."));
    expect(screen.getByTestId("cloud-share-you").textContent).not.toContain("Admin");
    cleanup();

    // The account's own organization list wins over the roster, and is there before the roster loads.
    const before = account.status;
    account.status = { identity: { organizationId: "org-1", email: "me@example.com" }, organizations: [{ id: "org-1", name: "Acme", role: "admin" }] };
    dialog();
    expect((await screen.findByTestId("cloud-share-you")).textContent).toBe("Your access: Admin (an organization admin: manages this workspace and who it is shared with).");
    account.status = before;
  });

  it("names every role it can tell apart, and guesses none it cannot", () => {
    const manager = { role: "manager", canApprove: true, canManageShares: true } as const;
    expect(yourAccessText(manager, "owner")).toMatch(/^Owner \(/);
    expect(yourAccessText(manager, "admin")).toMatch(/^Admin \(/);
    // Not known which: neither is claimed.
    expect(yourAccessText(manager, null)).toBe("Owner or admin of the organization (manages this workspace and who it is shared with)");
    // A plain member who created the workspace drives it and manages its shares.
    expect(yourAccessText({ role: "driver", canApprove: true, canManageShares: true }, "member")).toMatch(/^Creator \(you created this workspace/);
    expect(yourAccessText({ role: "driver", canApprove: false, canManageShares: false }, "member")).toBe("Driver (can send to agents and type in terminals)");
    expect(yourAccessText({ role: "driver", canApprove: true, canManageShares: false }, "member")).toBe("Driver (can send to agents and type in terminals), can approve permissions");
    expect(yourAccessText({ role: "viewer", canApprove: false, canManageShares: false }, "member")).toBe("Viewer (can read everything, not send)");
    expect(yourAccessText({ role: "none", canApprove: false, canManageShares: false }, "member")).toBe("No access to this workspace's content");
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

  it("shares a workspace in another organization with that organization's own members", async () => {
    render(<CloudShareDialog orgId="org-2" workspaceId="ws-1" name="Payments" onClose={() => undefined} />);
    const row = await screen.findByTestId("cloud-share-row");
    expect(mocks.shares).toHaveBeenCalledWith("ws-1", "org-2");
    // Its own roster, read by its id; never the default organization's people.
    expect(mocks.membersIn).toHaveBeenCalledWith("org-2");
    expect(mocks.members).not.toHaveBeenCalled();
    const picker = (await screen.findByLabelText("Add person")) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).queryByText(/Dana/)).toBeTruthy());
    expect(within(picker).queryByText(/Bob/)).toBeNull();
    fireEvent.change(picker, { target: { value: "u-dana" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("ws-1", "u-dana", "viewer", false, "org-2"));
    fireEvent.click(within(row).getByRole("button", { name: "Revoke Alice" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("ws-1", "u-alice", "org-2"));
  });

  it("says why nobody can be added when another organization's members cannot be read, and still manages the shares", async () => {
    mocks.membersIn.mockRejectedValueOnce({ code: "cloud_organization_unavailable", status: null });
    render(<CloudShareDialog orgId="org-2" workspaceId="ws-1" name="Payments" onClose={() => undefined} />);
    const row = await screen.findByTestId("cloud-share-row");
    const note = await screen.findByTestId("cloud-share-roster-error");
    expect(note.textContent).toContain("This organization's members can only be read while it is your default organization (Settings).");
    expect(screen.queryByLabelText("Add person")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Revoke Alice" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("ws-1", "u-alice", "org-2"));
    // Retry reads them again.
    fireEvent.click(within(screen.getByTestId("cloud-share-roster-error")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("cloud-share-roster-error")).toBeNull());
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Dana/)).toBeTruthy());
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
    listed = { shares: [share()], you: { role: "manager", canApprove: true, canManageShares: true } };
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" accessMode="organization" createdBy="u-me" canManage onClose={() => undefined} />);
    await screen.findByTestId("cloud-share-row");
    fireEvent.click(screen.getByRole("button", { name: /Make private again/ }));
    fireEvent.click(within(await screen.findByTestId("cloud-private-confirm")).getByRole("button", { name: "Revoke all and make private" }));
    expect((await screen.findByTestId("cloud-share-error")).textContent).toMatch(/^Only an organization owner or admin can change whether a workspace is private/);
    expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Make private again/ })).toBeTruthy();
  });
});

// Review D3: the two calls of "make visible and share" can part ways.
describe("when making it visible and sharing do not both succeed", () => {
  const open = async () => {
    listed = { shares: [], you: { role: "manager", canApprove: true, canManageShares: true } };
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" accessMode="private" createdBy="u-me" canManage onClose={() => undefined} />);
    const picker = (await screen.findByLabelText("Add person")) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).queryByText(/Bob/)).toBeTruthy());
    fireEvent.change(picker, { target: { value: "u-bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(within(await screen.findByTestId("cloud-share-confirm")).getByRole("button", { name: "Make visible and share" }));
  };

  it("says plainly that the workspace is visible but not shared yet, with Retry and Make private again", async () => {
    mocks.put.mockRejectedValueOnce({ code: "cloud_workspace_share_limit", status: 429 });
    await open();
    const note = await screen.findByTestId("cloud-share-unshared");
    expect(note.textContent).toContain("Payments is now visible to the organization, but it is not shared with Bob yet.");
    expect(note.textContent).toContain("maximum number of people (64)");
    expect(mocks.access).toHaveBeenCalledWith("ws-1", "organization", "org-1");
    // It is no longer described as private, and nobody else is offered until this is settled.
    expect(screen.queryByTestId("cloud-share-private")).toBeNull();
    expect(screen.queryByLabelText("Add person")).toBeNull();

    // Retry grants the same share, without switching visibility again.
    mocks.access.mockClear();
    fireEvent.click(within(note).getByRole("button", { name: "Retry sharing" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(2));
    expect(mocks.put).toHaveBeenLastCalledWith("ws-1", "u-bob", "viewer", false, "org-1");
    await waitFor(() => expect(screen.queryByTestId("cloud-share-unshared")).toBeNull());
    expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(1);
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it("can take the visibility back when the share cannot be made", async () => {
    mocks.put.mockRejectedValueOnce({ code: "organization_member_not_found", status: 404 });
    await open();
    const note = await screen.findByTestId("cloud-share-unshared");
    expect(note.textContent).toContain("Bob is no longer a member of this organization.");
    fireEvent.click(within(note).getByRole("button", { name: "Make private again" }));
    fireEvent.click(within(await screen.findByTestId("cloud-private-confirm")).getByRole("button", { name: "Make private" }));
    await waitFor(() => expect(mocks.access).toHaveBeenLastCalledWith("ws-1", "private", "org-1"));
    await waitFor(() => expect(screen.queryByTestId("cloud-share-unshared")).toBeNull());
    expect(await screen.findByTestId("cloud-share-private")).toBeTruthy();
  });

  it("reads the workspace back when the visibility change got no answer, and shares only if it is visible", async () => {
    // No answer, but it did go through.
    mocks.access.mockRejectedValueOnce({ code: "cloud_workspace_request_outcome_unknown", status: null });
    mocks.workspaces.mockResolvedValueOnce({ workspaces: [{ workspace: { id: "ws-1", accessMode: "organization" } }] });
    await open();
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("ws-1", "u-bob", "viewer", false, "org-1"));
    expect(mocks.workspaces).toHaveBeenCalledWith("org-1");
    await waitFor(() => expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(1));
    expect(screen.queryByTestId("cloud-share-error")).toBeNull();
  });

  it("does not share, and says it is still private, when the lost change did not go through", async () => {
    mocks.access.mockRejectedValueOnce({ code: "cloud_workspace_request_outcome_unknown", status: null });
    await open();
    expect((await screen.findByTestId("cloud-share-error")).textContent).toBe("The server did not answer, and the workspace is still private. Try again.");
    expect(mocks.put).not.toHaveBeenCalled();
    expect(screen.getByTestId("cloud-share-private")).toBeTruthy();
  });

  it("claims neither state when the workspace cannot be read back, until Check again can", async () => {
    mocks.access.mockRejectedValueOnce({ code: "cloud_workspace_request_outcome_unknown", status: null });
    mocks.workspaces.mockRejectedValueOnce({ code: "cloud_workspace_unavailable", status: null });
    await open();
    const unknown = await screen.findByTestId("cloud-share-access-unknown");
    expect(unknown.textContent).toContain("It is not known whether this workspace is private or visible to the organization right now.");
    expect(mocks.put).not.toHaveBeenCalled();
    // Neither "private" nor "visible" is shown, and nothing can be shared or made private on a guess.
    expect(screen.queryByTestId("cloud-share-private")).toBeNull();
    expect(screen.queryByLabelText("Add person")).toBeNull();
    expect(screen.queryByRole("button", { name: /Make private again/ })).toBeNull();
    mocks.workspaces.mockResolvedValueOnce({ workspaces: [{ workspace: { id: "ws-1", accessMode: "organization" } }] });
    fireEvent.click(within(unknown).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByTestId("cloud-share-access-unknown")).toBeNull());
    expect(await screen.findByRole("button", { name: /Make private again/ })).toBeTruthy();
    expect(screen.getByLabelText("Add person")).toBeTruthy();
  });
});

// Review D4: the creator of a workspace who is a plain member manages its shares, not its visibility.
describe("a creator who is not an owner or admin", () => {
  const creator = { role: "driver", canApprove: true, canManageShares: true } as const;
  const reason = "Only this workspace's creator or an organization owner or admin can change whether it is private or visible to the organization";

  it("cannot share a private workspace, and is told who can make it visible", async () => {
    listed = { shares: [], you: creator };
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" accessMode="private" createdBy="u-me" canManage onClose={() => undefined} />);
    const note = await screen.findByTestId("cloud-share-private");
    expect(note.textContent).toContain(`${reason}: ask one to make it visible, then share it from here.`);
    const picker = (await screen.findByLabelText("Add person")) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).queryByText(/Bob/)).toBeTruthy());
    fireEvent.change(picker, { target: { value: "u-bob" } });
    const button = screen.getByRole("button", { name: "Share" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(reason);
    fireEvent.click(button);
    expect(screen.queryByTestId("cloud-share-confirm")).toBeNull();
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("still manages the shares of a workspace that is already visible, with Make private again off and explained", async () => {
    listed = { shares: [share()], you: creator };
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" accessMode="organization" createdBy="u-me" canManage onClose={() => undefined} />);
    const row = await screen.findByTestId("cloud-share-row");
    const button = screen.getByRole("button", { name: /Make private again/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(reason);
    expect(screen.getByTestId("cloud-share-visibility").textContent).toBe(`Visible in the organization's sidebar. ${reason}.`);
    // Adding, changing and revoking shares all still work.
    const picker = screen.getByLabelText("Add person") as HTMLSelectElement;
    await waitFor(() => expect(within(picker).queryByText(/Bob/)).toBeTruthy());
    fireEvent.change(picker, { target: { value: "u-bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("ws-1", "u-bob", "viewer", false, "org-1"));
    fireEvent.click(within(row).getByRole("button", { name: "Revoke Alice" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("ws-1", "u-alice", "org-1"));
    expect(mocks.access).not.toHaveBeenCalled();
  });
});
