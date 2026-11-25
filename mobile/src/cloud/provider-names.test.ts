import { describe, expect, it, vi } from "vitest";
import type { CloudProvider } from "./api";
import { ProviderNames } from "./provider-names";

const provider = (id: string, label: string, displayName = label) => ({ id, displayName, descriptor: { label } }) as unknown as CloudProvider;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("an organization's providers by name (PRO-566)", () => {
  it("names a provider id as the organization's list does, with one read for each organization", async () => {
    const providers = vi.fn(async (orgId: string) => (orgId === "org-1" ? [provider("agent37", "Agent37"), provider("box", "Boat")] : [provider("agent37", "Agent37 EU")]));
    const names = new ProviderNames({ providers });
    const changed = vi.fn();
    names.subscribe(changed);
    expect(names.getSnapshot().get("org-1")).toBeUndefined();
    names.need("org-1");
    names.need("org-1");
    names.need("org-2");
    await settled();
    expect(providers.mock.calls).toEqual([["org-1"], ["org-2"]]);
    expect(names.getSnapshot().get("org-1")?.get("agent37")).toBe("Agent37");
    expect(names.getSnapshot().get("org-1")?.get("box")).toBe("Boat");
    expect(names.getSnapshot().get("org-2")?.get("agent37")).toBe("Agent37 EU");
    expect(changed).toHaveBeenCalledTimes(2);
    // Read once: a row drawn later asks nothing more.
    names.need("org-1");
    await settled();
    expect(providers).toHaveBeenCalledTimes(2);
  });

  it("falls back to the provider's display name, and leaves a nameless one out", async () => {
    const names = new ProviderNames({ providers: async () => [provider("box", "", "Boat"), provider("other", " ", " ")] });
    names.need("org-1");
    await settled();
    expect(names.getSnapshot().get("org-1")?.get("box")).toBe("Boat");
    expect(names.getSnapshot().get("org-1")?.has("other")).toBe(false);
  });

  it("asks again after a read that failed, and tells nobody of the failure", async () => {
    const providers = vi.fn<(orgId: string) => Promise<CloudProvider[]>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([provider("agent37", "Agent37")]);
    const names = new ProviderNames({ providers });
    const changed = vi.fn();
    names.subscribe(changed);
    names.need("org-1");
    await settled();
    expect(changed).not.toHaveBeenCalled();
    expect(names.getSnapshot().get("org-1")).toBeUndefined();
    names.need("org-1");
    await settled();
    expect(names.getSnapshot().get("org-1")?.get("agent37")).toBe("Agent37");
  });
});
