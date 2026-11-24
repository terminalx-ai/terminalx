import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudCatalogState } from "@/lib/cloudCatalog";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import type { ReassignedNotice } from "@/lib/desktopInbox";
const f = vi.hoisted(() => ({ status: {} as AccountStatus, catalog: {} as CloudCatalogState, reassign: vi.fn(), follow: vi.fn(), unfollow: vi.fn(), refresh: vi.fn(async () => undefined), roster: vi.fn(), settings: vi.fn(), rosterState: { roster: null, loading: false, error: null } as { roster: import("@/lib/organizationMembers").OrganizationRoster | null; loading: boolean; error: unknown } }));
const incoming = vi.hoisted(() => ({ notices: [] as ReassignedNotice[], dismiss: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { cloudWorkspaceFollow: f.follow, cloudWorkspaceUnfollow: f.unfollow, cloudWorkspaceReassign: f.reassign } }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: f.status }), useAccount: () => ({ status: f.status }), subscribeAccount: () => () => {} }));
vi.mock("@/lib/cloudCatalog", () => ({ relistCloudCatalog: f.refresh, useCloudCatalog: () => f.catalog }));
vi.mock("@/lib/organizationRoster", () => ({ useOrganizationRoster: () => f.rosterState }));
vi.mock("@/lib/cloudPeople", () => ({ loadRosterIn: f.roster, usePeople: () => () => "Sender" }));
vi.mock("@/lib/desktopInbox", () => ({ useReassignedNotices: () => incoming.notices, dismissReassignedNotice: incoming.dismiss }));
vi.mock("@/lib/sessions", () => ({ selectCloudWorkspace: incoming.open }));
vi.mock("@/lib/dataPrivacy", () => ({ privacyEnabled: () => false, useDataPrivacy: () => ({ enabled: false }), subscribeDataPrivacy: () => () => {} }));
vi.mock("@/lib/settingsLinks", () => ({ openOrganizationSettings: f.settings }));
vi.mock("@/components/people/MemberProfile", () => ({ memberName: (person: { displayName: string }) => person.displayName, MemberProfile: () => <span /> }));
import { dismissWorkspaceReassignReceipt, useWorkspaceReassignReceipt } from "@/lib/workspaceFollowing";
import { WorkspaceReassignDialog, WorkspaceFollowButton } from "./WorkspaceFollowing";
import { WorkspaceReassignedNotices } from "@/components/layout/WorkspaceReassignedNotices";
let item: CloudWorkspaceListItem;
beforeEach(() => {
  vi.clearAllMocks();
  incoming.notices = [];
  f.rosterState = { roster: null, loading: false, error: null };
  f.status = { state: "signed-in", context: { account: "account", scope: "org", revision: "1" }, identity: { name: "Me", email: "me@example.test", organization: "Team", organizationId: "org" }, organizations: [{ id: "org", name: "Team", role: "admin" }] } as AccountStatus;
  item = { workspace: { id: "workspace", orgId: "org", name: "Workspace", createdBy: "me", state: "suspended", accessMode: "organization" }, latestOperation: null, following: false } as CloudWorkspaceListItem;
  f.catalog = { viewerUserId: "me", orgs: { org: { source: "live", error: null, workspaces: [item] } } } as unknown as CloudCatalogState;
  f.status.phase2Readiness = { org: ["team.follow-reassign.v1"] };
  f.roster.mockResolvedValue([{ userId: "me", displayName: "Me", email: "me@example.test", role: "admin" }, { userId: "target", displayName: "Target", email: "target@example.test", role: "member" }]);
});
afterEach(() => {
  cleanup();
  dismissWorkspaceReassignReceipt();
});
function SenderReceipt() {
  const receipt = useWorkspaceReassignReceipt();
  return <output>{receipt ? `${receipt.targetName}: ${receipt.reassigned ? "new reassignment" : "earlier reassignment"}` : ""}</output>;
}
const response = (reassigned: boolean) => ({ workspaceId: "workspace", ownerId: "target", previousOwnerId: "me", reassigned });
it("keeps the request UUID, expected owner and optional note unchanged for an explicit retry", async () => {
  f.reassign.mockRejectedValueOnce({ code: "workspace_reassign_busy" }).mockResolvedValueOnce(response(false));
  const onClose = vi.fn();
  render(<><WorkspaceReassignDialog item={item} onClose={onClose} /><SenderReceipt /></>);
  const choice = await screen.findByRole("radio", { name: /Target/ }); fireEvent.click(choice);
  fireEvent.change(screen.getByLabelText("Note to the new owner"), { target: { value: "Away until Monday" } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Reassign" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Reassign" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry same attempt" }));
  await screen.findByText("Target: earlier reassignment");
  expect(onClose).toHaveBeenCalledOnce();
  expect(f.reassign).toHaveBeenCalledTimes(2);
  expect(f.reassign.mock.calls[0]).toEqual(f.reassign.mock.calls[1]);
  expect(f.reassign.mock.calls[0]?.[2]).toMatchObject({ targetUserId: "target", expectedOwnerId: "me", note: "Away until Monday" });
  expect(f.reassign.mock.calls[0]?.[2].requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(f.refresh).toHaveBeenCalledWith("org");
});
it("refuses private cross-owner transfer without pretending confirmation grants visibility", async () => {
  item.workspace.accessMode = "private";
  render(<WorkspaceReassignDialog item={item} onClose={vi.fn()} />);
  expect(screen.queryByRole("radio")).toBeNull();
  expect((screen.getByRole("button", { name: "Reassign" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Private cross-owner handover is unavailable/)).toBeTruthy();
  expect(f.roster).not.toHaveBeenCalled();
  expect(f.reassign).not.toHaveBeenCalled();
});
it("does not optimistically show Following, and hides the feature when the native gate is held", async () => {
  let finish!: () => void; f.follow.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<WorkspaceFollowButton item={item} />);
  fireEvent.click(await screen.findByRole("button", { name: "Follow" }));
  expect(screen.queryByRole("button", { name: "Following" })).toBeNull();
  finish(); await waitFor(() => expect(f.refresh).toHaveBeenCalledWith("org"));
  item = { ...item, following: true }; f.catalog.orgs.org!.workspaces = [item]; view.rerender(<WorkspaceFollowButton item={item} />);
  expect(screen.getByRole("button", { name: "Following" }).getAttribute("title")).toBe("Following on every device");
  f.status.phase2Readiness = { other: ["team.follow-reassign.v1"], org: ["team.presence.v1"] };
  view.rerender(<WorkspaceFollowButton item={item} />);
  expect(screen.queryByRole("button", { name: "Following" })).toBeNull();
});

it("does not reveal a late reassignment result or note after account context changes", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  f.reassign.mockReturnValueOnce(new Promise<ReturnType<typeof response>>((resolve) => { finish = resolve; }));
  const onClose = vi.fn();
  const view = render(<><WorkspaceReassignDialog item={item} onClose={onClose} /><SenderReceipt /></>);
  fireEvent.click(await screen.findByRole("radio", { name: /Target/ }));
  fireEvent.change(screen.getByLabelText("Note to the new owner"), { target: { value: "Account-private note" } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Reassign" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Reassign" }));
  await waitFor(() => expect(f.reassign).toHaveBeenCalledTimes(1));
  f.status = { ...f.status, context: { account: "other", scope: "org", revision: "2" } };
  view.rerender(<><WorkspaceReassignDialog item={item} onClose={onClose} /><SenderReceipt /></>);
  expect(screen.queryByDisplayValue("Account-private note")).toBeNull();
  finish(response(true));
  await waitFor(() => expect(screen.getByText(/The account changed/)).toBeTruthy());
  expect(f.refresh).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText(/new reassignment/)).toBeNull();
});

it("retires removed roster candidates and refuses their selected target before sending", async () => {
  const view = render(<WorkspaceReassignDialog item={item} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("radio", { name: /Target/ }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Reassign" }) as HTMLButtonElement).disabled).toBe(false));
  f.rosterState = { roster: { members: [] } as unknown as import("@/lib/organizationMembers").OrganizationRoster, loading: false, error: null };
  view.rerender(<WorkspaceReassignDialog item={item} onClose={vi.fn()} />);
  expect(screen.queryByRole("radio", { name: /Target/ })).toBeNull();
  expect((screen.getByRole("button", { name: "Reassign" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reassign" }));
  expect(f.reassign).not.toHaveBeenCalled();
});
it("hides the initial roster after an authorization refresh fails", async () => {
  const view = render(<WorkspaceReassignDialog item={item} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("radio", { name: /Target/ }));
  f.rosterState = { roster: null, loading: false, error: { code: "forbidden" } };
  view.rerender(<WorkspaceReassignDialog item={item} onClose={vi.fn()} />);
  expect(screen.queryByRole("radio", { name: /Target/ })).toBeNull();
  expect(screen.getByText(/The member list is unavailable/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Reassign" }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.reassign).not.toHaveBeenCalled();
});

it("blocks a known installed runtime and removes an already selected candidate", async () => {
  const view = render(<WorkspaceReassignDialog item={item} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("radio", { name: /Target/ }));
  const latest = { ...item, workspace: { ...item.workspace, runtime: { sha256: "sha", protocol: 1, installedAt: 1 } } };
  f.catalog.orgs.org!.workspaces = [latest];
  view.rerender(<WorkspaceReassignDialog item={item} onClose={vi.fn()} />);
  expect(screen.getByText(/Runtime handover is unavailable/)).toBeTruthy();
  expect(screen.queryByRole("radio")).toBeNull();
  expect((screen.getByRole("button", { name: "Reassign" }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.reassign).not.toHaveBeenCalled();
});

it("does not offer the picker when the readiness key belongs to another organization", () => {
  f.status.phase2Readiness = { other: ["team.follow-reassign.v1"] };
  render(<WorkspaceReassignDialog item={item} onClose={vi.fn()} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Reassign" })).toBeNull();
  expect(f.roster).not.toHaveBeenCalled();
});

it("renders authorized incoming notices with Events enabled and Follow/Reassign held", () => {
  f.status.phase2Readiness = { org: ["team.events.v1"], other: ["team.follow-reassign.v1"] };
  incoming.notices = [{ id: "1", organizationId: "org", workspaceId: "workspace", name: "Workspace", actorId: "sender", previousOwnerId: "sender", note: "Away until Monday" }];
  const view = render(<WorkspaceReassignedNotices />);

  expect(screen.getByRole("status").textContent).toContain("Sender reassigned to you Workspace");
  expect(screen.getByText("Away until Monday")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
  expect(incoming.open).toHaveBeenCalledWith("cloud:org:workspace");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss reassignment" }));
  expect(incoming.dismiss).toHaveBeenCalledWith("1");

  f.catalog.orgs.org!.workspaces = [{ ...item, workspace: { ...item.workspace, createdBy: "someone-else" } }];
  view.rerender(<WorkspaceReassignedNotices />);
  expect(screen.queryByText("Away until Monday")).toBeNull();
});
