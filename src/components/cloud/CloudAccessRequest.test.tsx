import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import type { CloudCatalogState } from "@/lib/cloudCatalog";
import { NotSharedNotice } from "./CloudCollab";

const mock = vi.hoisted(() => ({
  account: {} as AccountStatus,
  catalog: {} as CloudCatalogState,
  readShares: vi.fn(),
  copy: vi.fn(),
}));

vi.mock("@/lib/account", async (original) => ({
  ...(await original<typeof import("@/lib/account")>()),
  getAccount: () => ({ status: mock.account }),
  useAccount: () => ({ status: mock.account }),
}));
vi.mock("@/lib/cloudCatalog", async (original) => ({
  ...(await original<typeof import("@/lib/cloudCatalog")>()),
  getCloudCatalog: () => mock.catalog,
  useCloudCatalog: () => mock.catalog,
}));
vi.mock("@/lib/api", async (original) => {
  const mod = await original<typeof import("@/lib/api")>();
  return { ...mod, api: { ...mod.api, cloudWorkspaceShares: mock.readShares } };
});
vi.mock("@/lib/clipboard", () => ({ copyText: mock.copy }));

const orgId = "org-a";
const workspaceId = "workspace-a";
const feature = "cloud.workspaces.access-request-copy.v1";
const target = { orgId, workspaceId };

function item(accessMode: "organization" | "private" = "organization"): CloudWorkspaceListItem {
  return { workspace: { id: workspaceId, orgId, name: "Project Snowcap", accessMode, state: "ready",
    createdBy: "creator-a", creator: { userId: "creator-a", displayName: "Aisha", photoUrl: null },
  } } as CloudWorkspaceListItem;
}

beforeEach(() => {
  mock.copy.mockReset().mockResolvedValue(undefined);
  mock.readShares.mockReset().mockResolvedValue({ shares: [{ userId: "member-a", name: "Morgan", role: "viewer" }] });
  mock.account = {
    state: "signed-in",
    identity: { name: null, email: "member@example.test", organization: "Acme", organizationId: orgId },
    expiresAt: null, lastError: null,
    context: { account: "account-id", scope: "account-org", revision: "scope:1" },
    organizations: [{ id: orgId, name: "Acme", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } }],
    phase2Readiness: { [orgId]: [feature] },
  };
  mock.catalog = { loaded: true, createMemory: {}, notices: [], owner: "member@example.test", revision: "scope:1", orgs: {
    [orgId]: { orgId, source: "live", error: null, workspaces: [item()], repositories: null, repositoriesAt: null, fetchedAt: 1, quota: null, sessions: {} },
  } };
});

afterEach(cleanup);

describe("the locked workspace access request", () => {
  it("copies exactly the prepared text and offers a way back", async () => {
    const back = vi.fn();
    render(<NotSharedNotice requestTarget={target} onBack={back} />);
    expect(screen.getByText("Ask Aisha or an admin of Acme to share it with you.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    const message = (screen.getByRole("textbox", { name: "Prepared access request" }) as HTMLTextAreaElement).value;
    expect(message).toBe("Hi Aisha, could you share the TerminalX workspace “Project Snowcap” in Acme with me? Thanks!");
    expect(mock.copy).toHaveBeenCalledWith(message);
    expect(screen.getByRole("status").textContent).toContain("Send it to Aisha or an admin of Acme");
    fireEvent.click(screen.getByRole("button", { name: "Back to Overview" }));
    expect(back).toHaveBeenCalledOnce();
    expect(mock.readShares).not.toHaveBeenCalled();
  });

  it("keeps the message selectable when copying fails and requests a read-only share list on demand", async () => {
    mock.copy.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    render(<NotSharedNotice requestTarget={target} />);
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Prepared access request" }) as HTMLTextAreaElement).readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Who has access" }));
    const dialog = await screen.findByRole("dialog", { name: "Who has access" });
    expect(await within(dialog).findByText("Morgan · Read")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /edit|revoke|save/i })).toBeNull();
  });

  it.each(["held", "private", "stale"] as const)("preserves the legacy pane without disclosing creator or access when %s", (condition) => {
    if (condition === "held") mock.account.phase2Readiness = { other: [feature] };
    if (condition === "private") mock.catalog.orgs[orgId].workspaces = [item("private")];
    if (condition === "stale") mock.catalog.revision = "previous-identity";
    render(<NotSharedNotice requestTarget={target} onBack={vi.fn()} />);
    expect(screen.getByTestId("cloud-not-shared").textContent).toContain("Ask an organization admin or its creator");
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByText(/Aisha/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Request access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Who has access" })).toBeNull();
    expect(mock.readShares).not.toHaveBeenCalled();
  });
});
