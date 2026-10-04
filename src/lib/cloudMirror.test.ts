import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (target: { orgId: string; workspaceId: string }, client: unknown) => void | (() => void);

const mocks = vi.hoisted(() => ({
  api: {
    cloudMirrorStatus: vi.fn(),
    cloudMirrorEnable: vi.fn(),
    cloudMirrorDisable: vi.fn(),
    cloudMirrorCheck: vi.fn(),
    cloudMirrorPlan: vi.fn(),
    cloudMirrorStage: vi.fn(),
    cloudMirrorPublish: vi.fn(),
    cloudMirrorResolve: vi.fn(),
    cloudMirrorList: vi.fn(),
    cloudMirrorPurge: vi.fn(),
    cloudMirrorClaimOwner: vi.fn(),
  },
  listeners: new Set<Listener>(),
  connected: new Map<string, unknown>(),
  retain: vi.fn(),
  wake: vi.fn(),
  readMirrorManifest: vi.fn(),
  readRemoteFile: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("@/lib/cloudConnections", () => ({
  onCloudConnected: (listener: Listener) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
  connectedCloudClient: (key: string) => mocks.connected.get(key) ?? null,
  // Present so that a call would be seen: the mirror must never make one.
  retainCloudConnection: mocks.retain,
  wakeCloudConnection: mocks.wake,
}));
vi.mock("@terminalx/portable/workspaceMirror", () => ({ readMirrorManifest: mocks.readMirrorManifest }));
vi.mock("@terminalx/portable/workspaceFiles", () => ({ readRemoteFile: mocks.readRemoteFile }));

const mirror = await import("@/lib/cloudMirror");

const target = { orgId: "org-1", workspaceId: "ws-1" };
const KEY = "cloud:org-1:ws-1";
const ROOT = "/Users/someone/.raccoon/cloud-mirrors/org-1/ws-1/files";

/** Everything sent to the workspace in a test, to check what leaves this computer. */
let sent: unknown[] = [];
const client = (capabilities = ["fs/1", "mirror/1"]) => ({ hasCapability: (capability: string) => capabilities.includes(capability) });

const revision = (manifestId: string) => ({ manifestId, atMs: 1, files: 2, bytes: 6, repositories: [{ repo: ".", branch: "main", head: "a".repeat(40) }] });
const status = (enabled: boolean, manifestId: string | null = null) => ({ enabled, root: ROOT, revision: manifestId ? revision(manifestId) : null, files: manifestId ? 2 : 0 });
const manifest = (manifestId: string, paths: string[]) => ({
  manifestId,
  repositories: [{ repo: ".", branch: "main", head: "a".repeat(40) }],
  entries: paths.map((path) => ({ path, size: 3, version: `${manifestId}-${path}`, executable: false })),
  totalBytes: paths.length * 3,
  skipped: { secret: 1, toolConfig: 0, gitDirectory: 0, excluded: 0, symlink: 0, unsupported: 0, tooLarge: 0 },
  truncated: false,
});
const refused = { secret: 0, toolConfig: 0, gitDirectory: 0, collision: 0, tooLong: 0, invalid: 0, onDisk: 0 };
const plan = (fetch: string[], patch: Record<string, unknown> = {}) => ({ fetch, fetchBytes: fetch.length * 3, remove: 0, unchanged: 0, diverged: [], divergedTotal: 0, refused, upToDate: false, ...patch });

/** A workspace connects because someone opened it. Returns its disconnect. */
function connect(rpc: unknown = client()): () => void {
  mocks.connected.set(KEY, rpc);
  const cleanups = [...mocks.listeners].map((listener) => listener(target, rpc));
  return () => {
    mocks.connected.delete(KEY);
    for (const cleanup of cleanups) cleanup?.();
  };
}

const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};

beforeEach(async () => {
  vi.useFakeTimers();
  sent = [];
  for (const mock of Object.values(mocks.api)) mock.mockReset();
  mocks.readMirrorManifest.mockReset();
  mocks.readRemoteFile.mockReset();
  mocks.retain.mockReset();
  mocks.wake.mockReset();
  mocks.connected.clear();
  mocks.readMirrorManifest.mockImplementation(async () => {
    sent.push({ method: "mirror.manifest" });
    return manifest("m1", ["a.ts", "b.ts"]);
  });
  mocks.readRemoteFile.mockImplementation(async (_client: unknown, path: string) => {
    sent.push({ method: "fs.read", path });
    return { path, etag: `etag-${path}`, bytes: new Uint8Array([1, 2, 3]) };
  });
  mocks.api.cloudMirrorPlan.mockResolvedValue(plan(["a.ts", "b.ts"]));
  mocks.api.cloudMirrorStage.mockResolvedValue(undefined);
  mocks.api.cloudMirrorPublish.mockResolvedValue({ status: status(true, "m1"), diverged: [], divergedTotal: 0, written: 2, removed: 0, takenBack: 0 });
  mocks.api.cloudMirrorCheck.mockResolvedValue({ diverged: [], divergedTotal: 0 });
  mocks.api.cloudMirrorClaimOwner.mockResolvedValue(0);
  mirror.bootCloudMirrors();
  await mirror.claimCloudMirrorOwner("ada@example.com");
  mocks.api.cloudMirrorClaimOwner.mockClear();
});

afterEach(() => {
  mirror.resetCloudMirrors();
  mocks.listeners.clear();
  vi.useRealTimers();
});

describe("the local mirror's sync loop", () => {
  it("does nothing for a workspace whose mirror is off", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(false));
    connect();
    await settle();
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS * 3);
    expect(mirror.cloudMirrorState(KEY).phase).toBe("off");
    expect(mocks.readMirrorManifest).not.toHaveBeenCalled();
    expect(mocks.api.cloudMirrorPlan).not.toHaveBeenCalled();
  });

  it("syncs when the workspace connects, then again every 30 s while it stays connected", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true));
    connect();
    await settle();
    // Each file goes to the native side with the size the manifest listed, which it enforces.
    expect(mocks.api.cloudMirrorStage.mock.calls.map(([, , path, , size, etag]) => [path, size, etag])).toEqual([["a.ts", 3, "etag-a.ts"], ["b.ts", 3, "etag-b.ts"]]);
    expect(mocks.readRemoteFile.mock.calls.map(([, path, options]) => [path, options.maxBytes])).toEqual([["a.ts", 3], ["b.ts", 3]]);
    expect(mocks.api.cloudMirrorPublish).toHaveBeenCalledWith("org-1", "ws-1", expect.objectContaining({ manifestId: "m1" }), { "a.ts": "etag-a.ts", "b.ts": "etag-b.ts" });
    const state = mirror.cloudMirrorState(KEY);
    expect(state.phase).toBe("synced");
    expect(state.revision?.manifestId).toBe("m1");
    expect(state.root).toBe(ROOT);
    expect(state.skipped?.secret).toBe(1);

    // Unchanged workspace: the same manifest id, nothing read, only local changes checked.
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS);
    expect(mocks.readMirrorManifest).toHaveBeenCalledTimes(2);
    expect(mocks.readRemoteFile).toHaveBeenCalledTimes(2);
    expect(mocks.api.cloudMirrorPlan).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudMirrorCheck).toHaveBeenCalledTimes(1);

    // The workspace changes one file.
    mocks.readMirrorManifest.mockResolvedValue(manifest("m2", ["a.ts", "b.ts"]));
    mocks.api.cloudMirrorPlan.mockResolvedValue(plan(["b.ts"], { unchanged: 1 }));
    mocks.api.cloudMirrorPublish.mockResolvedValue({ status: status(true, "m2"), diverged: [], divergedTotal: 0, written: 1, removed: 0 });
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS);
    expect(mocks.readRemoteFile).toHaveBeenCalledTimes(3);
    expect(mirror.cloudMirrorState(KEY).revision?.manifestId).toBe("m2");
  });

  it("never opens a connection or wakes a workspace, and stops when the connection goes away", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true));
    const disconnect = connect();
    await settle();
    disconnect();
    expect(mirror.cloudMirrorState(KEY).phase).toBe("paused");
    expect(mirror.cloudMirrorState(KEY).revision?.manifestId).toBe("m1");
    const scans = mocks.readMirrorManifest.mock.calls.length;
    // A long time with the workspace stopped: no timer is left, nothing is asked.
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS * 100);
    expect(mocks.readMirrorManifest).toHaveBeenCalledTimes(scans);
    expect(vi.getTimerCount()).toBe(0);
    // Asking for a sync or turning it on while not connected reads nothing either.
    await mirror.syncCloudMirrorNow(target);
    mocks.api.cloudMirrorEnable.mockResolvedValue(status(true, "m1"));
    await mirror.setCloudMirrorEnabled(target, true);
    expect(mirror.cloudMirrorState(KEY).phase).toBe("paused");
    expect(mocks.readMirrorManifest).toHaveBeenCalledTimes(scans);
    expect(mocks.retain).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("sends the workspace only a manifest request and workspace-relative paths, never the mirror's location", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true));
    connect();
    await settle();
    expect(sent).toEqual([{ method: "mirror.manifest" }, { method: "fs.read", path: "a.ts" }, { method: "fs.read", path: "b.ts" }]);
    const toWorkspace = JSON.stringify([...sent, ...mocks.readMirrorManifest.mock.calls.map((call) => call.slice(1)), ...mocks.readRemoteFile.mock.calls.map((call) => call.slice(1))]);
    expect(toWorkspace).not.toContain("cloud-mirrors");
    expect(toWorkspace).not.toContain("/Users/");
    expect(toWorkspace).not.toContain(ROOT);
    // And the native side is told ids and relative paths, never asked to write somewhere named by the caller.
    for (const [org, workspace, path] of mocks.api.cloudMirrorStage.mock.calls) expect([org, workspace, String(path).startsWith("/")]).toEqual(["org-1", "ws-1", false]);
  });

  it("stops at a local divergence, writes nothing, and resumes only after the person resolves it", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true, "m0"));
    const diverged = [{ path: "a.ts", reason: "modified" }];
    mocks.api.cloudMirrorPlan.mockResolvedValue(plan([], { diverged, divergedTotal: 1 }));
    connect();
    await settle();
    let state = mirror.cloudMirrorState(KEY);
    expect(state.phase).toBe("diverged");
    expect(state.diverged).toEqual(diverged);
    expect(state.revision?.manifestId).toBe("m0");
    expect(mocks.readRemoteFile).not.toHaveBeenCalled();
    expect(mocks.api.cloudMirrorStage).not.toHaveBeenCalled();
    expect(mocks.api.cloudMirrorPublish).not.toHaveBeenCalled();
    // Still diverged on later scans; nothing resolves by itself.
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS * 2);
    expect(mocks.api.cloudMirrorResolve).not.toHaveBeenCalled();
    expect(mocks.api.cloudMirrorPublish).not.toHaveBeenCalled();

    mocks.api.cloudMirrorResolve.mockResolvedValue({ paths: 1, exportedTo: `${ROOT}/../exports/1` });
    mocks.api.cloudMirrorPlan.mockResolvedValue(plan(["a.ts"]));
    const exportedTo = await mirror.resolveCloudMirror(target, "export");
    expect(exportedTo).toContain("exports");
    expect(mocks.api.cloudMirrorResolve).toHaveBeenCalledWith("org-1", "ws-1", expect.objectContaining({ manifestId: "m1" }), "export");
    state = mirror.cloudMirrorState(KEY);
    expect(state.phase).toBe("synced");
    expect(state.diverged).toEqual([]);
  });

  it("notices a local edit of an unchanged workspace", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true, "m1"));
    mocks.api.cloudMirrorCheck.mockResolvedValue({ diverged: [{ path: "b.ts", reason: "deleted" }], divergedTotal: 1 });
    connect();
    await settle();
    expect(mirror.cloudMirrorState(KEY).phase).toBe("diverged");
    expect(mocks.api.cloudMirrorPlan).not.toHaveBeenCalled();
  });

  it("reports a failure with its reason, keeps the last successful revision, and tries again", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true, "m0"));
    mocks.readRemoteFile.mockRejectedValueOnce(new Error("the connection closed"));
    connect();
    await settle();
    let state = mirror.cloudMirrorState(KEY);
    expect([state.phase, state.error]).toEqual(["failed", "the connection closed"]);
    expect(state.revision?.manifestId).toBe("m0");
    expect(mocks.api.cloudMirrorPublish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS);
    state = mirror.cloudMirrorState(KEY);
    expect([state.phase, state.error]).toEqual(["synced", null]);

    // More files than a mirror holds: failed with the reason, nothing planned.
    mocks.readMirrorManifest.mockResolvedValue({ ...manifest("m3", ["a.ts"]), truncated: true });
    const plans = mocks.api.cloudMirrorPlan.mock.calls.length;
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS);
    expect(mirror.cloudMirrorState(KEY).phase).toBe("failed");
    expect(mirror.cloudMirrorState(KEY).error).toMatch(/more files/);
    expect(mocks.api.cloudMirrorPlan).toHaveBeenCalledTimes(plans);
  });

  it("adds what this computer left out to what the workspace left out", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true));
    mocks.api.cloudMirrorPlan.mockResolvedValue(plan(["a.ts"], { refused: { ...refused, secret: 1, gitDirectory: 4, collision: 2 } }));
    connect();
    await settle();
    expect(mirror.cloudMirrorState(KEY).skipped).toMatchObject({ secret: 2, gitDirectory: 4, collision: 2, toolConfig: 0 });
  });

  it("removes the copy of a workspace the person can no longer open, and every copy at sign-out", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true));
    mocks.api.cloudMirrorPurge.mockResolvedValue(2);
    mocks.api.cloudMirrorList.mockResolvedValue([
      { organizationId: "org-1", workspaceId: "ws-1" },
      { organizationId: "org-1", workspaceId: "ws-kept" },
      { organizationId: "org-2", workspaceId: "ws-other" },
    ]);
    connect();
    await settle();
    expect(mirror.cloudMirrorState(KEY).phase).toBe("synced");
    // The organization's list no longer has ws-1 for this person (role none, or deleted).
    await mirror.purgeCloudMirrors((orgId, workspaceId) => orgId !== "org-1" || workspaceId === "ws-kept");
    expect(mocks.api.cloudMirrorPurge.mock.calls).toEqual([["org-1", "ws-1"]]);
    expect(mirror.cloudMirrorState(KEY).phase).toBe("off");
    // Its loop is stopped: nothing more is read from that workspace.
    const scans = mocks.readMirrorManifest.mock.calls.length;
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS * 3);
    expect(mocks.readMirrorManifest).toHaveBeenCalledTimes(scans);

    mocks.api.cloudMirrorPurge.mockClear();
    await mirror.purgeCloudMirrors(() => false);
    expect(mocks.api.cloudMirrorPurge.mock.calls.map(([, workspace]) => workspace)).toEqual(["ws-1", "ws-kept", "ws-other"]);
    expect(mocks.retain).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("turns a mirror on only for the signed-in account, and tells the native side whose it is", async () => {
    mocks.api.cloudMirrorEnable.mockResolvedValue(status(true));
    // Nobody has been reported as signed in yet.
    mirror.resetCloudMirrors();
    await expect(mirror.setCloudMirrorEnabled(target, true)).rejects.toThrow(/Sign in/);
    expect(mocks.api.cloudMirrorEnable).not.toHaveBeenCalled();
    mocks.api.cloudMirrorClaimOwner.mockResolvedValue(0);
    await mirror.claimCloudMirrorOwner("ada@example.com");
    await mirror.setCloudMirrorEnabled(target, true);
    expect(mocks.api.cloudMirrorEnable).toHaveBeenCalledWith("org-1", "ws-1", "ada@example.com");
  });

  it("removes mirrors left by another account or by a sign-out while the app was closed", async () => {
    mocks.api.cloudMirrorList.mockResolvedValue([{ organizationId: "org-1", workspaceId: "ws-1" }]);
    mocks.api.cloudMirrorPurge.mockResolvedValue(1);
    mocks.api.cloudMirrorClaimOwner.mockResolvedValue(0);
    // Signed in as Ada since the app started (claimed once, before each test):
    // the same account reported again asks the native side nothing more.
    await mirror.claimCloudMirrorOwner("ada@example.com");
    await mirror.claimCloudMirrorOwner("ada@example.com");
    expect(mocks.api.cloudMirrorClaimOwner).not.toHaveBeenCalled();
    // Another account is reported without a sign-out in between.
    mocks.api.cloudMirrorClaimOwner.mockResolvedValue(1);
    await mirror.claimCloudMirrorOwner("bob@example.com");
    expect(mocks.api.cloudMirrorClaimOwner).toHaveBeenLastCalledWith("bob@example.com");
    // Nobody is signed in at launch: every mirror goes.
    await mirror.claimCloudMirrorOwner(null);
    expect(mocks.api.cloudMirrorPurge.mock.calls).toEqual([["org-1", "ws-1"]]);
  });

  it("counts what the check of the disk took back", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true));
    mocks.api.cloudMirrorPublish.mockResolvedValue({ status: status(true, "m1"), diverged: [], divergedTotal: 0, written: 2, removed: 0, takenBack: 2 });
    connect();
    await settle();
    expect(mirror.cloudMirrorState(KEY).skipped?.onDisk).toBe(2);
  });

  it("does not sync on a connection while the owner is not confirmed, and starts once it is", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true, "m0"));
    // A new account is reported and the native claim fails (the disk, a permission).
    mocks.api.cloudMirrorClaimOwner.mockRejectedValueOnce(new Error("could not read the owner"));
    await mirror.claimCloudMirrorOwner("account-b");
    connect();
    await settle();
    expect(mocks.readMirrorManifest).not.toHaveBeenCalled();
    expect(mocks.api.cloudMirrorPlan).not.toHaveBeenCalled();
    expect(mirror.cloudMirrorState(KEY).phase).toBe("paused");
    expect(mirror.cloudMirrorState(KEY).error).toMatch(/confirm that this mirror belongs/);
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS * 3);
    expect(mocks.readMirrorManifest).not.toHaveBeenCalled();
    // Turning one on is refused too.
    await expect(mirror.setCloudMirrorEnabled(target, true)).rejects.toThrow(/Sign in/);

    // The account is reported again and the claim succeeds: the workspace that is still connected syncs.
    mocks.api.cloudMirrorClaimOwner.mockResolvedValue(0);
    await mirror.claimCloudMirrorOwner("account-b");
    await settle();
    expect(mocks.readMirrorManifest).toHaveBeenCalledTimes(1);
    expect(mirror.cloudMirrorState(KEY).phase).toBe("synced");
  });

  it("removes nothing and syncs nothing when it is not known who is signed in", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true));
    mocks.api.cloudMirrorList.mockResolvedValue([{ organizationId: "org-1", workspaceId: "ws-1" }]);
    connect();
    await settle();
    expect(mirror.cloudMirrorState(KEY).phase).toBe("synced");
    const scans = mocks.readMirrorManifest.mock.calls.length;
    // The saved session could not be read (a Keychain failure): not a sign-out.
    await mirror.claimCloudMirrorOwner(undefined);
    expect(mocks.api.cloudMirrorPurge).not.toHaveBeenCalled();
    expect(mocks.api.cloudMirrorList).not.toHaveBeenCalled();
    expect(mirror.cloudMirrorState(KEY).phase).toBe("paused");
    expect(mirror.cloudMirrorState(KEY).revision?.manifestId).toBe("m1");
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS * 3);
    expect(mocks.readMirrorManifest).toHaveBeenCalledTimes(scans);
    // A real sign-out, known for certain, does remove them.
    mocks.api.cloudMirrorPurge.mockResolvedValue(1);
    await mirror.claimCloudMirrorOwner(null);
    expect(mocks.api.cloudMirrorPurge.mock.calls).toEqual([["org-1", "ws-1"]]);
  });

  it("says a runtime from before mirrors cannot be mirrored, and asks it nothing", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(true));
    connect(client(["fs/1"]));
    await settle();
    expect(mirror.cloudMirrorState(KEY).phase).toBe("unsupported");
    expect(mocks.readMirrorManifest).not.toHaveBeenCalled();
  });

  it("turning it on while connected syncs at once; turning it off stops and can remove the copy", async () => {
    mocks.api.cloudMirrorStatus.mockResolvedValue(status(false));
    connect();
    await settle();
    mocks.api.cloudMirrorEnable.mockResolvedValue(status(true));
    await mirror.setCloudMirrorEnabled(target, true);
    await settle();
    expect(mirror.cloudMirrorState(KEY).phase).toBe("synced");

    mocks.api.cloudMirrorDisable.mockResolvedValue(status(false));
    await mirror.setCloudMirrorEnabled(target, false, { removeFiles: true });
    expect(mocks.api.cloudMirrorDisable).toHaveBeenCalledWith("org-1", "ws-1", true);
    expect(mirror.cloudMirrorState(KEY).phase).toBe("off");
    const scans = mocks.readMirrorManifest.mock.calls.length;
    await vi.advanceTimersByTimeAsync(mirror.MIRROR_SCAN_MS * 3);
    expect(mocks.readMirrorManifest).toHaveBeenCalledTimes(scans);
  });
});
