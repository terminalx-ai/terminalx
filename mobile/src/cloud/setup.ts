import { CloudApiError, type CloudApi, type CloudCredential, type CloudOrganization, type CloudProvider } from "./api";

/**
 * Setting up cloud workspaces in an organization (25.01): four steps, each
 * read from the account service every time the Cloud tab is shown. Nothing
 * here is remembered as done: the organization list, the provider list and
 * the agent logins say how far the setup is, so someone who stops half-way
 * comes back to the step they left, on this phone or another.
 */

export type SetupStepKey = "organization" | "compute" | "agents" | "launch";
/** Done; the one to do next; one that waits for an earlier step; one that could not be read or needs fixing. */
export type SetupStepState = "done" | "next" | "waiting" | "failed";

/** One list of an organization, as last read. */
export interface SetupRead<T> {
  /** The last answer the service gave, kept while a later read fails. */
  value: T | null;
  /** Why the latest read failed (a code); null when it answered. */
  error: string | null;
  /** The latest read never got an answer: what is kept may be out of date. */
  unreachable: boolean;
  /** The service refused this person the list, as it does a member for some of them. */
  refused: boolean;
}

export interface OrganizationSetup {
  providers: SetupRead<CloudProvider[]>;
  logins: SetupRead<CloudCredential[]>;
  /** Whether a read has finished, whatever it found. */
  read: boolean;
}

const UNREAD: SetupRead<never> = { value: null, error: null, unreachable: false, refused: false };

type SetupApi = Pick<CloudApi, "providers" | "credentials">;

/** What each organization's setup lists said when last read, for the screens that show the steps. */
export class CloudSetupStore {
  private entries: ReadonlyMap<string, OrganizationSetup> = new Map();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: SetupApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ReadonlyMap<string, OrganizationSetup> => this.entries;

  /** Read an organization's providers and agent logins. A read already on its way is joined, not doubled. */
  read(orgId: string): Promise<void> {
    const flying = this.flights.get(orgId);
    if (flying) return flying;
    const flight = (async () => {
      const [providers, logins] = await Promise.allSettled([this.api.providers(orgId), this.api.credentials(orgId)]);
      const before = this.entries.get(orgId);
      const next = new Map(this.entries);
      next.set(orgId, { providers: settled(providers, before?.providers), logins: settled(logins, before?.logins), read: true });
      this.entries = next;
      this.flights.delete(orgId);
      for (const listener of this.listeners) listener();
    })();
    this.flights.set(orgId, flight);
    return flight;
  }
}

function settled<T>(result: PromiseSettledResult<T>, before: SetupRead<T> | undefined): SetupRead<T> {
  if (result.status === "fulfilled") return { value: result.value, error: null, unreachable: false, refused: false };
  const failure = result.reason instanceof CloudApiError ? result.reason : null;
  const unreachable = failure ? failure.refusal === "unreachable" : true;
  // An answer that says no is the answer: what was read before is no longer this person's to see.
  return { value: unreachable ? before?.value ?? null : null, error: failure?.code ?? "cloud_workspace_unavailable", unreachable, refused: failure?.refusal === "admin-required" };
}

const stores = new WeakMap<object, CloudSetupStore>();
/** The one setup store of a signed-in account's catalog: it goes when the catalog does. */
export function setupStoreFor(catalog: { api: SetupApi }): CloudSetupStore {
  let store = stores.get(catalog);
  if (!store) stores.set(catalog, store = new CloudSetupStore(catalog.api));
  return store;
}

/** Who may connect compute and store agent logins: the organization's owners and admins. */
export function managesOrganization(organization: Pick<CloudOrganization, "role">): boolean {
  return organization.role === "owner" || organization.role === "admin";
}

export const SETUP_TEXT = {
  intro: "A cloud workspace is a machine where your agents keep working while your phone is in your pocket. Four steps set one up.",
  organization: (name: string | null) => (name ? `Workspaces belong to an organization. Yours is ${name}.` : "Workspaces belong to an organization."),
  compute: "The provider account your workspaces run on.",
  agents: "What Codex, Claude Code and Cursor sign in with there.",
  launch: "Pick a size, see the price, start working.",
  launchWaits: "Waits for compute.",
  unread: "Could not be read. Pull down to try again.",
  unreadHelp: "Pull down to read it again.",
  keyRejected: (provider: string) => `${provider} rejected the stored key on its last check.`,
  offline: "Setup carries on when the phone is back online. Nothing you finished is lost.",
  noCompute: (name: string) => `${name} has no compute yet`,
  noComputeDetail: "An organization owner or admin must connect compute. You can launch a workspace once they have.",
  folded: "Set up cloud workspaces",
} as const;

export const SETUP_TITLES: Record<SetupStepKey, string> = { organization: "Organization", compute: "Connect compute", agents: "Sign your agents in", launch: "Launch a workspace" };

/** The agents a login is stored for, in the order the steps name them. GitHub's is a repository login, not an agent's. */
const AGENTS: readonly (readonly [string, string])[] = [["codex", "Codex"], ["claude", "Claude Code"], ["cursor", "Cursor"]];

/** A provider the organization connects with its own key. One that TerminalX holds the key for is not a step of this setup. */
const ownCompute = (provider: CloudProvider) => provider.descriptor.credentialSource === "organization";
const needsAttention = (provider: CloudProvider) => provider.availability === "attention-required" || provider.connection?.state === "attention-required";
const providerName = (provider: CloudProvider) => provider.displayName.trim() || provider.descriptor.label;

