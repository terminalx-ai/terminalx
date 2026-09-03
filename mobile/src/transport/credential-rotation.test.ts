import { describe, expect, it } from "vitest";
import type { HostCredential } from "../store/hosts";
import { applyResumeConfirmation } from "./credential-confirmation";

const credential: HostCredential = {
  v: 1,
  deviceToken: "device",
  current: { token: "a".repeat(43), hash: "b".repeat(43), version: 2, expiresAt: 100 },
  grace: { token: "c".repeat(43), hash: "d".repeat(43), version: 1, expiresAt: 50 },
};

describe("relay credential confirmation", () => {
  it("persists a renewed current deadline only for the credential used", () => {
    const next = applyResumeConfirmation(credential, 2, { v: 1, reqId: "confirm", currentVersion: 2, acceptedAs: "current", renewed: true, resumeExpiresAt: 500 });
    expect(next.current.expiresAt).toBe(500);
    expect(applyResumeConfirmation(credential, 1, { v: 1, reqId: "confirm", currentVersion: 2, acceptedAs: "current", renewed: true, resumeExpiresAt: 500 })).toBe(credential);
  });

  it("updates the grace deadline when reconnecting with grace", () => {
    const next = applyResumeConfirmation(credential, 1, { v: 1, reqId: "confirm", currentVersion: 2, acceptedAs: "grace", renewed: false, resumeExpiresAt: 500, graceExpiresAt: 75 });
    expect(next.grace?.expiresAt).toBe(75);
    expect(next.current.expiresAt).toBe(100);
  });
});
