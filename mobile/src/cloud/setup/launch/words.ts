import { CloudApiError, type CloudCredential, type CloudPreflightCheck, type CloudProviderDescriptor, type CloudProviderSetup, type CloudQuote } from "../../api";
import { refusalText } from "../../words";
import { priceText } from "../../../ui/PriceLines";
import { repositoryName } from "./repository";

/**
 * The launch form's words (25.05 rows 1 to 4). Every figure in them is the
 * server's: sizes, rates, regions and idle times come from the provider's
 * setup answer, the price from its quote, who bills from its descriptor.
 */

/** The agents and services a stored login is for, as the boards name them. */
const LOGIN_NAMES: Readonly<Record<string, string>> = { codex: "Codex", claude: "Claude Code", cursor: "Cursor", github: "GitHub" };

/** The logins a workspace runs its agents with; GitHub only clones the repository. */
export const AGENT_LOGINS: readonly string[] = ["codex", "claude", "cursor"];

export function loginName(provider: string): string {
  return LOGIN_NAMES[provider] ?? provider;
}

/** What a stored login is shown as beside its name: who it is, else how it signs in. */
export function loginDetail(credential: Pick<CloudCredential, "displayIdentity" | "authKind">): string {
  if (credential.displayIdentity) return credential.displayIdentity;
  return credential.authKind === "api-key" ? "API key" : credential.authKind === "personal-access-token" ? "Personal access token" : "";
}

/** A size of memory or disk the server gives in MiB, as the boards write it: 4 GiB, 0.5 GiB. */
function gibibytes(mebibytes: number): string {
  const gib = mebibytes / 1024;
  return `${Number.isInteger(gib) ? gib : Number(gib.toFixed(1))} GiB`;
}

type MachineClass = CloudProviderSetup["machineClasses"][number];

/** The Size row's value: the class's name, with its hourly rate when the provider quotes one. */
export function sizeValue(machineClass: MachineClass, currency: string): string {
  return machineClass.activeHourlyMicros === undefined ? machineClass.label : `${machineClass.label} · ${priceText(machineClass.activeHourlyMicros, currency)} / hour`;
}

/** A class's machine in the Size sheet: 2 vCPU · 4 GiB memory · 40 GiB disk. */
export function machineDetail(machineClass: Pick<MachineClass, "vcpu" | "memoryMiB" | "diskGiB">): string {
  return `${machineClass.vcpu} vCPU · ${gibibytes(machineClass.memoryMiB)} memory · ${machineClass.diskGiB} GiB disk`;
}

/** The review's Size: Small · 2 vCPU · 4 GiB · 40 GiB, from the quote. */
export function quotedSize(configuration: CloudQuote["configuration"]): string {
  return `${configuration.machineClassLabel} · ${configuration.vcpu} vCPU · ${gibibytes(configuration.memoryMiB)} · ${configuration.diskGiB} GiB`;
}

/** The Stop when idle row's value. Zero minutes is never. */
export function idleValue(minutes: number): string {
  return minutes === 0 ? "Never" : `After ${minutes} minutes`;
}

/** A choice in the Stop when idle sheet. */
export function idleChoice(minutes: number): string {
  return minutes === 0 ? "Never: always on" : `${minutes} minutes`;
}

/**
 * The idle times to offer, in the server's order with Never last. Under an
 * organization's cap the server's own maximum decides: nothing above it, and
 * no Never.
 */
export function idleChoices(setup: Pick<CloudProviderSetup, "allowedIdleSuspendMinutes" | "maxIdleSuspendMinutes">): number[] {
  const cap = setup.maxIdleSuspendMinutes ?? null;
  const allowed = setup.allowedIdleSuspendMinutes.filter((minutes, index, all) => all.indexOf(minutes) === index && (cap === null || (minutes > 0 && minutes <= cap)));
  return [...allowed.filter((minutes) => minutes > 0), ...allowed.filter((minutes) => minutes === 0)];
}

// A currency's name in the price notes. Hermes leaves `currencyDisplay: "name"` out, so the common ones are named here.
const CURRENCY_WORDS: Readonly<Record<string, string>> = { USD: "US dollars", EUR: "euros", GBP: "British pounds", CAD: "Canadian dollars", AUD: "Australian dollars", JPY: "Japanese yen", CHF: "Swiss francs" };

/** The currency as words for the price notes ("US dollars"), else its code. */
function currencyWords(currency: string): string {
  const known = CURRENCY_WORDS[currency.toUpperCase()];
  if (known) return known;
  try {
    const named = new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "name" }).formatToParts(2).find((part) => part.type === "currency")?.value;
    return named && named.toUpperCase() !== currency.toUpperCase() ? named : currency;
  } catch {
    return currency;
  }
}

/** The Size sheet's line under its title: Boat · prices are estimates, in US dollars. */
export function sizeSheetNote(providerLabel: string, currency: string): string {
  return `${providerLabel} · prices are estimates, in ${currencyWords(currency)}`;
}

