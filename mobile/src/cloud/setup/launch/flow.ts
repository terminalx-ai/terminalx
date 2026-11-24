import { useSyncExternalStore } from "react";
import { CloudApiError, type CloudApi, type CloudCredential, type CloudFirstRunSetup, type CloudLifecycle, type CloudProvider, type CloudProviderSetup, type CloudQuote, type CloudQuoteInput } from "../../api";
import { refusalText } from "../../words";
import { cloneUrl } from "./repository";
import { AGENT_LOGINS, priceDiffers, problemsOf, type Problem } from "./words";

/**
 * One launch from the phone (25.05 rows 1 to 4): the form's draft, the check
 * and the price it asks for, the review, and the launch itself.
 *
 * Nothing is created until `launch()`, which only the spend confirmation's
 * Launch calls. It never launches at a price that has run out: the quote's
 * expiry is checked on the server's clock as the request is made, and a quote
 * the server says has expired asks for a new one. Each launch attempt has one
 * idempotency key: sending the same request again (after a timeout or a lost
 * answer) sends the same key, so the server answers with the first launch
 * instead of starting a second; a changed form or a new quote is a different
 * request and gets a new key.
 */

/** One choice of each thing the provider's setup answer offers. */
export type Selection = Omit<CloudQuoteInput, "provider">;

export interface Draft {
  name: string;
  /** Which provider to launch on; null until the providers are read. */
  providerId: string | null;
  /** From the provider's setup answer, starting at its defaults; null until it is read. */
  selection: Selection | null;
  /** The repository as typed, with its branch or tag; null for none. */
  repository: { url: string; ref: string } | null;
  /** The agent logins chosen, by credential id. */
  agents: readonly string[];
}

/** What the form had read when it asked for the price. */
export interface Facts {
  provider: CloudProvider;
  setup: CloudProviderSetup;
  credentials: readonly CloudCredential[];
  organizationName: string;
}

export type Check =
  | { state: "idle" }
  | { state: "checking" }
  /** The server's preflight failed these: each blocks Review price until its field changes. */
  | { state: "problems"; problems: Problem[]; logins: string }
  /** The check or the quote was refused, or got no answer. */
  | { state: "refused"; error: CloudApiError };

export interface Review {
  facts: Facts;
  /** The draft as it was priced. */
  draft: Draft;
  input: CloudQuoteInput;
  setup: CloudFirstRunSetup;
  quote: CloudQuote;
  /** The quote shown before this one, when the new one prices differently. */
  previous: CloudQuote | null;
  /** The countdown ran out, or the server said so at launch: only a new price goes on from here. */
  expired: boolean;
  requoting: boolean;
  launching: boolean;
  /** Why the last launch or new price did not go through. */
  error: CloudApiError | null;
}

export interface LaunchSnapshot {
  draft: Draft;
  check: Check;
  review: Review | null;
}

type LaunchApi = Pick<CloudApi, "preflight" | "quote" | "createWorkspace" | "serverNow">;

export interface LaunchFlowOptions {
  api: LaunchApi;
  orgId: string;
  /** A fresh idempotency key: printable ASCII, at most 128 characters. */
  newKey(): string;
}

const REF_NOT_FOUND = "cloud_workspace_repository_ref_not_found";
const loginsSignature = (credentials: readonly CloudCredential[]) => credentials.map((credential) => `${credential.id}:${credential.version}:${credential.state}`).sort().join(",");

const EMPTY_DRAFT: Draft = { name: "", providerId: null, selection: null, repository: null, agents: [] };
const MAX_LOGINS = 4;

/**
 * What the new workspace starts with: the repository, the chosen agent
 * logins, and the organization's GitHub login when there is a repository to
 * clone (a private one needs it). Only logins the server says are connected.
 */
export function firstRunSetup(draft: Pick<Draft, "repository" | "agents">, credentials: readonly CloudCredential[]): CloudFirstRunSetup {
  const url = draft.repository ? cloneUrl(draft.repository.url) : null;
  const ref = draft.repository?.ref.trim() ?? "";
  const usable = credentials.filter((credential) => credential.state === "connected");
  const agents = usable.filter((credential) => AGENT_LOGINS.includes(credential.provider) && draft.agents.includes(credential.id)).map((credential) => credential.id);
  const github = url ? usable.find((credential) => credential.provider === "github")?.id : undefined;
  const credentialIds = [...(github ? [github] : []), ...agents].slice(0, MAX_LOGINS);
  return { ...(url ? { repositories: [{ cloneUrl: url, ...(ref ? { ref } : {}) }] } : {}), credentialIds };
}

