import { describe, expect, it } from "vitest";
import { DeviceCredentialInstalledSchema } from "./contracts";
import { isSameInstalledCredential } from "./install-reconciliation";

describe("pairing install reconciliation", () => {
  it("compares strict parsed results in their canonical field order", () => {
    const provisioned = DeviceCredentialInstalledSchema.parse({
      currentVersion: 1,
      authorizationMode: "relay-basis",
      reqId: "install-1",
      resumeExpiresAt: 500,
      v: 1,
    });
    const reconciled = DeviceCredentialInstalledSchema.parse({
      v: 1,
      reqId: "install-1",
      authorizationMode: "relay-basis",
      currentVersion: 1,
      resumeExpiresAt: 500,
    });

    expect(isSameInstalledCredential(provisioned, reconciled)).toBe(true);
    expect(isSameInstalledCredential(reconciled, { ...reconciled, currentVersion: 2 })).toBe(false);
  });
});
