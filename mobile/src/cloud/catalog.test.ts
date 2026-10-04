import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiError } from "./api";
import { CHANGING_POLL_LIMIT_MS, CHANGING_POLL_MS, CloudCatalog } from "./catalog";
import { keyItemName } from "./keys";

const item = (id: string, fields: Record<string, unknown> = {}) => ({ workspace: { id, orgId: "org-1", name: id, provider: "box", state: "suspended", you: { role: "driver", canApprove: false }, lastActivityAt: 1, ...fields }, latestOperation: null });

const HELD = "terminalx.cloud.held.v1";

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
    secrets.set(HELD, JSON.stringify([...JSON.parse(secrets.get(HELD) ?? "[]"), [orgId, workspaceId]]));
  };
  /** The workspace keys on the phone (the list of what is held is kept beside them). */
  const keys = () => [...secrets.keys()].filter((name) => name !== HELD);
  return { catalog, api, secrets, blobs, keep, keys };
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
    expect(h.keys()).toHaveLength(1);

    h.api.organizations.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null));
    await h.catalog.refresh();
    expect(h.catalog.getSnapshot()).toMatchObject({ error: "cloud_workspace_unavailable", loading: false });
    expect(h.catalog.getSnapshot().organizations[0].workspaces).toHaveLength(2);
    expect(h.keys()).toHaveLength(1);
  });

  it("removes the key, transcripts and outbox of a workspace that was deleted or is no longer shared with this person", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.keep("org-1", "ws-new");
    h.keep("org-1", "ws-old");
    // ws-new: deleted. ws-old: still listed.
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-old")] : [], tombstones: orgId === "org-1" ? [{ id: "ws-new", orgId: "org-1", deletedAt: 1, expiresAt: 2 }] : [] }));
    await h.catalog.refresh();
    expect(h.keys()).toEqual([keyItemName({ organizationId: "org-1", workspaceId: "ws-old" })]);
    expect([...h.blobs.keys()].filter((name) => name.includes("ws-new"))).toEqual([]);
    expect([...h.blobs.keys()].filter((name) => name.includes("ws-old"))).toHaveLength(2);
    // Access to ws-old is taken away: it just stops being listed.
    h.api.workspaces.mockImplementation(async () => ({ workspaces: [], tombstones: [] }));
    await h.catalog.refresh();
    expect(h.keys()).toEqual([]);
    expect([...h.blobs.keys()]).toEqual([]);
    expect(h.secrets.get(HELD)).toBe("[]");
  });

  it("removes what it keeps for an organization the account left", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.keep("org-2", "ws-x");
    h.api.organizations.mockResolvedValue([{ orgId: "org-1", name: "Acme", role: "member" }]);
    await h.catalog.refresh();
    expect(h.keys()).toEqual([]);
    expect([...h.blobs.keys()].some((name) => name.includes("ws-x"))).toBe(false);
  });

  it("leaves nothing on the phone after sign-out", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.keep("org-1", "ws-new");
    h.catalog.session("org-1", "ws-old");
    await vi.waitFor(() => expect(h.secrets.get(HELD)).toContain("ws-old"));
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
    await vi.waitFor(() => expect(h.keys()).toEqual([]));
    expect([...h.blobs.keys()].some((name) => name.includes("ws-new"))).toBe(false);
    release();
  });

  it("removes what it keeps when a share is revoked on a workspace the organization can still see (role none)", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.keep("org-1", "ws-new");
    expect(h.catalog.access("org-1", "ws-new")).toBe("ok");
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-new", { you: { role: "none", canApprove: false } })] : [], tombstones: [] }));
    await h.catalog.refresh();
    // Still listed, but nothing of it stays here.
    expect(h.catalog.workspace("org-1", "ws-new")).not.toBeNull();
    expect(h.catalog.access("org-1", "ws-new")).toBe("not-shared");
    expect(h.keys()).toEqual([]);
    expect([...h.blobs.keys()]).toEqual([]);
  });

  it("keeps what it holds when an older server reports no member list (role none, listed false)", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.keep("org-1", "ws-new");
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-new", { you: { role: "none", canApprove: false, listed: false } })] : [], tombstones: [] }));
    await h.catalog.refresh();
    expect(h.catalog.access("org-1", "ws-new")).toBe("ok");
    expect(h.keys()).toHaveLength(1);
  });

  it("closes an open workspace at once when access ends, and tells its screen why", async () => {
    const h = harness();
    expect(h.catalog.access("org-1", "ws-new")).toBe("unknown");
    await h.catalog.refresh();
    const release = h.catalog.retain("org-1", "ws-new");
    const open = h.catalog.opened("org-1", "ws-new")!;
    await vi.waitFor(() => expect(h.secrets.get(HELD)).toContain("ws-new"));
    const seen: string[] = [];
    h.catalog.subscribe(() => seen.push(`${h.catalog.access("org-1", "ws-new")}:${h.catalog.opened("org-1", "ws-new") ? "open" : "closed"}`));

    // Access is taken away: the workspace is no longer listed for this person.
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-old")] : [], tombstones: [] }));
    await h.catalog.refresh();
    expect(h.catalog.opened("org-1", "ws-new")).toBeNull();
    expect(h.catalog.access("org-1", "ws-new")).toBe("gone");
    // The screen was told after the session was closed, not only before.
    expect(seen.at(-1)).toBe("gone:closed");
    // The closed session publishes nothing more.
    const snapshot = open.getSnapshot();
    open.listChanged();
    expect(open.getSnapshot()).toBe(snapshot);
    release();

    // A deleted one says so.
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: [], tombstones: orgId === "org-1" ? [{ id: "ws-old", orgId: "org-1", deletedAt: 1, expiresAt: 2 }] : [] }));
    await h.catalog.refresh();
    expect(h.catalog.access("org-1", "ws-old")).toBe("deleted");
  });

  it("reads the list every few seconds while an open workspace is starting, and stops when it runs", async () => {
    const h = harness();
    let state = "resuming";
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-new", { state })] : [], tombstones: [] }));
    await h.catalog.refresh();
    // Nothing is open: nothing is followed.
    await vi.advanceTimersByTimeAsync(4 * CHANGING_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(1);

    const release = h.catalog.retain("org-1", "ws-new");
    await vi.advanceTimersByTimeAsync(CHANGING_POLL_MS + 100);
    expect(h.api.organizations).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHANGING_POLL_MS + 100);
    expect(h.api.organizations).toHaveBeenCalledTimes(3);
    // Only reads: nothing was asked of the workspace while it was starting.
    expect(h.api.open).not.toHaveBeenCalled();

    state = "suspended";
    await vi.advanceTimersByTimeAsync(CHANGING_POLL_MS + 100);
    const settled = h.api.organizations.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20 * CHANGING_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(settled);
    release();
  });

  it("stops following a workspace that never settles, and follows nothing in the background", async () => {
    const h = harness();
    let clock = 0;
    (h.catalog as unknown as { options: { now: () => number } }).options.now = () => clock;
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-new", { state: "resuming" })] : [], tombstones: [] }));
    await h.catalog.refresh();
    const release = h.catalog.retain("org-1", "ws-new");
    await vi.advanceTimersByTimeAsync(CHANGING_POLL_MS + 100);
    const following = h.api.organizations.mock.calls.length;
    expect(following).toBeGreaterThan(1);

    h.catalog.pause();
    await vi.advanceTimersByTimeAsync(20 * CHANGING_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(following);
    h.catalog.resume();
    await vi.advanceTimersByTimeAsync(CHANGING_POLL_MS + 100);
    expect(h.api.organizations.mock.calls.length).toBeGreaterThan(following);

    clock = CHANGING_POLL_LIMIT_MS + 1;
    await vi.advanceTimersByTimeAsync(2 * CHANGING_POLL_MS);
    const stopped = h.api.organizations.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20 * CHANGING_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(stopped);
    release();
  });

  it("says whether the list it has is fresh", async () => {
    const h = harness();
    expect(await h.catalog.fresh("org-1")).toBe(true);
    h.api.workspaces.mockRejectedValue(new CloudApiError("cloud_provider_unavailable", 503));
    expect(await h.catalog.fresh("org-1")).toBe(false);
    expect(await h.catalog.fresh("org-9")).toBe(false);
  });

  it("does not lose a workspace from the held list when two are opened at once", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.catalog.session("org-1", "ws-new");
    h.catalog.session("org-1", "ws-old");
    await vi.waitFor(() => expect(JSON.parse(h.secrets.get(HELD) ?? "[]")).toEqual([["org-1", "ws-new"], ["org-1", "ws-old"]]));
    h.catalog.close();
  });

  it("does not connect a workspace opened while the app is in the background, until it is back", async () => {
    const h = harness();
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-new", { state: "ready" })] : [], tombstones: [] }));
    await h.catalog.refresh();
    h.api.open.mockRejectedValue(new CloudApiError("cloud_workspace_not_found", 404));
    h.catalog.pause();
    const release = h.catalog.retain("org-1", "ws-new");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.api.open).not.toHaveBeenCalled();
    h.catalog.resume();
    await vi.waitFor(() => expect(h.api.open).toHaveBeenCalledTimes(1));
    release();
  });

  it("makes one read at a time", async () => {
    const h = harness();
    await Promise.all([h.catalog.refresh(), h.catalog.refresh()]);
    expect(h.api.organizations).toHaveBeenCalledTimes(1);
  });
});
