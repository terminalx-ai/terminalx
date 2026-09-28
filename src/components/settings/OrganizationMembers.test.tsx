import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { organizationMembers, type OrganizationRoster } from "@/lib/organizationMembers";
import { OrganizationMembers } from "./OrganizationMembers";

vi.mock("@/lib/organizationMembers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizationMembers")>()),
  organizationMembers: {
    list: vi.fn(),
    invite: vi.fn(),
    revokeInvite: vi.fn(),
    updateRole: vi.fn(),
    remove: vi.fn(),
  },
}));

const api = vi.mocked(organizationMembers);

const roster = (overrides: Partial<OrganizationRoster> = {}): OrganizationRoster => ({
  members: [
    { userId: "owner-1", email: "owner@example.com", displayName: "Olive Owner", role: "owner" },
    { userId: "admin-1", email: "admin@example.com", role: "admin" },
    { userId: "member-1", email: "member@example.com", role: "member" },
  ],
  pendingInvites: [
    { email: "pending@example.com", role: "member", createdAt: 1, expiresAt: Date.now() + 86_400_000, status: "pending" },
    { email: "stale@example.com", role: "admin", createdAt: 1, expiresAt: 2, status: "expired" },
  ],
  viewerRole: "admin",
  canManageMembers: true,
  contextRevision: "rev-1",
  ...overrides,
});

const renderAs = async (email = "admin@example.com", contextRevision = "account-1") => {
  const view = render(<OrganizationMembers accountEmail={email} contextRevision={contextRevision} />);
  await screen.findByRole("list", { name: "Organization members" });
  return view;
};

beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue(roster());
});
afterEach(cleanup);

it("lists members and pending invitations with their status", async () => {
  await renderAs();
  const members = screen.getByRole("list", { name: "Organization members" });
  expect(within(members).getByText("Olive Owner")).toBeTruthy();
  expect(within(members).getByText("(you)")).toBeTruthy();
  const invites = screen.getByRole("list", { name: "Pending invitations" });
  expect(within(invites).getByRole("listitem", { name: "pending@example.com" }).textContent).toContain("Pending");
  expect(within(invites).getByRole("listitem", { name: "stale@example.com" }).textContent).toContain("Expired");
});

it("never offers controls for the owner or the viewer's own row", async () => {
  await renderAs();
  expect(screen.queryByRole("combobox", { name: "Role for owner@example.com" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove owner@example.com" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Role for admin@example.com" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "Role for member@example.com" })).toBeTruthy();
});

it("is read-only for an ordinary member", async () => {
  api.list.mockResolvedValue(roster({ viewerRole: "member", canManageMembers: false }));
  await renderAs("member@example.com");
  expect(screen.getByText("Only owners and admins can invite or manage members.")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Invite email" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: /Role for/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Revoke invite/ })).toBeNull();
});

it("validates the address and refuses an existing member before sending", async () => {
  await renderAs();
  const input = screen.getByRole("textbox", { name: "Invite email" });
  const submit = screen.getByRole("button", { name: "Invite" }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: "not-an-email" } });
  expect(screen.getByText("Enter a valid email address.")).toBeTruthy();
  expect(submit.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "MEMBER@example.com" } });
  expect(screen.getByText("That person is already a member.")).toBeTruthy();
  expect(submit.disabled).toBe(true);
  expect(api.invite).not.toHaveBeenCalled();
});

it("invites with the chosen role and the roster's context revision, then shows the link", async () => {
  api.invite.mockResolvedValue(
    roster({
      contextRevision: "rev-2",
      invite: { email: "new@example.com", role: "admin", inviteUrl: "https://console.test/invite/abc", emailSent: false, deduplicated: false },
    }),
  );
  await renderAs();
  fireEvent.change(screen.getByRole("textbox", { name: "Invite email" }), { target: { value: " new@example.com " } });
  fireEvent.change(screen.getByRole("combobox", { name: "Invite role" }), { target: { value: "admin" } });
  fireEvent.click(screen.getByRole("button", { name: "Invite" }));
  await screen.findByText("https://console.test/invite/abc");
  expect(api.invite).toHaveBeenCalledWith("new@example.com", "admin", "rev-1");
  expect(screen.getByRole("status").textContent).toContain("could not be sent");
  expect((screen.getByRole("textbox", { name: "Invite email" }) as HTMLInputElement).value).toBe("");
});

it("resends and revokes pending invitations", async () => {
  api.invite.mockResolvedValue(
    roster({ invite: { email: "stale@example.com", role: "admin", emailSent: true, deduplicated: false } }),
  );
  api.revokeInvite.mockResolvedValue(roster({ pendingInvites: [] }));
  await renderAs();
  fireEvent.click(screen.getByRole("button", { name: "Resend invite to stale@example.com" }));
  await screen.findByText("Invite emailed to stale@example.com.");
  expect(api.invite).toHaveBeenCalledWith("stale@example.com", "admin", "rev-1");

  fireEvent.click(screen.getByRole("button", { name: "Revoke invite to pending@example.com" }));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Pending invitations" })).toBeNull());
  expect(api.revokeInvite).toHaveBeenCalledWith("pending@example.com", "rev-1");
});

