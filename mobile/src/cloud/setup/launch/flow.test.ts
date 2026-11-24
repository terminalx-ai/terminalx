import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiError, type CloudCredential, type CloudProvider, type CloudProviderSetup, type CloudQuote } from "../../api";
import { firstRunSetup, LaunchFlow, type Facts } from "./flow";

// PRO-530: one launch from the phone. These are the money rules: nothing is
// created but by the confirmation's Launch, never at a price that ran out,
// and one launch attempt is one idempotency key.
vi.mock("react-native", () => import("@mobile/ui/testing/native"));

const NOW = Date.UTC(2026, 10, 24, 10, 25);
const descriptor = { id: "box", label: "Boat", icon: "ship", order: 10, description: "", billing: "Per second, billed by Boat", billedByProvider: true, listed: true, credentialSource: "organization" as const, credentialFields: [], capabilities: { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: true }, offering: { locations: "automatic", sources: "none", machineClasses: "catalog", pricingSource: "provider-rate", suspendedBilling: "none" }, allowedIdleSuspendMinutes: [5, 15, 0], allowedRetentionDays: [7] };
const provider: CloudProvider = { id: "box", displayName: "Boat", availability: "available", canManage: true, descriptor };
const defaults = { sourceId: "default", locationId: "eu", machineClassId: "small", idleSuspendMinutes: 15, retentionDays: 7, networkPolicy: "relay-only" as const };
const setup: CloudProviderSetup = { provider: "box", credentialFingerprint: "fp", currency: "USD", pricing: "provider-rate", pricingObservedAt: NOW, sources: [], locations: [{ id: "eu", label: "Automatic EU placement", placement: "automatic" }], machineClasses: [{ id: "small", label: "Small", vcpu: 2, memoryMiB: 4096, diskGiB: 40, activeHourlyMicros: 18_000 }], defaults, allowedIdleSuspendMinutes: [5, 15, 0], allowedRetentionDays: [7], maxIdleSuspendMinutes: null };
const login = (id: string, kind: string, state = "connected"): CloudCredential => ({ id, provider: kind, authKind: "api-key", fingerprint: "f", version: 1, updatedAt: NOW, state, sharedUse: "organization", epoch: 1 });
const credentials = [login("cred-codex", "codex"), login("cred-claude", "claude"), login("cred-github", "github")];
const facts: Facts = { provider, setup, credentials, organizationName: "Northwind" };
let quotes = 0;
const quote = (micros = 18_000, expiresAt = NOW + 300_000): CloudQuote => ({ id: `quote-${++quotes}`, provider: "box", expiresAt, currency: "USD", pricing: "provider-rate", pricingObservedAt: NOW, activeHourlyMicros: micros, alwaysOnThirtyDayMicros: micros * 720, configuration: { ...defaults, sourceLabel: "Default", locationLabel: "Automatic EU placement", machineClassLabel: "Small", vcpu: 2, memoryMiB: 4096, diskGiB: 40, architecture: "x86_64" } });
const launched = { workspace: { id: "ws-new", orgId: "org-n", name: "Checkout redesign", provider: "box", state: "provisioning" }, operation: { id: "op-1", workspaceId: "ws-new", type: "create", state: "queued", stage: null, cancelable: true, createdAt: NOW, updatedAt: NOW } };

function world() {
  let clock = NOW;
  let keys = 0;
  const api = {
    serverNow: vi.fn(() => clock),
    preflight: vi.fn(async () => ({ version: 1 as const, ready: true, checks: [] })),
    quote: vi.fn(async () => quote()),
    createWorkspace: vi.fn(async () => launched),
  };
  const flow = new LaunchFlow({ api: api as never, orgId: "org-n", newKey: () => `key-${++keys}` });
  flow.edit({ name: "Checkout redesign", providerId: "box", selection: defaults, agents: ["cred-codex"] });
  return { api, flow, tick: (ms: number) => { clock += ms; } };
}
const keyOf = (api: ReturnType<typeof world>["api"], call: number) => (api.createWorkspace.mock.calls[call] as unknown[])[2];
const timeout = () => new CloudApiError("cloud_workspace_unavailable", null, "timeout");

beforeEach(() => { quotes = 0; });

