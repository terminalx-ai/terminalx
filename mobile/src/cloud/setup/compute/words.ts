import type { CloudApiError, CloudProviderDescriptor } from "../../api";
import { refusalText } from "../../words";

/**
 * The words of board 25.03 (Connect compute). The server answers the phone
 * with a code and no sentence, so every sentence here is the phone's: the
 * board's, word for word, with the provider named as the server names it.
 * A refusal the board has no sentence for is said by `refusalText`, never by
 * its code.
 */

export const INTRO = "Cloud workspaces run on machines in a provider account. Connecting checks and stores a key; it creates no machine and spends nothing.";
export const ONE_IS_ENOUGH = "One provider is enough. A workspace picks its provider when it is launched.";
export const MEMBER = "An organization owner or admin must connect compute. You can continue using this organization.";
export const NONE_OFFERED = { title: "No providers are offered", detail: "Your account service offers no compute provider to this organization right now." };
export const UNREADABLE_TITLE = "Providers could not be read";
/** 25.03's "Could not be read": the service could not be reached, and a read changes nothing. */
export const UNREACHABLE_DETAIL = "The service could not be reached. Nothing was changed.";
export const READING_LABEL = "Reading compute providers";
export const KEY_HELPER = "Sent once, encrypted at rest, and never shown again, here or anywhere.";
export const FINGERPRINT_HELPER = "The key itself is never shown again. The line above is a fingerprint, to tell one key from another.";
export const CHECKING = "Checking the key…";
/** A provider that asks for more than one value: the phone's route takes one, so it cannot send them (`CloudApi.connectProvider`). */
export const SEVERAL_FIELDS = "This provider asks for more than one value, which the phone cannot send yet. Connect it from the desktop app or the web console.";

export const connectTitle = (provider: string) => `Connect ${provider}`;
export const replaceTitle = (provider: string) => `Replace ${provider} key`;

/** The acknowledgement the server requires with every connect: the console's one sentence, for both of its flags (owner's decision on 25.07, question 4). */
export const consentText = (provider: string) => `I understand ${provider} bills this organization directly and every admin here can launch machines with this key.`;

export const attentionText = (provider: string) => `${provider} rejected the stored key on its last check. Replace the key to continue. Workspaces on it cannot be started until then.`;

export const disconnectQuestion = (provider: string) => ({
  title: `Disconnect ${provider}?`,
  detail: `Existing workspaces keep running. New ones cannot be launched on ${provider} until a key is connected again.`,
});

/** `cloud_provider_disposition_required`: the phone cannot choose what happens to what the provider holds (25.07, question 6). */
export const stillHoldsWorkspaces = (provider: string) => ({
  title: `${provider} still holds workspaces`,
  detail: `Delete this organization’s workspaces on ${provider} first, then disconnect. Nothing was changed.`,
});
export const notDisconnectedTitle = (provider: string) => `${provider} was not disconnected`;

/**
 * Where a refused connect is said, and what happens to the key.
 *
 * - `field`: one line under the key field, in place of its helper.
 * - `form`: a notice under the form; the helper stays.
 *
 * `clearKey` is true only for a key the provider rejected: it is emptied and
 * the field focused, so a rejected key is never kept on screen. After any
 * other refusal the key stays for another try, as the board draws it.
 */
export interface ConnectRefusal {
  where: "field" | "form";
  text: string;
  clearKey: boolean;
}

export function connectRefusal(error: CloudApiError, provider: string): ConnectRefusal {
  // The request never left, or the service could not be read: the key was not sent.
  if (error.reason === "network") return { where: "form", text: "No connection. The key was not sent. Try again when the phone is back online.", clearKey: false };
  switch (error.refusal) {
    case "provider-key-invalid": return { where: "field", text: `${provider} rejected that key. Paste it again, or make a new one.`, clearKey: true };
    case "provider-permission-denied": return { where: "field", text: "The key is valid but not allowed to do something TerminalX needs. Check the permissions of the key.", clearKey: false };
    case "provider-billing-required": return { where: "field", text: `${provider} needs billing set up on that account before it will act.`, clearKey: false };
    case "provider-unavailable":
    case "provider-rate-limited":
      return { where: "form", text: `${provider} is not answering right now. The key was not stored. Try again in a moment.`, clearKey: false };
    default: return { where: "form", text: refusalText(error), clearKey: false };
  }
}

/** The list's failure in one sentence: the board's for an unreachable service, the shared sentence for anything else. */
export const listFailure = (error: CloudApiError) => (error.refusal === "unreachable" ? UNREACHABLE_DETAIL : refusalText(error));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const two = (value: number) => String(value).padStart(2, "0");

/** "23 Nov 2026", in the phone's time zone. */
export const dayText = (at: number) => { const date = new Date(at); return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`; };

/** "today, 10:02" for a time today; the day and time otherwise. */
export function checkedText(at: number, now: number): string {
  const date = new Date(at);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return sameDay(date, new Date(now)) ? `today, ${time}` : `${dayText(at)}, ${time}`;
}

/** What the provider's descriptor says about its machines, as the web console says it (terminalx-saas `providerFacts`). */
export type ProviderFact = { kind: "location" | "source" | "pricing" | "suspend"; text: string };

export function providerFacts(descriptor: Pick<CloudProviderDescriptor, "offering" | "capabilities">): ProviderFact[] {
  const { offering, capabilities } = descriptor;
  const facts: ProviderFact[] = [];
  facts.push({ kind: "location", text: offering.locations === "automatic" ? "Location is selected automatically by the provider." : "You choose the machine’s location." });
  if (offering.sources === "optional") facts.push({ kind: "source", text: "A source or template is optional." });
  if (offering.sources === "required") facts.push({ kind: "source", text: "You choose an image or template." });
  facts.push({ kind: "pricing", text: offering.pricingSource === "provider-rate" ? "Prices come from the provider’s live rates." : "Prices shown are estimates." });
  if (!capabilities.stopStart) facts.push({ kind: "suspend", text: "This provider does not support suspending machines." });
  return facts;
}
