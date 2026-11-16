import { api, type CloudProviderSummary } from "@/lib/api";
import { defaultOrgId } from "@/lib/cloudCatalog";
import { getAccount } from "@/lib/account";
import { CreateRefused, PROVIDER_CREATION_PAUSED, PROVIDER_NOT_OFFERED, listedNames, usableProviders } from "@/lib/cloudCreate";

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

/**
 * The connected providers whose new machines are paused (PRO-79): offered to
 * a new workspace once an owner or admin allows them. A hidden Machine0 is
 * not among them, since allowing it would not offer it.
 */
export function pausedProviders(providers: CloudProviderSummary[], orgId?: string | null): CloudProviderSummary[] {
  return providers.filter((provider) => provider.availability === "disabled-for-create" && (provider.id !== "machine0" || machine0Offered(orgId)));
}

/** The providers settings list: a hidden one only while the organization is still connected to it. */
export function listedProviders(providers: CloudProviderSummary[], orgId?: string | null): CloudProviderSummary[] {
  return providers.filter((provider) => provider.id !== "machine0" || Boolean(provider.connection) || machine0Offered(orgId));
}

/**
 * Why a new workspace has no provider to use, once `creatableProviders` is
 * empty (PRO-372). A provider that is connected but whose new machines are
 * paused (PRO-112), or whose connection needs attention, is not "no provider
 * connected": saying so asked people to connect again what they had connected
 * in the web console. The detail names the providers concerned.
 */
export function noProviderRefusal(providers: CloudProviderSummary[], orgId?: string | null): CreateRefused {
  const paused = pausedProviders(providers, orgId);
  if (paused.length) return new ProvidersPaused(paused);
  const attention = providers.filter((provider) => provider.availability === "attention-required" && (provider.id !== "machine0" || machine0Offered(orgId)));
  if (attention.length) return new CreateRefused("cloud_provider_connection_attention_required", listedNames(attention.map((provider) => provider.displayName)));
  return new CreateRefused("cloud_provider_connection_required");
}

/** No provider to use because new machines are paused on these, connected ones: the refusal carries them, so a manager can allow them in place. */
export class ProvidersPaused extends CreateRefused {
  constructor(public readonly providers: CloudProviderSummary[]) {
    super(PROVIDER_CREATION_PAUSED, listedNames(providers.map((provider) => provider.displayName)));
  }
}

/**
 * Allow new machines on a paused provider of the active organization (owners
 * and admins), then read its providers again. When the server still pauses
 * it, its own capability says no (an environment switch or a pilot list), not
 * the setting: refused with PROVIDER_NOT_OFFERED so the reader is told, rather
 * than the button seeming to do nothing.
 */
export async function allowNewMachines(provider: CloudProviderSummary): Promise<CloudProviderSummary[]> {
  const revision = getAccount().status.context?.revision;
  if (!revision) throw new CreateRefused("active_organization_required");
  await api.cloudProviderSetCreationEnabled(provider.id, revision, true);
  const { providers } = await api.cloudProviders();
  if (!usableProviders(providers).some((item) => item.id === provider.id)) throw new CreateRefused(PROVIDER_NOT_OFFERED, provider.displayName);
  return providers;
}