it("explains a rate-limited resend and re-reads the roster", async () => {
  api.invite.mockRejectedValue({ code: "invite_recently_sent", status: 429, retryAfterSeconds: 42 });
  await renderAs();
  fireEvent.click(screen.getByRole("button", { name: "Resend invite to pending@example.com" }));
  await screen.findByText("An invite was just sent to that address. Try again in 42 seconds.");
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  // The refusal stays visible after the re-read and the controls unlock.
  expect(screen.getByText("An invite was just sent to that address. Try again in 42 seconds.")).toBeTruthy();
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Resend invite to pending@example.com" }) as HTMLButtonElement).disabled).toBe(false),
  );
});

it("allows only one administrative action at a time", async () => {
  let finish!: (value: OrganizationRoster) => void;
  api.revokeInvite.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  await renderAs();
  fireEvent.click(screen.getByRole("button", { name: "Revoke invite to pending@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke invite to pending@example.com" }));
  expect((screen.getByRole("button", { name: "Resend invite to stale@example.com" }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.revokeInvite).toHaveBeenCalledTimes(1);
  finish(roster());
  await waitFor(() => expect((screen.getByRole("button", { name: "Resend invite to stale@example.com" }) as HTMLButtonElement).disabled).toBe(false));
});

it("changes a role and surfaces a server refusal", async () => {
  api.updateRole.mockResolvedValueOnce(
    roster({ members: roster().members.map((m) => (m.userId === "member-1" ? { ...m, role: "admin" } : m)) }),
  );
  await renderAs();
  fireEvent.change(screen.getByRole("combobox", { name: "Role for member@example.com" }), { target: { value: "admin" } });
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "Role for member@example.com" }) as HTMLSelectElement).value).toBe("admin"),
  );
  expect(api.updateRole).toHaveBeenCalledWith("member-1", "admin", "rev-1");

  api.updateRole.mockRejectedValueOnce({ code: "forbidden", status: 403, retryAfterSeconds: null });
  fireEvent.change(screen.getByRole("combobox", { name: "Role for member@example.com" }), { target: { value: "member" } });
  await screen.findByText("Only organization owners and admins can manage members.");
});

it("removes a member only after confirmation", async () => {
  api.remove.mockResolvedValue(roster({ members: roster().members.filter((m) => m.userId !== "member-1") }));
  await renderAs();
  fireEvent.click(screen.getByRole("button", { name: "Remove member@example.com" }));
  expect(api.remove).not.toHaveBeenCalled();
  expect(screen.getByText(/loses access to this organization immediately/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(screen.queryByRole("listitem", { name: "member@example.com" })).toBeNull());
  expect(api.remove).toHaveBeenCalledWith("member-1", "rev-1");
});

it("reloads for a new account context and ignores the previous context's late result", async () => {
  let late!: (value: OrganizationRoster) => void;
  api.list.mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
  api.list.mockResolvedValueOnce(roster({ contextRevision: "rev-b", members: [{ userId: "b", email: "b@example.com", role: "owner" }] }));
  const view = render(<OrganizationMembers accountEmail="admin@example.com" contextRevision="account-a" />);
  view.rerender(<OrganizationMembers accountEmail="admin@example.com" contextRevision="account-b" />);
  await screen.findByRole("listitem", { name: "b@example.com" });
  late(roster());
  await Promise.resolve();
  expect(screen.queryByRole("listitem", { name: "member@example.com" })).toBeNull();
});

it("hides invite and resend when the organization cannot invite, but keeps revoke", async () => {
  api.list.mockResolvedValue(roster({ canInvite: false }));
  await renderAs();
  expect(screen.queryByRole("textbox", { name: "Invite email" })).toBeNull();
  expect(screen.getByText("This organization cannot invite members.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Resend invite/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Revoke invite to pending@example.com" })).toBeTruthy();
});

it("stops offering a link once its invite is revoked", async () => {
  api.invite.mockResolvedValue(
    roster({
      invite: { email: "pending@example.com", role: "member", inviteUrl: "https://console.test/invite/old", emailSent: false, deduplicated: false },
    }),
  );
  api.revokeInvite.mockResolvedValue(roster({ pendingInvites: [] }));
  await renderAs();
  fireEvent.click(screen.getByRole("button", { name: "Resend invite to pending@example.com" }));
  await screen.findByText("https://console.test/invite/old");
  fireEvent.click(screen.getByRole("button", { name: "Revoke invite to pending@example.com" }));
  await waitFor(() => expect(screen.queryByText("https://console.test/invite/old")).toBeNull());
});

it("keeps a mutation result when an older refresh finishes after it", async () => {
  let stale!: (value: OrganizationRoster) => void;
  await renderAs();
  api.list.mockReturnValueOnce(new Promise((resolve) => (stale = resolve)));
  api.remove.mockResolvedValue(roster({ members: roster().members.filter((m) => m.userId !== "member-1") }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh members" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove member@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(screen.queryByRole("listitem", { name: "member@example.com" })).toBeNull());
  stale(roster());
  await Promise.resolve();
  await Promise.resolve();
  expect(screen.queryByRole("listitem", { name: "member@example.com" })).toBeNull();
  expect((screen.getByRole("button", { name: "Refresh members" }) as HTMLButtonElement).disabled).toBe(false);
});

it("says the outcome is unknown when a sent change loses its response", async () => {
  api.remove.mockRejectedValue({ code: "organization_members_outcome_unknown", status: null, retryAfterSeconds: null });
  await renderAs();
  fireEvent.click(screen.getByRole("button", { name: "Remove member@example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await screen.findByText(/may or may not have been applied/);
});
