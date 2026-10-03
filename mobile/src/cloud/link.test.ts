import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcClient, type WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { CloudApiError } from "./api";
import { NOW, pairingCode, relayHostId, Runtime } from "./fake-runtime";
import { CloudWorkspaceLink, MAX_ATTEMPTS, MAX_WAITS, PHONE_CAPABILITIES, STABLE_AFTER_MS } from "./link";

// The real link against a runtime that speaks the real handshake and frames
// (as `relay-client.test.ts` does for a paired Mac): nothing of the encrypted
// session is mocked.

const ticket = (runtimeGeneration = 3) => ({ v: 1 as const, token: "attach-jwt", expiresAt: NOW + 60_000, runtimeGeneration, protocol: "terminalx-workspace-rpc/1" as const });
const ready = (fields: Record<string, unknown> = {}) => ({ id: "a1", workspaceId: "ws-1", state: "ready" as const, authority: "participate" as const, expiresAt: NOW + 600_000, pairingCode: pairingCode(), attachTicket: ticket(), ...fields });

function harness(listed: string | null = "ready", clock: { now?: () => number; serverNow?: () => number } = { now: () => NOW }) {
  const runtimes: Runtime[] = [];
  const open = vi.fn(async (..._args: unknown[]) => ready() as never);
  let state = listed;
  const link = new CloudWorkspaceLink({
    api: { open: open as never, ...(clock.serverNow ? { serverNow: clock.serverNow } : {}) },
    target: { orgId: "org-1", workspaceId: "ws-1" },
    clientInstallationId: "install-1",
    workspaceState: () => state,
    appVersion: "0.1.0",
    ...(clock.now ? { now: clock.now } : {}),
    random: { bytes: (length) => new Uint8Array(length).fill(9) },
    createSocket: (url) => {
      const runtime = new Runtime();
      runtime.url = url;
      configure?.(runtime);
      runtimes.push(runtime);
      queueMicrotask(() => runtime.onopen?.());
      return runtime as never;
    },
  });
  let configure: ((runtime: Runtime) => void) | null = null;
  const states: WorkspaceConnectionState[] = [];
  link.onState((next) => states.push(next));
  return { link, open, runtimes, states, list: (next: string | null) => (state = next), each: (run: (runtime: Runtime) => void) => (configure = run) };
}

