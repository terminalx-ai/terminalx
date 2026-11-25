import { refreshRosterFlags, rosterFlagAccount } from "@/test/rosterFlags";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccessApply, CloudGroupShare, CloudWorkspaceShare, CloudWorkspaceShares } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  shares: vi.fn(),
  put: vi.fn(),
  revoke: vi.fn(),
  members: vi.fn(),
  access: vi.fn(),
  membersIn: vi.fn(),
  workspaces: vi.fn(),
  groups: vi.fn(),
  apply: vi.fn(),
  native: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: mocks.native,
}));
vi.mock("@/lib/api", () => ({
  api: {
    cloudWorkspaceShares: mocks.shares,
    cloudWorkspaceSharePut: mocks.put,
    cloudWorkspaceShareRevoke: mocks.revoke,
    cloudWorkspaceSetAccess: mocks.access,
    cloudWorkspaces: mocks.workspaces,
    cloudWorkspaceGroups: mocks.groups,
    cloudWorkspaceSharesApply: mocks.apply,
  },
}));
vi.mock("@/lib/organizationMembers", () => ({ organizationMembers: { list: mocks.members, listIn: mocks.membersIn } }));
// The account's default organization decides whether the roster applies.
const account = rosterFlagAccount;
vi.mock("@/lib/account", async () => (await import("@/test/rosterFlags")).rosterFlagAccountMock);

import { CloudShareDialog, CloudShareDialogHost, openShareDialog, shareErrorMessage, yourAccessText } from "./CloudShareDialog";
import { personName, resetPeople } from "@/lib/cloudPeople";
import { invalidateOrganizationRoster } from "@/lib/organizationRoster";
import { onAccessChanged } from "@/lib/cloudCollab";
import { refreshDataPrivacy } from "@/lib/dataPrivacy";

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

