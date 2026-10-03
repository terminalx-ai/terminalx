import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiError, type CloudCommand, type CloudWorkspace } from "./api";
import { b64, checkpointAad, unb64, type CheckpointEnvelope, type CommandEnvelope } from "./crypto";
import { NOW, pairingCode, Runtime } from "./fake-runtime";
import { CloudWorkspaceSession } from "./workspace";

const scope = { organizationId: "org-1", workspaceId: "ws-1" };
const key = new Uint8Array(randomBytes(32));
const event = (seq: number, text = `m${seq}`) => ({ id: `e${seq}`, sessionId: "s1", tabId: "t1", harness: "claude", seq, ts: "2026-10-03T00:00:00Z", payload: { type: "status", text } });

function checkpoint(version: number, events: unknown[], fields: { status?: string; tabId?: string } = {}): CheckpointEnvelope {
  const meta = { tabId: fields.tabId ?? "t1", epoch: 1, version, schemaVersion: 1, keyId: "k1" };
  const body = { v: 1, sessionId: "s1", tabId: meta.tabId, title: "Fix login", harness: "claude", status: fields.status ?? "completed", lastSeq: version, events, truncated: false, pendingPermissions: [] };
  const iv = new Uint8Array(randomBytes(12));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(checkpointAad(scope.organizationId, scope.workspaceId, meta.tabId, meta.epoch, meta.version, meta.schemaVersion, meta.keyId));
  const ciphertext = b64(new Uint8Array(Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(body)))), cipher.final(), cipher.getAuthTag()])));
  return { ...meta, iv: b64(iv), ciphertext, sha256: createHash("sha256").update(unb64(ciphertext)).digest("hex") };
}

function harness(options: { state?: string | null; role?: string; canApprove?: boolean; secrets?: Map<string, string>; blobs?: Map<string, string>; checkpoints?: CheckpointEnvelope[] } = {}) {
  let listed: CloudWorkspace | null = options.state === null ? null : ({ id: "ws-1", orgId: "org-1", name: "fix-login", provider: "box", state: options.state ?? "ready", you: { role: options.role ?? "driver", canApprove: options.canApprove ?? false } } as CloudWorkspace);
  const secrets = options.secrets ?? new Map<string, string>();
  const blobs = options.blobs ?? new Map<string, string>();
  const runtimes: Runtime[] = [];
  const posted: CommandEnvelope[] = [];
  const stored = options.checkpoints ?? [];
  const command = (envelope: CommandEnvelope, state = "queued"): CloudCommand => ({ clientCommandId: envelope.clientCommandId, tabId: envelope.tabId, kind: envelope.kind, state, keyId: envelope.keyId, createdAt: 1, updatedAt: 1 });
  const api = {
    open: vi.fn(async () => ({ id: "a1", workspaceId: "ws-1", state: "ready" as const, authority: "participate" as const, expiresAt: NOW + 600_000, pairingCode: pairingCode(), attachTicket: { v: 1 as const, token: "attach-jwt", expiresAt: NOW + 60_000, runtimeGeneration: 3, protocol: "terminalx-workspace-rpc/1" as const } })),
    enqueue: vi.fn(async (_org: string, _ws: string, envelope: CommandEnvelope) => {
      posted.push(envelope);
      return { command: command(envelope), existing: false, wake: listed?.state === "suspended" ? "queued" : "not-needed" };
    }),
    commandStatuses: vi.fn(async (): Promise<CloudCommand[]> => []),
    cancelCommand: vi.fn(async (_org: string, _ws: string, id: string) => command(posted.find((sent) => sent.clientCommandId === id)!, "cancelled")),
    checkpoints: vi.fn(async () => stored.map(({ tabId, epoch, version, schemaVersion, keyId, sha256 }) => ({ tabId, epoch, version, schemaVersion, keyId, sha256 }))),
    checkpoint: vi.fn(async (_org: string, _ws: string, tabId: string, after?: { epoch: number; version: number } | null) => {
      const found = stored.find((entry) => entry.tabId === tabId) ?? null;
      return found && after && found.version <= after.version ? null : found;
    }),
  };
  const nudges = { count: 0 };
  /** The list read again for a send: what it then says, and whether it could be read. */
  const refresh = { calls: 0, state: undefined as string | null | undefined, ok: true };
  let configure: ((runtime: Runtime) => void) | null = null;
  const session = new CloudWorkspaceSession({
    scope,
    api: api as never,
    secrets: { get: async (name) => secrets.get(name) ?? null, set: async (name, value) => void secrets.set(name, value), delete: async (name) => void secrets.delete(name) },
    storage: { getItem: async (name) => blobs.get(name) ?? null, setItem: async (name, value) => void blobs.set(name, value), removeItem: async (name) => void blobs.delete(name) },
    listed: () => listed,
    refreshList: async () => {
      refresh.calls += 1;
      if (refresh.ok && refresh.state !== undefined) listed = refresh.state === null ? null : ({ ...listed!, state: refresh.state } as CloudWorkspace);
      return refresh.ok;
    },
    clientInstallationId: "install-1",
    appVersion: "0.1.0",
    link: {
      now: () => NOW,
      createSocket: (url) => {
        const runtime = new Runtime();
        runtime.url = url;
        runtime.you = { userId: "u-me", role: options.role ?? "driver", canApprove: options.canApprove ?? false };
        runtime.methods = {
          "keys.get": () => ({ currentKeyId: "k1", keys: [{ keyId: "k1", key: b64(key), createdAt: 1, retiredAt: null }] }),
          "session.tabs": () => ({ tabs: [{ sessionId: "s1", tabId: "t1", title: "Fix login", harness: "claude", status: "in_progress", pendingPermissions: [] }] }),
          "session.subscribe": () => ({ subscriptionId: "sub-1", events: [{ cursor: "c2", event: event(2) }], cursor: "c2" }),
          "session.nudge": () => (nudges.count++, {}),
        };
        configure?.(runtime);
        runtimes.push(runtime);
        queueMicrotask(() => runtime.onopen?.());
        return runtime as never;
      },
    },
  });
  return { session, api, posted, runtimes, secrets, blobs, nudges, refresh, list: (state: string | null) => (listed = state === null ? null : ({ ...listed!, state } as CloudWorkspace)), each: (run: (runtime: Runtime) => void) => (configure = run) };
}

