import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexLoginFlow, type CodexLoginStorage } from "./codex-login";
import { DEVICE, loginService, NOW, offline, ORG, refuse } from "./testing/login-service";

// PRO-529: the Codex device sign-in as the phone runs it, against the service's own answers.
const AGREED = { organizationSharing: true, machineInstallation: true } as const;

function keychain(initial: string | null = null) {
  const held = { value: initial };
  const storage: CodexLoginStorage = { get: async () => held.value, set: async (value) => { held.value = value; }, delete: async () => { held.value = null; } };
  return { held, storage };
}

function make(options: { userId?: string; orgId?: string; kept?: string | null } = {}) {
  const service = loginService();
  const chain = keychain(options.kept ?? null);
  const flow = new CodexLoginFlow({ api: service.api, orgId: options.orgId ?? ORG, userId: options.userId ?? "user-1", storage: chain.storage });
  return { service, flow, chain, polls: () => service.sent("POST", "/codex/device-poll"), cancels: () => service.sent("POST", "/codex/device-cancel") };
}
const pass = (milliseconds: number) => vi.advanceTimersByTimeAsync(milliseconds);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("a new sign-in", () => {
  it("shows the code, keeps the attempt on the phone, and asks no sooner than the service's interval", async () => {
    const { flow, chain, polls } = make();
    await flow.start(AGREED);
    expect(flow.getSnapshot()).toMatchObject({ phase: "waiting", opened: false, offline: false, login: { userCode: "K7QM-4TXP", verificationUri: DEVICE.verificationUri, expiresAt: NOW + 900_000 } });
    expect(JSON.parse(chain.held.value!)).toMatchObject({ v: 1, userId: "user-1", orgId: ORG, opened: false, login: { attemptId: "attempt_1", userCode: "K7QM-4TXP" } });
    await pass(4_999);
    expect(polls()).toHaveLength(0);
    await pass(1);
    expect(polls()).toHaveLength(1);
    expect(polls()[0]!.body).toEqual({ attemptId: "attempt_1", deviceAuthId: "device-auth-1", userCode: "K7QM-4TXP", confirmOrganizationSharing: true, confirmMachineInstallation: true });
    await pass(5_000);
    expect(polls()).toHaveLength(2);
  });

  it("never starts a second one while the first is waiting", async () => {
    const { flow, service } = make();
    await flow.start(AGREED);
    await flow.start(AGREED);
    expect(service.starts).toBe(1);
  });

  it("ends with the login the service stored, and keeps nothing of the attempt", async () => {
    const { flow, service, chain, polls } = make();
    await flow.start(AGREED);
    service.device = "complete";
    await pass(5_000);
    expect(flow.getSnapshot()).toMatchObject({ phase: "done", credential: { provider: "codex", displayIdentity: "alex@example.com" } });
    expect(chain.held.value).toBeNull();
    await pass(60_000);
    expect(polls()).toHaveLength(1);
  });

  it.each([["expired", "expired"], ["canceled", "canceled"], ["failed", "failed"]] as const)("stops asking when the service says %s", async (answer, phase) => {
    const { flow, service, chain, polls } = make();
    await flow.start(AGREED);
    service.device = answer;
    await pass(5_000);
    expect(flow.getSnapshot()).toMatchObject({ phase, code: "K7QM-4TXP" });
    expect(chain.held.value).toBeNull();
    await pass(60_000);
    expect(polls()).toHaveLength(1);
  });

  it("expires by the clock without asking again", async () => {
    const { flow, polls } = make();
    await flow.start(AGREED);
    await pass(895_000);
    const asked = polls().length;
    await pass(5_000);
    expect(flow.getSnapshot()).toEqual({ phase: "expired", code: "K7QM-4TXP" });
    expect(polls()).toHaveLength(asked);
  });

  it("says no code could be had when the service has none to give", async () => {
    const { flow, service, chain } = make();
    service.on("POST", "/codex/device-start", () => refuse("cloud_workspace_device_auth_unavailable", 503));
    await flow.start(AGREED);
    expect(flow.getSnapshot()).toEqual({ phase: "unavailable", refusal: "device-login-unavailable" });
    expect(chain.held.value).toBeNull();
  });

  it("stops the code working when the person gave up before it arrived, and never shows it", async () => {
    const { flow, service, cancels } = make();
    let arrive!: () => void;
    service.on("POST", "/codex/device-start", () => new Promise((resolve) => { arrive = () => resolve({ body: DEVICE }); }));
    const starting = flow.start(AGREED);
    await pass(0);
    expect(flow.getSnapshot()).toEqual({ phase: "starting" });
    flow.abandon();
    expect(flow.getSnapshot()).toEqual({ phase: "idle" });
    arrive();
    await starting;
    await pass(0);
    expect(flow.getSnapshot()).toEqual({ phase: "idle" });
    expect(cancels()).toHaveLength(1);
    expect(cancels()[0]!.body).toEqual({ attemptId: "attempt_1", deviceAuthId: "device-auth-1", userCode: "K7QM-4TXP" });
  });
});

