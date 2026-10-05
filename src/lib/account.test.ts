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

    // A missed announcement is caught on focus: the status is read again,
    // with the organizations and roles (throttled natively, so not forced).
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.invoke.mockClear().mockResolvedValue({ status: signedIn(true, "org-b"), fresh: false });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(account.getAccount().status.identity?.organizationId).toBe("org-b"));
    expect(mocks.invoke.mock.calls[0]).toEqual(["account_refresh_roles", { force: false }]);
  });
});

describe("a role changed elsewhere (an owner demotes this admin)", () => {
  const as = (role: string, extra: Record<string, unknown> = {}) => ({
    state: "signed-in" as const,
    identity: { name: "Erin", email: "erin@example.com", organization: "org-a", organizationId: "org-a" },
    expiresAt: null,
    lastError: null,
    context: { scope: "erin", revision: "erin:1", account: "erin" },
    organizations: [{ id: "org-a", name: "Share Lab", role, isPersonal: false, cloud: { enabled: true, flags: {} } }],
    multiOrg: true,
    ...extra,
  });
  /** What the native side answers, per command; `roles` is the account service's current word. */
  const native = (held: string, roles: { role: string; fresh?: boolean } | Error) =>
    mocks.invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === "account_status") return as(held);
      if (command === "account_refresh_roles") {
        if (roles instanceof Error) throw roles;
        return { status: as(roles.role), fresh: roles.fresh ?? true };
      }
      // The local-mirror housekeeping an account change triggers is local: it asks no server and is refused for no role.
      if (command === "cloud_mirror_list") return [];
      if (command.startsWith("cloud_mirror_")) return 0;
      throw { code: "organization_admin_required", status: 403 };
    });
  const roleCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "account_refresh_roles").map(([, args]) => args);
  const role = (account: typeof import("./account")) => account.getAccount().status.organizations?.[0].role;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("is read from the account service on launch, without waiting for the token to near its expiry", async () => {
    vi.resetModules();
    // The saved session still says admin (it did even after a restart); the server says member.
    native("admin", { role: "member" });
    const account = await import("./account");
    const { mayStartCloudSessions } = await import("./multiOrg");
    await account.bootAccount();
    await vi.waitFor(() => expect(role(account)).toBe("member"));
    expect(roleCalls()).toEqual([{ force: true }]);
    // What every menu derives from: "+", New session, New project… and New cloud workspace… are no longer offered.
    expect(mayStartCloudSessions(account.getAccount().status, "org-a")).toBe(false);
  });

  it("is read again at once when a cloud call is refused for lack of role", async () => {
    vi.resetModules();
    native("admin", { role: "admin" });
    const account = await import("./account");
    // Every native call's failure passes through this (see accountRoles.test.ts).
    const { noteCallFailure } = await import("./accountRoles");
    await account.bootAccount();
    await vi.waitFor(() => expect(roleCalls()).toHaveLength(1));
    await settle();
    native("admin", { role: "member" });
    noteCallFailure({ code: "cloud_workspace_quota_exceeded", status: 409 });
    expect(roleCalls()).toEqual([]);
    noteCallFailure({ code: "organization_admin_required", status: 403 });
    await vi.waitFor(() => expect(role(account)).toBe("member"));
    expect(roleCalls()).toEqual([{ force: true }]);
  });

  it("follows a workspace list that says otherwise at once, and asks the account service", async () => {
    vi.resetModules();
    native("admin", { role: "admin" });
    const account = await import("./account");
    await account.bootAccount();
    await vi.waitFor(() => expect(roleCalls()).toHaveLength(1));
    await settle();

    // The account service cannot be reached; the list (read every 30 s) says this person no longer manages.
    native("admin", new Error("offline"));
    const { roleAskStamp } = await import("./accountRoles");
    account.noteListedOrgRole("org-a", false, roleAskStamp());
    expect(role(account)).toBe("member");
    expect(roleCalls()).toEqual([{ force: true }]);
    await settle();
    // A status announced meanwhile with the old role does not bring the old menus back.
    mocks.listeners.get("account_status")!({ payload: as("admin") });
    expect(role(account)).toBe("member");

    // Once the account service answers, its word is the one shown: promoted to owner meanwhile.
    native("admin", { role: "owner" });
    const listAskedBefore = roleAskStamp();
    await account.refreshAccountRoles(true);
    expect(role(account)).toBe("owner");
    // A list asked for before that answer says nothing new.
    account.noteListedOrgRole("org-a", false, listAskedBefore);
    expect(role(account)).toBe("owner");
  });

  it("keeps a roles read and a workspace list asked for in the same millisecond in the order they were asked", async () => {
    vi.resetModules();
    // Every read of the clock in this test answers the same millisecond.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      native("admin", { role: "admin" });
      const account = await import("./account");
      const { roleAskStamp } = await import("./accountRoles");
      await account.bootAccount();
      await vi.waitFor(() => expect(roleCalls()).toHaveLength(1));
      await settle();

      // A list asked for after the roles answered, in that millisecond, is the newer word: this admin was demoted.
      native("admin", new Error("offline"));
      account.noteListedOrgRole("org-a", false, roleAskStamp());
      expect(role(account)).toBe("member");
      expect(roleCalls()).toEqual([{ force: true }]);
      await settle();

      // A roles read asked for after that list, in that millisecond still, is newer than the list.
      native("admin", { role: "owner" });
      await account.refreshAccountRoles(true);
      expect(role(account)).toBe("owner");

      // And a list asked for before a roles read, whose answer arrives after the roles', says nothing new.
      const listAsked = roleAskStamp();
      await account.refreshAccountRoles(true);
      account.noteListedOrgRole("org-a", false, listAsked);
      expect(role(account)).toBe("owner");
      expect(Date.now()).toBe(1_700_000_000_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("takes a promotion from the list too, and nothing from a list that does not say", async () => {
    vi.resetModules();
    native("member", { role: "member" });
    const account = await import("./account");
    await account.bootAccount();
    await vi.waitFor(() => expect(roleCalls()).toHaveLength(1));
    await settle();
    native("member", { role: "member", fresh: false });
    const { roleAskStamp } = await import("./accountRoles");
    account.noteListedOrgRole("org-a", null, roleAskStamp());
    account.noteListedOrgRole("org-a", false, roleAskStamp());
    expect(roleCalls()).toEqual([]);
    account.noteListedOrgRole("org-a", true, roleAskStamp());
    expect(role(account)).toBe("admin");
    expect(roleCalls()).toEqual([{ force: true }]);
    await settle();
    // The list agrees with the account again: nothing is overridden.
    account.noteListedOrgRole("org-a", false, roleAskStamp());
    expect(role(account)).toBe("member");
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

describe("leftovers of an organization left or another user (PRO-71 follow-ups)", () => {
  const who = (email: string, orgs: string[], active = orgs[0]) => ({
    state: "signed-in" as const,
    identity: { name: "A", email, organization: active, organizationId: active },
    expiresAt: null,
    lastError: null,
    context: { scope: `scope-${email}-${active}`, revision: "r:1", account: `acct-${email}` },
    organizations: orgs.map((id) => ({ id, name: id, role: "member", cloud: { enabled: true, flags: {} } })),
    multiOrg: true,
  });
  const pending = { idempotencyKey: "k", createdAt: Date.now(), request: { name: "n", launch: { prompt: "secret plan" } } } as never;
  const announce = (payload: unknown) => mocks.listeners.get("account_status")!({ payload });

  it("scopes pending creates by user, and leaving an organization clears its pending creates and sidebar prefs only", async () => {
    mocks.invoke.mockResolvedValue(who("a@example.com", ["org-a", "org-b"]));
    const account = await import("./account");
    const create = await import("./cloudCreate");
    const prefs = await import("./prefs");
    localStorage.clear();
    await account.bootAccount();
    await account.refreshAccount();
    announce(who("a@example.com", ["org-a", "org-b"]));
    create.savePending("org-a", pending);
    create.savePending("org-b", pending);
    expect(localStorage.getItem("terminalx.cloudCreate.pending.a%40example%2Ecom.org-b")).toContain("secret plan");
    prefs.setPrefs({ cloudPinned: { "org-a": ["x"], "org-b": ["y"] }, cloudProjects: { "org-b": ["z"] }, cloudBlankProjects: { "org-a": ["p"], "org-b": ["q"] } });

    announce(who("a@example.com", ["org-a"]));
    expect(create.loadPending("org-b")).toBeNull();
    expect(localStorage.getItem("terminalx.cloudCreate.pending.a%40example%2Ecom.org-b")).toBeNull();
    expect(create.loadPending("org-a")).not.toBeNull();
    expect(prefs.getPrefs().cloudPinned).toEqual({ "org-a": ["x"] });
    expect(prefs.getPrefs().cloudProjects).toEqual({});
    expect(prefs.getPrefs().cloudBlankProjects).toEqual({ "org-a": ["p"] });
  });

  it("another user signing in removes the previous user's pending creates and other organizations' prefs; the same user again keeps them", async () => {
    const account = await import("./account");
    const create = await import("./cloudCreate");
    const prefs = await import("./prefs");
    announce(who("a@example.com", ["org-a"]));
    create.savePending("org-a", pending);
    // An unscoped one from before this change is removed on the next user change too.
    localStorage.setItem("terminalx.cloudCreate.pending.org-a", "{}");
    prefs.setPrefs({ cloudPinned: { "org-a": ["x"], "org-c": ["y"] }, cloudProjects: {}, cloudBlankProjects: {} });

    // Sign-out and the same user again: nothing goes.
    announce({ state: "signed-out", identity: null, expiresAt: null, lastError: null });
    expect(create.loadPending("org-a")).toBeNull(); // nobody signed in: nothing is read
    announce(who("a@example.com", ["org-a"]));
    expect(create.loadPending("org-a")).not.toBeNull();

    announce(who("b@example.com", ["org-c"]));
    expect(create.loadPending("org-a")).toBeNull();
    expect(localStorage.getItem("terminalx.cloudCreate.pending.a%40example%2Ecom.org-a")).toBeNull();
    expect(localStorage.getItem("terminalx.cloudCreate.pending.org-a")).toBeNull();
    expect(prefs.getPrefs().cloudPinned).toEqual({ "org-c": ["y"] });
    expect(account.getAccount().status.identity?.email).toBe("b@example.com");
  });

  it("forgets organization setup records on sign-out and when another user signs in; a left organization loses only its own (PRO-16)", async () => {
    const account = await import("./account");
    const setups = await import("./organizationSetup");
    const record = (requestId: string, organizationId: string) => ({ ...setups.newSetup("Team", requestId, 1), organizationId, step: "compute" as const });
    announce(who("a@example.com", ["org-a", "org-b"]));
    setups.saveSetup("a@example.com", record("r-a", "org-a"));
    setups.saveSetup("a@example.com", record("r-b", "org-b"));
    localStorage.setItem("terminalx.organization-setup.v1.a@example.com.name", "Draft");

    // Leaving one organization takes only its record.
    announce(who("a@example.com", ["org-a"]));
    expect(setups.loadSetups("a@example.com").map((r) => r.organizationId)).toEqual(["org-a"]);

    // Another user signs in without a sign-out in between: the first user's records go, theirs stay.
    setups.saveSetup("b@example.com", record("r-c", "org-c"));
    announce(who("b@example.com", ["org-c"]));
    expect(setups.loadSetups("a@example.com")).toEqual([]);
    expect(localStorage.getItem("terminalx.organization-setup.v1.a@example.com.name")).toBeNull();
    expect(setups.loadSetups("b@example.com")).toHaveLength(1);

    // Signing out forgets them.
    announce({ state: "signed-out", identity: null, expiresAt: null, lastError: null });
    expect(setups.loadSetups("b@example.com")).toEqual([]);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("terminalx.organization-setup"))).toEqual([]);
    expect(account.getAccount().status.state).toBe("signed-out");
  });
});

describe("who owns the local mirrors on this computer (PRO-25)", () => {
  const base = { identity: null, expiresAt: null, lastError: null } as const;

  it("is the account's own id when signed in, never the email", async () => {
    const { mirrorOwnerOf } = await import("./account");
    const signedIn = { ...base, state: "signed-in" as const, identity: { name: null, email: "ada@example.com", organization: null }, context: { scope: "s", revision: "r", account: "acc-hash-1" } };
    expect(mirrorOwnerOf(signedIn)).toBe("acc-hash-1");
    // The same person under a changed address is still the owner; another person reusing the address is not.
    expect(mirrorOwnerOf({ ...signedIn, identity: { ...signedIn.identity, email: "ada@new.example" } })).toBe("acc-hash-1");
    expect(mirrorOwnerOf({ ...signedIn, context: { scope: "s", revision: "r", account: "acc-hash-2" } })).toBe("acc-hash-2");
    // No id to go by: not known, so nothing is claimed.
    expect(mirrorOwnerOf({ ...signedIn, context: null })).toBeUndefined();
  });

  it("is nobody only for a clean signed-out, and unknown when the saved session could not be read", async () => {
    const { mirrorOwnerOf } = await import("./account");
    expect(mirrorOwnerOf({ ...base, state: "signed-out" })).toBeNull();
    // What a Keychain read failure at launch reports: signed-out, marked unreadable.
    expect(mirrorOwnerOf({ ...base, state: "signed-out", sessionUnreadable: true, lastError: "The saved TerminalX account session could not be read from macOS Keychain." })).toBeUndefined();
    // An error alone is still a real signed-out: a sign-in that timed out leaves nobody signed in.
    expect(mirrorOwnerOf({ ...base, state: "signed-out", lastError: "Sign-in timed out. Try again." })).toBeNull();
    expect(mirrorOwnerOf({ ...base, state: "signing-in" })).toBeUndefined();
  });
});
