import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { organizationMembers, type OrganizationRoster } from "@/lib/organizationMembers";
import { InviteStep } from "./InviteStep";
import type { StepProps } from "./stepProps";

vi.mock("@/lib/organizationMembers", async (original) => ({
  ...await original<typeof import("@/lib/organizationMembers")>(),
  organizationMembers: { list: vi.fn(), invite: vi.fn(), revokeInvite: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api: { cloudAgentLogins: async () => ({ credentials: [] }), cloudProviders: async () => ({ providers: [] }) } }));
vi.mock("@/lib/organizationGithubApp", () => ({ organizationGithubApp: { summary: async () => ({ installations: [], repositories: [] }) } }));
vi.mock("./FinishActions", () => ({ FinishActions: () => null }));

const email = "new@example.com";
const url = "https://console.test/invite/recipient-token";
const roster = (extra: Partial<OrganizationRoster> = {}): OrganizationRoster => ({
  members: [], pendingInvites: [], viewerRole: "owner", canManageMembers: true, canInvite: true, contextRevision: "roster-1", ...extra,
});
const issued = (extra: Partial<OrganizationRoster> = {}) => roster({
  pendingInvites: [{ email, role: "admin", createdAt: Date.now(), expiresAt: Date.now() + 60_000 }],
  invite: { email, role: "admin", inviteUrl: url, emailSent: false, deduplicated: false },
  ...extra,
});
const props: StepProps & { onDone: () => void } = {
  organization: { id: "org-1", name: "Team", role: "owner" }, contextRevision: "account-1", accountEmail: "owner@example.com",
  record: { v: 2, requestId: "setup", name: "Team", organizationId: "org-1", createdAt: 0, step: "done", agent: "required", workspace: null, completedAt: null },
  onRecord: vi.fn(), onContinue: vi.fn(), onDone: vi.fn(),
};
const writeText = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(organizationMembers.list).mockResolvedValue(roster());
  vi.mocked(organizationMembers.invite).mockResolvedValue(issued());
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(cleanup);

async function send() {
  fireEvent.change(await screen.findByLabelText("Invite by email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Role for these invites"), { target: { value: "admin" } });
  fireEvent.click(screen.getByRole("button", { name: "Send invites" }));
  await screen.findByText("Sent 1 invite.");
}
const copy = () => screen.queryByRole("button", { name: `Copy invitation link for ${email}` });

it("shows unsupported shared links without offering a domain token, including on older servers", async () => {
  vi.mocked(organizationMembers.list).mockResolvedValue(roster({ canInvite: undefined }));
  render(<InviteStep {...props} />);
  expect(await screen.findByText("Shared invite link unavailable. Invite each person by email.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
  expect(screen.queryByText(/anyone with/)).toBeNull();
  expect(writeText).not.toHaveBeenCalled();
});

it("copies only the issued recipient link and describes its email and server role", async () => {
  render(<InviteStep {...props} />);
  await send();
  expect(screen.getByText(`Only ${email} can accept this link, joining as Admin.`)).toBeTruthy();
  fireEvent.click(copy()!);
  await screen.findByText("Copied");
  expect(writeText).toHaveBeenCalledWith(url);
  expect(organizationMembers.invite).toHaveBeenCalledWith(email, "admin", "roster-1");
});

it.each([
  { canManageMembers: false, viewerRole: "member" },
  { canInvite: false },
])("offers no copy action when the authoritative response denies invitations: %j", async (denial) => {
  vi.mocked(organizationMembers.invite).mockResolvedValue(issued(denial));
  render(<InviteStep {...props} />);
  fireEvent.change(await screen.findByLabelText("Invite by email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Send invites" }));
  await screen.findByText(/cannot invite members|Only owners and admins/);
  expect(copy()).toBeNull();
});

it.each(["expired", "missing", "role mismatch"])("does not offer a %s recipient link", async (scenario) => {
  const response = issued();
  if (scenario === "expired") response.pendingInvites[0].expiresAt = Date.now() - 1;
  if (scenario === "missing") response.invite!.inviteUrl = undefined;
  if (scenario === "role mismatch") response.pendingInvites[0].role = "member";
  vi.mocked(organizationMembers.invite).mockResolvedValue(response);
  render(<InviteStep {...props} />);
  await send();
  expect(copy()).toBeNull();
});

it.each(["rejected", "unavailable"])("reports clipboard failure when %s and permits retry", async (failure) => {
  render(<InviteStep {...props} />);
  await send();
  if (failure === "rejected") writeText.mockRejectedValueOnce(new Error("Denied"));
  else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  fireEvent.click(copy()!);
  await screen.findByText("Couldn't copy the invitation link. Try again.");
  expect(screen.queryByText("Copied")).toBeNull();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(copy()!);
  await screen.findByText("Copied");
  expect(screen.queryByText("Couldn't copy the invitation link. Try again.")).toBeNull();
});

it.each(["organization", "revision", "account"])("discards tokens and late clipboard feedback after a change to %s", async (change) => {
  let complete!: () => void;
  writeText.mockReturnValue(new Promise<void>((resolve) => { complete = resolve; }));
  const view = render(<InviteStep {...props} />);
  await send();
  fireEvent.click(copy()!);
  const next = { ...props };
  if (change === "organization") next.organization = { ...props.organization, id: "org-2" };
  if (change === "revision") next.contextRevision = "account-2";
  if (change === "account") next.accountEmail = "other@example.com";
  // Even the same pending email in the new context must not inherit a token.
  vi.mocked(organizationMembers.list).mockResolvedValue(issued());
  view.rerender(<InviteStep {...next} />);
  await screen.findByLabelText("Invite by email");
  await act(async () => complete());
  expect(copy()).toBeNull();
  expect(screen.queryByText("Copied")).toBeNull();
});

it("ignores an invitation response arriving after an account switch", async () => {
  let complete!: (value: OrganizationRoster) => void;
  vi.mocked(organizationMembers.invite).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  const view = render(<InviteStep {...props} />);
  fireEvent.change(await screen.findByLabelText("Invite by email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Send invites" }));
  view.rerender(<InviteStep {...props} contextRevision="account-2" />);
  await act(async () => complete(issued()));
  await screen.findByLabelText("Invite by email");
  expect(copy()).toBeNull();
  expect(screen.queryByText("Sent 1 invite.")).toBeNull();
});