/** The compute an organization has connected and what is wrong with it, from its provider list. */
export function connectedCompute(providers: readonly CloudProvider[]): { connected: string[]; attention: string[] } {
  const own = providers.filter(ownCompute);
  return {
    connected: own.filter((provider) => provider.connection && !needsAttention(provider)).map(providerName),
    attention: own.filter(needsAttention).map(providerName),
  };
}

/** The agents an organization has a working login for, by name. */
export function signedInAgents(logins: readonly CloudCredential[]): string[] {
  return AGENTS.filter(([provider]) => logins.some((login) => login.provider === provider && login.state === "connected")).map(([, name]) => name);
}

export interface SetupStepView {
  key: SetupStepKey;
  title: string;
  /** What the step is for, or, once done, what it holds. */
  detail: string;
  state: SetupStepState;
  /** The detail says what is wrong. */
  alert: boolean;
  /** Whether the row opens the step's page: not while it waits, and not a step this person may not change. */
  opens: boolean;
}

export interface SetupView {
  steps: SetupStepView[];
  /** The button under the card: the step to carry on with, or the key to fix. */
  action: { step: SetupStepKey; label: string } | null;
  done: number;
  /** The provider or login list did not answer and nothing is kept of it. */
  unread: boolean;
  /** What is shown was read before; the service cannot be reached now. */
  stale: boolean;
  /** Compute is connected and the steps before launch are done. */
  canLaunch: boolean;
  /** This person may not connect compute here and nobody has yet. */
  noCompute: boolean;
}

const ACTIONS: Record<SetupStepKey, string> = { organization: "Start setup", compute: "Continue: connect compute", agents: "Continue: sign your agents in", launch: "Launch a workspace" };
export const FIX_KEY = "Fix the provider key";

/**
 * An organization's four steps as the page draws them. `chosen` is false on
 * first run, when the person has not yet said which organization to set up:
 * then only the first step is offered and nothing else was read.
 */
export function setupView(organization: CloudOrganization | null, chosen: boolean, setup: OrganizationSetup | undefined): SetupView {
  const step = (key: SetupStepKey, state: SetupStepState, detail: string, opens: boolean, alert = false): SetupStepView => ({ key, title: SETUP_TITLES[key], detail, state, alert, opens });
  if (!organization || !chosen) {
    return {
      steps: [step("organization", "next", SETUP_TEXT.organization(organization?.name ?? null), true), step("compute", "waiting", SETUP_TEXT.compute, false), step("agents", "waiting", SETUP_TEXT.agents, false), step("launch", "waiting", SETUP_TEXT.launch, false)],
      action: { step: "organization", label: ACTIONS.organization }, done: 0, unread: false, stale: false, canLaunch: false, noCompute: false,
    };
  }
  const manages = managesOrganization(organization);
  const providers = setup?.providers ?? UNREAD;
  const logins = setup?.logins ?? UNREAD;
  const read = setup?.read === true;
  const compute = providers.value ? connectedCompute(providers.value) : null;
  const agents = logins.value ? signedInAgents(logins.value) : null;
  // A list that did not answer is neither done nor missing; a member being refused the logins is no failure of theirs.
  const computeUnread = read && !compute;
  const agentsUnread = read && !agents && !(logins.refused && !manages);
  const computeDone = !!compute?.connected.length;
  const keyRejected = !computeDone && !!compute?.attention.length;
  const agentsDone = !!agents?.length;

  const steps: SetupStepView[] = [step("organization", "done", organization.name, true)];
  // Each step not yet done is the next one only if nothing before it still waits.
  let open = read;
  const place = (done: boolean, failed: boolean, mine: boolean): SetupStepState => {
    if (done) return "done";
    if (failed) { open = false; return "failed"; }
    const state = open && mine ? "next" : "waiting";
    open = false;
    return state;
  };
  const computeState = place(computeDone, computeUnread || keyRejected, manages);
  steps.push(step("compute", computeState, computeDone ? `${compute!.connected.join(", ")} · connected` : computeUnread ? SETUP_TEXT.unread : keyRejected ? SETUP_TEXT.keyRejected(compute!.attention[0]!) : SETUP_TEXT.compute, manages && !computeUnread && computeState !== "waiting", computeUnread || keyRejected));
  // A member launches once compute is connected, whatever they may read of the logins.
  if (!manages && computeDone) open = read;
  const agentsState = manages ? place(agentsDone, agentsUnread, true) : agentsDone ? "done" : agentsUnread ? "failed" : "waiting";
  steps.push(step("agents", agentsState, agentsDone ? `${agents!.join(", ")} · connected` : agentsUnread ? SETUP_TEXT.unread : SETUP_TEXT.agents, manages && !agentsUnread && agentsState !== "waiting", agentsUnread));
  if (!manages && agentsUnread) open = false;
  const launchState = place(false, false, true);
  steps.push(step("launch", launchState, keyRejected ? SETUP_TEXT.launchWaits : SETUP_TEXT.launch, launchState === "next"));

  const next = steps.find((entry) => entry.state === "next");
  const action = keyRejected && manages ? { step: "compute" as const, label: FIX_KEY } : next ? { step: next.key, label: ACTIONS[next.key] } : null;
  return {
    steps, action,
    done: steps.filter((entry) => entry.state === "done").length,
    unread: computeUnread || agentsUnread,
    stale: providers.unreachable || logins.unreachable,
    canLaunch: launchState === "next",
    noCompute: !manages && read && !!compute && !computeDone,
  };
}

/** "2 of 4 steps done", under the folded row of an organization still being set up. */
export function stepsDoneLabel(view: Pick<SetupView, "done" | "steps">): string {
  return `${view.done} of ${view.steps.length} steps done`;
}
