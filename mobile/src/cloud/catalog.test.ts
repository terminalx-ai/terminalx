import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiError, SUPPORTED_PROVIDERS } from "./api";
import { CHANGING_POLL_LIMIT_MS, CHANGING_POLL_MS, CloudCatalog, SAVED_LIST, WATCH_POLL_MS, workspaceTitle } from "./catalog";
import { keyItemName } from "./keys";
import { cloudSections, emptyOrganizationsLabel } from "./list";

const item = (id: string, fields: Record<string, unknown> = {}) => ({ workspace: { id, orgId: "org-1", name: id, provider: "box", state: "suspended", you: { role: "driver", canApprove: false }, lastActivityAt: 1, ...fields }, latestOperation: null });

const HELD = "terminalx.cloud.held.v1";
const TITLES = "terminalx.cloud.titles.v1";

/** A phone's storage, kept across runs of the app when passed to the next harness. */
function harness(phone: { secrets?: Map<string, string>; blobs?: Map<string, string> } = {}) {
  const secrets = phone.secrets ?? new Map<string, string>();
  const blobs = phone.blobs ?? new Map<string, string>();
  const api = {
    organizations: vi.fn(async () => [{ orgId: "org-1", name: "Acme", role: "member" }, { orgId: "org-2", name: "Beta", role: "admin" }]),
    workspaces: vi.fn(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-old", { lastActivityAt: 5 }), item("ws-new", { lastActivityAt: 9 })] : [], tombstones: [] as { id: string; orgId: string; deletedAt: number; expiresAt: number }[] })),
    open: vi.fn(),
    enqueue: vi.fn(),
    commandStatuses: vi.fn(async () => []),
    cancelCommand: vi.fn(),
    checkpoints: vi.fn(async () => []),
    checkpoint: vi.fn(async () => null),
    resume: vi.fn(async (orgId: string, workspaceId: string) => ({ workspace: { ...item(workspaceId).workspace, orgId, state: "resuming" }, operation: { id: "op-1", state: "queued", action: "resume" } })),
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
  /** The workspace keys on the phone (the list of what is held, and the titles, are kept beside them). */
  const keys = () => [...secrets.keys()].filter((name) => name !== HELD && name !== TITLES);
  /** What is kept for workspaces in plain storage: the last list read is not one workspace's. */
  const kept = () => [...blobs.keys()].filter((name) => name !== SAVED_LIST);
  return { catalog, api, secrets, blobs, keep, keys, kept };
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

  it("lists an unfamiliar provider under its organization and opens its running workspace", async () => {
    const h = harness();
    const workspace = item("ws-new-provider", { provider: "new-compute", state: "ready" });
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [workspace] : [], tombstones: [] }));
    h.api.open.mockResolvedValue({ id: "a1", workspaceId: "ws-new-provider", state: "waiting-for-runtime", authority: "participate", expiresAt: Date.now() + 60_000 });

    await h.catalog.refresh();
    const { sections } = cloudSections(h.catalog.getSnapshot().organizations);
    expect(sections).toEqual([{ key: "org-1", title: "Acme", error: null, data: [workspace] }]);
    expect(h.api.open).not.toHaveBeenCalled();

    const listed = sections[0].data[0].workspace;
    const release = h.catalog.retain(listed.orgId, listed.id);
    try {
      await vi.waitFor(() => expect(h.api.open).toHaveBeenCalledWith("org-1", "ws-new-provider", "mobile-1", expect.anything()));
    } finally {
      release();
      h.catalog.close();
    }
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
    expect(h.kept().filter((name) => name.includes("ws-new"))).toEqual([]);
    expect(h.kept().filter((name) => name.includes("ws-old"))).toHaveLength(2);
    // Access to ws-old is taken away: it just stops being listed.
    h.api.workspaces.mockImplementation(async () => ({ workspaces: [], tombstones: [] }));
    await h.catalog.refresh();
    expect(h.keys()).toEqual([]);
    expect(h.kept()).toEqual([]);
    expect(h.secrets.get(HELD)).toBe("[]");
  });

  it("removes what it keeps for an organization the account left", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.keep("org-2", "ws-x");
    h.api.organizations.mockResolvedValue([{ orgId: "org-1", name: "Acme", role: "member" }]);
    await h.catalog.refresh();
    expect(h.keys()).toEqual([]);
    expect(h.kept().some((name) => name.includes("ws-x"))).toBe(false);
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
    expect(h.kept().some((name) => name.includes("ws-new"))).toBe(false);
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
    expect(h.kept()).toEqual([]);
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
    const unwatch = h.catalog.watch();
    await vi.advanceTimersByTimeAsync(CHANGING_POLL_MS + 100);
    expect(h.api.organizations).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHANGING_POLL_MS + 100);
    expect(h.api.organizations).toHaveBeenCalledTimes(3);
    // Only reads: nothing was asked of the workspace while it was starting.
    expect(h.api.open).not.toHaveBeenCalled();

    state = "suspended";
    await vi.advanceTimersByTimeAsync(CHANGING_POLL_MS + 100);
    const settled = h.api.organizations.mock.calls.length;
    // Settled: only the occasional read of a workspace on the screen.
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS - 1_000);
    expect(h.api.organizations).toHaveBeenCalledTimes(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.api.organizations).toHaveBeenCalledTimes(settled + 1);
    release();
    unwatch();
    await vi.advanceTimersByTimeAsync(4 * WATCH_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(settled + 1);
  });

  it("notices an open stopped workspace that someone else started, within one read, and connects", async () => {
    const h = harness();
    let state = "suspended";
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-new", { state })] : [], tombstones: [] }));
    h.api.open.mockRejectedValue(new CloudApiError("cloud_workspace_not_found", 404));
    await h.catalog.refresh();
    const release = h.catalog.retain("org-1", "ws-new");
    const unwatch = h.catalog.watch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.catalog.opened("org-1", "ws-new")?.getSnapshot().connection.state).toBe("suspended");
    expect(h.api.open).not.toHaveBeenCalled();

    // Resumed from someone's desktop: nothing on this phone asked for it, and nothing on it is changing.
    state = "ready";
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS + 100);
    expect(h.catalog.workspace("org-1", "ws-new")).toMatchObject({ state: "ready" });
    await vi.waitFor(() => expect(h.api.open).toHaveBeenCalled());
    release();
    unwatch();
    // Off the screen: nothing is read any more.
    const reads = h.api.organizations.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4 * WATCH_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(reads);
  });

  it("does not read now and then for an open workspace with another screen in front of it", async () => {
    const h = harness();
    await h.catalog.refresh();
    const release = h.catalog.retain("org-1", "ws-new");
    const unwatch = h.catalog.watch();
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS + 100);
    expect(h.api.organizations).toHaveBeenCalledTimes(2);
    // Sharing is pushed over the workspace: it stays open, and the list is not read for it.
    unwatch();
    await vi.advanceTimersByTimeAsync(4 * WATCH_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(2);
    expect(h.catalog.opened("org-1", "ws-new")).not.toBeNull();
    release();
  });

  it("keeps reading now and then after a read that failed", async () => {
    const h = harness();
    await h.catalog.refresh();
    const unwatch = h.catalog.watch();
    h.api.organizations.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null));
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS + 100);
    expect(h.api.organizations).toHaveBeenCalledTimes(2);
    expect(h.catalog.getSnapshot().error).toBe("cloud_workspace_unavailable");
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(3);
    expect(h.catalog.getSnapshot().error).toBeNull();
    unwatch();
  });

  it("reads the list now and then while the list is on the screen, and not after", async () => {
    const h = harness();
    await h.catalog.refresh();
    await vi.advanceTimersByTimeAsync(4 * WATCH_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(1);
    const stop = h.catalog.watch();
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS + 100);
    expect(h.api.organizations).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(3);
    h.catalog.pause();
    await vi.advanceTimersByTimeAsync(4 * WATCH_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(3);
    h.catalog.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.api.organizations).toHaveBeenCalledTimes(4);
    stop();
    stop();
    await vi.advanceTimersByTimeAsync(4 * WATCH_POLL_MS);
    expect(h.api.organizations).toHaveBeenCalledTimes(4);
  });

  it("stops following a workspace that never settles, and follows nothing in the background", async () => {
    const h = harness();
    let clock = 0;
    (h.catalog as unknown as { options: { now: () => number } }).options.now = () => clock;
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-new", { state: "resuming" })] : [], tombstones: [] }));
    await h.catalog.refresh();
    const release = h.catalog.retain("org-1", "ws-new");
    const unwatch = h.catalog.watch();
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
    // Only the occasional read of a workspace on the screen is left.
    await vi.advanceTimersByTimeAsync(4 * WATCH_POLL_MS - 100);
    expect(h.api.organizations.mock.calls.length - stopped).toBeLessThanOrEqual(4);
    release();
    unwatch();
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

describe("what the phone keeps of the list between runs (#988)", () => {
  it("shows the last list at once next time, and opens nothing by it until the list is read again", async () => {
    const first = harness();
    await first.catalog.refresh();
    const saved = JSON.parse(first.blobs.get(SAVED_LIST)!);
    expect(saved.organizations.map((entry: { organization: { name: string } }) => entry.organization.name)).toEqual(["Acme", "Beta"]);

    // The next run: the list is read again, slowly.
    const next = harness({ secrets: first.secrets, blobs: first.blobs });
    let answer: (value: unknown) => void = () => undefined;
    next.api.organizations.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve as never; }));
    const reading = next.catalog.refresh();
    await next.catalog.restored;
    const shown = next.catalog.getSnapshot();
    expect(shown).toMatchObject({ saved: true, refreshedAt: null });
    expect(shown.organizations[0].workspaces.map((entry) => entry.workspace.id)).toEqual(["ws-new", "ws-old"]);
    // Shown, but who may open it is not known yet.
    expect(next.catalog.access("org-1", "ws-new")).toBe("unknown");
    answer([{ orgId: "org-1", name: "Acme", role: "member" }]);
    await reading;
    expect(next.catalog.getSnapshot()).toMatchObject({ saved: false, refreshedAt: 42 });
    expect(next.catalog.access("org-1", "ws-new")).toBe("ok");
    // The organization the account left is gone from what is kept, too.
    expect(JSON.parse(next.blobs.get(SAVED_LIST)!).organizations).toHaveLength(1);
  });

  it("does not put an old list over one already read, and keeps none it cannot read", async () => {
    const blobs = new Map([[SAVED_LIST, JSON.stringify({ v: 1, providers: SUPPORTED_PROVIDERS, organizations: [{ organization: { orgId: "org-9", name: "Old", role: "member" }, workspaces: [] }] })]]);
    const h = harness({ blobs });
    await h.catalog.refresh();
    await h.catalog.restored;
    expect(h.catalog.getSnapshot().organizations.map((entry) => entry.organization.name)).toEqual(["Acme", "Beta"]);
    const broken = harness({ blobs: new Map([[SAVED_LIST, "{not json"]]) });
    await broken.catalog.restored;
    expect(broken.catalog.getSnapshot()).toMatchObject({ saved: false, organizations: [] });
  });

  describe("an organization with a workspace from a provider the old build did not ask for (PRO-456)", () => {
    const AGENT37 = { orgId: "org-37", name: "Agent37 Demo", role: "owner" };
    const others = Array.from({ length: 10 }, (_, index) => ({ orgId: `org-e${index}`, name: `Empty ${index}`, role: "member" }));
    const workspace = (state: string) => ({
      workspace: { id: "ws-37", orgId: "org-37", name: "Check the latest commits of this", provider: "agent37", state, accessMode: "private", you: { role: "manager", canApprove: true }, lastActivityAt: 7, repositories: [{ fullName: "Cassini-Research/landing-page", primary: true }], launch: { workBranch: "terminalx/check-the-latest-commits" } },
      latestOperation: null,
    });
    /** The list the reporter's phone kept: written before `described` was asked for, Agent37 Demo among the empty ones. */
    const keptByOldBuild = () => new Map([[SAVED_LIST, JSON.stringify({ v: 1, organizations: [AGENT37, ...others].map((organization) => ({ organization, workspaces: [] })) })]]);
    const answering = (h: ReturnType<typeof harness>, state: () => string) => {
      h.api.organizations.mockImplementation(async () => [AGENT37, ...others]);
      h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-37" ? [workspace(state())] : [], tombstones: [] }));
    };

    it("does not show the old build's list, and lists the workspace once under its organization after the refresh", async () => {
      const h = harness({ blobs: keptByOldBuild() });
      await h.catalog.restored;
      // A list read for fewer providers says nothing about the others': it is not shown as "no workspaces".
      expect(h.catalog.getSnapshot()).toMatchObject({ saved: false, organizations: [] });
      expect(cloudSections(h.catalog.getSnapshot().organizations).empty).toEqual([]);

      answering(h, () => "suspended");
      await h.catalog.refresh();
      const { sections, empty } = cloudSections(h.catalog.getSnapshot().organizations);
      expect(sections).toEqual([{ key: "org-37", title: "Agent37 Demo", error: null, data: [workspace("suspended")] }]);
      expect(empty.map((organization) => organization.orgId)).not.toContain("org-37");
      expect(emptyOrganizationsLabel(empty.length)).toBe("10 organizations with no workspaces");
      expect(h.catalog.access("org-37", "ws-37")).toBe("ok");
      // What it keeps now is this list, for the providers it asked for.
      const kept = JSON.parse(h.blobs.get(SAVED_LIST)!);
      expect(kept.providers).toBe(SUPPORTED_PROVIDERS);
      expect(kept.organizations.find((entry: { organization: { orgId: string } }) => entry.organization.orgId === "org-37").workspaces).toHaveLength(1);
      h.catalog.close();
    });

    it("reports the workspace's state as it changes, and listing or opening it changes no lifecycle", async () => {
      const h = harness();
      let state = "suspended";
      answering(h, () => state);
      await h.catalog.refresh();
      expect(h.catalog.workspace("org-37", "ws-37")).toMatchObject({ state: "suspended" });
      // The stopped detail: its session reads checkpoints and asks for no attachment.
      const release = h.catalog.retain("org-37", "ws-37");
      await vi.waitFor(() => expect(h.api.checkpoints).toHaveBeenCalledWith("org-37", "ws-37"));
      await h.catalog.refresh();
      expect(h.api.open).not.toHaveBeenCalled();

      // Started from elsewhere: the next read says so, and the open screen connects to this workspace.
      state = "ready";
      h.api.open.mockResolvedValue({ id: "a1", workspaceId: "ws-37", state: "waiting-for-runtime", authority: "participate", expiresAt: Date.now() + 60_000 });
      await h.catalog.refresh();
      expect(h.catalog.workspace("org-37", "ws-37")).toMatchObject({ state: "ready" });
      expect(cloudSections(h.catalog.getSnapshot().organizations).sections[0].data[0].workspace.state).toBe("ready");
      await vi.waitFor(() => expect(h.api.open).toHaveBeenCalledWith("org-37", "ws-37", "mobile-1", expect.anything()));
      // Nothing here asked the server to start, stop or queue anything.
      expect(h.api.resume).not.toHaveBeenCalled();
      expect(h.api.enqueue).not.toHaveBeenCalled();
      release();
      h.catalog.close();
    });
  });

  it("keeps an organization never read as not read, not as one with no workspaces, and recovers on the next read", async () => {
    const first = harness();
    first.api.workspaces.mockImplementation(async (orgId: string) => {
      if (orgId === "org-2") throw new CloudApiError("cloud_workspace_unavailable", 503);
      return { workspaces: [item("ws-new")], tombstones: [] };
    });
    await first.catalog.refresh();
    // This run: shown as a section that could not be read, with a reason, not in the footer.
    const live = cloudSections(first.catalog.getSnapshot().organizations);
    expect(live.sections.map((section) => [section.key, section.error])).toEqual([["org-1", null], ["org-2", "cloud_workspace_unavailable"]]);
    expect(live.empty).toEqual([]);

    // The next cold launch shows the same, before the list is read again.
    const next = harness({ secrets: first.secrets, blobs: first.blobs });
    let answer: (value: unknown) => void = () => undefined;
    next.api.organizations.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve as never; }));
    const reading = next.catalog.refresh();
    await next.catalog.restored;
    const restored = cloudSections(next.catalog.getSnapshot().organizations);
    expect(restored.sections.map((section) => [section.key, section.error])).toEqual([["org-1", null], ["org-2", "cloud_workspace_unavailable"]]);
    expect(restored.empty).toEqual([]);

    // A read that succeeds: org-2 has a workspace now, and an organization truly empty goes to the footer.
    next.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-2" ? [item("ws-b", { orgId: "org-2" })] : [], tombstones: [] }));
    answer([{ orgId: "org-1", name: "Acme", role: "member" }, { orgId: "org-2", name: "Beta", role: "admin" }]);
    await reading;
    const read = cloudSections(next.catalog.getSnapshot().organizations);
    expect(read.sections.map((section) => [section.key, section.error, section.data.map((entry) => entry.workspace.id)])).toEqual([["org-2", null, ["ws-b"]]]);
    expect(read.empty.map((organization) => organization.orgId)).toEqual(["org-1"]);
    next.catalog.close();
  });

  it("keeps a read organization's list when a later read fails, and its truly empty organizations in the footer", async () => {
    const first = harness();
    await first.catalog.refresh();
    first.api.workspaces.mockRejectedValue(new CloudApiError("cloud_workspace_unavailable", null));
    await first.catalog.refresh();
    const next = harness({ secrets: first.secrets, blobs: first.blobs });
    await next.catalog.restored;
    const restored = cloudSections(next.catalog.getSnapshot().organizations);
    expect(restored.sections.map((section) => [section.key, section.error, section.data.length])).toEqual([["org-1", null, 2]]);
    expect(restored.empty.map((organization) => organization.orgId)).toEqual(["org-2"]);
    next.catalog.close();
  });

  it("learns a workspace's generated title from its agent tab, keeps it beside the keys, and forgets it with the workspace", async () => {
    const h = harness();
    await h.catalog.refresh();
    const session = h.catalog.session("org-1", "ws-new");
    vi.spyOn(session, "getSnapshot").mockReturnValue({ ...session.getSnapshot(), tabs: [{ tabId: "t1", sessionId: "s1", title: "Checkout redesign", status: "idle", source: "checkpoint", pendingPermissions: [], events: [], truncated: false, noKey: false, continuous: false }] });
    session.listChanged();
    expect(workspaceTitle(h.catalog.getSnapshot(), h.catalog.workspace("org-1", "ws-new")!)).toBe("Checkout redesign");
    expect(workspaceTitle(h.catalog.getSnapshot(), h.catalog.workspace("org-1", "ws-old")!)).toBe("ws-old");
    await vi.waitFor(() => expect(JSON.parse(h.secrets.get(TITLES) ?? "{}")).toEqual({ "org-1/ws-new": "Checkout redesign" }));
    // It comes from the encrypted conversation: never in plain storage.
    expect([...h.blobs.values()].some((value) => value.includes("Checkout redesign"))).toBe(false);

    // The next run shows it in the list before anything is opened.
    const next = harness({ secrets: h.secrets, blobs: h.blobs });
    await next.catalog.restored;
    expect(next.catalog.getSnapshot().titles).toEqual({ "org-1/ws-new": "Checkout redesign" });

    // Access taken away: the title goes with the rest.
    next.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-old")] : [], tombstones: [] }));
    next.keep("org-1", "ws-new");
    await next.catalog.refresh();
    expect(next.catalog.getSnapshot().titles).toEqual({});
    expect(JSON.parse(next.secrets.get(TITLES)!)).toEqual({});
    h.catalog.close();
  });

  it("removes the kept list and titles when the person signs out", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.secrets.set(TITLES, JSON.stringify({ "org-1/ws-new": "Checkout redesign" }));
    await h.catalog.signOut();
    expect(h.blobs.has(SAVED_LIST)).toBe(false);
    expect(h.secrets.has(TITLES)).toBe(false);
    // And a phone signed out before it was read shows nothing kept.
    const next = harness({ secrets: h.secrets, blobs: h.blobs });
    await next.catalog.restored;
    expect(next.catalog.getSnapshot()).toMatchObject({ saved: false, organizations: [], titles: {} });
  });
});