describe("while waiting", () => {
  it("carries on by itself through a spell with no network", async () => {
    const { flow, service, polls } = make();
    await flow.start(AGREED);
    service.on("POST", "/codex/device-poll", offline);
    await pass(5_000);
    expect(flow.getSnapshot()).toMatchObject({ phase: "waiting", offline: true });
    service.restore("POST", "/codex/device-poll");
    await pass(5_000);
    expect(flow.getSnapshot()).toMatchObject({ phase: "waiting", offline: false });
    expect(polls()).toHaveLength(2);
  });

  it("keeps waiting when the service is briefly unable to answer", async () => {
    const { flow, service } = make();
    await flow.start(AGREED);
    service.on("POST", "/codex/device-poll", () => refuse("cloud_provider_unavailable", 503));
    await pass(5_000);
    expect(flow.getSnapshot()).toMatchObject({ phase: "waiting", offline: false });
  });

  it.each([["cloud_workspace_device_auth_not_found", 404, "device-login-not-found"], ["organization_admin_required", 403, "admin-required"]] as const)("ends when the service refuses the question (%s)", async (code, status, refusal) => {
    const { flow, service } = make();
    await flow.start(AGREED);
    service.on("POST", "/codex/device-poll", () => refuse(code, status));
    await pass(5_000);
    expect(flow.getSnapshot()).toEqual({ phase: "failed", code: "K7QM-4TXP", refusal });
  });

  it("asks nothing in the background and asks at once on coming back", async () => {
    const { flow, polls } = make();
    await flow.start(AGREED);
    flow.pause();
    await pass(60_000);
    expect(polls()).toHaveLength(0);
    flow.wake();
    await pass(0);
    expect(polls()).toHaveLength(1);
  });

  it("remembers that the sign-in page was opened", async () => {
    const { flow, chain } = make();
    await flow.start(AGREED);
    flow.markOpened();
    await pass(0);
    expect(flow.getSnapshot()).toMatchObject({ phase: "waiting", opened: true });
    expect(JSON.parse(chain.held.value!).opened).toBe(true);
  });
});

describe("cancelling", () => {
  it("tells the service, and ends canceled", async () => {
    const { flow, chain, cancels, polls } = make();
    await flow.start(AGREED);
    await flow.cancel();
    expect(cancels()[0]!.body).toEqual({ attemptId: "attempt_1", deviceAuthId: "device-auth-1", userCode: "K7QM-4TXP" });
    expect(flow.getSnapshot()).toEqual({ phase: "canceled", code: "K7QM-4TXP" });
    expect(chain.held.value).toBeNull();
    await pass(60_000);
    expect(polls()).toHaveLength(0);
  });

  it("keeps the login when the sign-in was approved first", async () => {
    const { flow, service } = make();
    await flow.start(AGREED);
    service.on("POST", "/codex/device-cancel", () => ({ body: { status: "connected" } }));
    service.device = "complete";
    await flow.cancel();
    expect(flow.getSnapshot()).toMatchObject({ phase: "done", credential: { provider: "codex" } });
  });

  it("goes on waiting when the service could not be told", async () => {
    const { flow, service, chain, polls } = make();
    await flow.start(AGREED);
    service.on("POST", "/codex/device-cancel", offline);
    await flow.cancel();
    expect(flow.getSnapshot()).toMatchObject({ phase: "waiting", canceling: false, cancelFailed: true, offline: true });
    expect(chain.held.value).not.toBeNull();
    await pass(5_000);
    expect(polls()).toHaveLength(1);
  });
});

describe("coming back to a sign-in", () => {
  const kept = (over: Record<string, unknown> = {}, login: Record<string, unknown> = {}) => JSON.stringify({ v: 1, userId: "user-1", orgId: ORG, opened: true, login: { attemptId: "attempt_1", deviceAuthId: "device-auth-1", userCode: "K7QM-4TXP", verificationUri: DEVICE.verificationUri, intervalSeconds: 5, expiresAt: NOW + 600_000, ...login }, ...over });

  it("carries on with the same code and asks at once, without starting another", async () => {
    const { flow, service, polls } = make({ kept: kept() });
    expect(await flow.resume(AGREED)).toBe(true);
    await pass(0);
    expect(flow.getSnapshot()).toMatchObject({ phase: "waiting", opened: true, login: { userCode: "K7QM-4TXP", expiresAt: NOW + 600_000 } });
    expect(service.starts).toBe(0);
    expect(polls()).toHaveLength(1);
  });

  it("survives the page going away: a new page picks the attempt up", async () => {
    const first = make();
    await first.flow.start(AGREED);
    first.flow.close();
    await pass(60_000);
    expect(first.polls()).toHaveLength(0);
    const second = make({ kept: first.chain.held.value });
    expect(await second.flow.resume(AGREED)).toBe(true);
    expect(second.flow.getSnapshot()).toMatchObject({ phase: "waiting", login: { attemptId: "attempt_1" } });
    expect(second.service.starts).toBe(0);
  });

  it.each([
    ["someone else's", kept({ userId: "user-2" })],
    ["past its time", kept({}, { expiresAt: NOW })],
    ["unreadable", "{not json"],
    ["in a shape this app does not know", JSON.stringify({ v: 2 })],
  ])("drops an attempt that is %s", async (_what, value) => {
    const { flow, chain, polls } = make({ kept: value });
    expect(await flow.resume(AGREED)).toBe(false);
    expect(flow.getSnapshot()).toEqual({ phase: "idle" });
    expect(chain.held.value).toBeNull();
    await pass(60_000);
    expect(polls()).toHaveLength(0);
  });

  it("leaves another organization's attempt for that organization", async () => {
    const { flow, chain } = make({ kept: kept({ orgId: "org-acme" }) });
    expect(await flow.resume(AGREED)).toBe(false);
    expect(chain.held.value).not.toBeNull();
  });
});