/** The launch requests of one flow, each with its idempotency key. */
class Attempts {
  private last: { request: string; key: string } | null = null;

  constructor(private readonly newKey: () => string) {}

  /** The same request as last time keeps its key; any other request is a new attempt. */
  keyFor(request: unknown): string {
    const said = JSON.stringify(request);
    if (this.last?.request === said) return this.last.key;
    this.last = { request: said, key: this.newKey() };
    return this.last.key;
  }

  /** The server answered: the next press is a new attempt. */
  forget(): void {
    this.last = null;
  }
}

export class LaunchFlow {
  private snapshot: LaunchSnapshot = { draft: EMPTY_DRAFT, check: { state: "idle" }, review: null };
  private readonly listeners = new Set<() => void>();
  private readonly attempts: Attempts;
  /** Counts edits, so an answer to a check of a draft that has since changed is dropped. */
  private edits = 0;

  constructor(private readonly options: LaunchFlowOptions) {
    this.attempts = new Attempts(options.newKey);
  }

  get orgId(): string {
    return this.options.orgId;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LaunchSnapshot => this.snapshot;

  /** The server's clock, for the quote's countdown. */
  serverNow = (): number => this.options.api.serverNow();

  private set(next: Partial<LaunchSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private setReview(patch: Partial<Review>): void {
    if (this.snapshot.review) this.set({ review: { ...this.snapshot.review, ...patch } });
  }

  /**
   * Change the form. A failed check stays listed until the field it belongs
   * to changes; a refusal is cleared by any change. A priced review is of the
   * draft before, so it goes.
   */
  edit(patch: Partial<Draft>): void {
    if (this.snapshot.check.state === "checking") return;
    const before = this.snapshot.draft;
    const draft = { ...before, ...patch };
    this.edits += 1;
    let check = this.snapshot.check;
    if (check.state === "refused") check = { state: "idle" };
    if (check.state === "problems") {
      const repositoryChanged = JSON.stringify(before.repository) !== JSON.stringify(draft.repository);
      const toggled = new Set([...before.agents.filter((id) => !draft.agents.includes(id)), ...draft.agents.filter((id) => !before.agents.includes(id))]);
      const providerChanged = before.providerId !== draft.providerId;
      const problems = check.problems.filter((problem) => {
        // A failed check with no field of its own, or on another provider, is of the draft before.
        if (!problem.field || providerChanged) return false;
        if (problem.field.kind === "repository") return !repositoryChanged;
        return problem.field.credentialId ? !toggled.has(problem.field.credentialId) : toggled.size === 0;
      });
      check = problems.length ? { ...check, problems } : { state: "idle" };
    }
    this.set({ draft, check, review: null });
  }

  /**
   * The organization's logins were read again (coming back from Agent logins,
   * say). When they changed, what failed because of a login may be fixed
   * now: those checks are cleared, for Review price to check again. A branch
   * that was not there is the repository's own, and stays.
   */
  loginsRead(credentials: readonly CloudCredential[]): void {
    const check = this.snapshot.check;
    if (check.state !== "problems" || check.logins === loginsSignature(credentials)) return;
    const problems = check.problems.filter((problem) => problem.field?.kind === "repository" && problem.code === REF_NOT_FOUND);
    this.set({ check: problems.length ? { state: "problems", problems, logins: loginsSignature(credentials) } : { state: "idle" } });
  }

  /** Whether Review price can be pressed: a name, a choice of each thing, and nothing failed. */
  canPrice(): boolean {
    const { draft, check } = this.snapshot;
    return draft.name.trim() !== "" && draft.providerId !== null && draft.selection !== null && (check.state === "idle" || check.state === "refused");
  }

  /**
   * Review price: the server's preflight of the repository and the logins,
   * then its quote, in one go. True when the review is ready to show.
   */
  async price(facts: Facts): Promise<boolean> {
    if (!this.canPrice()) return false;
    const { draft } = this.snapshot;
    if (facts.provider.id !== draft.providerId || facts.setup.provider !== draft.providerId) return false;
    const edits = this.edits;
    const input: CloudQuoteInput = { provider: facts.provider.id, ...draft.selection! };
    const setup = firstRunSetup(draft, facts.credentials);
    this.set({ check: { state: "checking" } });
    try {
      // Nothing to clone and no login to check: there is nothing for the preflight to say.
      if (setup.repositories?.length || setup.credentialIds.length) {
        const preflight = await this.options.api.preflight(this.options.orgId, setup);
        if (edits !== this.edits) return false;
        if (!preflight.ready) {
          const problems = problemsOf(preflight.checks, facts.credentials);
          // Not ready with no failed check named: blocked all the same, with the generic sentence.
          this.set({ check: { state: "problems", logins: loginsSignature(facts.credentials), problems: problems.length ? problems : [{ field: null, code: null, text: refusalText("unknown") }] } });
          return false;
        }
      }
      const quote = await this.options.api.quote(this.options.orgId, input);
      if (edits !== this.edits) return false;
      this.set({ check: { state: "idle" }, review: { facts, draft, input, setup, quote, previous: null, expired: false, requoting: false, launching: false, error: null } });
      return true;
    } catch (error) {
      if (!(error instanceof CloudApiError)) throw error;
      if (edits === this.edits) this.set({ check: { state: "refused", error } });
      return false;
    }
  }

  /** The quote's countdown ran out. */
  expire(): void {
    const review = this.snapshot.review;
    if (review && !review.expired && !review.launching) this.setReview({ expired: true, previous: null });
  }

  /** Whether the quote shown can still be launched on, by the server's clock. */
  private live(review: Review): boolean {
    return !review.expired && this.options.api.serverNow() < review.quote.expiresAt;
  }

  /**
   * Get a new price for the same choice. A new price that differs says what
   * the old one was; either way Launch asks for confirmation again.
   */
  async requote(): Promise<void> {
    const review = this.snapshot.review;
    if (!review || review.requoting || review.launching) return;
    this.setReview({ requoting: true, error: null });
    try {
      const quote = await this.options.api.quote(this.options.orgId, review.input);
      if (this.snapshot.review?.quote !== review.quote) return;
      this.setReview({ quote, previous: priceDiffers(review.quote, quote) ? review.quote : null, expired: false, requoting: false });
    } catch (error) {
      if (!(error instanceof CloudApiError)) throw error;
      this.setReview({ requoting: false, error });
    }
  }

  /**
   * Launch, with the person's own yes to the quoted spend: called only from
   * the spend confirmation's Launch. Null when nothing was sent or it did not
   * go through (the review says why); the workspace and its operation when
   * the server accepted it.
   */
  async launch(): Promise<CloudLifecycle | null> {
    const review = this.snapshot.review;
    if (!review || review.launching || review.requoting) return null;
    if (!this.live(review)) {
      this.setReview({ expired: true, previous: null, error: null });
      return null;
    }
    const request = { name: review.draft.name.trim(), quoteId: review.quote.id, confirmProviderSpend: true as const, setup: review.setup };
    const key = this.attempts.keyFor(request);
    this.setReview({ launching: true, error: null });
    try {
      const launched = await this.options.api.createWorkspace(this.options.orgId, request, key);
      this.attempts.forget();
      this.setReview({ launching: false });
      return launched;
    } catch (error) {
      if (!(error instanceof CloudApiError)) {
        this.setReview({ launching: false });
        throw error;
      }
      if (error.refusal === "quote-expired") {
        this.attempts.forget();
        this.setReview({ launching: false, expired: true, previous: null });
        return null;
      }
      // No answer, or the service could not give one: the server may have acted, so the same request keeps its key.
      if (!error.unreachable && error.refusal !== "unreachable") this.attempts.forget();
      this.setReview({ launching: false, error });
      return null;
    }
  }
}

// ── The flow the launch pages share ──
//
// The form, the repository page and the review are pages of their own; the
// form holds the flow while it is open and the other two read it from here.

const held = new Map<string, LaunchFlow>();
const watchers = new Set<() => void>();
let version = 0;

/** The form holds its flow for its organization while it is open; the returned function lets it go. */
export function holdLaunch(flow: LaunchFlow): () => void {
  held.set(flow.orgId, flow);
  version += 1;
  for (const watcher of watchers) watcher();
  return () => {
    if (held.get(flow.orgId) !== flow) return;
    held.delete(flow.orgId);
    version += 1;
    for (const watcher of watchers) watcher();
  };
}

const watchHeld = (watcher: () => void) => {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
};

/** The flow the form holds for an organization, or null when no form is open for it. */
export function useHeldLaunch(orgId: string | undefined): LaunchFlow | null {
  useSyncExternalStore(watchHeld, () => version, () => version);
  return orgId ? held.get(orgId) ?? null : null;
}

const NO_SNAPSHOT: LaunchSnapshot = { draft: EMPTY_DRAFT, check: { state: "idle" }, review: null };
const none = () => () => undefined;

export function useLaunchSnapshot(flow: LaunchFlow | null): LaunchSnapshot {
  return useSyncExternalStore(flow?.subscribe ?? none, flow?.getSnapshot ?? (() => NO_SNAPSHOT), flow?.getSnapshot ?? (() => NO_SNAPSHOT));
}
