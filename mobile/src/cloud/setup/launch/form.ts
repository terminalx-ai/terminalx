import { CloudApiError, type CloudApi, type CloudCredential, type CloudProvider, type CloudProviderSetup } from "../../api";
import { refusalText } from "../../words";
import type { Selection } from "./flow";
import { AGENT_LOGINS } from "./words";

/** What the form page shows before there is anything to set up (25.05, row 2). */
export type BlockedPage =
  | { kind: "connect" }
  | { kind: "paused" }
  | { kind: "unreadable"; detail: string };

/** The providers a workspace can be launched on now, in the server's order. */
export function launchableProviders(providers: readonly CloudProvider[]): CloudProvider[] {
  return providers.filter((provider) => provider.availability === "available");
}

/** With nothing to launch on: paused when the server holds new workspaces back, else compute to connect. */
export function nothingToLaunchOn(providers: readonly CloudProvider[]): BlockedPage | null {
  if (launchableProviders(providers).length) return null;
  return providers.some((provider) => provider.availability === "disabled-for-create") ? { kind: "paused" } : { kind: "connect" };
}

const PAUSED = new Set(["cloud_provisioning_paused", "cloud_provider_creation_disabled"]);

/** A read the form needs that did not answer, as the page it shows. */
export function readFailure(error: CloudApiError): BlockedPage {
  if (PAUSED.has(error.code)) return { kind: "paused" };
  if (error.refusal === "provider-not-connected") return { kind: "connect" };
  // The board's own sentence for no network; anything else as its refusal says it.
  return { kind: "unreadable", detail: error.refusal === "unreachable" ? "The service could not be reached. Nothing was launched." : refusalText(error) };
}

/**
 * The organization's stored logins, as the form may use them. Only owners
 * and admins read them; for anyone else the form offers none, and the server
 * says at the check whether the workspace needs one.
 */
export async function readLogins(api: Pick<CloudApi, "credentials">, orgId: string): Promise<CloudCredential[]> {
  try {
    return await api.credentials(orgId);
  } catch (error) {
    if (error instanceof CloudApiError && error.refusal === "admin-required") return [];
    throw error;
  }
}

/** The agent logins to offer: those the server says are connected, in its order. */
export function agentLogins(credentials: readonly CloudCredential[]): CloudCredential[] {
  return credentials.filter((credential) => credential.state === "connected" && AGENT_LOGINS.includes(credential.provider));
}

/** The provider's own defaults, the form's first choice. */
export function defaultSelection(setup: CloudProviderSetup): Selection {
  const { sourceId, locationId, machineClassId, idleSuspendMinutes, retentionDays, networkPolicy } = setup.defaults;
  return { sourceId, locationId, machineClassId, idleSuspendMinutes, retentionDays, networkPolicy };
}