describe("pricing", () => {
  it("checks, then quotes, and creates nothing", async () => {
    const { api, flow } = world();
    expect(await flow.price(facts)).toBe(true);
    expect(api.preflight).toHaveBeenCalledWith("org-n", { credentialIds: ["cred-codex"] });
    expect(api.quote).toHaveBeenCalledWith("org-n", { provider: "box", ...defaults });
    expect(api.createWorkspace).not.toHaveBeenCalled();
    expect(flow.getSnapshot().review?.quote.id).toBe("quote-1");
  });

  it("lists every failed check, does not quote, and keeps Review price off until each field changes", async () => {
    const { api, flow } = world();
    flow.edit({ repository: { url: "github.com/acme/app", ref: "" } });
    api.preflight.mockResolvedValueOnce({ version: 1, ready: false, checks: [
      { kind: "repository", cloneUrl: "https://github.com/acme/app.git", status: "failed", errorCode: "cloud_workspace_repository_credential_required" },
      { kind: "credential", provider: "codex", credentialId: "cred-codex", status: "failed", errorCode: "cloud_agent_credential_reauth_required" },
      { kind: "credential", provider: "github", credentialId: "cred-github", status: "verified" },
    ] } as never);
    expect(await flow.price(facts)).toBe(false);
    expect(api.quote).not.toHaveBeenCalled();
    const check = flow.getSnapshot().check;
    expect(check.state === "problems" && check.problems.map((problem) => problem.text)).toEqual(["acme/app: this repository needs a GitHub personal access token.", "Codex: sign-in required."]);
    expect(flow.canPrice()).toBe(false);
    flow.edit({ name: "Another name" });
    expect(flow.canPrice()).toBe(false);
    flow.edit({ repository: null });
    expect(flow.canPrice()).toBe(false);
    flow.edit({ agents: [] });
    expect(flow.canPrice()).toBe(true);
  });

  it("clears what failed for want of a login once the logins read again have changed", async () => {
    const { api, flow } = world();
    api.preflight.mockResolvedValueOnce({ version: 1, ready: false, checks: [{ kind: "credential", provider: "codex", credentialId: "cred-codex", status: "failed", errorCode: "cloud_agent_credential_reauth_required" }] } as never);
    await flow.price(facts);
    flow.loginsRead(credentials);
    expect(flow.canPrice()).toBe(false);
    flow.loginsRead([{ ...credentials[0]!, version: 2 }, credentials[1]!, credentials[2]!]);
    expect(flow.canPrice()).toBe(true);
  });

  it("sends the GitHub login with a repository, and only connected logins", () => {
    expect(firstRunSetup({ repository: { url: "https://github.com/acme/app", ref: " main " }, agents: ["cred-codex", "cred-gone"] }, [...credentials, login("cred-gone", "cursor", "revoked")]))
      .toEqual({ repositories: [{ cloneUrl: "https://github.com/acme/app.git", ref: "main" }], credentialIds: ["cred-github", "cred-codex"] });
    expect(firstRunSetup({ repository: null, agents: ["cred-claude"] }, credentials)).toEqual({ credentialIds: ["cred-claude"] });
  });

  it("says a refused check or quote in its own words and lets Review price try again", async () => {
    const { api, flow } = world();
    api.quote.mockRejectedValueOnce(new CloudApiError("cloud_workspace_policy_denied", 403));
    expect(await flow.price(facts)).toBe(false);
    const check = flow.getSnapshot().check;
    expect(check.state === "refused" && check.error.code).toBe("cloud_workspace_policy_denied");
    expect(flow.canPrice()).toBe(true);
  });
});