beforeEach(async () => {
  mocks.native.mockResolvedValue({ enabled: false, managed: false });
  await refreshDataPrivacy();
  refreshRosterFlags();
  mocks.groups.mockReset().mockResolvedValue({ groups: [], nextCursor: null });
  mocks.apply.mockReset();
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
      { userId: "u-erin", email: "erin@example.com", displayName: "Erin", role: "member" },
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

  it("reuses the roster on consecutive opens, then removes departed members after invalidation", async () => {
    dialog();
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Bob/)).toBeTruthy());
    cleanup();
    dialog();
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Bob/)).toBeTruthy());
    expect(mocks.members).toHaveBeenCalledTimes(1);
    cleanup();
    // Bob is removed from the organization while the dialog is closed.
    mocks.members.mockResolvedValue({ members: [{ userId: "u-me", email: "me@example.com", displayName: "Me", role: "owner" }, { userId: "u-erin", email: "erin@example.com", displayName: "Erin", role: "member" }], pendingInvites: [], viewerRole: "owner", canManageMembers: true, contextRevision: "r2" });
    invalidateOrganizationRoster("org-1");
    dialog();
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Erin/)).toBeTruthy());
    expect(within(screen.getByLabelText("Add person")).queryByText(/Bob/)).toBeNull();
    expect(mocks.members).toHaveBeenCalledTimes(2);
  });

  it("reads the members and shares again when a share is refused because the person left the organization (#501)", async () => {
    listed = { ...listed, shares: [share(), share({ userId: "u-bob", email: "bob@example.com", name: "Bob" })] };
    dialog();
    await waitFor(() => expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(2));
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Erin/)).toBeTruthy());
    // Bob is removed from the organization while the dialog is open: the server revoked his share with it.
    mocks.members.mockResolvedValue({ members: [{ userId: "u-me", email: "me@example.com", displayName: "Me", role: "owner" }, { userId: "u-alice", email: "alice@example.com", displayName: "Alice", role: "member" }], pendingInvites: [], viewerRole: "owner", canManageMembers: true, contextRevision: "r2" });
    listed = { ...listed, shares: [share()] };
    mocks.put.mockRejectedValueOnce({ code: "organization_member_not_found", status: 404 });
    fireEvent.change(screen.getByLabelText("Role for Bob"), { target: { value: "driver" } });
    expect((await screen.findByTestId("cloud-share-error")).textContent).toBe("Bob is no longer a member of this organization.");
    await waitFor(() => expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Erin/)).toBeNull());
    expect(screen.queryByLabelText("Role for Bob")).toBeNull();
  });

  it("shows the newest read of the members, not an older one that answers late (#501)", async () => {
    let late!: (value: unknown) => void;
    // The read on opening is slow and still names Bob; the one after the refusal answers first without him.
    mocks.members.mockReset().mockImplementationOnce(() => new Promise((resolve) => (late = resolve))).mockResolvedValue({ members: [{ userId: "u-me", email: "me@example.com", displayName: "Me", role: "owner" }, { userId: "u-erin", email: "erin@example.com", displayName: "Erin", role: "member" }], pendingInvites: [], viewerRole: "owner", canManageMembers: true, contextRevision: "r2" });
    listed = { ...listed, shares: [share({ userId: "u-bob", email: "bob@example.com", name: "Bob" })] };
    dialog();
    await screen.findByTestId("cloud-share-row");
    listed = { ...listed, shares: [] };
    mocks.put.mockRejectedValueOnce({ code: "organization_member_not_found", status: 404 });
    fireEvent.change(screen.getByLabelText("Role for Bob"), { target: { value: "driver" } });
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Erin/)).toBeTruthy());
    await act(async () => late({ members: [{ userId: "u-bob", email: "bob@example.com", displayName: "Bob", role: "member" }], pendingInvites: [], viewerRole: "owner", canManageMembers: true, contextRevision: "r1" }));
    expect(within(screen.getByLabelText("Add person")).queryByText(/Bob/)).toBeNull();
    expect(within(screen.getByLabelText("Add person")).queryByText(/Erin/)).toBeTruthy();
  });

  it("stops offering someone a share was refused for because they left the organization (#501)", async () => {
    dialog();
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Bob/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Add person"), { target: { value: "u-bob" } });
    mocks.members.mockResolvedValue({ members: [{ userId: "u-me", email: "me@example.com", displayName: "Me", role: "owner" }, { userId: "u-erin", email: "erin@example.com", displayName: "Erin", role: "member" }], pendingInvites: [], viewerRole: "owner", canManageMembers: true, contextRevision: "r2" });
    mocks.put.mockRejectedValueOnce({ code: "organization_member_not_found", status: 404 });
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect((await screen.findByTestId("cloud-share-error")).textContent).toBe("Bob is no longer a member of this organization.");
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Bob/)).toBeNull());
    expect((screen.getByLabelText("Add person") as HTMLSelectElement).value).toBe("");
  });

  it("does not offer the workspace's creator, and says why a driver share is refused for a managers-only login", async () => {
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" createdBy="u-bob" onClose={() => undefined} />);
    await screen.findByTestId("cloud-share-row");
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Erin/)).toBeTruthy());
    expect(within(screen.getByLabelText("Add person")).queryByText(/Bob/)).toBeNull();
    expect(shareErrorMessage({ code: "cloud_workspace_share_credential_restricted" })).toMatch(/agent login that only owners and admins may use/);
    // A creator's personal route credential (PRO-18) handed to the running workspace keeps it theirs alone until it restarts.
    expect(shareErrorMessage({ code: "cloud_workspace_share_personal_route" })).toMatch(/handed its creator's own model credential.*can't be opened to the organization or shared with Can send yet.*stops and resumes the workspace/);
  });

  it("tells the organization's owner they are the Owner, and an admin that they are an Admin", async () => {
    // The API's role for both is `manager`; the roster (or the account) says which.
    dialog();
    await waitFor(() => expect(screen.getByTestId("cloud-share-you").textContent).toBe("Your access: Owner (the organization's owner: manages this workspace and who it is shared with)."));
    expect(screen.getByTestId("cloud-share-you").textContent).not.toContain("Admin");
    cleanup();

    // The account's own organization list wins over the roster, and is there before the roster loads.
    const before = account.status;
    account.status = { ...account.status, identity: { organizationId: "org-1", email: "me@example.com", name: "Me", organization: "Acme" }, organizations: [{ id: "org-1", name: "Acme", role: "admin" }] };
    dialog();
    expect((await screen.findByTestId("cloud-share-you")).textContent).toBe("Your access: Admin (an organization admin: manages this workspace and who it is shared with).");
    account.status = before;
  });

  it("names every role it can tell apart, and guesses none it cannot", () => {
    const manager = { role: "manager", canApprove: true, canManageShares: true } as const;
    expect(yourAccessText(manager, "owner")).toMatch(/^Owner \(/);
    expect(yourAccessText(manager, "admin")).toMatch(/^Admin \(/);
    expect(yourAccessText(manager, null)).toMatch(/^Admin \(/);
    expect(yourAccessText(manager, "member")).toMatch(/^Workspace Admin \(/);
    expect(yourAccessText(manager, "owner", true)).toMatch(/^Creator \(/);
    expect(yourAccessText({ ...manager, canApprove: false }, null)).not.toContain("can approve");
    // A plain member who created the workspace drives it and manages its shares.
    expect(yourAccessText({ role: "driver", canApprove: true, canManageShares: true }, "member", true)).toMatch(/^Creator \(you created this workspace/);
    expect(yourAccessText({ role: "driver", canApprove: true, canManageShares: true }, "member")).toMatch(/^Driver \(/);
    expect(yourAccessText({ role: "driver", canApprove: false, canManageShares: true }, "member", true)).not.toContain("approve permissions and manage");
    expect(shareErrorMessage({ code: "cloud_workspace_last_admin" })).toBe("A workspace must have at least one admin.");
    expect(shareErrorMessage({ code: "cloud_workspace_runtime_unsupported" })).toContain("not supported");
    expect(yourAccessText({ role: "driver", canApprove: false, canManageShares: false }, "member")).toBe("Driver (can send to agents; typing in terminals also needs the right to approve permissions)");
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

  it("shows an existing Admin without offering an Admin grant or disabling approval silently", async () => {
    listed = { ...listed, shares: [share({ role: "manager", canApprove: true })] };
    dialog();
    const row = await screen.findByTestId("cloud-share-row");
    const role = within(row).getByLabelText("Role for Alice") as HTMLSelectElement;
    expect(role.value).toBe("manager");
    expect(within(role).getByRole("option", { name: "Admin" }).hasAttribute("disabled")).toBe(true);
    expect(within(screen.getByLabelText("New person's role")).queryByRole("option", { name: "Admin" })).toBeNull();
    const approval = within(row).getByRole("switch", { name: "Can approve permissions: Alice" }) as HTMLButtonElement;
    expect(approval.disabled).toBe(true);
    expect(approval.getAttribute("aria-description")).toContain("not supported");
    fireEvent.click(approval);
    expect(mocks.put).not.toHaveBeenCalled();
    fireEvent.change(role, { target: { value: "driver" } });
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("ws-1", "u-alice", "driver", true, "org-1"));
  });

  it("shows a read-only Admin and preserves the independent approval flag", async () => {
    listed = { shares: [share({ role: "manager", canApprove: false })], you: { role: "viewer", canApprove: false, canManageShares: false } };
    dialog();
    const row = await screen.findByTestId("cloud-share-row");
    expect(row.textContent).toContain("Admin");
    expect(row.textContent).not.toContain("Viewer");
    expect(row.textContent).not.toContain("can approve");
  });

  it("updates manager provenance when a delayed roster identifies the creator", async () => {
    refreshRosterFlags([]);
    account.status = { ...account.status, organizations: [] };
    let resolveRoster!: (value: unknown) => void;
    mocks.members.mockImplementationOnce(() => new Promise((resolve) => { resolveRoster = resolve; }));
    render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" createdBy="u-me" onClose={() => undefined} />);
    expect((await screen.findByTestId("cloud-share-you")).textContent).toMatch(/^Your access: Admin \(/);
    await act(async () => resolveRoster({ members: [{ userId: "u-me", email: "me@example.com", displayName: "Me", role: "member" }], pendingInvites: [], viewerRole: "member", canManageMembers: false, contextRevision: "r1" }));
    await waitFor(() => expect(screen.getByTestId("cloud-share-you").textContent).toMatch(/^Your access: Creator \(/));
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
    mocks.membersIn.mockRejectedValueOnce({ code: "cloud_organization_unavailable", status: null }).mockRejectedValueOnce({ code: "cloud_organization_unavailable", status: null });
    render(<CloudShareDialog orgId="org-2" workspaceId="ws-1" name="Payments" onClose={() => undefined} />);
    const row = await screen.findByTestId("cloud-share-row");
    const note = await screen.findByTestId("cloud-share-roster-error");
    expect(note.textContent).toContain("This organization's members can only be read while it is your default organization (Settings).");
    expect(screen.queryByLabelText("Add person")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Revoke Alice" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("ws-1", "u-alice", "org-2"));
    // The access event also refreshes the roster; retry still recovers a refusal.
    await waitFor(() => expect(mocks.membersIn).toHaveBeenCalledTimes(2));
    await screen.findByTestId("cloud-share-roster-error");
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
    // The roster says who this person is (by email); Bob created it, so he is not offered.
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Erin/)).toBeTruthy());
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
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Erin/)).toBeTruthy());
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

it("opens the shared profile from a share avatar", async () => {
  dialog();
  fireEvent.click(await screen.findByRole("button", { name: "View profile: Alice" }));
  const profile = await screen.findByRole("dialog", { name: "Profile of Alice" });
  expect(within(profile).getByText("alice@example.com")).toBeTruthy();
  expect(within(profile).getByText("Member")).toBeTruthy();
});

it("falls back to per-open roster reads without profile avatars when the flag is missing", async () => {
  refreshRosterFlags([]);
  dialog();
  await screen.findByTestId("cloud-share-row");
  await waitFor(() => expect(mocks.members).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: /View profile/ })).toBeNull();
  cleanup();
  dialog();
  await waitFor(() => expect(mocks.members).toHaveBeenCalledTimes(2));
});

it("closes a Share profile when capability refresh removes the flag", async () => {
  dialog();
  fireEvent.click(await screen.findByRole("button", { name: "View profile: Alice" }));
  await screen.findByRole("dialog", { name: "Profile of Alice" });
  act(() => refreshRosterFlags([]));
  expect(screen.queryByRole("dialog", { name: "Profile of Alice" })).toBeNull();
  expect(screen.queryByRole("button", { name: /View profile/ })).toBeNull();
  expect(screen.getByTestId("cloud-share-dialog")).toBeTruthy();
});

describe("organization workspace-group readiness", () => {
  const feature = "cloud.workspace-groups.v1";
  const group = { id: "group-1", name: "Release crew", memberCount: 3 };
  const existingGroup = { id: "group-2", name: "Testing crew", memberCount: 1 };
  const revision = "account-1";
  function enabled(organization = "org-1", groupShares: CloudGroupShare[] = []) {
    account.status.phase2Readiness = { [organization]: [feature] };
    listed = { ...listed, groupShares, accessRevision: "opaque:1" };
  }
  function renderEditor(props: Partial<Parameters<typeof CloudShareDialog>[0]> = {}) {
    const onClose = vi.fn();
    return { ...render(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" onClose={onClose} {...props} />), onClose };
  }

  function receipt(result: { shares?: CloudWorkspaceShare[]; groupShares?: CloudGroupShare[]; accessRevision: string }, results: unknown[]) {
    listed = { ...listed, ...result };
    return { accessRevision: listed.accessRevision, groupShares: listed.groupShares, shares: listed.shares, results };
  }
  const save = () => screen.getByRole("button", { name: "Save" });
  const search = () => screen.getByRole("searchbox", { name: /Add people or groups from/ });
  const role = (name: string) => screen.getByRole("combobox", { name: `Role for ${name}` });

  it("keeps the exact legacy dialog and calls when only another organization is enabled", async () => {
    enabled("org-2", [{ groupId: group.id, group, role: "driver", canApprove: true }]);
    renderEditor();
    await screen.findByRole("combobox", { name: "Add person" });
    expect(mocks.shares).toHaveBeenCalledWith("ws-1", "org-1");
    expect(screen.queryByText("Release crew")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.change(role("Alice"), { target: { value: "driver" } });
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("ws-1", "u-alice", "driver", false, "org-1"));
    expect(mocks.groups).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it.each([true, false])("opens the legacy dialog under privacy when held (editor scope: %s)", async (scoped) => {
    enabled("org-2");
    if (!scoped) account.status.context = null;
    mocks.native.mockResolvedValue({ enabled: true, managed: false });
    await refreshDataPrivacy();
    renderEditor();
    await screen.findByRole("combobox", { name: "Add person" });
    expect(mocks.shares.mock.calls).toEqual([["ws-1", "org-1"]]);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(mocks.groups).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("uses the inactive member organization's exact search and cursor, including already-shared groups", async () => {
    enabled("org-2", [{ groupId: existingGroup.id, group: existingGroup, role: "driver", canApprove: true }]);
    mocks.groups
      .mockResolvedValueOnce({ groups: [existingGroup], nextCursor: "page:2" })
      .mockResolvedValueOnce({ groups: [group], nextCursor: null });
    renderEditor({ orgId: "org-2" });
    expect(await screen.findByText("Group · 1 member")).toBeTruthy();
    expect(mocks.shares).toHaveBeenCalledWith("ws-1", "org-2", revision);
    fireEvent.change(search(), { target: { value: "CreW & %" } });
    expect((await screen.findByRole("button", { name: /Testing crew.*Already added/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "More groups" }));
    fireEvent.click(await screen.findByRole("button", { name: /Release crew/ }));
    expect(mocks.groups.mock.calls).toEqual([
      ["org-2", "CreW & %", null, revision],
      ["org-2", "CreW & %", "page:2", revision],
    ]);
    expect(screen.getByText("Group · 3 members")).toBeTruthy();
    expect(screen.getByText("1 unsaved change · nothing changes until you press Save")).toBeTruthy();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("ignores an earlier search response after the query changes", async () => {
    enabled();
    let respond!: (value: unknown) => void;
    mocks.groups.mockImplementation((_org: string, query: string) => query === "Release"
      ? new Promise((resolve) => { respond = resolve; })
      : Promise.resolve({ groups: [], nextCursor: null }));
    renderEditor();
    await screen.findByTestId("cloud-share-you");
    fireEvent.change(search(), { target: { value: "Release" } });
    await waitFor(() => expect(respond).toBeTypeOf("function"));
    fireEvent.change(search(), { target: { value: "Something else" } });
    await screen.findByText("No one matches the search. You can add members and groups of org-1.");
    await act(async () => respond({ groups: [group], nextCursor: "more" }));
    expect(screen.queryByText("Release crew")).toBeNull();
    expect(screen.queryByText("More groups")).toBeNull();
  });

  it("names discarded changes on Escape and button close, and keeps the draft on Keep editing", async () => {
    enabled();
    const { onClose } = renderEditor();
    await screen.findByTestId("cloud-share-you");
    fireEvent.change(role("Alice"), { target: { value: "driver" } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    let confirmation = await screen.findByRole("dialog", { name: "Discard access changes?" });
    expect(within(confirmation).getByText("Alice · Change to Driver, approval off")).toBeTruthy();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
    expect((role("Alice") as HTMLSelectElement).value).toBe("driver");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    confirmation = await screen.findByRole("dialog", { name: "Discard access changes?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("commits one batch, identifies the failed row, then retries only that row with a fresh request", async () => {
    enabled();
    mocks.groups.mockResolvedValue({ groups: [group], nextCursor: null });
    mocks.apply.mockImplementationOnce(async (_workspace: string, _org: string, request: CloudAccessApply) =>
      receipt({ shares: [share({ role: "driver" })], accessRevision: "opaque:2" }, request.changes.map((change) =>
        change.subject.type === "group" ? { id: change.id, status: "failed", code: "organization_group_not_found", message: "The group could not be found." }
          : { id: change.id, status: "applied" })))
      .mockImplementationOnce(async (_workspace: string, _org: string, request: CloudAccessApply) =>
        receipt({ groupShares: [{ groupId: group.id, group, role: "viewer", canApprove: false }], accessRevision: "opaque:3" },
          request.changes.map(({ id }) => ({ id, status: "applied" }))));
    renderEditor();
    await screen.findByTestId("cloud-share-you");
    fireEvent.change(role("Alice"), { target: { value: "driver" } });
    fireEvent.change(search(), { target: { value: "Release" } });
    fireEvent.click(await screen.findByRole("button", { name: /Release crew/ }));
    expect(screen.getByText(/2 unsaved changes/)).toBeTruthy();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    fireEvent.click(save());
    expect((await screen.findByText(/The group could not be found/)).textContent).toContain("Release crew");
    await waitFor(() => expect((save() as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("1 of 2 changes saved.")).toBeTruthy();
    fireEvent.click(save());
    await screen.findByText("Access changes saved.");
    const [[workspace, org, first, context], [, , second]] = mocks.apply.mock.calls;
    expect([workspace, org, context]).toEqual(["ws-1", "org-1", revision]);
    expect(first).toMatchObject({ accessRevision: "opaque:1", changes: [
      { op: "put", subject: { type: "user", id: "u-alice" }, role: "driver", canApprove: false },
      { op: "put", subject: { type: "group", id: group.id }, role: "viewer", canApprove: false },
    ] });
    expect(new Set(first.changes.map((change: { id: string }) => change.id)).size).toBe(2);
    expect(second).toMatchObject({ accessRevision: "opaque:2", changes: [{ ...first.changes[1], id: expect.any(String) }] });
    expect(second.requestId).not.toBe(first.requestId);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("freezes the original payload on an ambiguous reply and uses the server standing after replay", async () => {
    enabled();
    mocks.apply.mockRejectedValueOnce({ code: "cloud_workspace_request_outcome_unknown", retryWithSameIdempotencyKey: true })
      .mockImplementationOnce(async (_workspace: string, _org: string, request: CloudAccessApply) => {
        listed = { ...listed, you: { role: "viewer", canApprove: false, canManageShares: false } };
        return receipt({ shares: [], accessRevision: "opaque:2" }, request.changes.map(({ id }) => ({ id, status: "applied" })));
      });
    renderEditor();
    await screen.findByTestId("cloud-share-you");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Alice" }));
    fireEvent.click(save());
    const retry = await screen.findByRole("button", { name: "Retry save" });
    expect((screen.getByRole("button", { name: "Undo removal of Alice" }) as HTMLButtonElement).disabled).toBe(true);
    expect((search() as HTMLInputElement).disabled).toBe(true);
    expect(mocks.shares).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await screen.findByRole("heading", { name: "Who has access" });
    expect(mocks.apply.mock.calls[0]).toEqual(mocks.apply.mock.calls[1]);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("retains a staged draft through readiness loss and requires explicit discard to close", async () => {
    enabled();
    const { onClose, rerender } = renderEditor();
    const refresh = (ready: boolean) => {
      account.status.phase2Readiness = ready ? { "org-1": [feature] } : {};
      rerender(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" onClose={onClose} />);
    };
    await screen.findByTestId("cloud-share-you");
    fireEvent.change(role("Alice"), { target: { value: "driver" } });
    refresh(false);
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Add person" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const confirm = await screen.findByRole("dialog", { name: "Discard access changes?" });
    expect(within(confirm).getByText(/Alice · Change to Driver/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(onClose).not.toHaveBeenCalled();
    refresh(true);
    expect((role("Alice") as HTMLSelectElement).value).toBe("driver");
    refresh(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard access changes?" })).getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.shares.mock.calls).toEqual([["ws-1", "org-1", revision]]);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("retries an unresolved request unchanged after a live hold and a server readiness refusal", async () => {
    enabled();
    let loseReply!: (error: unknown) => void;
    mocks.apply.mockImplementationOnce(() => new Promise((_resolve, reject) => { loseReply = reject; }))
      .mockRejectedValueOnce({ code: "cloud_workspace_groups_unavailable", status: 404 })
      .mockImplementationOnce(async (_workspace: string, _org: string, request: CloudAccessApply) =>
        receipt({ shares: [], accessRevision: "opaque:2" }, request.changes.map(({ id }) => ({ id, status: "applied" }))));
    const { onClose, rerender } = renderEditor();
    const refresh = (ready: boolean) => {
      account.status.phase2Readiness = ready ? { "org-1": [feature] } : {};
      rerender(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" onClose={onClose} />);
    };
    await screen.findByTestId("cloud-share-you");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Alice" }));
    fireEvent.click(save());
    refresh(false);
    expect(screen.getByText("Waiting for the current request to finish.")).toBeTruthy();
    await act(async () => loseReply({ code: "cloud_workspace_request_outcome_unknown", retryWithSameIdempotencyKey: true }));
    expect(screen.getByText("Save outcome unknown")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    refresh(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await screen.findByText("Workspace group sharing is unavailable. Retry the same changes when it returns.");
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await screen.findByText("Access changes saved.");
    expect(mocks.apply.mock.calls).toEqual(Array(3).fill(mocks.apply.mock.calls[0]));
  });

  it.each(["applied", "refused"])("reports a %s in-flight save while readiness is held", async (outcome) => {
    enabled();
    let reply!: () => void;
    mocks.apply.mockImplementationOnce((_workspace: string, _org: string, request: CloudAccessApply) => new Promise((resolve, reject) => {
      reply = outcome === "applied"
        ? () => resolve(receipt({ shares: [], accessRevision: "opaque:2" }, request.changes.map(({ id }) => ({ id, status: "applied" }))))
        : () => reject({ code: "cloud_workspace_access_revision_conflict", status: 409 });
    }));
    const { onClose, rerender } = renderEditor();
    await screen.findByTestId("cloud-share-you");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Alice" }));
    fireEvent.click(save());
    account.status.phase2Readiness = {};
    rerender(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" onClose={onClose} />);
    await act(async () => reply());
    expect(screen.getByText(outcome === "applied" ? "Access changes saved." : /Workspace access changed while you were editing/)).toBeTruthy();
    expect(screen.queryByText("Save outcome unknown")).toBeNull();
    expect(mocks.shares).toHaveBeenCalledTimes(1);
  });

  it("hides names in the editor and its open discard confirmation under privacy, and resumes the exact retry", async () => {
    enabled("org-1", [{ groupId: group.id, group, role: "driver", canApprove: true }]);
    mocks.apply.mockRejectedValueOnce({ code: "cloud_workspace_request_outcome_unknown" })
      .mockRejectedValueOnce({ code: "cloud_workspace_access_revision_conflict" });
    renderEditor();
    await screen.findByTestId("cloud-share-you");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Alice" }));
    fireEvent.click(save());
    await screen.findByRole("button", { name: "Retry save" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText("Alice · Remove access")).toBeTruthy();
    mocks.native.mockResolvedValue({ enabled: true, managed: false });
    await act(() => refreshDataPrivacy());
    expect(document.body.textContent).not.toMatch(/Alice|alice@example.com|Release crew|Payments/);
    const confirm = screen.getByRole("dialog", { name: "Discard access changes?" });
    expect(within(confirm).getByText("The save may have reached the server. Closing ends this retry.")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "Workspace access" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
    expect(mocks.groups).not.toHaveBeenCalled();
    expect(mocks.shares).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    mocks.native.mockResolvedValue({ enabled: false, managed: false });
    await act(() => refreshDataPrivacy());
    fireEvent.click(await screen.findByRole("button", { name: "Retry save" }));
    await screen.findByRole("button", { name: "Refresh access" });
    expect(mocks.apply.mock.calls[1]).toEqual(mocks.apply.mock.calls[0]);
  });

  it("blocks a queued search under privacy and restores the legacy dialog on a clean hold", async () => {
    enabled();
    const { onClose, rerender } = renderEditor();
    await screen.findByTestId("cloud-share-you");
    fireEvent.change(search(), { target: { value: "Release crew" } });
    mocks.native.mockResolvedValue({ enabled: true, managed: false });
    await act(() => refreshDataPrivacy());
    expect(screen.getByText("Sharing is paused while data privacy mode is on.")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Add person" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Release crew|Payments/);
    expect(mocks.shares.mock.calls).toEqual([["ws-1", "org-1", revision]]);
    account.status.phase2Readiness = {};
    rerender(<CloudShareDialog orgId="org-1" workspaceId="ws-1" name="Payments" onClose={onClose} />);
    await screen.findByRole("combobox", { name: "Add person" });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(mocks.shares.mock.calls).toEqual([["ws-1", "org-1", revision], ["ws-1", "org-1"]]);
    expect(mocks.groups).not.toHaveBeenCalled();
  });

  it("requires an explicit choice between complete grants after a stale revision", async () => {
    enabled();
    mocks.apply.mockRejectedValueOnce({ code: "cloud_workspace_access_revision_conflict" })
      .mockImplementationOnce(async (_workspace: string, _org: string, request: CloudAccessApply) =>
        receipt({ shares: [share({ role: "driver" })], accessRevision: "opaque:3" }, request.changes.map(({ id }) => ({ id, status: "applied" }))));
    renderEditor();
    await screen.findByTestId("cloud-share-you");
    fireEvent.change(role("Alice"), { target: { value: "driver" } });
    fireEvent.click(save());
    const refresh = await screen.findByRole("button", { name: "Refresh access" });
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    listed = { ...listed, accessRevision: "opaque:2", shares: [share({ canApprove: true }), share({ userId: "u-bob", name: "Bob" })] };
    fireEvent.click(refresh);
    await screen.findByRole("combobox", { name: "Role for Bob" });
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByRole("button", { name: "Keep current: Viewer, can approve" })).toBeTruthy();
    fireEvent.click(save());
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Use my change: Driver, approval off" }));
    fireEvent.click(save());
    await screen.findByText("Access changes saved.");
    expect(mocks.apply.mock.calls[1][2]).toMatchObject({ accessRevision: "opaque:2", changes: [{ subject: { type: "user", id: "u-alice" }, role: "driver", canApprove: false }] });
    expect(mocks.apply.mock.calls[1][2].requestId).not.toBe(mocks.apply.mock.calls[0][2].requestId);
  });

  it("drops an edit to a revoked share while preserving unrelated drafts", async () => {
    enabled();
    const bob = share({ userId: "u-bob", name: "Bob" });
    listed = { ...listed, shares: [share(), bob] };
    mocks.apply.mockRejectedValueOnce({ code: "cloud_workspace_access_revision_conflict" })
      .mockImplementationOnce(async (_workspace: string, _org: string, request: CloudAccessApply) =>
        receipt({ shares: [{ ...bob, role: "driver" }], accessRevision: "opaque:3" },
          request.changes.map(({ id }) => ({ id, status: "applied" }))));
    renderEditor();
    await screen.findByTestId("cloud-share-you");
    fireEvent.change(role("Alice"), { target: { value: "driver" } });
    fireEvent.change(role("Bob"), { target: { value: "driver" } });
    fireEvent.click(save());
    const refresh = await screen.findByRole("button", { name: "Refresh access" });
    listed = { ...listed, accessRevision: "opaque:2", shares: [bob] };
    fireEvent.click(refresh);
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Role for Alice" })).toBeNull());
    fireEvent.click(save());
    await screen.findByText("Access changes saved.");
    expect(mocks.apply.mock.calls[1][2].changes).toEqual([
      expect.objectContaining({ op: "put", subject: { type: "user", id: "u-bob" }, role: "driver" }),
    ]);
  });

  it("withholds Admin grants for both people and groups while displaying existing Admin access", async () => {
    enabled("org-1", [{ groupId: group.id, group, role: "viewer", canApprove: false }]);
    listed = { ...listed, shares: [share({ role: "manager", canApprove: true }), share({ userId: "u-bob", name: "Bob" })] };
    renderEditor();
    await screen.findByTestId("cloud-share-you");
    expect((role("Alice") as HTMLSelectElement).value).toBe("manager");
    expect((within(role("Alice")).getByRole("option", { name: "Admin" }) as HTMLOptionElement).disabled).toBe(true);
    expect(within(role("Bob")).queryByRole("option", { name: "Admin" })).toBeNull();
    expect(within(role(group.name)).queryByRole("option", { name: "Admin" })).toBeNull();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it.each(["account", "revision", "active organization", "target organization", "workspace"])("retires an ambiguous payload when the %s changes", async (change) => {
    enabled();
    account.status.phase2Readiness = { "org-1": [feature], "org-2": [feature] };
    mocks.apply.mockRejectedValueOnce({ code: "cloud_workspace_request_outcome_unknown" });
    const onClose = vi.fn();
    const props = { orgId: "org-1", workspaceId: "ws-1", name: "Payments", onClose };
    const { rerender } = render(<CloudShareDialog {...props} />);
    await screen.findByTestId("cloud-share-you");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Alice" }));
    fireEvent.click(save());
    await screen.findByRole("button", { name: "Retry save" });
    if (change === "account") account.status.context = { ...account.status.context!, account: "replacement" };
    if (change === "revision") account.status.context = { ...account.status.context!, revision: "replacement-1" };
    if (change === "active organization") account.status.identity = { ...account.status.identity!, organizationId: "org-2" };
    const next = {
      ...props,
      orgId: change === "target organization" ? "org-2" : props.orgId,
      workspaceId: change === "workspace" ? "ws-2" : props.workspaceId,
    };
    rerender(<CloudShareDialog {...next} />);
    await waitFor(() => expect((save() as HTMLButtonElement).disabled).toBe(true));
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
    expect(mocks.shares).toHaveBeenLastCalledWith(next.workspaceId, next.orgId, account.status.context?.revision);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it("hides and retires a pending reply when the target membership is lost", async () => {
    enabled("org-2");
    let reply!: () => void;
    mocks.apply.mockImplementationOnce((_workspace: string, _org: string, request: CloudAccessApply) => new Promise((resolve) => {
      reply = () => resolve({
        shares: [], groupShares: [], accessRevision: "opaque:2", results: request.changes.map(({ id }) => ({ id, status: "applied" })),
      });
    }));
    const { onClose, rerender } = renderEditor({ orgId: "org-2" });
    await screen.findByTestId("cloud-share-you");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Alice" }));
    fireEvent.click(save());
    account.status.organizations = account.status.organizations?.filter(({ id }) => id !== "org-2");
    account.status.phase2Readiness = {};
    mocks.shares.mockRejectedValueOnce({ code: "cloud_organization_unavailable" });
    rerender(<CloudShareDialog orgId="org-2" workspaceId="ws-1" name="Payments" onClose={onClose} />);
    await act(async () => reply());
    expect(screen.queryByText("Access changes saved.")).toBeNull();
    expect(screen.queryByText("Save outcome unknown")).toBeNull();
    expect(screen.queryByTestId("cloud-share-you")).toBeNull();
    expect(mocks.shares.mock.calls).toEqual([["ws-1", "org-2", revision], ["ws-1", "org-2"]]);
  });

  it("confirms visibility before making a private workspace shareable and saves using the refreshed revision", async () => {
    enabled();
    listed = { ...listed, shares: [] };
    mocks.groups.mockResolvedValue({ groups: [group], nextCursor: null });
    mocks.access.mockImplementationOnce(async () => {
      listed = { ...listed, accessRevision: "opaque:visible" };
      return { accessMode: "organization" };
    });
    mocks.apply.mockImplementationOnce(async (_workspace: string, _org: string, request: CloudAccessApply) =>
      receipt({ groupShares: [{ groupId: group.id, group, role: "viewer", canApprove: false }], accessRevision: "opaque:saved" },
        request.changes.map(({ id }) => ({ id, status: "applied" }))));
    renderEditor({ accessMode: "private", createdBy: "u-me" });
    await screen.findByTestId("cloud-share-you");
    fireEvent.change(search(), { target: { value: "Release" } });
    fireEvent.click(await screen.findByRole("button", { name: /Release crew/ }));
    fireEvent.click(save());
    const confirmation = await screen.findByRole("dialog", { name: "Make workspace visible and save?" });
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Make visible and save" }));
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
    expect(mocks.access).toHaveBeenCalledWith("ws-1", "organization", "org-1", revision);
    expect(mocks.apply.mock.calls[0][2].accessRevision).toBe("opaque:visible");
  });
});
