import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus, CloudWorkspaceListItem, PresenceReadResponse } from "@/lib/api";
import type { CloudCatalogState } from "@/lib/cloudCatalog";
import type { OrganizationMember, OrganizationRoster } from "@/lib/organizationMembers";
const f = vi.hoisted(() => ({
  status: {} as AccountStatus,
  presence: { state: "unavailable", activeMembers: [], workspaces: [] } as { state: string; activeMembers: PresenceReadResponse["activeMembers"]; workspaces: PresenceReadResponse["workspaces"] },
  catalog: {} as CloudCatalogState,
  load: vi.fn<() => Promise<OrganizationMember[]>>(),
  roster: { roster: null, loading: false, error: null } as { roster: OrganizationRoster | null; loading: boolean; error: unknown },
}));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: f.status }) }));
vi.mock("@/lib/cloudCatalog", () => ({ useCloudCatalog: () => f.catalog }));
vi.mock("@/lib/cloudPresence", () => ({ useCloudPresence: () => f.presence, useCloudPresenceVersion: () => 0, cloudPresence: { snapshot: () => f.presence } }));
vi.mock("@/lib/cloudPeople", () => ({ loadRosterIn: f.load, initials: (name: string) => name.slice(0, 2) }));
vi.mock("@/lib/organizationRoster", () => ({ useOrganizationRoster: () => f.roster }));
vi.mock("@/lib/dataPrivacy", () => ({ useDataPrivacy: () => ({ enabled: false }) }));
vi.mock("@/components/people/MemberProfile", () => ({
  memberName: (member: OrganizationMember) => member.displayName,
  MemberProfile: ({ member, online }: { member: OrganizationMember; online?: boolean }) => (
    <button type="button" aria-label={`View profile: ${member.displayName}`} data-online={online} />
  ),
}));
import { ownerStorageKey, useTeamOverview, PresenceFaces, OwnerProfile, type TeamRow } from "./TeamOverview";
import { OrganizationPresenceCount, WorkspaceFollowingSection } from "@/components/layout/WorkspaceFollowingSection";
vi.mock("@/lib/sessions", () => ({ selectCloudWorkspace: vi.fn() }));
function Overview({ org = "org", rows = [{ id: "local", ownerId: "me" }] }: { org?: string; rows?: TeamRow[] }) {
  const team = useTeamOverview(rows, org, new Map([["me", "You"]]));
  return <>{team.controls}{team.views}<output aria-label="Visible rows">{team.rows.map((row) => row.id).join(",")}</output></>;
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  f.presence = { state: "unavailable", activeMembers: [], workspaces: [] };
  f.status = {
    state: "signed-in", identity: null, expiresAt: null, lastError: null,
    context: { account: "a", scope: "org", revision: "1" },
    phase2Readiness: { org: ["team.follow-reassign.v1", "team.presence.v1"] },
  };
  f.catalog = { viewerUserId: "me", orgs: { org: { source: "live", error: null, workspaces: [] }, other: { source: "live", error: null, workspaces: [] } } } as unknown as CloudCatalogState;
  f.roster = { roster: null, loading: false, error: null };
  f.load.mockImplementation(() => new Promise(() => {}));
});
afterEach(cleanup);
it("keeps the saved By selection while the roster loads, then prunes only after an authorized roster change", async () => {
  const key = ownerStorageKey("a", "org");
  localStorage.setItem(key, '["bob"]');
  let finish!: (members: OrganizationMember[]) => void;
  f.load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<Overview />);
  expect(screen.getByLabelText("Visible rows").textContent).toBe("");
  expect(localStorage.getItem(key)).toBe('["bob"]');
  await act(async () => { finish([{ userId: "bob", displayName: "Bob", email: "bob@example.test", role: "member" }]); });
  expect(localStorage.getItem(key)).toBe('["bob"]');
  f.roster = { roster: { members: [] } as unknown as OrganizationRoster, loading: false, error: null };
  view.rerender(<Overview />);
  await waitFor(() => expect(localStorage.getItem(key)).toBe("[]"));
  expect(screen.getByLabelText("Visible rows").textContent).toBe("local");
});
it("renders from the current account/org preference immediately and never saves another scope's selection", () => {
  const a = ownerStorageKey("a", "org");
  localStorage.setItem(a, '["bob"]');
  const view = render(<Overview />);
  expect(screen.getByLabelText("Visible rows").textContent).toBe("");
  f.status = { ...f.status, context: { account: "b", scope: "org", revision: "2" } };
  view.rerender(<Overview />);
  expect(screen.getByLabelText("Visible rows").textContent).toBe("local");
  expect(localStorage.getItem(ownerStorageKey("b", "org"))).toBeNull();
  f.status = { ...f.status, context: { account: "a", scope: "org", revision: "3" } };
  view.rerender(<Overview />);
  expect(screen.getByLabelText("Visible rows").textContent).toBe("");
  view.rerender(<Overview org="other" />);
  expect(screen.getByLabelText("Visible rows").textContent).toBe("local");
  expect(localStorage.getItem(a)).toBe('["bob"]');
});

