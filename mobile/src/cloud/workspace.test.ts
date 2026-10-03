import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCommand, CloudWorkspace } from "./api";
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
  let configure: ((runtime: Runtime) => void) | null = null;
  const session = new CloudWorkspaceSession({
    scope,
    api: api as never,
    secrets: { get: async (name) => secrets.get(name) ?? null, set: async (name, value) => void secrets.set(name, value), delete: async (name) => void secrets.delete(name) },
    storage: { getItem: async (name) => blobs.get(name) ?? null, setItem: async (name, value) => void blobs.set(name, value), removeItem: async (name) => void blobs.delete(name) },
    listed: () => listed,
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
  return { session, api, posted, runtimes, secrets, blobs, nudges, list: (state: string | null) => (listed = state === null ? null : ({ ...listed!, state } as CloudWorkspace)), each: (run: (runtime: Runtime) => void) => (configure = run) };
}

const connected = (h: ReturnType<typeof harness>) => vi.waitFor(() => expect(h.session.getSnapshot().tabs[0]?.source).toBe("live"));
const tab = (h: ReturnType<typeof harness>) => h.session.getSnapshot().tabs[0];

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

  it("lets a viewer read and nothing else, and only an approver decide", async () => {
    const viewer = harness({ role: "viewer" });
    await viewer.session.start();
    await connected(viewer);
    await expect(viewer.session.send("t1", "hi")).rejects.toMatchObject({ code: "read-only" });
    await expect(viewer.session.steer("t1", "hi")).rejects.toMatchObject({ code: "read-only" });
    await expect(viewer.session.stop("t1")).rejects.toMatchObject({ code: "read-only" });
    await expect(viewer.session.decide("t1", { requestId: "r1", optionId: "allow" })).rejects.toMatchObject({ code: "cannot-approve" });
    expect(viewer.api.enqueue).not.toHaveBeenCalled();
    viewer.session.close();

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
