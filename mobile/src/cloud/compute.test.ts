import { describe, expect, it } from "vitest";
import { CloudApiError } from "./api";
import { computeHref, computeProviderHref, connectFailure, disconnectFailure, keyStored, listFailure, managesCompute, needsAttention, providerFacts, whenText } from "./compute";

// PRO-528: what the compute pages (25.03) say, and when.

const offering = { locations: "required", sources: "none", machineClasses: "catalog", pricingSource: "estimate", suspendedBilling: "none" };
const capabilities = { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: true, computeRunsUntilStopped: false };
const facts = (change: { offering?: Partial<typeof offering>; stopStart?: boolean; release?: string } = {}) =>
  providerFacts({ capabilities: change.release ? { releaseDisposition: change.release } : undefined, descriptor: { offering: { ...offering, ...change.offering }, capabilities: { ...capabilities, stopStart: change.stopStart ?? true } } }).map((fact) => fact.text);

describe("what to know about a provider", () => {
  it("says the console's sentences by the console's rule", () => {
    expect(facts({ release: "destroyed" })).toEqual(["You choose the machine's location.", "Prices shown are estimates.", "Provider resources are permanently destroyed when released."]);
    expect(facts({ offering: { locations: "automatic", sources: "optional", pricingSource: "provider-rate" }, release: "archived", stopStart: false })).toEqual([
      "Location is selected automatically by the provider.",
      "A source or template is optional.",
      "Prices come from the provider's live rates.",
      "Provider resources are archived rather than permanently deleted when released.",
      "This provider does not support suspending machines.",
    ]);
    expect(facts({ offering: { sources: "required" } })).toContain("You choose an image or template.");
  });

  it("says nothing of a value it does not know, rather than guess", () => {
    expect(facts({ offering: { locations: "by-lottery", sources: "sometimes", pricingSource: "unavailable" }, release: "recycled" })).toEqual([]);
  });
});

describe("the key's facts", () => {
  it("says a time of today as a time, and any other day as its date", () => {
    const now = new Date(2026, 10, 23, 10, 25).getTime();
    expect(whenText(new Date(2026, 10, 23, 10, 2).getTime(), now)).toBe("today, 10:02");
    expect(whenText(new Date(2026, 10, 22, 23, 59).getTime(), now)).toBe("22 Nov 2026");
    expect(whenText(new Date(2025, 0, 5, 9, 0).getTime(), now)).toBe("5 Jan 2025");
    expect(whenText(Number.NaN, now)).toBe("Unknown");
  });
});

describe("who manages compute, and what is stored", () => {
  it("goes by what the server says of each provider", () => {
    expect(managesCompute([{ canManage: false }, { canManage: true }])).toBe(true);
    expect(managesCompute([{ canManage: false }])).toBe(false);
    expect(managesCompute([])).toBe(false);
    expect(keyStored({ connection: { state: "connected", connectedAt: 1 } })).toBe(true);
    expect(keyStored({})).toBe(false);
    expect(needsAttention({ availability: "attention-required" })).toBe(true);
    expect(needsAttention({ availability: "available", connection: { state: "attention-required", connectedAt: 1 } })).toBe(true);
    expect(needsAttention({ availability: "available", connection: { state: "connected", connectedAt: 1 } })).toBe(false);
  });

  it("names the pages for the screens that lead to them", () => {
    expect(computeHref("org-1")).toEqual({ pathname: "/cloud/compute", params: { orgId: "org-1" } });
    expect(computeProviderHref("org-1", "agent37")).toEqual({ pathname: "/cloud/provider", params: { orgId: "org-1", providerId: "agent37" } });
  });
});

describe("a refused connect", () => {
  it.each([
    ["cloud_provider_credential_invalid", 422, "field", "Agent37 rejected that key. Paste it again, or make a new one."],
    ["cloud_provider_permission_denied", 403, "field", "The key is valid but not allowed to do something TerminalX needs. Check the permissions of the key."],
    ["cloud_provider_billing_required", 402, "field", "Agent37 needs billing set up on that account before it will act."],
    ["cloud_provider_unavailable", 503, "form", "Agent37 is not answering right now. The key was not stored. Try again in a moment."],
    ["cloud_provider_rate_limited", 429, "form", "Agent37 is not answering right now. The key was not stored. Try again in a moment."],
    ["organization_admin_required", 403, "form", "Only an organization owner or admin can connect compute. The key was not stored."],
  ])("%s is said in words, where it belongs", (code, status, where, text) => {
    expect(connectFailure(new CloudApiError(code, status), "Agent37")).toEqual({ where, text, stored: "no" });
  });

  it("says a key that never left the phone was not sent", () => {
    expect(connectFailure(new CloudApiError("cloud_workspace_unavailable", null, "network"), "Agent37")).toEqual({ where: "form", text: "No connection. The key was not sent. Try again when the phone is back online.", stored: "no", offline: true });
  });

  it.each([
    ["no answer in time", new CloudApiError("cloud_workspace_unavailable", null, "timeout")],
    ["a service error", new CloudApiError("internal_error", 500)],
    ["an error that is not the service's", new CloudApiError("cloud_workspace_unavailable", 502, "unreadable")],
    ["an answer this app cannot read", new CloudApiError("cloud_workspace_invalid_response", 200)],
    ["a code this app does not know", new CloudApiError("cloud_something_new", 409)],
    ["something that is not a refusal at all", new Error("boom")],
  ])("does not claim to know what became of the key after %s", (_what, error) => {
    expect(connectFailure(error, "Agent37")).toMatchObject({ where: "form", stored: "unknown" });
  });

  it("never repeats a code the server sent", () => {
    for (const code of ["cloud_something_new", "cloud_provider_credential_invalid", "internal_error"]) expect(connectFailure(new CloudApiError(code, 409), "Agent37").text).not.toContain(code);
  });
});

describe("a refused disconnect", () => {
  it("says what to do first when the provider still holds workspaces", () => {
    expect(disconnectFailure(new CloudApiError("cloud_provider_disposition_required", 409), "Boat")).toEqual({ blocked: true, title: "Boat still holds workspaces", text: "Delete this organization’s workspaces on Boat first, then disconnect. Nothing was changed." });
  });

  it("says anything else under the page, and claims nothing it does not know", () => {
    expect(disconnectFailure(new CloudApiError("cloud_workspace_unavailable", null, "network"), "Boat")).toEqual({ blocked: false, text: "No connection. Nothing was changed. Try again when the phone is back online." });
    expect(disconnectFailure(new CloudApiError("cloud_workspace_unavailable", null, "timeout"), "Boat")).toEqual({ blocked: false, text: "The service did not answer. Check whether Boat is still connected before trying again." });
    expect(disconnectFailure(new CloudApiError("organization_admin_required", 403), "Boat").text).toBe("Only an organization owner or admin can disconnect compute.");
  });
});

describe("a provider list that could not be read", () => {
  it("is one sentence, by why", () => {
    expect(listFailure(new CloudApiError("cloud_workspace_unavailable", null, "network"))).toEqual({ title: "Providers could not be read", detail: "The service could not be reached. Nothing was changed." });
    expect(listFailure(new CloudApiError("account_signed_out", 401)).title).toBe("Sign in again");
    expect(listFailure(new CloudApiError("cloud_workspace_invalid_response", 200)).title).toBe("Update the app");
  });
});
