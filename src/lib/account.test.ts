import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  teardown: {
    resetCloudConnections: vi.fn(),
    closeCloudConnectionsIn: vi.fn(),
    closeWorkspaceConnections: vi.fn(),
    closeWorkspaceConnectionsIn: vi.fn(),
    resetCloudTerminals: vi.fn(),
    dropCloudTerminalsIn: vi.fn(),
    resetCloudFiles: vi.fn(),
    resetCloudFilesIn: vi.fn(),
    dropCloudAgentsIn: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  closeWorkspaceConnections: mocks.teardown.closeWorkspaceConnections,
  closeWorkspaceConnectionsIn: mocks.teardown.closeWorkspaceConnectionsIn,
}));
vi.mock("@/lib/cloudConnections", () => ({
  resetCloudConnections: mocks.teardown.resetCloudConnections,
  closeCloudConnectionsIn: mocks.teardown.closeCloudConnectionsIn,
}));
vi.mock("@/lib/cloudTerminals", () => ({
  resetCloudTerminals: mocks.teardown.resetCloudTerminals,
  dropCloudTerminalsIn: mocks.teardown.dropCloudTerminalsIn,
}));
vi.mock("@/lib/workspaceFiles", () => ({
  resetCloudFiles: mocks.teardown.resetCloudFiles,
  resetCloudFilesIn: mocks.teardown.resetCloudFilesIn,
}));
vi.mock("@/lib/cloudAgents", () => ({ dropCloudAgentsIn: mocks.teardown.dropCloudAgentsIn }));

const signedIn = (cloud: boolean, activeOrg = "org-a") => ({
  state: "signed-in",
  identity: { name: "A", email: "a@example.com", organization: activeOrg, organizationId: activeOrg },
  expiresAt: null,
  lastError: null,
  context: { scope: "s", revision: "s:1" },
  organizations: [{ id: "org-a", name: "Acme", role: "owner", isPersonal: false, ...(cloud ? { cloud: { enabled: true, flags: {} } } : {}) }],
});

describe("account status after a silent token refresh", () => {
  it("takes the native announcement, and re-reads the status on window focus", async () => {
    mocks.invoke.mockResolvedValue(signedIn(false));
    const account = await import("./account");
    await account.bootAccount();
    expect(account.getAccount().status.organizations?.[0].cloud).toBeUndefined();

    // The native side refreshed the token and announces the new organizations.
    mocks.listeners.get("account_status")!({ payload: signedIn(true) });
    expect(account.getAccount().status.organizations?.[0].cloud?.enabled).toBe(true);

    // A missed announcement is caught on focus: the status is read again.
    mocks.invoke.mockClear().mockResolvedValue(signedIn(true, "org-b"));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(account.getAccount().status.identity?.organizationId).toBe("org-b"));
    expect(mocks.invoke.mock.calls[0][0]).toBe("account_status");
  });
});

describe("every organization live (CS-18): what a status change tears down", () => {
  const status = (fields: { active?: string; orgs?: string[]; multiOrg?: boolean; account?: string; scope?: string } = {}) => {
    const active = fields.active ?? "org-a";
    return {
      state: "signed-in" as const,
      identity: { name: "A", email: "a@example.com", organization: active, organizationId: active },
      expiresAt: null,
      lastError: null,
      context: { scope: fields.scope ?? `scope-${active}`, revision: `scope-${active}:1`, account: fields.account ?? "acct" },
      organizations: (fields.orgs ?? ["org-a", "org-b"]).map((id) => ({ id, name: id, role: "member", cloud: { enabled: true, flags: {} } })),
      multiOrg: fields.multiOrg ?? true,
    };
  };

  it("without the capability, any change of scope (the default organization included) drops everything, as before", async () => {
    const { cloudChange } = await import("./account");
    expect(cloudChange(status({ multiOrg: false }), status({ multiOrg: false, active: "org-b" }))).toEqual({ kind: "all" });
    expect(cloudChange(status({ multiOrg: false }), status({ multiOrg: false }))).toEqual({ kind: "orgs", left: [] });
  });

  it("with it, a change of the default organization drops nothing", async () => {
    const { cloudChange } = await import("./account");
    expect(cloudChange(status(), status({ active: "org-b" }))).toEqual({ kind: "orgs", left: [] });
  });

  it("with it, a lost membership drops only that organization, and another user drops everything", async () => {
    const { cloudChange } = await import("./account");
    expect(cloudChange(status(), status({ orgs: ["org-a"] }))).toEqual({ kind: "orgs", left: ["org-b"] });
    expect(cloudChange(status(), status({ account: "someone-else" }))).toEqual({ kind: "all" });
    expect(cloudChange(status(), { state: "signed-out", identity: null, expiresAt: null, lastError: null })).toEqual({ kind: "all" });
  });

  it("a server that drops the capability leaves only the default organization kept", async () => {
    const { cloudChange } = await import("./account");
    expect(cloudChange(status(), status({ multiOrg: false }))).toEqual({ kind: "orgs", left: ["org-b"] });
  });

  it("applies it: a default change closes no connection; leaving an organization closes only its connections", async () => {
    mocks.invoke.mockResolvedValue(status());
    const account = await import("./account");
    await account.refreshAccount();
    for (const fn of Object.values(mocks.teardown)) fn.mockClear();

    mocks.listeners.get("account_status")!({ payload: status({ active: "org-b" }) });
    for (const fn of Object.values(mocks.teardown)) expect(fn).not.toHaveBeenCalled();

    mocks.listeners.get("account_status")!({ payload: status({ active: "org-b", orgs: ["org-b"] }) });
    expect(mocks.teardown.closeCloudConnectionsIn).toHaveBeenCalledWith("org-a");
    expect(mocks.teardown.closeWorkspaceConnectionsIn).toHaveBeenCalledWith("org-a");
    expect(mocks.teardown.dropCloudTerminalsIn).toHaveBeenCalledWith("org-a");
    expect(mocks.teardown.resetCloudFilesIn).toHaveBeenCalledWith("org-a");
    expect(mocks.teardown.dropCloudAgentsIn).toHaveBeenCalledWith("org-a");
    expect(mocks.teardown.closeCloudConnectionsIn).not.toHaveBeenCalledWith("org-b");
    expect(mocks.teardown.resetCloudConnections).not.toHaveBeenCalled();
    expect(mocks.teardown.closeWorkspaceConnections).not.toHaveBeenCalled();
  });
});