it("keeps compact sidebar presence unknown without inventing zero or losing its accessible state", () => {
  for (const [state, label] of [["unavailable", "Presence unavailable"], ["loading", "Loading presence…"], ["stale", "Presence stale"]]) {
    f.presence = { state, activeMembers: [], workspaces: [] };
    const view = render(<PresenceFaces orgId="org" workspaceId="workspace" compact />);
    expect(screen.getByLabelText(label).textContent).toBe("—");
    expect(screen.getByLabelText(label).getAttribute("title")).toBe(label);
    expect(screen.queryByText("No one online")).toBeNull();
    view.unmount();
  }
});
it("retains full overview state words and distinguishes authoritative empty presence from unknown", () => {
  const view = render(<PresenceFaces orgId="org" />);
  expect(screen.getByText("Presence unavailable")).toBeTruthy();
  f.presence = { state: "live", activeMembers: [], workspaces: [] };
  view.rerender(<PresenceFaces orgId="org" />);
  expect(screen.getByText("No one online")).toBeTruthy();
});
it("keeps organization presence labels truthful in compact quota and action rows", () => {
  const view = render(<OrganizationPresenceCount orgId="org" />);
  expect(screen.getByLabelText("Presence unavailable").textContent).toBe("—");
  expect(screen.queryByText("0 online")).toBeNull();
  f.presence = { state: "live", activeMembers: [], workspaces: [] };
  view.rerender(<OrganizationPresenceCount orgId="org" />);
  expect(screen.getByLabelText("cloud · 0 online").textContent).toBe("cloud · 0 online");
});

