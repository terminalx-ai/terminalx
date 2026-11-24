import { describe, expect, it } from "vitest";
import { CloudApiError, type CloudProvider } from "@mobile/cloud/api";
import { credentialOf, providerPage, storedAfterTimeout } from "./model";
import { checkedText, connectRefusal, dayText, providerFacts } from "./words";

const descriptor = (fields: CloudProvider["descriptor"]["credentialFields"]): CloudProvider["descriptor"] => ({
  id: "p", label: "P", icon: "server", order: 1, description: "", billing: "", billedByProvider: true, listed: true, credentialSource: "organization", credentialFields: fields,
  capabilities: { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: false },
  offering: { locations: "required", sources: "none", machineClasses: "catalog", pricingSource: "estimate", suspendedBilling: "none" },
  allowedIdleSuspendMinutes: [], allowedRetentionDays: [],
});
const key = [{ name: "credential", kind: "secret" as const, label: "Key" }];
const provider = (over: Partial<CloudProvider> = {}): CloudProvider => ({ id: "p", displayName: "P", availability: "not-connected", canManage: true, descriptor: descriptor(key), ...over });
const connected = (fingerprint: string, connectedAt: number) => provider({ availability: "available", connection: { state: "connected", connectedAt, credentialFingerprint: fingerprint } });

describe("storedAfterTimeout", () => {
  it("is true only when the list shows a key the provider did not have before", () => {
    expect(storedAfterTimeout(provider(), connected("sha256:a", 1))).toBe(true);
    expect(storedAfterTimeout(connected("sha256:a", 1), connected("sha256:b", 2))).toBe(true);
    expect(storedAfterTimeout(connected("sha256:a", 1), connected("sha256:a", 1))).toBe(false);
    expect(storedAfterTimeout(provider(), provider())).toBe(false);
    expect(storedAfterTimeout(provider(), null)).toBe(false);
  });
});

describe("providerPage", () => {
  it("is the form, the stored key, ready, or a member's view, from the list alone", () => {
    expect(providerPage(provider(), { replacing: false, justConnected: null })).toEqual({ kind: "form", replacing: false });
    expect(providerPage(connected("sha256:a", 1), { replacing: true, justConnected: null })).toEqual({ kind: "form", replacing: true });
    expect(providerPage(connected("sha256:a", 1), { replacing: false, justConnected: null })).toMatchObject({ kind: "connected", connection: { state: "connected", fingerprint: "sha256:a" } });
    expect(providerPage(provider({ availability: "attention-required", connection: { state: "attention-required", connectedAt: 1 } }), { replacing: false, justConnected: null })).toMatchObject({ kind: "connected", connection: { state: "attention-required" } });
    expect(providerPage(provider({ descriptor: descriptor([]), availability: "available" }), { replacing: false, justConnected: null })).toEqual({ kind: "ready" });
    expect(providerPage(provider({ canManage: false }), { replacing: false, justConnected: null })).toEqual({ kind: "member" });
  });
});

describe("credentialOf", () => {
  it("sends the one field's value, and nothing for a form of several", () => {
    expect(credentialOf(provider(), { credential: "k" })).toBe("k");
    expect(credentialOf(provider(), { credential: "" })).toBeNull();
    expect(credentialOf(provider({ descriptor: descriptor([...key, { name: "account", kind: "text", label: "Account" }]) }), { credential: "k", account: "a" })).toBeNull();
  });
});

describe("words", () => {
  it("says a refusal with the provider's name, and only a rejected key is cleared", () => {
    expect(connectRefusal(new CloudApiError("cloud_provider_credential_invalid", 422), "Boat")).toEqual({ where: "field", text: "Boat rejected that key. Paste it again, or make a new one.", clearKey: true });
    expect(connectRefusal(new CloudApiError("cloud_provider_rate_limited", 429), "Boat")).toEqual({ where: "form", text: "Boat is not answering right now. The key was not stored. Try again in a moment.", clearKey: false });
    expect(connectRefusal(new CloudApiError("cloud_provider_account_mismatch", 409), "Boat").text).toBe("That key is for a different provider account than the one connected here. Use a key from the same account.");
  });

  it("dates a key as the board does", () => {
    const at = new Date(2026, 10, 23, 10, 2).getTime();
    expect(dayText(at)).toBe("23 Nov 2026");
    expect(checkedText(at, new Date(2026, 10, 23, 18, 0).getTime())).toBe("today, 10:02");
    expect(checkedText(at, new Date(2026, 10, 25, 9, 0).getTime())).toBe("23 Nov 2026, 10:02");
  });

  it("says the descriptor's facts in the console's words", () => {
    expect(providerFacts(descriptor(key)).map((fact) => fact.text)).toEqual(["You choose the machine’s location.", "Prices shown are estimates."]);
    const other = descriptor(key);
    expect(providerFacts({ offering: { ...other.offering, locations: "automatic", sources: "required", pricingSource: "provider-rate" }, capabilities: { ...other.capabilities, stopStart: false } }).map((fact) => fact.text)).toEqual([
      "Location is selected automatically by the provider.", "You choose an image or template.", "Prices come from the provider’s live rates.", "This provider does not support suspending machines.",
    ]);
  });
});
