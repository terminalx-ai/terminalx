import { describe, expect, it, vi } from "vitest";
import { CloudApiError, type CloudCredential, type CloudOrganization, type CloudProvider } from "./api";
import { CloudSetupStore, connectedCompute, FIX_KEY, setupStoreFor, setupView, signedInAgents, stepsDoneLabel, type OrganizationSetup, type SetupRead } from "./setup";

// PRO-527: an organization's four setup steps, from what the server lists for it (25.01).

const owner: CloudOrganization = { orgId: "org-p", name: "Personal (alex@example.com)", role: "owner", isPersonal: true };
const member: CloudOrganization = { orgId: "org-n", name: "Northwind", role: "member" };

const provider = (displayName: string, fields: { availability?: string; state?: string | null; source?: "organization" | "platform" } = {}): CloudProvider => ({
  id: displayName.toLowerCase(), displayName, availability: fields.availability ?? "available", canManage: true,
  ...(fields.state === null ? {} : { connection: { state: fields.state ?? "connected", connectedAt: 1 } }),
  descriptor: { label: displayName, credentialSource: fields.source ?? "organization" },
} as unknown as CloudProvider);
const offered = (displayName: string) => provider(displayName, { availability: "not-connected", state: null });
const login = (name: string, state = "connected"): CloudCredential => ({ id: `c-${name}`, provider: name, state } as unknown as CloudCredential);

const ok = <T,>(value: T): SetupRead<T> => ({ value, error: null, unreachable: false, refused: false });
const failed = <T,>(fields: Partial<SetupRead<T>> = {}): SetupRead<T> => ({ value: null, error: "cloud_workspace_invalid_response", unreachable: false, refused: false, ...fields });
const setup = (providers: SetupRead<CloudProvider[]>, logins: SetupRead<CloudCredential[]>): OrganizationSetup => ({ providers, logins, read: true });
const states = (view: ReturnType<typeof setupView>) => view.steps.map((step) => step.state);
const opens = (view: ReturnType<typeof setupView>) => view.steps.map((step) => step.opens);

describe("the setup steps", () => {
  it("offers only the first step until an organization was chosen, naming the one that exists", () => {
    const view = setupView(owner, false, undefined);
    expect(states(view)).toEqual(["next", "waiting", "waiting", "waiting"]);
    expect(opens(view)).toEqual([true, false, false, false]);
    expect(view.steps[0]!.detail).toBe("Workspaces belong to an organization. Yours is Personal (alex@example.com).");
    expect(view.steps.slice(1).map((step) => step.detail)).toEqual(["The provider account your workspaces run on.", "What Codex, Claude Code and Cursor sign in with there.", "Pick a size, see the price, start working."]);
    expect(view.action).toEqual({ step: "organization", label: "Start setup" });
    expect(setupView(null, false, undefined).steps[0]!.detail).toBe("Workspaces belong to an organization.");
  });

  it("says nothing of a step before its list was read", () => {
    const view = setupView(owner, true, undefined);
    expect(states(view)).toEqual(["done", "waiting", "waiting", "waiting"]);
    expect(view.action).toBeNull();
    expect(view.unread).toBe(false);
  });

  it("carries on with the first step that is missing, and names what the finished ones hold", () => {
    const nothing = setupView(owner, true, setup(ok([offered("Boat"), offered("Agent37")]), ok([])));
    expect(states(nothing)).toEqual(["done", "next", "waiting", "waiting"]);
    expect(nothing.steps[0]!.detail).toBe("Personal (alex@example.com)");
    expect(nothing.action).toEqual({ step: "compute", label: "Continue: connect compute" });
    expect(stepsDoneLabel(nothing)).toBe("1 of 4 steps done");

    const halfWay = setupView(owner, true, setup(ok([provider("Boat"), offered("Agent37")]), ok([login("github")])));
    expect(states(halfWay)).toEqual(["done", "done", "next", "waiting"]);
    expect(halfWay.steps[1]!.detail).toBe("Boat · connected");
    expect(opens(halfWay)).toEqual([true, true, true, false]);
    expect(halfWay.action).toEqual({ step: "agents", label: "Continue: sign your agents in" });
    expect(halfWay.canLaunch).toBe(false);
    expect(stepsDoneLabel(halfWay)).toBe("2 of 4 steps done");

    const ready = setupView(owner, true, setup(ok([provider("Boat")]), ok([login("claude"), login("codex"), login("cursor", "revoked")])));
    expect(states(ready)).toEqual(["done", "done", "done", "next"]);
    expect(ready.steps[2]!.detail).toBe("Codex, Claude Code · connected");
    expect(ready.action).toEqual({ step: "launch", label: "Launch a workspace" });
    expect(ready.canLaunch).toBe(true);
  });

  it("does not count compute that TerminalX holds the key for as the organization's own", () => {
    const view = setupView(owner, true, setup(ok([provider("TerminalX Cloud", { source: "platform" }), offered("Boat")]), ok([login("codex")])));
    expect(states(view)).toEqual(["done", "next", "done", "waiting"]);
    expect(view.canLaunch).toBe(false);
    expect(connectedCompute([provider("TerminalX Cloud", { source: "platform" })])).toEqual({ connected: [], attention: [] });
  });

  it("turns the compute step red when the provider rejected the stored key, and sends the button to it", () => {
    const view = setupView(owner, true, setup(ok([provider("Boat", { availability: "attention-required", state: "attention-required" })]), ok([login("codex")])));
    expect(states(view)).toEqual(["done", "failed", "done", "waiting"]);
    expect(view.steps[1]).toMatchObject({ detail: "Boat rejected the stored key on its last check.", alert: true, opens: true });
    expect(view.steps[3]!.detail).toBe("Waits for compute.");
    expect(view.action).toEqual({ step: "compute", label: FIX_KEY });
    // Another provider that works is compute enough: the broken key is seen on the compute page.
    const other = setupView(owner, true, setup(ok([provider("Boat", { availability: "attention-required" }), provider("Agent37")]), ok([])));
    expect(states(other)).toEqual(["done", "done", "next", "waiting"]);
    expect(other.steps[1]!.detail).toBe("Agent37 · connected");
  });

  it("shows a list that did not answer as unread, never as done or missing", () => {
    const view = setupView(owner, true, setup(failed(), failed()));
    expect(states(view)).toEqual(["done", "failed", "failed", "waiting"]);
    expect(view.steps[1]).toMatchObject({ detail: "Could not be read. Pull down to try again.", alert: true, opens: false });
    expect(view.steps[2]).toMatchObject({ detail: "Could not be read. Pull down to try again.", alert: true, opens: false });
    expect(view.action).toBeNull();
    expect(view.unread).toBe(true);
    // One list read, the other not: the read one still says where it is.
    const partly = setupView(owner, true, setup(ok([offered("Boat")]), failed()));
    expect(states(partly)).toEqual(["done", "next", "failed", "waiting"]);
    expect(partly.action).toEqual({ step: "compute", label: "Continue: connect compute" });
  });

  it("keeps what was read before while the service cannot be reached, and says it may be out of date", () => {
    const view = setupView(owner, true, setup({ value: [provider("Boat")], error: "cloud_workspace_unavailable", unreachable: true, refused: false }, ok([])));
    expect(states(view)).toEqual(["done", "done", "next", "waiting"]);
    expect(view.stale).toBe(true);
    expect(view.unread).toBe(false);
  });

  it("gives a member no way into compute or agent logins, and the launch once compute is connected", () => {
    const none = setupView(member, true, setup(ok([offered("Boat")]), failed({ error: "organization_admin_required", refused: true })));
    expect(none.noCompute).toBe(true);
    expect(states(none)).toEqual(["done", "waiting", "waiting", "waiting"]);
    expect(opens(none)).toEqual([true, false, false, false]);
    expect(none.action).toBeNull();
    expect(none.unread).toBe(false);

    const connected = setupView(member, true, setup(ok([provider("Boat")]), failed({ error: "organization_admin_required", refused: true })));
    expect(connected.noCompute).toBe(false);
    expect(states(connected)).toEqual(["done", "done", "waiting", "next"]);
    expect(opens(connected)).toEqual([true, false, false, true]);
    expect(connected.action).toEqual({ step: "launch", label: "Launch a workspace" });
    expect(connected.canLaunch).toBe(true);

    // An owner being refused the logins is a failure to read them, not a rule.
    expect(states(setupView(owner, true, setup(ok([provider("Boat")]), failed({ refused: true }))))).toEqual(["done", "done", "failed", "waiting"]);
    // A key that needs attention is its admins' to fix: a member gets no button for it.
    expect(setupView(member, true, setup(ok([provider("Boat", { availability: "attention-required" })]), ok([]))).action).toBeNull();
  });

  it("names the agents in the steps' order, and only those with a working login", () => {
    expect(signedInAgents([login("cursor"), login("github"), login("claude", "sign-in-required"), login("codex")])).toEqual(["Codex", "Cursor"]);
    expect(signedInAgents([login("github")])).toEqual([]);
  });
});

