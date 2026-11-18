import { describe, expect, it } from "vitest";
import type { CloudProviderDescriptor, CloudProviderSummary } from "@/lib/api";

const { creatableProviders, listedProviders, noProviderRefusal, pausedProviders } = await import("@/lib/hiddenProviders");
const cloudProviders = await import("@/lib/cloudProviders");

// Which provider is hidden, and in what order they come, is the server's to
// say through each provider's descriptor (PRO-415): the ids here are made up
// on purpose, since no app code may name a provider.
const descriptor = (id: string, order: number, listed = true): CloudProviderDescriptor => ({
  id,
  label: id.toUpperCase(),
  icon: "cloud",
  order,
  description: `${id} machines`,
  billing: `Billed by ${id}`,
  billedByProvider: true,
  listed,
  credentialFields: [{ name: "credential", kind: "secret", label: `${id} key`, helpUrl: null }],
  capabilities: { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: false },
  offering: { locations: "required", sources: "none", machineClasses: "catalog", pricingSource: "provider-rate", suspendedBilling: "none" },
  allowedIdleSuspendMinutes: [10, 0],
  allowedRetentionDays: [30],
});

const summary = (id: string, order: number, overrides: Partial<CloudProviderSummary> & { listed?: boolean } = {}): CloudProviderSummary => {
  const { listed, ...rest } = overrides;
  return {
    id,
    displayName: id.toUpperCase(),
    availability: "available",
    canManage: true,
    connection: null,
    capabilities: {} as CloudProviderSummary["capabilities"],
    descriptor: descriptor(id, order, listed ?? true),
    ...rest,
  };
};

const connected = { state: "connected" as const, connectedAt: 1, lastValidatedAt: null, credentialFingerprint: null };

/**
 * A provider that runs on the platform's own credential (PRO-452), as the
 * server lists it: no credential fields, never "not connected", and no
 * connection of the organization's.
 */
const platform = (id: string, order: number, overrides: Partial<CloudProviderSummary> = {}): CloudProviderSummary =>
  summary(id, order, { descriptor: { ...descriptor(id, order), credentialSource: "platform", credentialFields: [] }, ...overrides });

// PRO-452: a platform provider has no connection, and none is asked for.
describe("platform providers", () => {
  const { cloudProviderCredentialSource, cloudProviderInPlace, cloudProviderIsPlatform, cloudProviderReady } = cloudProviders;

  it("reads whose credential a provider runs on, taking anything but `platform` for the organization's", () => {
    expect(cloudProviderCredentialSource(platform("plat", 1))).toBe("platform");
    expect(cloudProviderIsPlatform(platform("plat", 1))).toBe(true);
    // The descriptor by itself, as the app keeps it.
    expect(cloudProviderIsPlatform(platform("plat", 1).descriptor)).toBe(true);
    // An older server sends no field; a newer one may send a value this app does not know.
    expect(cloudProviderCredentialSource(summary("alpha", 2))).toBe("organization");
    expect(cloudProviderCredentialSource(summary("alpha", 2, { descriptor: { ...descriptor("alpha", 2), credentialSource: "organization" } }))).toBe("organization");
    expect(cloudProviderCredentialSource(summary("alpha", 2, { descriptor: { ...descriptor("alpha", 2), credentialSource: "something-new" as never } }))).toBe("organization");
    // A provider from a server older than descriptors, and no provider at all.
    expect(cloudProviderCredentialSource({ ...summary("old", 0), descriptor: null })).toBe("organization");
    expect(cloudProviderCredentialSource(null)).toBe("organization");
    // An id the app has read no descriptor for.
    expect(cloudProviderIsPlatform("never-described")).toBe(false);
  });

  it("is in place and ready without a connection, unless it needs attention", () => {
    expect(cloudProviderInPlace(platform("plat", 1))).toBe(true);
    expect(cloudProviderReady(platform("plat", 1))).toBe(true);
    // Paused for new machines, it is still in place and working.
    expect(cloudProviderReady(platform("plat", 1, { availability: "disabled-for-create" }))).toBe(true);
    expect(cloudProviderInPlace(platform("plat", 1, { availability: "attention-required" }))).toBe(true);
    expect(cloudProviderReady(platform("plat", 1, { availability: "attention-required" }))).toBe(false);
    // An organization's provider is in place once connected, as before.
    expect(cloudProviderInPlace(summary("alpha", 2, { availability: "not-connected" }))).toBe(false);
    expect(cloudProviderReady(summary("alpha", 2))).toBe(false);
    expect(cloudProviderInPlace(summary("alpha", 2, { connection: connected }))).toBe(true);
    expect(cloudProviderReady(summary("alpha", 2, { connection: connected }))).toBe(true);
    expect(cloudProviderReady(summary("alpha", 2, { connection: { ...connected, state: "attention-required" } }))).toBe(false);
  });

  it("is offered to a new workspace and listed in settings beside the organization's providers", () => {
    const providers = [summary("alpha", 2, { connection: connected }), platform("plat", 1), summary("beta", 3, { availability: "not-connected" })];
    expect(creatableProviders(providers).map((provider) => provider.id)).toEqual(["plat", "alpha"]);
    expect(listedProviders(providers).map((provider) => provider.id)).toEqual(["plat", "alpha", "beta"]);
    // By itself it is all a new workspace needs: nothing is "not connected".
    expect(creatableProviders([platform("plat", 1)]).map((provider) => provider.id)).toEqual(["plat"]);
  });

  it("can have its new machines paused and allowed like any other, and says so when it is the reason", () => {
    const paused = platform("plat", 1, { availability: "disabled-for-create" });
    expect(creatableProviders([paused])).toEqual([]);
    expect(pausedProviders([paused]).map((provider) => provider.id)).toEqual(["plat"]);
    const refusal = noProviderRefusal([paused, summary("beta", 2, { availability: "not-connected" })]);
    expect([refusal.code, refusal.detail]).toEqual(["cloud_provider_creation_paused", "PLAT"]);
  });

  it("is not offered for now when it needs attention: there is no connection of the organization's to repair", () => {
    const unavailable = platform("plat", 1, { availability: "attention-required" });
    const refusal = noProviderRefusal([unavailable, summary("beta", 2, { availability: "not-connected" })]);
    expect([refusal.code, refusal.detail]).toEqual(["cloud_provider_not_offered_for_create", "PLAT"]);
    // A connection the organization can repair is what it is told about, and only that one is named.
    const both = noProviderRefusal([unavailable, summary("alpha", 2, { availability: "attention-required", connection: { ...connected, state: "attention-required" } })]);
    expect([both.code, both.detail]).toEqual(["cloud_provider_connection_attention_required", "ALPHA"]);
  });
});

