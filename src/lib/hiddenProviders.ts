import type { CloudProviderSummary } from "@/lib/api";
import { defaultOrgId } from "@/lib/cloudCatalog";
import { getAccount } from "@/lib/account";
import { usableProviders } from "@/lib/cloudCreate";

// Machine0 is hidden while Boat is the launch provider (saas
// CLOUD_MACHINE0_ENABLED, 2026-10-17). A server that offers it says so in the
// organization's `cloud.machine0-byok-pilot.v1` flag, and one that hides it
// reports false. Hidden means not offered as a new choice: an organization
// still connected to Machine0 keeps seeing it in provider settings so it can
// disconnect, and its workspaces still list so they can be deleted.
const MACHINE0_OFFERED_FLAG = "cloud.machine0-byok-pilot.v1";

/** Whether the server offers Machine0 to this organization (default: the active one). */
export function machine0Offered(orgId?: string | null): boolean {
  const status = getAccount().status;
  const id = orgId ?? defaultOrgId(status);
  if (!id) return false;
  return status.organizations?.find((org) => org.id === id)?.cloud?.flags?.[MACHINE0_OFFERED_FLAG] === true;
}

/** The providers a new workspace may pick: available now, and not hidden. */
export function creatableProviders(providers: CloudProviderSummary[], orgId?: string | null): CloudProviderSummary[] {
  return usableProviders(providers).filter((provider) => provider.id !== "machine0" || machine0Offered(orgId));
}

/** The providers settings list: a hidden one only while the organization is still connected to it. */
export function listedProviders(providers: CloudProviderSummary[], orgId?: string | null): CloudProviderSummary[] {
  return providers.filter((provider) => provider.id !== "machine0" || Boolean(provider.connection) || machine0Offered(orgId));
}
