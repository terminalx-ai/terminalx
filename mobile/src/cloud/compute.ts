import { CloudApiError, type CloudProvider } from "./api";

/**
 * What the compute screens (25.03) say. The board gives each sentence: some
 * are the web console's as they stand, some say the same in the phone's words
 * (PRO-568), and a refusal is the phone's own, since the server sends a code only.
 */

/** 25.03's words for the console's `computeSetupDescription`: what compute is, first, for someone who has never seen the console. */
export const COMPUTE_INTRO = "Cloud workspaces run on machines in a provider account. Connecting checks and stores a key; it creates no machine and spends nothing.";
/** The console's `computeSetupOwnerRequired`: who a member asks. */
export const COMPUTE_OWNER_REQUIRED = "An organization owner or admin must connect compute. You can continue using this organization.";
/** 25.03's words for the console's `cloudConnectBody`. The field's own Paste button says where the key goes; this says what becomes of it. */
export const KEY_HANDLING = "Sent once, encrypted at rest, and never shown again, here or anywhere.";
/** The console's `cloudConnectDisclosure`: the acknowledgement the server requires with every connect. */
export const connectDisclosure = (provider: string) => `I understand ${provider} bills this organization directly and every admin here can launch machines with this key.`;
/** The console's `cloudDisconnectTitle`, and its `cloudDisconnectBody` in 25.03's words. */
export const disconnectTitle = (provider: string) => `Disconnect ${provider}?`;
export const disconnectBody = (provider: string) => `Existing workspaces keep running. New ones cannot be launched on ${provider} until a key is connected again.`;

/** Where the compute pages live, for the screens that lead to them. */
export const computeHref = (orgId: string) => ({ pathname: "/cloud/compute", params: { orgId } }) as const;
export const computeProviderHref = (orgId: string, providerId: string) => ({ pathname: "/cloud/provider", params: { orgId, providerId } }) as const;

/** Whether this person may connect and disconnect compute here: the server says so on each provider it lists. */
export const managesCompute = (providers: readonly Pick<CloudProvider, "canManage">[]): boolean => providers.some((provider) => provider.canManage);

/** Whether a key is stored for this provider, as far as this person is told. */
export const keyStored = (provider: Pick<CloudProvider, "connection">): boolean => !!provider.connection;

/** Whether the server's last check of the stored key failed. */
export const needsAttention = (provider: Pick<CloudProvider, "availability" | "connection">): boolean => provider.availability === "attention-required" || provider.connection?.state === "attention-required";

export type ProviderFactKind = "location" | "source" | "pricing" | "release" | "suspend";

/**
 * What to know about a provider before launching on it, by the console's
 * rule and in its sentences (`providerFacts`). A value this app does not know
 * gets no line rather than a guess.
 */