describe("hidden providers", () => {
  it("never offers a hidden provider to a new workspace, even an available one", () => {
    const providers = [summary("hid", 1, { listed: false }), summary("alpha", 2), summary("beta", 3, { availability: "not-connected" })];
    expect(creatableProviders(providers).map((provider) => provider.id)).toEqual(["alpha"]);
    expect(creatableProviders([summary("hid", 1), summary("alpha", 2)]).map((provider) => provider.id)).toEqual(["hid", "alpha"]);
  });

  it("orders providers as their descriptors say, whatever order the list came in", () => {
    const providers = [summary("beta", 20), summary("alpha", 10), summary("gamma", 30)];
    expect(creatableProviders(providers).map((provider) => provider.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(listedProviders(providers).map((provider) => provider.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("counts a provider from an older server, without a descriptor, as offered and last", () => {
    const bare = { ...summary("old", 0), descriptor: null };
    expect(creatableProviders([bare, summary("alpha", 5)]).map((provider) => provider.id)).toEqual(["alpha", "old"]);
  });

  it("keeps listing a hidden provider in settings while it is still connected, so it can be disconnected", () => {
    const providers = [summary("hid", 1, { listed: false, availability: "disabled-for-create", connection: connected }), summary("alpha", 2)];
    expect(listedProviders(providers).map((provider) => provider.id)).toEqual(["hid", "alpha"]);
    expect(listedProviders([summary("hid", 1, { listed: false, availability: "not-connected" }), summary("alpha", 2)]).map((provider) => provider.id)).toEqual(["alpha"]);
  });

  // PRO-112: what allowing new machines would offer, and a hidden provider is not that.
  it("counts a connected provider with new machines paused, but never a hidden one", () => {
    const providers = [
      summary("hid", 1, { listed: false, availability: "disabled-for-create", connection: connected }),
      summary("alpha", 2, { availability: "disabled-for-create", connection: connected }),
      summary("beta", 3),
    ];
    expect(pausedProviders(providers).map((provider) => provider.id)).toEqual(["alpha"]);
  });

  // PRO-372: a provider connected in the web console with its new machines paused is not "none connected".
  it("says why there is no provider to use: paused, needing attention, or none connected", () => {
    const paused = noProviderRefusal([summary("alpha", 1, { availability: "disabled-for-create", connection: connected }), summary("beta", 2, { availability: "not-connected" })]);
    expect([paused.code, paused.detail]).toEqual(["cloud_provider_creation_paused", "ALPHA"]);
    const both = noProviderRefusal([summary("alpha", 1, { availability: "disabled-for-create", connection: connected }), summary("beta", 2, { availability: "disabled-for-create", connection: connected })]);
    expect(both.detail).toBe("ALPHA and BETA");
    const attention = noProviderRefusal([summary("alpha", 1, { availability: "attention-required", connection: { ...connected, state: "attention-required" } })]);
    expect([attention.code, attention.detail]).toEqual(["cloud_provider_connection_attention_required", "ALPHA"]);
    expect(noProviderRefusal([summary("alpha", 1, { availability: "not-connected" })]).code).toBe("cloud_provider_connection_required");
    expect(noProviderRefusal([]).code).toBe("cloud_provider_connection_required");
    // A hidden provider, paused or needing attention, is no reason: allowing it would not offer it.
    expect(noProviderRefusal([summary("hid", 1, { listed: false, availability: "disabled-for-create", connection: connected })]).code).toBe("cloud_provider_connection_required");
    expect(noProviderRefusal([summary("hid", 1, { listed: false, availability: "attention-required", connection: connected })]).code).toBe("cloud_provider_connection_required");
  });
});