const settle = async () => {
  for (let index = 0; index < 40; index++) await Promise.resolve();
};
const connected = (h: ReturnType<typeof harness>) => vi.waitFor(() => expect(h.session.getSnapshot().tabs[0]?.source).toBe("live"));
const tab = (h: ReturnType<typeof harness>) => h.session.getSnapshot().tabs[0];

/** A phone that connected once before, so it holds the workspace key. */
async function keyed() {
  const earlier = harness();
  await earlier.session.start();
  await connected(earlier);
  earlier.session.close();
  return earlier;
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("a cloud workspace on the phone", () => {
  it("connects to a running workspace, takes the key over the encrypted channel, and lists its tabs live", async () => {
    const h = harness();
    await h.session.start();
    await connected(h);
    const snapshot = h.session.getSnapshot();
    expect(snapshot).toMatchObject({ connection: { state: "connected", authority: "participate" }, role: "driver", canApprove: false, hasKey: true, error: null });
    expect(snapshot.tabs).toMatchObject([{ tabId: "t1", sessionId: "s1", title: "Fix login", status: "in_progress", source: "live" }]);
    // The key is in the secure store only.
    expect(h.secrets.size).toBe(1);
    expect([...h.blobs.values()].join("")).not.toContain(b64(key));
    h.session.close();
  });

  it("streams the tab being looked at, on top of its checkpoint, without repeating events", async () => {
    const h = harness({ checkpoints: [checkpoint(1, [event(1)])] });
    await h.session.start();
    await connected(h);
    const stop = h.session.view("t1");
    await vi.waitFor(() => expect(tab(h).events.map((entry) => entry.seq)).toEqual([1, 2]));
    h.runtimes[0].encrypted({ event: "session.event", params: { subscriptionId: "sub-1", cursor: "c3", event: event(3) } });
    h.runtimes[0].encrypted({ event: "session.event", params: { subscriptionId: "sub-1", cursor: "c3", event: event(3) } });
    h.runtimes[0].encrypted({ event: "session.status", params: { subscriptionId: "sub-1", sessionId: "s1", tabId: "t1", status: "completed" } });
    await vi.waitFor(() => expect(tab(h).status).toBe("completed"));
    expect(tab(h).events.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    stop();
    h.session.close();
  });

  it.each(["suspended", "archived"])("shows a %s workspace from its checkpoints and wakes nothing by looking", async (state) => {
    // An earlier connection left the key on this phone.
    const earlier = harness();
    await earlier.session.start();
    await connected(earlier);
    earlier.session.close();

    const h = harness({ state, secrets: earlier.secrets, checkpoints: [checkpoint(4, [event(3), event(4, "the last answer")], { status: "completed" })] });
    await h.session.start();
    const stop = h.session.view("t1");
    await vi.waitFor(() => expect(tab(h)?.events).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.session.getSnapshot()).toMatchObject({ connection: { state: "suspended" }, role: "driver", hasKey: true });
    expect(tab(h)).toMatchObject({ source: "checkpoint", title: "Fix login", status: "completed", noKey: false });
    // Only reads were made: no attachment was asked for, nothing was queued, no socket opened.
    expect(h.api.open).not.toHaveBeenCalled();
    expect(h.api.enqueue).not.toHaveBeenCalled();
    expect(h.runtimes).toEqual([]);
    // The transcript is kept encrypted.
    expect([...h.blobs.values()].join("")).not.toContain("the last answer");
    stop();
    h.session.close();
  });

  it("says so when a checkpoint exists but this phone was never handed the key", async () => {
    const h = harness({ state: "suspended", checkpoints: [checkpoint(4, [event(4)])] });
    await h.session.start();
    await vi.waitFor(() => expect(tab(h)).toMatchObject({ noKey: true, events: [] }));
    expect(h.session.getSnapshot().hasKey).toBe(false);
    await expect(h.session.send("t1", "hi", { allowWake: true })).rejects.toMatchObject({ code: "no-key" });
    expect(h.api.enqueue).not.toHaveBeenCalled();
    h.session.close();
  });

  it("sends through the encrypted mailbox and nudges the connected runtime", async () => {
    const h = harness();
    await h.session.start();
    await connected(h);
    const entry = await h.session.send("t1", "run the tests");
    expect(entry).toMatchObject({ kind: "send", text: "run the tests", state: "queued", wake: "not-needed" });
    expect(h.posted[0]).toMatchObject({ tabId: "t1", kind: "send", keyId: "k1" });
    expect(JSON.stringify(h.posted[0])).not.toContain("run the tests");
    await vi.waitFor(() => expect(h.nudges.count).toBe(1));
    expect(h.session.getSnapshot().outbox).toMatchObject([{ text: "run the tests" }]);
    h.session.close();
  });

  it("does not start a stopped workspace with a message unless the person said so", async () => {
    const earlier = harness();
    await earlier.session.start();
    await connected(earlier);
    earlier.session.close();

    const h = harness({ state: "suspended", secrets: earlier.secrets });
    await h.session.start();
    await expect(h.session.send("t1", "wake up")).rejects.toMatchObject({ code: "would-wake" });
    await expect(h.session.stop("t1")).rejects.toMatchObject({ code: "would-wake" });
    expect(h.api.enqueue).not.toHaveBeenCalled();
    expect((await h.session.send("t1", "wake up", { allowWake: true })).wake).toBe("queued");
    expect(h.api.enqueue).toHaveBeenCalledTimes(1);
    // Still no attachment asked for from here: the list says when it runs.
    expect(h.api.open).not.toHaveBeenCalled();
    h.list("ready");
    h.session.listChanged();
    await connected(h);
    h.session.close();
  });

  it("lets a viewer read, and answer a permission request only with the right to approve; a driver without it cannot", async () => {
    const viewer = harness({ role: "viewer" });
    await viewer.session.start();
    await connected(viewer);
    await expect(viewer.session.send("t1", "hi")).rejects.toMatchObject({ code: "read-only" });
    await expect(viewer.session.steer("t1", "hi")).rejects.toMatchObject({ code: "read-only" });
    await expect(viewer.session.stop("t1")).rejects.toMatchObject({ code: "read-only" });
    await expect(viewer.session.decide("t1", { requestId: "r1", optionId: "allow" })).rejects.toMatchObject({ code: "cannot-approve" });
    expect(viewer.api.enqueue).not.toHaveBeenCalled();
    viewer.session.close();

    // The right to approve is its own right: a viewer who has it decides, and still cannot send.
    const approvingViewer = harness({ role: "viewer", canApprove: true });
    await approvingViewer.session.start();
    await connected(approvingViewer);
    expect(await approvingViewer.session.decide("t1", { requestId: "r1", optionId: "allow" })).toMatchObject({ kind: "permission-decision", requestId: "r1", state: "queued" });
    expect(approvingViewer.posted).toMatchObject([{ kind: "permission-decision" }]);
    await expect(approvingViewer.session.send("t1", "hi")).rejects.toMatchObject({ code: "read-only" });
    approvingViewer.session.close();

    const driver = harness({ role: "driver", canApprove: false });
    await driver.session.start();
    await connected(driver);
    await expect(driver.session.decide("t1", { requestId: "r1", optionId: "allow" })).rejects.toMatchObject({ code: "cannot-approve" });
    driver.session.close();

    const approver = harness({ role: "driver", canApprove: true });
    await approver.session.start();
    await connected(approver);
    expect(await approver.session.decide("t1", { requestId: "r1", optionId: "allow" })).toMatchObject({ kind: "permission-decision", requestId: "r1" });
    approver.session.close();
  });

  it("holds a message that never left the phone when the workspace is found stopped: opening it posts nothing", async () => {
    // Yesterday: sent while offline, to a running workspace. It stays on the phone.
    const before = harness();
    await before.session.start();
    await connected(before);
    before.api.enqueue.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null));
    expect(await before.session.send("t1", "written offline")).toMatchObject({ state: "unsent" });
    before.session.close();

    // Today the workspace is stopped, and it is opened only to read.
    const h = harness({ state: "suspended", secrets: before.secrets, blobs: before.blobs });
    await h.session.start();
    const stop = h.session.view("t1");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.api.enqueue).not.toHaveBeenCalled();
    expect(h.api.open).not.toHaveBeenCalled();
    expect(h.session.getSnapshot().outbox).toMatchObject([{ text: "written offline", state: "unsent" }]);
    // Nothing polls for it either.
    expect(h.api.commandStatuses).not.toHaveBeenCalled();

    // Delivering it starts the workspace, so it needs the person's word.
    await expect(h.session.deliverHeld()).rejects.toMatchObject({ code: "would-wake" });
    expect(h.api.enqueue).not.toHaveBeenCalled();
    await h.session.deliverHeld({ allowWake: true });
    expect(h.posted).toHaveLength(1);
    expect(h.session.getSnapshot().outbox).toMatchObject([{ state: "queued", wake: "queued" }]);
    stop();
    h.session.close();
  });

  it("delivers a held message by itself once the workspace is seen running", async () => {
    const before = harness();
    await before.session.start();
    await connected(before);
    before.api.enqueue.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null));
    await before.session.send("t1", "written offline");
    before.session.close();

    const h = harness({ secrets: before.secrets, blobs: before.blobs });
    await h.session.start();
    await connected(h);
    await vi.waitFor(() => expect(h.posted).toHaveLength(1));
    expect(h.session.getSnapshot().outbox).toMatchObject([{ state: "queued", wake: "not-needed" }]);
    h.session.close();
  });

  it("does not trust a list that says running when it is not connected: it reads the list again before a send", async () => {
    // The screen has been open a while; the workspace was stopped from a desktop meanwhile.
    const h = harness({ secrets: (await keyed()).secrets });
    h.api.open.mockRejectedValue(new CloudApiError("cloud_workspace_not_found", 404));
    await h.session.start();
    await vi.waitFor(() => expect(h.session.getSnapshot().connection.state).toBe("stopped"));
    h.refresh.state = "suspended";
    await expect(h.session.send("t1", "are you there")).rejects.toMatchObject({ code: "would-wake" });
    expect(h.refresh.calls).toBe(1);
    expect(h.api.enqueue).not.toHaveBeenCalled();
    // With the person's word it goes, and starts the workspace.
    expect(await h.session.send("t1", "are you there", { allowWake: true })).toMatchObject({ wake: "queued" });
    h.session.close();
  });

  it("keeps a command on the phone, unposted, when it cannot tell whether the workspace runs", async () => {
    const h = harness({ secrets: (await keyed()).secrets });
    h.api.open.mockRejectedValue(new CloudApiError("cloud_workspace_unavailable", null));
    await h.session.start();
    await settle();
    h.refresh.ok = false;
    expect(await h.session.send("t1", "maybe")).toMatchObject({ state: "unsent" });
    expect(h.api.enqueue).not.toHaveBeenCalled();
    // The list is read and says running: now it goes.
    h.refresh.ok = true;
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.waitFor(() => expect(h.posted).toHaveLength(1));
    h.session.close();
  });

  it("says the list should be followed while the workspace changes state or was asked to start", async () => {
    const before = harness();
    await before.session.start();
    await connected(before);
    before.session.close();

    const h = harness({ state: "suspended", secrets: before.secrets });
    await h.session.start();
    expect(h.session.changing).toBe(false);
    await h.session.send("t1", "start", { allowWake: true });
    expect(h.session.changing).toBe(true);
    h.list("resuming");
    expect(h.session.changing).toBe(true);
    h.list("ready");
    expect(h.session.changing).toBe(false);
    h.session.close();
  });

  it("polls and posts nothing from the background, also when the list is read after pausing", async () => {
    const h = harness();
    await h.session.start();
    await connected(h);
    await h.session.send("t1", "sent");
    // One more, written offline: it stays on the phone.
    h.api.enqueue.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null));
    await h.session.send("t1", "held");
    h.session.pause();
    const polls = h.api.commandStatuses.mock.calls.length;
    const posts = h.api.enqueue.mock.calls.length;
    // A list read that was on its way finishes after the app went to the background.
    h.session.listChanged();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.api.commandStatuses).toHaveBeenCalledTimes(polls);
    expect(h.api.enqueue).toHaveBeenCalledTimes(posts);
    // Back in the foreground it carries on.
    h.session.resume();
    await connected(h);
    await vi.waitFor(() => expect(h.api.enqueue.mock.calls.length).toBe(posts + 1));
    h.session.close();
  });

  it("lets go of the connection in the background and takes it up again in the foreground", async () => {
    const h = harness();
    await h.session.start();
    await connected(h);
    h.session.pause();
    expect(h.session.getSnapshot().connection.state).toBe("idle");
    expect(h.runtimes[0].readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.api.open).toHaveBeenCalledTimes(1);
    h.session.resume();
    await connected(h);
    expect(h.api.open).toHaveBeenCalledTimes(2);
    h.session.close();
  });

  it("refuses to send to a workspace that is not listed for this person or is archived", async () => {
    for (const state of [null, "archived"]) {
      const h = harness({ state, role: "driver" });
      await h.session.start();
      await expect(h.session.send("t1", "hi", { allowWake: true })).rejects.toMatchObject({ code: "unavailable" });
      expect(h.api.enqueue).not.toHaveBeenCalled();
      h.session.close();
    }
  });

  it("keeps what it showed when the connection drops, and catches up after it returns", async () => {
    const h = harness();
    await h.session.start();
    await connected(h);
    const stop = h.session.view("t1");
    await vi.waitFor(() => expect(tab(h).events).toHaveLength(1));
    h.runtimes[0].drop(1006);
    expect(h.session.getSnapshot().connection.state).toBe("reconnecting");
    expect(tab(h)).toMatchObject({ source: "checkpoint", events: [{ seq: 2 }] });
    h.each((runtime) => (runtime.methods["session.subscribe"] = () => ({ subscriptionId: "sub-2", events: [{ cursor: "c5", event: event(5) }], cursor: "c5" })));
    await vi.advanceTimersByTimeAsync(1_000);
    await connected(h);
    await vi.waitFor(() => expect(tab(h).events.map((entry) => entry.seq)).toEqual([2, 5]));
    stop();
    h.session.close();
  });

  it("follows a sent command until it settles, then stops asking", async () => {
    const h = harness();
    await h.session.start();
    await connected(h);
    await h.session.send("t1", "go");
    h.api.commandStatuses.mockImplementation(async () => [{ clientCommandId: h.posted[0].clientCommandId, tabId: "t1", kind: "send", state: "applied", keyId: "k1", createdAt: 1, updatedAt: 2 }]);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.waitFor(() => expect(h.session.getSnapshot().outbox[0].state).toBe("applied"));
    const calls = h.api.commandStatuses.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.api.commandStatuses.mock.calls.length).toBe(calls);
    h.session.close();
  });

  it("forgets the key, the outbox and the transcripts when purged", async () => {
    const h = harness({ checkpoints: [checkpoint(1, [event(1)])] });
    await h.session.start();
    await connected(h);
    await h.session.send("t1", "go");
    await vi.waitFor(() => expect(h.blobs.size).toBeGreaterThan(1));
    await h.session.purge();
    expect(h.secrets.size).toBe(0);
    expect(h.blobs.size).toBe(0);
    expect(h.runtimes[0].readyState).toBe(3);
  });
});