export function providerFacts(provider: Pick<CloudProvider, "capabilities"> & { descriptor: Pick<CloudProvider["descriptor"], "offering" | "capabilities"> }): { kind: ProviderFactKind; text: string }[] {
  const { offering, capabilities } = provider.descriptor;
  const facts: { kind: ProviderFactKind; text: string }[] = [];
  if (offering.locations === "automatic") facts.push({ kind: "location", text: "Location is selected automatically by the provider." });
  else if (offering.locations === "required") facts.push({ kind: "location", text: "You choose the machine's location." });
  if (offering.sources === "optional") facts.push({ kind: "source", text: "A source or template is optional." });
  else if (offering.sources === "required") facts.push({ kind: "source", text: "You choose an image or template." });
  if (offering.pricingSource === "provider-rate") facts.push({ kind: "pricing", text: "Prices come from the provider's live rates." });
  else if (offering.pricingSource === "estimate") facts.push({ kind: "pricing", text: "Prices shown are estimates." });
  const release = provider.capabilities?.releaseDisposition;
  if (release === "archived") facts.push({ kind: "release", text: "Provider resources are archived rather than permanently deleted when released." });
  else if (release === "destroyed") facts.push({ kind: "release", text: "Provider resources are permanently destroyed when released." });
  if (!capabilities.stopStart) facts.push({ kind: "suspend", text: "This provider does not support suspending machines." });
  return facts;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (value: number) => String(value).padStart(2, "0");

/** A time as the key's facts say it: "today, 10:02", or the day ("23 Nov 2026") for any other day. */
export function whenText(at: number, now: number): string {
  const then = new Date(at);
  const today = new Date(now);
  if (!Number.isFinite(then.getTime())) return "Unknown";
  const sameDay = then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate();
  return sameDay ? `today, ${two(then.getHours())}:${two(then.getMinutes())}` : `${then.getDate()} ${MONTHS[then.getMonth()]} ${then.getFullYear()}`;
}

/** Why the provider list could not be shown. */
export function listFailure(error: unknown): { title: string; detail: string } {
  const refusal = error instanceof CloudApiError ? error.refusal : "unknown";
  if (refusal === "signed-out") return { title: "Sign in again", detail: "Your sign-in has expired. Nothing was changed." };
  if (refusal === "invalid-response") return { title: "Update the app", detail: "This version of the app cannot read the providers your account service offers." };
  if (refusal === "not-found" || refusal === "admin-required") return { title: "Organization unavailable", detail: "It is no longer on this account, or you are no longer a member of it." };
  return { title: "Providers could not be read", detail: "The service could not be reached. Nothing was changed." };
}

/**
 * What a failed connect says and where: under the key's field (`field`) or
 * under the form (`form`). `stored` is what is known of the key: `no` when the
 * refusal says it was not kept, `unknown` when no answer came that says
 * either way, so the screen reads the provider list before it says anything.
 */
export interface ConnectFailure {
  where: "field" | "form";
  text: string;
  stored: "no" | "unknown";
  /** No connection at all: drawn with the offline mark. */
  offline?: boolean;
}

export function connectFailure(error: unknown, provider: string): ConnectFailure {
  if (!(error instanceof CloudApiError)) return { where: "form", text: "That did not work. Paste the key and try again.", stored: "unknown" };
  // It never left the phone.
  if (error.reason === "network") return { where: "form", text: "No connection. The key was not sent. Try again when the phone is back online.", stored: "no", offline: true };
  switch (error.refusal) {
    case "provider-key-invalid": return { where: "field", text: `${provider} rejected that key. Paste it again, or make a new one.`, stored: "no" };
    case "provider-permission-denied": return { where: "field", text: "The key is valid but not allowed to do something TerminalX needs. Check the permissions of the key.", stored: "no" };
    case "provider-billing-required": return { where: "field", text: `${provider} needs billing set up on that account before it will act.`, stored: "no" };
    case "provider-key-other-account": return { where: "field", text: `That key belongs to another ${provider} account than the one connected here. Use a key of the same account, or disconnect first.`, stored: "no" };
    case "invalid-request": return { where: "field", text: "The service did not take that key as it was sent. Check it and paste it again.", stored: "no" };
    case "provider-unavailable":
    case "provider-rate-limited": return { where: "form", text: `${provider} is not answering right now. The key was not stored. Try again in a moment.`, stored: "no" };
    case "provider-not-offered": return { where: "form", text: `${provider} is not offered to this organization right now. The key was not stored.`, stored: "no" };
    case "provider-busy": return { where: "form", text: `Another change to ${provider} is under way for this organization. The key was not stored. Try again in a moment.`, stored: "no" };
    case "admin-required": return { where: "form", text: "Only an organization owner or admin can connect compute. The key was not stored.", stored: "no" };
    case "not-found": return { where: "form", text: `${provider} is no longer offered to this organization. The key was not stored.`, stored: "no" };
    case "signed-out": return { where: "form", text: "Your sign-in has expired. The key was not stored. Sign in again, then paste it.", stored: "no" };
    case "rate-limited": return { where: "form", text: "Too many requests just now. The key was not stored. Try again in a moment.", stored: "no" };
    // No answer in time, a service error, or an answer this app cannot read: the key may have been stored.
    default: return { where: "form", text: "The service did not answer. The key was not stored. Paste it and try again.", stored: "unknown" };
  }
}

/** What to say when no answer came and the provider list could not be read either. */
export const CONNECT_OUTCOME_UNKNOWN = "The service did not answer, so it is not known whether the key was stored. Open this page again when the phone is back online.";

/** Why a disconnect was refused. `blocked` is the provider still holding workspaces, said as an alert of its own. */
export function disconnectFailure(error: unknown, provider: string): { blocked: boolean; title?: string; text: string } {
  const refusal = error instanceof CloudApiError ? error.refusal : "unknown";
  if (refusal === "provider-has-machines") return { blocked: true, title: `${provider} still holds workspaces`, text: `Delete this organization’s workspaces on ${provider} first, then disconnect. Nothing was changed.` };
  if (error instanceof CloudApiError && error.reason === "network") return { blocked: false, text: "No connection. Nothing was changed. Try again when the phone is back online." };
  if (refusal === "provider-busy") return { blocked: false, text: `Another change to ${provider} is under way for this organization. Try again in a moment.` };
  if (refusal === "admin-required") return { blocked: false, text: "Only an organization owner or admin can disconnect compute." };
  if (refusal === "signed-out") return { blocked: false, text: "Your sign-in has expired. Sign in again, then disconnect." };
  if (refusal === "provider-unavailable" || refusal === "provider-rate-limited") return { blocked: false, text: `${provider} is not answering right now. Nothing was changed. Try again in a moment.` };
  return { blocked: false, text: `The service did not answer. Check whether ${provider} is still connected before trying again.` };
}
