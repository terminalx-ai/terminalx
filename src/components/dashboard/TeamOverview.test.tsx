import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import type { CloudCatalogState } from "@/lib/cloudCatalog";
import type { OrganizationMember, OrganizationRoster } from "@/lib/organizationMembers";
const f = vi.hoisted(() => ({
  status: {} as AccountStatus,
  catalog: {} as CloudCatalogState,
  load: vi.fn<() => Promise<OrganizationMember[]>>(),
  roster: { roster: null, loading: false, error: null } as { roster: OrganizationRoster | null; loading: boolean; error: unknown },
}));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: f.status }) }));
vi.mock("@/lib/cloudCatalog", () => ({ useCloudCatalog: () => f.catalog }));
vi.mock("@/lib/cloudPresence", () => ({ useCloudPresenceVersion: () => 0, cloudPresence: { snapshot: () => ({ state: "unavailable" }) } }));
vi.mock("@/lib/cloudPeople", () => ({ loadRosterIn: f.load }));
vi.mock("@/lib/organizationRoster", () => ({ useOrganizationRoster: () => f.roster }));
vi.mock("@/lib/dataPrivacy", () => ({ useDataPrivacy: () => ({ enabled: false }) }));
vi.mock("@/components/people/MemberProfile", () => ({ MemberProfile: () => null }));
import { ownerStorageKey, useTeamOverview } from "./TeamOverview";
function Overview({ org = "org" }: { org?: string }) {
  const team = useTeamOverview([{ id: "local", ownerId: "me" }], org, new Map([["me", "You"]]));
  return <>{team.controls}{team.views}<output aria-label="Visible rows">{team.rows.map((row) => row.id).join(",")}</output></>;
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  f.status = { state: "signed-in", context: { account: "a", scope: "org", revision: "1" } } as AccountStatus;
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