/** The provider's own billing line from its descriptor, then that prices are estimates: the note before the countdown. */
export function billingNote(descriptor: Pick<CloudProviderDescriptor, "billing">, currency: string): string {
  const billing = descriptor.billing.trim();
  const said = billing ? `${billing}${/[.!?]$/.test(billing) ? "" : "."} ` : "";
  return `${said}Prices are estimates, in ${currencyWords(currency)}.`;
}

/**
 * The spend confirmation, word for word as the owner gave it. Who bills is
 * the descriptor's `billedByProvider`, never the provider's id; the rate is
 * the quote's.
 */
export function spendSentence(descriptor: Pick<CloudProviderDescriptor, "label" | "billedByProvider">, organizationName: string, quote: Pick<CloudQuote, "activeHourlyMicros" | "currency">): string {
  const rate = priceText(quote.activeHourlyMicros, quote.currency);
  return descriptor.billedByProvider
    ? `${descriptor.label} bills this workspace to ${organizationName} directly, not TerminalX: about ${rate} for each hour it is active.`
    : `TerminalX bills this workspace to ${organizationName}: about ${rate} for each hour it is active.`;
}

export const SPEND_TITLE = "Launch and start spending?";

/** A new quote that differs from the one shown before says what that one was. */
export function priceChangedText(previous: Pick<CloudQuote, "activeHourlyMicros" | "currency">): string {
  return `The price changed since you last looked: it was ${priceText(previous.activeHourlyMicros, previous.currency)} per active hour.`;
}

/** Whether a new quote prices differently from the one before it. */
export function priceDiffers(before: Pick<CloudQuote, "activeHourlyMicros" | "alwaysOnThirtyDayMicros" | "currency">, after: Pick<CloudQuote, "activeHourlyMicros" | "alwaysOnThirtyDayMicros" | "currency">): boolean {
  return before.currency !== after.currency || before.activeHourlyMicros !== after.activeHourlyMicros || before.alwaysOnThirtyDayMicros !== after.alwaysOnThirtyDayMicros;
}

export const OPEN_TO_ORGANIZATION = "Every member of this organization can use this workspace and steer its sessions.";
export const IDLE_NOTE = "A stopped workspace starts again when you send it a message.";
export const REPOSITORY_INTRO = "Optional. The repository is cloned before the workspace becomes available.";
export const REPOSITORY_HELPER = "A private repository is cloned with the GitHub token saved in Agent logins.";

/** Which part of the form a failed check belongs to. */
export type ProblemField = { kind: "repository" } | { kind: "login"; credentialId: string | null; provider: string };

/** One failed preflight check, in the board's words, and the field it marks. */
export interface Problem {
  field: ProblemField | null;
  /** The code the server gave for it, so the repository page can say it under its field. */
  code: string | null;
  text: string;
}

const lowerFirst = (sentence: string) => sentence.charAt(0).toLowerCase() + sentence.slice(1);
const REAUTH = "cloud_agent_credential_reauth_required";

/** The sentence for a code the server answered a check with: the board's, else the generic one, never the code. */
function codeSentence(code: string | undefined): string {
  return refusalText(new CloudApiError(code ?? "cloud_workspace_request_invalid", 422));
}

/**
 * Every check the server failed, as the form lists them: `acme/app: this
 * repository needs a GitHub personal access token.`, `Codex: sign-in
 * required.` A GitHub login that failed marks the repository, which it is for.
 */
export function problemsOf(checks: readonly CloudPreflightCheck[], credentials: readonly Pick<CloudCredential, "id" | "provider">[]): Problem[] {
  return checks.filter((check) => check.status === "failed").map((check): Problem => {
    const code = check.errorCode ?? null;
    if (check.kind === "repository") {
      const name = check.cloneUrl ? repositoryName(check.cloneUrl) : null;
      const sentence = codeSentence(check.errorCode);
      return { field: { kind: "repository" }, code, text: name ? `${name}: ${lowerFirst(sentence)}` : sentence };
    }
    const credentialId = check.kind === "credential" ? check.credentialId : null;
    const provider = (check.kind === "credential" ? check.provider : check.agent ?? check.provider) ?? credentials.find((each) => each.id === credentialId)?.provider ?? "";
    const reauth = code === REAUTH || (code !== null && new CloudApiError(code, 422).refusal === "login-invalid");
    const sentence = reauth ? "Sign-in required." : codeSentence(check.errorCode);
    const field: ProblemField = provider === "github" ? { kind: "repository" } : { kind: "login", credentialId, provider };
    return { field, code, text: provider ? `${loginName(provider)}: ${lowerFirst(sentence)}` : sentence };
  });
}

const COUNTS = ["", "One thing", "Two things", "Three things", "Four things", "Five things"];

/** The heading over the failed checks: Two things to fix before this can be priced. */
export function problemsTitle(count: number): string {
  return `${COUNTS[count] ?? `${count} things`} to fix before this can be priced`;
}
