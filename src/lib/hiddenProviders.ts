import { api, type CloudProviderSummary } from "@/lib/api";
import { getAccount } from "@/lib/account";
import { cloudProviderIsPlatform, cloudProviderLabel, cloudProviderOffered, orderedCloudProviders } from "@/lib/cloudProviders";
import { CreateRefused, PROVIDER_CREATION_PAUSED, PROVIDER_NOT_OFFERED, listedNames, usableProviders } from "@/lib/cloudCreate";

// A provider can be hidden: the server lists it only while an organization
// is still connected to it, so it can disconnect and its workspaces can still
// be deleted, but never offers it as a new choice. Its descriptor says so
// (`listed: false`, PRO-415); the app names no provider to know it.

/** The providers a new workspace may pick, in their descriptors' order: available now, and not hidden. */
export function creatableProviders(providers: CloudProviderSummary[]): CloudProviderSummary[] {
  return orderedCloudProviders(usableProviders(providers).filter(cloudProviderOffered));
}

/**
 * The connected providers whose new machines are paused (PRO-79): offered to
 * a new workspace once an owner or admin allows them. A hidden provider is
 * not among them, since allowing it would not offer it.
 */
export function pausedProviders(providers: CloudProviderSummary[]): CloudProviderSummary[] {
  return orderedCloudProviders(providers.filter((provider) => provider.availability === "disabled-for-create" && cloudProviderOffered(provider)));
}

/** The providers settings list, in their descriptors' order: a hidden one only while the organization is still connected to it. */
export function listedProviders(providers: CloudProviderSummary[]): CloudProviderSummary[] {
  return orderedCloudProviders(providers.filter((provider) => cloudProviderOffered(provider) || Boolean(provider.connection)));
}

/**
 * Why a new workspace has no provider to use, once `creatableProviders` is
 * empty (PRO-372). A provider that is connected but whose new machines are
 * paused (PRO-112), or whose connection needs attention, is not "no provider
 * connected": saying so asked people to connect again what they had connected
 * in the web console. The detail names the providers concerned. A platform
 * provider that needs attention is named only when no connection of the
 * organization's does: that one somebody here can repair.
 */
export function noProviderRefusal(providers: CloudProviderSummary[]): CreateRefused {
  const paused = pausedProviders(providers);
  if (paused.length) return new ProvidersPaused(paused);
  const attention = providers.filter((provider) => provider.availability === "attention-required" && cloudProviderOffered(provider));
  const repairable = attention.filter((provider) => !cloudProviderIsPlatform(provider));
  if (repairable.length) return new CreateRefused("cloud_provider_connection_attention_required", listedNames(repairable.map(cloudProviderLabel)));
  // A provider TerminalX itself provides (PRO-452) has no connection for anyone
  // to repair in Settings: it is not offered for now, and trying later is all there is.
  if (attention.length) return new CreateRefused(PROVIDER_NOT_OFFERED, listedNames(attention.map(cloudProviderLabel)));
  return new CreateRefused("cloud_provider_connection_required");
}

/** No provider to use because new machines are paused on these, connected ones: the refusal carries them, so a manager can allow them in place. */
export class ProvidersPaused extends CreateRefused {
  constructor(public readonly providers: CloudProviderSummary[]) {
    super(PROVIDER_CREATION_PAUSED, listedNames(providers.map(cloudProviderLabel)));
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
  if (!usableProviders(providers).some((item) => item.id === provider.id)) throw new CreateRefused(PROVIDER_NOT_OFFERED, cloudProviderLabel(provider));
  return providers;
}