describe("starting a stopped workspace from the phone (#988)", () => {
  it("asks the server to resume it, shows it starting at once, and follows the list until it runs", async () => {
    const h = harness();
    await h.catalog.refresh();
    const release = h.catalog.retain("org-1", "ws-new");
    const seen: string[] = [];
    h.catalog.subscribe(() => seen.push(h.catalog.workspace("org-1", "ws-new")?.state ?? "none"));
    // The server lists it as resuming once it took the request.
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-new", { state: "resuming" }), item("ws-old")] : [], tombstones: [] }));
    h.api.workspaces.mockClear();
    const starting = h.catalog.start("org-1", "ws-new");
    await starting;
    expect(h.api.resume).toHaveBeenCalledWith("org-1", "ws-new");
    // Nothing was queued to wake it: the start was asked for by itself.
    expect(h.api.enqueue).not.toHaveBeenCalled();
    // Shown starting from the server's answer, before the list was read again.
    expect(seen[0]).toBe("resuming");
    expect(h.api.workspaces).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.catalog.workspace("org-1", "ws-new")?.state).toBe("resuming");
    // Starting: the list is read every few seconds until it runs.
    h.api.workspaces.mockClear();
    await vi.advanceTimersByTimeAsync(CHANGING_POLL_MS + 10);
    expect(h.api.workspaces).toHaveBeenCalled();
    h.api.workspaces.mockImplementation(async (orgId: string) => ({ workspaces: orgId === "org-1" ? [item("ws-new", { state: "ready" }), item("ws-old")] : [], tombstones: [] }));
    h.api.open.mockRejectedValue(new CloudApiError("cloud_workspace_not_found", 404));
    await vi.advanceTimersByTimeAsync(CHANGING_POLL_MS + 10);
    expect(h.catalog.workspace("org-1", "ws-new")?.state).toBe("ready");
    // Running: the open screen connects by itself, with nothing more asked of the person.
    await vi.waitFor(() => expect(h.api.open).toHaveBeenCalledWith("org-1", "ws-new", "mobile-1", expect.anything()));
    release();
  });

  it("passes on the server's refusal for someone who may not start it", async () => {
    const h = harness();
    await h.catalog.refresh();
    h.api.resume.mockRejectedValueOnce(new CloudApiError("cloud_workspace_manager_required", 403));
    await expect(h.catalog.start("org-1", "ws-new")).rejects.toMatchObject({ code: "cloud_workspace_manager_required" });
    expect(h.catalog.workspace("org-1", "ws-new")?.state).toBe("suspended");
  });
});