const cloudRows: TeamRow[] = [{ id: "cloud-one", orgId: "org", workspaceId: "one" }];
function catalogWorkspace(createdBy?: string): CloudWorkspaceListItem {
  return { workspace: { id: "one", orgId: "org", name: "One", provider: "machine0", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 1,
    createdBy }, latestOperation: null } as CloudWorkspaceListItem;
}
it("keeps Mine unavailable until current authorized ownership is known, then distinguishes own from other", () => {
  f.catalog.orgs.org.workspaces = [catalogWorkspace()];
  const view = render(<Overview rows={cloudRows} />);
  const mine = () => screen.getByRole("button", { name: /^Mine/ }) as HTMLButtonElement;
  expect(mine().disabled).toBe(true);
  expect(mine().textContent).toBe("Mine—");
  f.catalog.orgs.org.workspaces = [catalogWorkspace("me")];
  view.rerender(<Overview rows={cloudRows} />);
  expect(mine().disabled).toBe(false);
  expect(mine().textContent).toBe("Mine1");
  f.catalog.orgs.org.workspaces = [catalogWorkspace("other")];
  view.rerender(<Overview rows={cloudRows} />);
  expect(mine().disabled).toBe(false);
  expect(mine().textContent).toBe("Mine0");
});
it("does not count cached, errored or omitted ownership as known Mine data", () => {
  f.catalog.orgs.org.workspaces = [catalogWorkspace("me")];
  f.catalog.orgs.org.source = "cache";
  const view = render(<Overview rows={cloudRows} />);
  const unknown = () => {
    const button = screen.getByRole("button", { name: /^Mine/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Mine—");
  };
  unknown();
  f.catalog.orgs.org.source = "live"; f.catalog.orgs.org.error = "refresh failed";
  view.rerender(<Overview rows={cloudRows} />); unknown();
  f.catalog.orgs.org.error = null; f.catalog.orgs.org.workspaces = [];
  view.rerender(<Overview rows={cloudRows} />); unknown();
});
it("requires workspace presence coverage before Active now can report authoritative zero or active rows", () => {
  f.catalog.orgs.org.workspaces = [catalogWorkspace("me")];
  const bob = { userId: "bob", displayName: "Bob", photoUrl: null };
  f.presence = { state: "live", activeMembers: [bob], workspaces: [] };
  const view = render(<Overview rows={cloudRows} />);
  const active = () => screen.getByRole("button", { name: /^Active now/ }) as HTMLButtonElement;
  expect(active().disabled).toBe(true);
  expect(active().textContent).toBe("Active now—");
  f.presence.workspaces = [{ workspaceId: "one", owner: { userId: "me", displayName: "Me", photoUrl: null }, activeMembers: [] }];
  view.rerender(<Overview rows={cloudRows} />);
  expect(active().disabled).toBe(false);
  expect(active().textContent).toBe("Active now0");
  fireEvent.click(active());
  expect(screen.getByLabelText("Visible rows").textContent).toBe("");
  f.presence.workspaces[0].activeMembers = [bob];
  view.rerender(<Overview rows={cloudRows} />);
  expect(active().textContent).toBe("Active now1");
  expect(screen.getByLabelText("Visible rows").textContent).toBe("cloud-one");
});


it("stops displaying followed workspaces when follow readiness is killed", () => {
  f.catalog.orgs.org!.workspaces = [{ ...catalogWorkspace("me"), following: true }];
  const view = render(<><Overview rows={cloudRows} /><WorkspaceFollowingSection orgId="org" /></>);
  fireEvent.click(screen.getByRole("button", { name: /^Following/ }));
  expect(screen.getByRole("region", { name: "Following" })).toBeTruthy();
  f.status.phase2Readiness = { org: ["team.presence.v1"] };
  view.rerender(<><Overview rows={cloudRows} /><WorkspaceFollowingSection orgId="org" /></>);
  expect(screen.queryByRole("region", { name: "Following" })).toBeNull();
  expect((screen.getByRole("button", { name: /Following/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText("Visible rows").textContent).toBe("cloud-one");
});

it("uses only authorized live presence for the By menu and profiles, and drops it when readiness is held", () => {
  const bob = { userId: "bob", displayName: "Bob", photoUrl: null };
  f.roster.roster = { members: [{ ...bob, photoUrl: undefined, email: "bob@example.test", role: "member" }] } as OrganizationRoster;
  f.presence = { state: "live", activeMembers: [bob], workspaces: [] };
  const demo = () => <><Overview /><PresenceFaces orgId="org" /><OwnerProfile orgId="org" userId="bob" name="Bob" photoUrl={null} /></>;
  const view = render(demo());
  const open = () => fireEvent.pointerDown(screen.getByRole("button", { name: "By Anyone" }), { button: 0, ctrlKey: false });
  open();
  expect(screen.getByRole("menuitemcheckbox", { name: "Bob" }).getAttribute("aria-description")).toBe("Active now");
  expect(screen.getAllByRole("button", { name: "View profile: Bob", hidden: true }).map((button) => button.dataset.online)).toEqual(["true", "true"]);

  f.presence = { state: "live", activeMembers: [], workspaces: [] };
  view.rerender(demo());
  expect(screen.getByRole("menuitemcheckbox", { name: "Bob" }).hasAttribute("aria-description")).toBe(false);
  expect(screen.getByRole("button", { name: "View profile: Bob", hidden: true }).dataset.online).toBe("false");

  f.presence = { state: "live", activeMembers: [bob], workspaces: [] };
  f.status.phase2Readiness = { org: ["team.follow-reassign.v1"] };
  view.rerender(demo());
  expect(screen.getByRole("menuitemcheckbox", { name: "Bob" }).hasAttribute("aria-description")).toBe(false);
  expect(screen.getByRole("button", { name: "View profile: Bob", hidden: true }).dataset.online).toBeUndefined();
  expect(screen.getByText("Presence unavailable")).toBeTruthy();
});