describe("the setup store", () => {
  const world = () => {
    const api = { providers: vi.fn(async (_orgId: string) => [provider("Boat")]), credentials: vi.fn(async (_orgId: string) => [login("codex")]) };
    return { api, store: new CloudSetupStore(api) };
  };

  it("reads an organization's providers and agent logins, and tells whoever is listening", async () => {
    const { api, store } = world();
    const heard = vi.fn();
    store.subscribe(heard);
    expect(store.getSnapshot().get("org-p")).toBeUndefined();
    await store.read("org-p");
    expect(api.providers).toHaveBeenCalledExactlyOnceWith("org-p");
    expect(api.credentials).toHaveBeenCalledExactlyOnceWith("org-p");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().get("org-p")).toMatchObject({ read: true, providers: { error: null }, logins: { error: null } });
    expect(store.getSnapshot().get("org-n")).toBeUndefined();
  });

  it("joins a read already on its way instead of asking twice", async () => {
    const { api, store } = world();
    await Promise.all([store.read("org-p"), store.read("org-p")]);
    expect(api.providers).toHaveBeenCalledTimes(1);
    await store.read("org-p");
    expect(api.providers).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer while the service cannot be reached, and drops it when the service says no", async () => {
    const { api, store } = world();
    await store.read("org-p");
    api.providers.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null, "network"));
    api.credentials.mockRejectedValueOnce(new CloudApiError("organization_admin_required", 403));
    await store.read("org-p");
    const kept = store.getSnapshot().get("org-p")!;
    expect(kept.providers).toMatchObject({ error: "cloud_workspace_unavailable", unreachable: true, refused: false });
    expect(kept.providers.value).toHaveLength(1);
    expect(kept.logins).toEqual({ value: null, error: "organization_admin_required", unreachable: false, refused: true });
    // Something that is not the service's error at all is no answer either.
    api.providers.mockRejectedValueOnce(new Error("boom"));
    await store.read("org-p");
    expect(store.getSnapshot().get("org-p")!.providers).toMatchObject({ unreachable: true, error: "cloud_workspace_unavailable" });
  });

  it("is one store for a signed-in account's catalog", () => {
    const { api } = world();
    const catalog = { api };
    expect(setupStoreFor(catalog)).toBe(setupStoreFor(catalog));
    expect(setupStoreFor({ api })).not.toBe(setupStoreFor(catalog));
  });
});
