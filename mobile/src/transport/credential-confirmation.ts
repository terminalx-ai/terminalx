import type { DeviceResumeConfirmed } from "../pairing/contracts";
import type { HostCredential } from "../store/hosts";

export function applyResumeConfirmation(credential: HostCredential, usedVersion: number, confirmation: DeviceResumeConfirmed): HostCredential {
  if (confirmation.acceptedAs === "current" && confirmation.renewed && credential.current.version === usedVersion && confirmation.currentVersion === usedVersion) {
    return { ...credential, current: { ...credential.current, expiresAt: confirmation.resumeExpiresAt } };
  }
  if (confirmation.acceptedAs === "grace" && credential.grace?.version === usedVersion && confirmation.graceExpiresAt) {
    return { ...credential, grace: { ...credential.grace, expiresAt: confirmation.graceExpiresAt } };
  }
  return credential;
}
