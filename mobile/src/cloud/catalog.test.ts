import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiError } from "./api";
import { CloudCatalog } from "./catalog";
import { keyItemName } from "./keys";

const item = (id: string, fields: Record<string, unknown> = {}) => ({ workspace: { id, orgId: "org-1", name: id, provider: "box", state: "suspended", you: { role: "driver", canApprove: false }, lastActivityAt: 1, ...fields }, latestOperation: null });

function harness() {
  const secrets = new Map<string, string>();
  const blobs = new Map<string, string>();
  const api = {
    organizations: vi.fn(async () => [{ orgId: "org-1", name: "Acme", role: "member" }, { orgId: "org-2", name: "Beta", role: "admin" }]),
    workspaces: vi.fn(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-old", { lastActivityAt: 5 }), item("ws-new", { lastActivityAt: 9 })] : [], tombstones: [] as { id: string; orgId: string; deletedAt: number; expiresAt: number }[] })),
    open: vi.fn(),
    enqueue: vi.fn(),
    commandStatuses: vi.fn(async () => []),
    cancelCommand: vi.fn(),
    checkpoints: vi.fn(async () => []),
    checkpoint: vi.fn(async () => null),
  };
  const catalog = new CloudCatalog({
    api: api as never,
    secrets: { get: async (name) => secrets.get(name) ?? null, set: async (name, value) => void secrets.set(name, value), delete: async (name) => void secrets.delete(name) },
    storage: { getItem: async (name) => blobs.get(name) ?? null, setItem: async (name, value) => void blobs.set(name, value), removeItem: async (name) => void blobs.delete(name), getAllKeys: async () => [...blobs.keys()] },
    clientInstallationId: "mobile-1",
    appVersion: "0.1.0",
    now: () => 42,
  });
  /** As if this phone had connected to the workspace before. */
  const keep = (orgId: string, workspaceId: string) => {
    secrets.set(keyItemName({ organizationId: orgId, workspaceId }), "{}");
    blobs.set(`terminalx:cloud-checkpoint:${orgId}:${workspaceId}:t1`, "{}");
    blobs.set(`terminalx:cloud-outbox:${orgId}:${workspaceId}`, "{}");
    blobs.set("terminalx:cloud-held:v1", JSON.stringify([...JSON.parse(blobs.get("terminalx:cloud-held:v1") ?? "[]"), [orgId, workspaceId]]));
  };
  return { catalog, api, secrets, blobs, keep };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("the phone's cloud catalog", () => {
  it("lists each organization's workspaces, newest first, with reads only", async () => {
    const h = harness();
    await h.catalog.refresh();
    const snapshot = h.catalog.getSnapshot();
    expect(snapshot).toMatchObject({ loading: false, error: null, refreshedAt: 42 });
    expect(snapshot.organizations.map((entry) => [entry.organization.name, entry.workspaces.map((workspace) => workspace.workspace.id)])).toEqual([["Acme", ["ws-new", "ws-old"]], ["Beta", []]]);
    expect(h.catalog.workspace("org-1", "ws-new")).toMatchObject({ state: "suspended" });
    expect(h.catalog.workspace("org-2", "ws-new")).toBeNull();
    // Listing stopped workspaces asked for no attachment and queued nothing.
    expect(h.api.open).not.toHaveBeenCalled();
    expect(h.api.enqueue).not.toHaveBeenCalled();
  });

  it("opening a stopped workspace's session reads its checkpoints and wakes nothing", async () => {
    const h = harness();
    await h.catalog.refresh();
    const session = h.catalog.session("org-1", "ws-new");
    expect(h.catalog.session("org-1", "ws-new")).toBe(session);
    await vi.waitFor(() => expect(h.api.checkpoints).toHaveBeenCalledWith("org-1", "ws-new"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.getSnapshot().connection.state).toBe("suspended");
    expect(h.api.open).not.toHaveBeenCalled();
    h.catalog.release("org-1", "ws-new");
    expect(h.catalog.session("org-1", "ws-new")).not.toBe(session);
    h.catalog.close();
  });

  it("keeps what it showed for an organization whose list could not be read, and forgets nothing because of it", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.keep("org-1", "ws-new");
    h.api.workspaces.mockImplementation(async (orgId: string) => {
      if (orgId === "org-1") throw new CloudApiError("cloud_provider_unavailable", 503);
      return { workspaces: [], tombstones: [] };
    });
    await h.catalog.refresh();
    expect(h.catalog.getSnapshot().organizations[0]).toMatchObject({ error: "cloud_provider_unavailable", loaded: true });
    expect(h.catalog.getSnapshot().organizations[0].workspaces).toHaveLength(2);
    expect(h.secrets.size).toBe(1);

    h.api.organizations.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null));
    await h.catalog.refresh();
    expect(h.catalog.getSnapshot()).toMatchObject({ error: "cloud_workspace_unavailable", loading: false });
    expect(h.catalog.getSnapshot().organizations[0].workspaces).toHaveLength(2);
    expect(h.secrets.size).toBe(1);
  });

  it("removes the key, transcripts and outbox of a workspace that was deleted or is no longer shared with this person", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.keep("org-1", "ws-new");
    h.keep("org-1", "ws-old");
    // ws-new: deleted. ws-old: still listed.
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-old")] : [], tombstones: orgId === "org-1" ? [{ id: "ws-new", orgId: "org-1", deletedAt: 1, expiresAt: 2 }] : [] }));
    await h.catalog.refresh();
    expect([...h.secrets.keys()]).toEqual([keyItemName({ organizationId: "org-1", workspaceId: "ws-old" })]);
    expect([...h.blobs.keys()].filter((name) => name.includes("ws-new"))).toEqual([]);
    expect([...h.blobs.keys()].filter((name) => name.includes("ws-old"))).toHaveLength(2);
    // Access to ws-old is taken away: it just stops being listed.
    h.api.workspaces.mockImplementation(async () => ({ workspaces: [], tombstones: [] }));
    await h.catalog.refresh();
    expect(h.secrets.size).toBe(0);
    expect([...h.blobs.keys()]).toEqual(["terminalx:cloud-held:v1"]);
    expect(h.blobs.get("terminalx:cloud-held:v1")).toBe("[]");
  });

  it("removes what it keeps for an organization the account left", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.keep("org-2", "ws-x");
    h.api.organizations.mockResolvedValue([{ orgId: "org-1", name: "Acme", role: "member" }]);
    await h.catalog.refresh();
    expect(h.secrets.size).toBe(0);
    expect([...h.blobs.keys()].some((name) => name.includes("ws-x"))).toBe(false);
  });

  it("leaves nothing on the phone after sign-out", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.keep("org-1", "ws-new");
    h.catalog.session("org-1", "ws-old");
    await vi.waitFor(() => expect(h.blobs.get("terminalx:cloud-held:v1")).toContain("ws-old"));
    await h.catalog.signOut();
    expect(h.secrets.size).toBe(0);
    expect(h.blobs.size).toBe(0);
    expect(h.catalog.getSnapshot().organizations).toEqual([]);
  });

  it("keeps a workspace's session while a screen shows it and closes it when the last one leaves", async () => {
    const h = harness();
    await h.catalog.refresh();
    expect(h.catalog.opened("org-1", "ws-new")).toBeNull();
    const seen = vi.fn();
    h.catalog.subscribe(seen);
    const first = h.catalog.retain("org-1", "ws-new");
    const second = h.catalog.retain("org-1", "ws-new");
    const session = h.catalog.opened("org-1", "ws-new");
    expect(session).not.toBeNull();
    expect(seen).toHaveBeenCalled();
    first();
    first();
    expect(h.catalog.opened("org-1", "ws-new")).toBe(session);
    second();
    expect(h.catalog.opened("org-1", "ws-new")).toBeNull();
    expect(h.api.open).not.toHaveBeenCalled();
  });

  it("reads the list again when an open workspace refuses this person, and then removes what it kept", async () => {
    const h = harness();
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-new", { state: "ready" })] : [], tombstones: [] }));
    await h.catalog.refresh();
    h.keep("org-1", "ws-new");
    // The share was revoked: attaching is refused, and the list no longer has the workspace.
    h.api.open.mockRejectedValue(new CloudApiError("cloud_workspace_not_found", 404));
    h.api.workspaces.mockImplementation(async () => ({ workspaces: [], tombstones: [] }));
    const release = h.catalog.retain("org-1", "ws-new");
    await vi.waitFor(() => expect(h.catalog.workspace("org-1", "ws-new")).toBeNull());
    await vi.waitFor(() => expect(h.secrets.size).toBe(0));
    expect([...h.blobs.keys()].some((name) => name.includes("ws-new"))).toBe(false);
    release();
  });

  it("makes one read at a time", async () => {
    const h = harness();
    await Promise.all([h.catalog.refresh(), h.catalog.refresh()]);
    expect(h.api.organizations).toHaveBeenCalledTimes(1);
  });
});
