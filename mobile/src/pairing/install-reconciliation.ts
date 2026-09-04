import type { DeviceCredentialInstalled } from "./contracts";

export function isSameInstalledCredential(left: DeviceCredentialInstalled, right: DeviceCredentialInstalled): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