const settle = async () => {
  for (let index = 0; index < 40; index++) await Promise.resolve();
};
const connected = async (h: ReturnType<typeof harness>) => vi.waitFor(() => expect(h.link.state.state).toBe("connected"));

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("the phone's connection to a cloud workspace", () => {
  it("opens, attaches with the ticket, runs the encrypted handshake, and negotiates as a participant", async () => {
    const h = harness();
    h.link.start();
    await connected(h);
    const runtime = h.runtimes[0];
    expect(h.open).toHaveBeenCalledWith("org-1", "ws-1", "install-1", { refreshPairing: false });
    expect(runtime.url).toBe(`wss://cell.example.test/v1/connect/${relayHostId}`);
    // The relay sees the single-use invite and the attach ticket, never the device credential.
    expect(runtime.auth).toEqual({ type: "relay-auth", v: 2, mode: "connect", credential: "i".repeat(43), attachTicket: "attach-jwt" });
    expect(runtime.deviceToken).toBe("device-token-0123456789");
    expect(runtime.requests.map((request) => request.method)).toEqual(["pairing.provisionRelay", "rpc.hello"]);
    expect(runtime.requests[1].params).toEqual({ protocol: "terminalx-workspace-rpc/1", client: { app: "terminalx-mobile", version: "0.1.0" }, want: [...PHONE_CAPABILITIES] });
    // No terminals, files or Git are asked for from a phone.
    expect(PHONE_CAPABILITIES.some((capability) => /^(pty|fs|git)\//.test(capability))).toBe(false);
    expect(h.link.state).toEqual({ state: "connected", runtimeGeneration: 3, runtimeEpoch: "e1", runtimeVersion: "0.2.7", capabilities: [...PHONE_CAPABILITIES], authority: "participate", you: { userId: "u-me", role: "driver", canApprove: false } });
    expect(h.states.map((state) => state.state)).toEqual(["opening", "connecting", "connected"]);
    expect(h.link.problem).toBeNull();
  });

  it("carries the shared workspace RPC client: calls, answers and notifications", async () => {
    const h = harness();
    const client = new WorkspaceRpcClient(h.link, () => "req-1");
    h.link.start();
    await connected(h);
    expect(await client.call("session.tabs", {})).toEqual({ tabs: [{ tabId: "t1" }] });
    const events: string[] = [];
    client.onNotification((notification) => events.push(notification.event));
    h.runtimes[0].encrypted({ event: "collab.presence", params: { participants: [] } });
    await vi.waitFor(() => expect(events).toEqual(["collab.presence"]));
    client.close();
  });

  it.each([
    ["suspended", "suspended"],
    ["archived", "suspended"],
    [null, "stopped"],
    ["attention-required", "stopped"],
  ] as const)("never asks to open a workspace the list calls %s: it parks, and nothing resumes", async (listed, expected) => {
    const h = harness(listed);
    h.link.start();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.link.state.state).toBe(expected);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.runtimes).toEqual([]);
  });

  it("connects once the list says a parked workspace is running", async () => {
    const h = harness("suspended");
    h.link.start();
    await settle();
    expect(h.open).not.toHaveBeenCalled();
    // Someone resumed it elsewhere; the list was read again.
    h.list("provisioning");
    h.link.listChanged();
    await settle();
    expect(h.link.state.state).toBe("waitingForRuntime");
    expect(h.open).not.toHaveBeenCalled();
    h.list("ready");
    h.link.listChanged();
    await connected(h);
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  it("waits for a runtime that is not ready yet, asking again", async () => {
    const h = harness();
    h.open.mockResolvedValueOnce({ id: "a1", workspaceId: "ws-1", state: "waiting-for-runtime", authority: "participate", expiresAt: NOW } as never);
    h.link.start();
    await settle();
    expect(h.link.state.state).toBe("waitingForRuntime");
    await vi.advanceTimersByTimeAsync(2_000);
    await connected(h);
    expect(h.open).toHaveBeenCalledTimes(2);
  });

  it("tells an unreachable service (retried) from a refusal (not retried until the list changes)", async () => {
    const offline = harness();
    offline.open.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null));
    offline.link.start();
    await settle();
    expect(offline.link.state).toMatchObject({ state: "reconnecting", attempt: 1, reason: "api:cloud_workspace_unavailable" });
    expect(offline.link.problem).toEqual({ kind: "api", code: "cloud_workspace_unavailable", unreachable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await connected(offline);

    const refused = harness();
    refused.open.mockRejectedValue(new CloudApiError("cloud_workspace_not_found", 404));
    refused.link.start();
    await settle();
    expect(refused.link.state.state).toBe("stopped");
    expect(refused.link.problem).toEqual({ kind: "api", code: "cloud_workspace_not_found", unreachable: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refused.open).toHaveBeenCalledTimes(1);
    // A list that says the same as before causes no further request, however often it is read.
    refused.link.listChanged();
    refused.link.listChanged();
    await settle();
    expect(refused.open).toHaveBeenCalledTimes(1);
    // The person asks (or the listed state changes): it tries again.
    refused.open.mockResolvedValue(ready() as never);
    refused.link.reconnect();
    await connected(refused);
  });

  it("reconnects after the network drops with the resume credential and a new ticket, and reports the reason meanwhile", async () => {
    const h = harness();
    h.link.start();
    await connected(h);
    h.runtimes[0].drop(1006);
    expect(h.link.state).toMatchObject({ state: "reconnecting", attempt: 1, reason: "relay:1006" });
    // Frames are refused at once while down, so the RPC client resends after the reconnect.
    expect(h.link.send({ id: "x", method: "session.tabs" })).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await connected(h);
    expect(h.open).toHaveBeenCalledTimes(2);
    // The same pairing: no new invite is asked for, and the relay gets the resume credential.
    expect(h.open.mock.calls[1][3]).toEqual({ refreshPairing: false });
    expect(h.runtimes[1].auth).toMatchObject({ v: 2, attachTicket: "attach-jwt" });
    expect(h.runtimes[1].auth!.credential).not.toBe("i".repeat(43));
    // A resume connection installs nothing new.
    expect(h.runtimes[1].requests.map((request) => request.method)).toEqual(["rpc.hello"]);
  });

  it("asks for a new pairing when the relay refuses the credential itself", async () => {
    const h = harness();
    h.link.start();
    await connected(h);
    h.runtimes[0].drop(4401);
    await vi.advanceTimersByTimeAsync(1_000);
    await connected(h);
    expect(h.open.mock.calls[1][3]).toEqual({ refreshPairing: true });
    expect(h.runtimes[1].auth!.credential).toBe("i".repeat(43));
  });

  it("stops and says an update is needed when the runtime speaks a newer protocol", async () => {
    const h = harness();
    h.link.start();
    await connected(h);
    h.runtimes[0].drop(4103);
    expect(h.link.state.state).toBe("updateRequired");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  it("does not accept a runtime of another generation than its ticket, or one that grants a phone runtime scope", async () => {
    const older = harness();
    older.each((runtime) => (runtime.generation = 2));
    older.link.start();
    await vi.waitFor(() => expect(older.link.state.state).toBe("reconnecting"));
    expect(older.link.state).toMatchObject({ reason: "relay:4101" });
    expect(older.states.some((state) => state.state === "connected")).toBe(false);

    const generous = harness();
    generous.each((runtime) => (runtime.authority = "manage"));
    generous.link.start();
    await vi.waitFor(() => expect(generous.link.state.state).toBe("reconnecting"));
    expect(generous.states.some((state) => state.state === "connected")).toBe(false);
    expect(generous.link.problem).toMatchObject({ kind: "protocol" });
  });

  it("refuses an offer that is not a session-scope, authenticated relay offer", async () => {
    for (const fields of [{ scope: "runtime" }, { identityMode: "inherit" }, { relay: undefined }]) {
      const h = harness();
      h.open.mockResolvedValue(ready({ pairingCode: pairingCode(fields) }) as never);
      h.link.start();
      await settle();
      expect(h.link.state.state).toBe("reconnecting");
      expect(h.runtimes).toEqual([]);
    }
  });

  it("reports the relay's refusal code, and never sends the device credential before the encrypted channel is up", async () => {
    const h = harness();
    h.each((runtime) => (runtime.refuse = 4404));
    h.link.start();
    await vi.waitFor(() => expect(h.link.state.state).toBe("reconnecting"));
    expect(h.link.state).toMatchObject({ reason: "relay:4404" });
    expect(h.link.problem).toEqual({ kind: "relay", code: 4404 });
    expect(h.runtimes[0].deviceToken).toBeNull();
  });

  it("closes for good: no retry, no late state", async () => {
    const h = harness();
    h.link.start();
    await connected(h);
    h.link.close();
    expect(h.link.state.state).toBe("idle");
    expect(h.runtimes[0].readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)).toEqual({ state: "idle" });
  });

  describe("a phone whose clock is wrong", () => {
    const real = Date.now;
    afterEach(() => {
      Date.now = real;
    });

    it("judges a ticket's expiry by the server's clock, so a phone 55 s ahead still connects", async () => {
      // By the phone's own clock the 60 s ticket has 5 s left, under the margin.
      Date.now = () => NOW + 55_000;
      const h = harness("ready", { serverNow: () => NOW });
      h.link.start();
      await connected(h);
      expect(h.open).toHaveBeenCalledTimes(1);
    });

    it("never asks again without a pause when a ticket is too old, and stops after a few tries", async () => {
      // No server time known, and the phone is far ahead: every ticket looks expired.
      Date.now = () => NOW + 120_000;
      const h = harness("ready", {});
      h.open.mockImplementation(async () => ready({ pairingCode: pairingCode({ relay: { v: 1, directorUrl: "https://relay.example.test", cellUrl: "https://cell.example.test", assignmentEpoch: 1, relayHostId, inviteToken: "i".repeat(43), inviteExpiresAt: NOW + 120_000 + 5 * 60_000, e2eeFraming: 2 } }) }) as never);
      h.link.start();
      await settle();
      expect(h.link.state).toMatchObject({ state: "reconnecting", attempt: 1, reason: "ticket" });
      expect((h.link.state as { retryInMs: number }).retryInMs).toBeGreaterThanOrEqual(125);
      // No tight loop: one request so far, and none without time passing.
      await settle();
      expect(h.open).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(h.link.state.state).toBe("stopped");
      expect(h.link.problem).toEqual({ kind: "gave-up" });
      expect(h.open).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1);
      expect(h.runtimes).toEqual([]);
    });
  });

  it("stops trying after a number of failures in a row, and tries again only when asked", async () => {
    const h = harness();
    h.open.mockRejectedValue(new CloudApiError("cloud_provider_unavailable", 503));
    h.link.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.link.state.state).toBe("stopped");
    expect(h.link.problem).toEqual({ kind: "gave-up" });
    expect(h.open).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1);
    // Left alone, and with the list read again and again, it asks nothing more.
    h.link.listChanged();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.open).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1);
    h.open.mockResolvedValue(ready() as never);
    h.link.reconnect();
    await connected(h);
  });

  it("backs off and gives up on a connection that keeps authenticating and then dropping", async () => {
    const h = harness();
    h.link.start();
    const delays: number[] = [];
    for (let drop = 0; drop < 40 && h.link.problem?.kind !== "gave-up"; drop++) {
      await connected(h);
      // Up for a moment only, then gone again.
      h.runtimes.at(-1)!.drop(1006);
      if (h.link.state.state !== "reconnecting") break;
      delays.push(h.link.state.retryInMs);
      await vi.advanceTimersByTimeAsync(h.link.state.retryInMs + 10);
    }
    // Each drop counted: the pauses grew, and it stopped by itself.
    expect(h.link.state.state).toBe("stopped");
    expect(h.link.problem).toEqual({ kind: "gave-up" });
    expect(h.open).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1);
    expect(delays.at(-1)!).toBeGreaterThan(delays[0]! * 8);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.open).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1);
  });

  it("forgets earlier failures once a connection has stayed up for a while", async () => {
    const h = harness();
    h.link.start();
    await connected(h);
    h.runtimes[0].drop(1006);
    expect(h.link.state).toMatchObject({ attempt: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    await connected(h);
    // Dropped again before it was stable: the count goes on.
    h.runtimes[1].drop(1006);
    expect(h.link.state).toMatchObject({ attempt: 2 });
    await vi.advanceTimersByTimeAsync(1_000);
    await connected(h);
    await vi.advanceTimersByTimeAsync(STABLE_AFTER_MS + 100);
    h.runtimes[2].drop(1006);
    expect(h.link.state).toMatchObject({ attempt: 1 });
  });

  it("asks less and less often for a runtime that is not ready, and stops", async () => {
    const h = harness();
    h.open.mockResolvedValue({ id: "a1", workspaceId: "ws-1", state: "waiting-for-runtime", authority: "participate", expiresAt: NOW } as never);
    h.link.start();
    await settle();
    await vi.advanceTimersByTimeAsync(1_600);
    expect(h.open).toHaveBeenCalledTimes(2);
    // The second wait is longer than the first.
    await vi.advanceTimersByTimeAsync(1_600);
    expect(h.open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.open).toHaveBeenCalledTimes(MAX_WAITS + 1);
    expect(h.link.state.state).toBe("stopped");
    expect(h.link.problem).toEqual({ kind: "gave-up" });
  });

  it("waits for the list, without asking, while a workspace is starting", async () => {
    const h = harness("resuming");
    h.link.start();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.link.state.state).toBe("waitingForRuntime");
    expect(h.open).not.toHaveBeenCalled();
    h.list("ready");
    h.link.listChanged();
    await connected(h);
  });

  it("says an update is needed when the API answers in a shape this app does not know, and does not retry", async () => {
    const h = harness();
    h.open.mockRejectedValue(new CloudApiError("cloud_workspace_invalid_response", 200));
    h.link.start();
    await settle();
    expect(h.link.state.state).toBe("updateRequired");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  it("takes an older runtime that does not state an authority at the API's word", async () => {
    const h = harness();
    h.each((runtime) => (runtime.authority = undefined as never));
    h.link.start();
    await connected(h);
    expect(h.link.state).toMatchObject({ authority: "participate" });
  });

  it("asks for a new pairing after it was closed and started again (the app came back)", async () => {
    const h = harness();
    h.link.start();
    await connected(h);
    h.link.close();
    h.link.start();
    await connected(h);
    expect(h.open.mock.calls[1][3]).toEqual({ refreshPairing: true });
  });
});
