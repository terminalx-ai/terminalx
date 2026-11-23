import { z } from "zod";
import { CloudApiError, type CloudApi, type CloudCredential, type CloudRefusal, type CredentialConsent } from "./api";
import { refusalOf, transient } from "./logins";

/**
 * "Sign in with ChatGPT" for Codex from the phone (board 25.04): ask the
 * service for a one-time code, show it, and ask every few seconds whether the
 * person entered it on OpenAI's page.
 *
 * One sign-in at a time. The attempt is kept on the phone while it waits, so
 * leaving the app, or the app being closed, and coming back carries on with
 * the same code: a second login is never started while one is still good.
 * The tokens OpenAI hands out never reach the phone; the service stores them
 * and answers with the login's name and fingerprint.
 */

/** The attempt as the phone holds it. `expiresAt` is on the phone's own clock, set when the code arrived. */
export interface HeldCodexLogin {
  attemptId: string;
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: number;
}

export type CodexLoginState =
  /** Not yet known whether this phone is waiting on a sign-in from before. */
  | { phase: "looking" }
  | { phase: "idle" }
  | { phase: "starting" }
  | {
    phase: "waiting";
    login: HeldCodexLogin;
    /** The sign-in page was opened from here: the page now says it is waiting. */
    opened: boolean;
    /** The last question got no answer at all. The wait goes on by itself. */
    offline: boolean;
    canceling: boolean;
    /** The person asked to cancel and the service could not be told. */
    cancelFailed: boolean;
  }
  | { phase: "done"; credential: CloudCredential }
  /** Over without a login. The code stays in view, struck through. */
  | { phase: "expired"; code: string }
  | { phase: "canceled"; code: string }
  | { phase: "failed"; code: string; refusal: CloudRefusal | null }
  /** No code could be had. */
  | { phase: "unavailable"; refusal: CloudRefusal };

/** Where the waiting attempt is kept: one item in the phone's keychain. */
export interface CodexLoginStorage {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}
export const CODEX_LOGIN_ITEM = "terminalx.cloud.codex-login.v1";

const heldSchema = z.object({
  v: z.literal(1),
  userId: z.string().min(1),
  orgId: z.string().min(1),
  opened: z.boolean(),
  login: z.object({ attemptId: z.string().min(1), deviceAuthId: z.string().min(1), userCode: z.string().min(1), verificationUri: z.string().startsWith("https://"), intervalSeconds: z.number().positive(), expiresAt: z.number() }),
});

export interface CodexLoginOptions {
  api: Pick<CloudApi, "startCodexLogin" | "pollCodexLogin" | "cancelCodexLogin">;
  orgId: string;
  /** Who is signed in: an attempt kept by someone else is never carried on. */
  userId: string;
  storage: CodexLoginStorage;
  now?: () => number;
}

export class CodexLoginFlow {
  private state: CodexLoginState = { phase: "looking" };
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private consent: CredentialConsent | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Counts the sign-ins this object began: an answer to an earlier one is dropped. */
  private run = 0;
  private asking = false;
  private paused = false;
  private closed = false;

  constructor(private readonly options: CodexLoginOptions) {
    this.now = options.now ?? Date.now;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): CodexLoginState => this.state;

  /**
   * Carry on with the attempt this phone was waiting on, if it is this
   * person's, for this organization, and its code is still good. `consent` is
   * the authorization given before that code was asked for: an attempt is
   * only ever kept after it. True when there was one to carry on with.
   */
  async resume(consent: CredentialConsent): Promise<boolean> {
    // The page is (again) in front: a wait that `close` stopped carries on.
    this.closed = false;
    if (this.state.phase === "waiting") {
      void this.ask();
      return true;
    }
    if (this.state.phase !== "looking") return false;
    const raw = await this.options.storage.get().catch(() => null);
    if (this.closed || this.state.phase !== "looking") return false;
    let held: z.infer<typeof heldSchema> | null = null;
    try { held = raw ? heldSchema.parse(JSON.parse(raw)) : null; } catch { held = null; }
    // Unreadable, someone else's, or past its time: it is of no use to anyone.
    if (raw && (!held || held.userId !== this.options.userId || held.login.expiresAt <= this.now())) {
      await this.options.storage.delete().catch(() => undefined);
      held = null;
    }
    // Another organization's attempt is left for that organization's page.
    if (!held || held.orgId !== this.options.orgId) {
      if (this.state.phase === "looking") this.set({ phase: "idle" });
      return false;
    }
    if (this.state.phase !== "looking") return false;
    this.run += 1;
    this.consent = consent;
    this.set({ phase: "waiting", login: held.login, opened: held.opened, offline: false, canceling: false, cancelFailed: false });
    void this.ask();
    return true;
  }

  /** Ask for a code. Does nothing while a sign-in is already under way. */
  async start(consent: CredentialConsent): Promise<void> {
    if (this.closed || this.state.phase === "starting" || this.state.phase === "waiting") return;
    const run = ++this.run;
    this.consent = consent;
    this.set({ phase: "starting" });
    let login: HeldCodexLogin;
    try {
      const started = await this.options.api.startCodexLogin(this.options.orgId);
      login = { attemptId: started.attemptId, deviceAuthId: started.deviceAuthId, userCode: started.userCode, verificationUri: started.verificationUri, intervalSeconds: started.intervalSeconds, expiresAt: this.now() + started.expiresInSeconds * 1000 };
    } catch (error) {
      if (run === this.run && !this.closed) this.set({ phase: "unavailable", refusal: refusalOf(error) });
      return;
    }
    if (run !== this.run || this.closed) {
      // Given up while the code was on its way: it is told to stop working, and is never shown.
      void this.options.api.cancelCodexLogin(this.options.orgId, login).catch(() => undefined);
      return;
    }
    this.set({ phase: "waiting", login, opened: false, offline: false, canceling: false, cancelFailed: false });
    await this.keep();
    this.schedule(login);
  }

