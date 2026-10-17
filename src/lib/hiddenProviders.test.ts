import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudProviderSummary } from "@/lib/api";

const account = vi.hoisted(() => ({ flags: {} as Record<string, boolean> }));
vi.mock("@/lib/account", async (original) => ({
  ...(await original<typeof import("@/lib/account")>()),
  getAccount: () => ({
    status: {
      state: "signed-in",
      identity: { name: null, email: "a@example.com", organization: "Acme", organizationId: "org-1" },
      organizations: [
        { id: "org-1", name: "Acme", role: "admin", cloud: { enabled: true, flags: account.flags } },
        { id: "org-2", name: "Other", role: "member", cloud: { enabled: true, flags: { "cloud.machine0-byok-pilot.v1": true } } },
      ],
    },
    ready: true,
    busy: false,
  }),
}));

const { creatableProviders, listedProviders, machine0Offered } = await import("@/lib/hiddenProviders");

const summary = (id: CloudProviderSummary["id"], overrides: Partial<CloudProviderSummary> = {}): CloudProviderSummary => ({
  id,
  displayName: id,
  availability: "available",
  canManage: true,
  connection: null,
  capabilities: {} as CloudProviderSummary["capabilities"],
  ...overrides,
});

const connected = { state: "connected" as const, connectedAt: 1, lastValidatedAt: null, credentialFingerprint: null };

beforeEach(() => {
  account.flags = {};
});

describe("hidden providers (Machine0)", () => {
  it("is hidden unless the server reports it offered", () => {
    expect(machine0Offered()).toBe(false);
    account.flags = { "cloud.machine0-byok-pilot.v1": false };
    expect(machine0Offered()).toBe(false);
    account.flags = { "cloud.machine0-byok-pilot.v1": true };
    expect(machine0Offered()).toBe(true);
  });

  it("answers for the organization asked about", () => {
    expect(machine0Offered("org-1")).toBe(false);
    expect(machine0Offered("org-2")).toBe(true);
    expect(machine0Offered("org-unknown")).toBe(false);
  });

  it("never offers a hidden Machine0 to a new workspace, even an available one", () => {
    const providers = [summary("machine0"), summary("box"), summary("hetzner", { availability: "not-connected" })];
    expect(creatableProviders(providers).map((provider) => provider.id)).toEqual(["box"]);
    account.flags = { "cloud.machine0-byok-pilot.v1": true };
    expect(creatableProviders(providers).map((provider) => provider.id)).toEqual(["machine0", "box"]);
  });

  it("keeps listing a hidden Machine0 in settings while it is still connected, so it can be disconnected", () => {
    const providers = [summary("machine0", { availability: "disabled-for-create", connection: connected }), summary("box")];
    expect(listedProviders(providers).map((provider) => provider.id)).toEqual(["machine0", "box"]);
    expect(listedProviders([summary("machine0", { availability: "not-connected" }), summary("box")]).map((provider) => provider.id)).toEqual(["box"]);
  });
});
