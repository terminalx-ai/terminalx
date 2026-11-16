import { describe, expect, it } from "vitest";
import type { CloudProviderDescriptor, CloudProviderSummary } from "@/lib/api";

const { creatableProviders, listedProviders, noProviderRefusal, pausedProviders } = await import("@/lib/hiddenProviders");

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