  /** Give up before a code arrived. */
  abandon(): void {
    if (this.state.phase !== "starting") return;
    this.run += 1;
    this.set({ phase: "idle" });
  }

  /** Back to the start from a sign-in that is over. */
  reset(): void {
    if (this.state.phase === "starting" || this.state.phase === "waiting") return;
    this.set({ phase: "idle" });
  }

  /** The sign-in page was opened. */
  markOpened(): void {
    if (this.state.phase !== "waiting" || this.state.opened) return;
    this.set({ ...this.state, opened: true });
    void this.keep();
  }

  /** The clock ran out on the code: nothing more is asked. */
  expire(): void {
    if (this.state.phase === "waiting" && this.now() >= this.state.login.expiresAt) this.end({ phase: "expired", code: this.state.login.userCode });
  }

  /**
   * Tell the service to stop the code working. If the sign-in was approved
   * first, the service says so and the login is kept: the next answer shows it.
   */
  async cancel(): Promise<void> {
    const state = this.state;
    if (state.phase !== "waiting" || state.canceling) return;
    const run = this.run;
    this.clear();
    this.set({ ...state, canceling: true, cancelFailed: false });
    let status: Awaited<ReturnType<CloudApi["cancelCodexLogin"]>>;
    try {
      status = await this.options.api.cancelCodexLogin(this.options.orgId, state.login);
    } catch (error) {
      if (run !== this.run || this.state.phase !== "waiting") return;
      // An attempt the service no longer knows cannot be approved either.
      if (refusalOf(error) === "device-login-not-found") return this.end({ phase: "canceled", code: state.login.userCode });
      // Not canceled: the code is still good, so the wait goes on.
      this.set({ ...this.state, canceling: false, cancelFailed: true, offline: error instanceof CloudApiError && error.status === null });
      this.schedule(state.login);
      return;
    }
    if (run !== this.run || this.state.phase !== "waiting") return;
    if (status === "canceled") return this.end({ phase: "canceled", code: state.login.userCode });
    if (status === "expired") return this.end({ phase: "expired", code: state.login.userCode });
    if (status === "failed") return this.end({ phase: "failed", code: state.login.userCode, refusal: null });
    this.set({ ...this.state, canceling: false });
    await this.ask();
  }

  /** The app went to the background: nothing is asked until it is back. */
  pause(): void {
    this.paused = true;
    this.clear();
  }

  /** The app is in front again: ask at once. */
  wake(): void {
    if (!this.paused) return;
    this.paused = false;
    void this.ask();
  }

  /** The page went away. The attempt stays kept: coming back (`resume`) carries on with it. */
  close(): void {
    this.closed = true;
    this.clear();
  }

  private async ask(): Promise<void> {
    const state = this.state;
    if (this.closed || this.paused || this.asking || state.phase !== "waiting" || state.canceling || !this.consent) return;
    this.clear();
    const { login } = state;
    if (this.now() >= login.expiresAt) return this.end({ phase: "expired", code: login.userCode });
    const run = this.run;
    this.asking = true;
    let answer: Awaited<ReturnType<CloudApi["pollCodexLogin"]>> | null = null;
    let failure: unknown = null;
    try {
      answer = await this.options.api.pollCodexLogin(this.options.orgId, login, this.consent);
    } catch (error) {
      failure = error ?? new Error("failed");
    } finally {
      this.asking = false;
    }
    // Canceled or closed meanwhile: an approval that arrived first is still shown; anything else is dropped.
    if (run !== this.run || this.state.phase !== "waiting") return;
    if (answer?.status === "complete") return this.end({ phase: "done", credential: answer.credential });
    if (answer?.status === "expired") return this.end({ phase: "expired", code: login.userCode });
    if (answer?.status === "canceled") return this.end({ phase: "canceled", code: login.userCode });
    if (answer?.status === "failed") return this.end({ phase: "failed", code: login.userCode, refusal: null });
    if (failure && !transient(failure)) return this.end({ phase: "failed", code: login.userCode, refusal: refusalOf(failure) });
    // Still waiting, or the service could not be asked: the code is good until its time.
    const offline = failure instanceof CloudApiError && failure.status === null;
    if (this.state.offline !== offline) this.set({ ...this.state, offline });
    if (!this.state.canceling) this.schedule(login);
  }

  private schedule(login: HeldCodexLogin): void {
    this.clear();
    if (this.closed || this.paused) return;
    this.timer = setTimeout(() => { this.timer = null; void this.ask(); }, login.intervalSeconds * 1000);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The sign-in is over, one way or the other: nothing is kept of the attempt. */
  private end(state: Extract<CodexLoginState, { phase: "done" | "expired" | "canceled" | "failed" }>): void {
    this.clear();
    void this.options.storage.delete().catch(() => undefined);
    this.set(state);
  }

  private async keep(): Promise<void> {
    if (this.state.phase !== "waiting") return;
    const held: z.infer<typeof heldSchema> = { v: 1, userId: this.options.userId, orgId: this.options.orgId, opened: this.state.opened, login: this.state.login };
    await this.options.storage.set(JSON.stringify(held)).catch(() => undefined);
  }

  private set(state: CodexLoginState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}