describe("launching", () => {
  it("sends the quote with the spend confirmation, and the setup that was checked", async () => {
    const { api, flow } = world();
    await flow.price(facts);
    expect(await flow.launch()).toBe(launched);
    expect(api.createWorkspace).toHaveBeenCalledWith("org-n", { name: "Checkout redesign", quoteId: "quote-1", confirmProviderSpend: true, setup: { credentialIds: ["cred-codex"] } }, "key-1");
  });

  it("retries a launch that timed out, or whose answer was lost, with the same idempotency key", async () => {
    const { api, flow } = world();
    await flow.price(facts);
    api.createWorkspace.mockRejectedValueOnce(timeout()).mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", 503));
    expect(await flow.launch()).toBeNull();
    expect(flow.getSnapshot().review?.error?.reason).toBe("timeout");
    expect(await flow.launch()).toBeNull();
    expect(await flow.launch()).toBe(launched);
    expect(api.createWorkspace).toHaveBeenCalledTimes(3);
    expect([keyOf(api, 0), keyOf(api, 1), keyOf(api, 2)]).toEqual(["key-1", "key-1", "key-1"]);
  });

  it("gives a new key to a launch after a changed form", async () => {
    const { api, flow } = world();
    await flow.price(facts);
    api.createWorkspace.mockRejectedValueOnce(timeout());
    await flow.launch();
    flow.edit({ name: "Checkout redesign, take two" });
    await flow.price(facts);
    await flow.launch();
    expect([keyOf(api, 0), keyOf(api, 1)]).toEqual(["key-1", "key-2"]);
    expect((api.createWorkspace.mock.calls[1] as unknown[])[1]).toMatchObject({ name: "Checkout redesign, take two", quoteId: "quote-2" });
  });

  it("gives a new key to a launch on a new quote", async () => {
    const { api, flow, tick } = world();
    await flow.price(facts);
    api.createWorkspace.mockRejectedValueOnce(timeout());
    await flow.launch();
    tick(301_000);
    flow.expire();
    api.quote.mockResolvedValueOnce(quote(18_000, NOW + 900_000));
    await flow.requote();
    await flow.launch();
    expect([keyOf(api, 0), keyOf(api, 1)]).toEqual(["key-1", "key-2"]);
    expect((api.createWorkspace.mock.calls[1] as unknown[])[1]).toMatchObject({ quoteId: "quote-2" });
  });

  it("makes a new attempt after the server refused one", async () => {
    const { api, flow } = world();
    await flow.price(facts);
    api.createWorkspace.mockRejectedValueOnce(new CloudApiError("cloud_workspace_concurrency_exceeded", 409));
    await flow.launch();
    await flow.launch();
    expect([keyOf(api, 0), keyOf(api, 1)]).toEqual(["key-1", "key-2"]);
  });

  it("never launches once the countdown has run out, and asks for a new price", async () => {
    const { api, flow, tick } = world();
    await flow.price(facts);
    tick(300_000);
    expect(await flow.launch()).toBeNull();
    expect(api.createWorkspace).not.toHaveBeenCalled();
    expect(flow.getSnapshot().review?.expired).toBe(true);
    // Expired stays expired, whatever the clock says next: only a new price goes on.
    tick(-120_000);
    expect(await flow.launch()).toBeNull();
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });

  it("never launches a quote the countdown marked expired", async () => {
    const { api, flow } = world();
    await flow.price(facts);
    flow.expire();
    expect(await flow.launch()).toBeNull();
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });

  it("asks for a new price when the server says the quote expired at launch, and never sends the old one again", async () => {
    const { api, flow } = world();
    await flow.price(facts);
    api.createWorkspace.mockRejectedValueOnce(new CloudApiError("cloud_workspace_quote_expired", 409));
    expect(await flow.launch()).toBeNull();
    expect(flow.getSnapshot().review).toMatchObject({ expired: true, error: null });
    expect(await flow.launch()).toBeNull();
    expect(api.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("says what a new price that differs was, and launches only at the new one", async () => {
    const { api, flow, tick } = world();
    await flow.price(facts);
    tick(300_000);
    flow.expire();
    api.quote.mockResolvedValueOnce(quote(20_000, NOW + 600_000));
    await flow.requote();
    const review = flow.getSnapshot().review!;
    expect(review).toMatchObject({ expired: false, previous: { activeHourlyMicros: 18_000 }, quote: { activeHourlyMicros: 20_000 } });
    await flow.launch();
    expect((api.createWorkspace.mock.calls[0] as unknown[])[1]).toMatchObject({ quoteId: "quote-2" });
  });

  it("says nothing about a new price that is the same", async () => {
    const { api, flow } = world();
    await flow.price(facts);
    flow.expire();
    api.quote.mockResolvedValueOnce(quote(18_000, NOW + 600_000));
    await flow.requote();
    expect(flow.getSnapshot().review).toMatchObject({ expired: false, previous: null });
  });

  it("sends one launch at a time", async () => {
    const { api, flow } = world();
    await flow.price(facts);
    let answer: (value: typeof launched) => void = () => undefined;
    api.createWorkspace.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const first = flow.launch();
    expect(flow.getSnapshot().review?.launching).toBe(true);
    expect(await flow.launch()).toBeNull();
    answer(launched);
    expect(await first).toBe(launched);
    expect(api.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("has nothing to launch before a price was reviewed", async () => {
    const { api, flow } = world();
    expect(await flow.launch()).toBeNull();
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });
});
