import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { CloudApiError, type CloudApi } from "../cloud/api";
import {
  ACCOUNT_DELETION_ERRORS as E,
  accountDeletionText as T,
  refusalSentence,
  stoppedAtConfirm,
  type AccountDeletionAttempt,
  type AccountDeletionRead,
} from "./deletion";
import { rememberPendingDeletion } from "./pending-deletion";

/** How often the page asks again while running cloud workspaces are being stopped (they settle within 15 minutes). */
export const STOP_POLL_MS = 2_500;

export type DeletionNotice =
  | { kind: "refused"; tone: "danger" | "warning"; text: string }
  | { kind: "stale" }
  | { kind: "blocked" }
  | { kind: "unknown" }
  | { kind: "offline" }
  | { kind: "other-account" };

export type DeletionPhase =
  | { kind: "loading" }
  | { kind: "unreadable" }
  | { kind: "ready" }
  /** Scheduled, and this phone signed out: the day it is deleted, and how many were stopped. */
  /** `deleteAfter` is the server's; null when every device was signed out before it was read (then `graceDays` is said). */
  | { kind: "scheduled"; deleteAfter: number | null; graceDays: number; stopped: number }
  /** The final deletion has started: signing in no longer cancels it. */
  | { kind: "finishing" };

export interface DeletionState {
  phase: DeletionPhase;
  read: AccountDeletionRead | null;
  /** What the button says while a confirmation is under way: stopping running ones, or deleting. */
  sending: "stopping" | "deleting" | null;
  notice: DeletionNotice | null;
  signingIn: boolean;
  /** The server said the address does not match. */
  mismatch: boolean;
}

export interface AccountDeletionDeps {
  api: Pick<CloudApi, "accountDeletion" | "requestAccountDeletion"> | null;
  /** The account's own address: sent to confirm, never what was typed. */
  email: string | null;
  online: boolean;
  reauthenticate(): Promise<"signed-in" | "closed" | "other-account">;
  forgetDeletedAccount(): Promise<void>;
  /** A provider's name as people know it, from the organization of that workspace; the attempt names it by id. */
  providerName?(providerId: string, workspaceId: string | null): string;
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The server read the request and refused it, so nothing changed (`account_deletion_busy`, say).
 * No answer, a 5xx, a sign-out or an answer that cannot be read may have scheduled it.
 */
function answeredRefusal(error: unknown): boolean {
  return error instanceof CloudApiError && error.reason === null && error.status !== null && error.status < 500 && error.status !== 401 && error.status !== 408 && error.code !== "cloud_workspace_invalid_response";
}

/** Signed out by the server: after confirming, that is the deletion being scheduled (every device is signed out). */
function signedOut(error: unknown): boolean {
  return error instanceof CloudApiError && error.status === 401;
}

/**
 * The Delete account page's state (PRO-584): what the read route says, the
 * one confirmation under way, and the sentence for whatever stopped it. One
 * request at a time; nothing is retried on its own.
 */
export class AccountDeletionFlow {
  private state: DeletionState = { phase: { kind: "loading" }, read: null, sending: null, notice: null, signingIn: false, mismatch: false };
  private readonly listeners = new Set<() => void>();
  /** A confirmation, or the check after one, is under way. */
  private busy = false;
  private closed = false;
  private finished = false;

  constructor(private deps: AccountDeletionDeps) {}

  /** What the page hands in now (the network, a provider name read since): the next request uses it. */
  update(deps: AccountDeletionDeps): void {
    this.deps = deps;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): DeletionState => this.state;

  /** The page is (again) on screen: answers land on it. */
  open(): void {
    this.closed = false;
  }

  /** The page went away: a late answer changes nothing, and following stops. */
  close(): void {
    this.closed = true;
  }

  private set(change: Partial<DeletionState>): void {
    if (this.closed) return;
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  private graceDays(): number {
    return this.state.read?.graceDays ?? 14;
  }

  private running(): number {
    return this.state.read?.deleted.runningWorkspaces.length ?? 0;
  }

  /** Read what stands in the way and what goes. `quiet`: the notice on the page stays. */
  async load(quiet = false): Promise<void> {
    const api = this.deps.api;
    if (!api || this.finished) return;
    let value: AccountDeletionRead;
    try {
      value = await api.accountDeletion();
    } catch {
      if (this.state.phase.kind === "loading") this.set({ phase: { kind: "unreadable" } });
      return;
    }
    if (this.finished) return;
    const notice = quiet ? this.state.notice : this.state.notice?.kind === "unknown" || this.state.notice?.kind === "refused" ? this.state.notice : null;
    this.set({ read: value, notice, phase: this.state.phase.kind === "loading" || this.state.phase.kind === "unreadable" ? { kind: "ready" } : this.state.phase });
    const attempt = value.deletion;
    // Opened again while running ones are stopping, or after the final deletion started.
    if (attempt?.state === "stopping" && !this.busy) {
      this.busy = true;
      this.set({ sending: "stopping" });
      void this.follow(value.deleted.runningWorkspaces.length);
    } else if (attempt?.state === "deleting") this.set({ phase: { kind: "finishing" } });
  }

  /** Read again from the start, after the read failed. */
  reload = (): void => {
    this.set({ phase: { kind: "loading" } });
    void this.load();
  };

  /** Back on the page: a fixed item goes away by itself. Not while a confirmation is under way. */
  refocus(): void {
    if (!this.busy && !this.finished) void this.load(true);
  }

  confirm = (): void => {
    const { api, email, online } = this.deps;
    const read = this.state.read;
    if (this.busy || this.finished || !api || !email || !read) return;
    if (!online) {
      this.set({ notice: { kind: "offline" } });
      return;
    }
    this.busy = true;
    const running = read.deleted.runningWorkspaces.length;
    this.set({ mismatch: false, notice: null, sending: running ? "stopping" : "deleting" });
    void (async () => {
      let attempt: AccountDeletionAttempt;
      try {
        attempt = await api.requestAccountDeletion(email);
      } catch (error) {
        await this.refused(error);
        return;
      }
      if (await this.settle(attempt, running)) await this.follow(running);
    })();
  };

  private async refused(error: unknown): Promise<void> {
    const code = error instanceof CloudApiError ? error.code : "";
    this.busy = false;
    this.set({ sending: null });
    if (code === E.recentSignIn) {
      if (this.state.read) this.set({ read: { ...this.state.read, recentSignIn: false }, notice: { kind: "stale" } });
    } else if (code === E.mismatch) {
      this.set({ mismatch: true });
    } else if (code === E.blocked) {
      this.set({ notice: { kind: "blocked" } });
      await this.load(true);
    } else if (code === E.alreadyRequested || code === E.inProgress) {
      // Asked before (another device, or an answer lost): what the server holds decides.
      await this.verify();
    } else if (answeredRefusal(error)) {
      this.set({ notice: { kind: "refused", tone: "danger", text: T.failRefused } });
    } else {
      // No answer, or one that cannot be read: it may have been scheduled.
      this.set({ notice: { kind: "unknown" } });
    }
  }

  /** Scheduled: the phone forgets the account; the page says when it goes. */
  /** The day a `stopping` attempt said, if it said one: what the page says when the read after is refused. */
  private stoppingDeleteAfter: number | null = null;

  private async scheduled(deleteAfter: number | null, stopped: number): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.busy = false;
    this.set({ sending: null, notice: null, phase: { kind: "scheduled", deleteAfter, graceDays: this.graceDays(), stopped } });
    // Settings says the day only when the server said it; no day is made up here.
    if (deleteAfter !== null) await rememberPendingDeletion(deleteAfter);
    await this.deps.forgetDeletedAccount();
  }

  /** What an attempt the server answered with means for the page; true while it is still stopping. */
  private async settle(attempt: AccountDeletionAttempt | null | undefined, stoppedBefore: number): Promise<boolean> {
    switch (attempt?.state) {
      case "stopping": {
        // The day the server will delete it, once it says so while stopping (terminalx-saas #352): the
        // sign-out that comes with scheduling refuses every read after, so this is the last chance to learn it.
        const at = Date.parse(attempt.deleteAfter ?? "");
        if (Number.isFinite(at)) this.stoppingDeleteAfter = at;
        this.set({ sending: "stopping" });
        return true;
      }
      case "scheduled": {
        const at = Date.parse(attempt.deleteAfter ?? "");
        await this.scheduled(Number.isFinite(at) ? at : null, stoppedAtConfirm(attempt) || stoppedBefore);
        return false;
      }
      case "deleting":
        this.busy = false;
        this.set({ sending: null, phase: { kind: "finishing" } });
        return false;
      case "refused": {
        this.busy = false;
        // Nothing was scheduled: a later try makes a new attempt with its own day.
        this.stoppingDeleteAfter = null;
        const names = new Map((this.state.read?.deleted.runningWorkspaces ?? []).map((workspace) => [workspace.id, workspace.name]));
        const provider = this.deps.providerName ?? (() => T.aProvider);
        const sentence = refusalSentence(attempt.failure, (id) => provider(id, attempt.failure?.workspaceId ?? null), (id) => names.get(id) ?? null);
        this.set({ sending: null, notice: { kind: "refused", tone: sentence.tone, text: sentence.text } });
        // A blocker that appeared after confirming: the list is read again so the page shows it.
        if (sentence.blocked) await this.load(true);
        return false;
      }
      default:
        this.busy = false;
        this.set({ sending: null, notice: { kind: "unknown" } });
        return false;
    }
  }

  /** Ask until the running ones have stopped and the deletion is scheduled, or one refused. */
  private async follow(stoppedBefore: number): Promise<void> {
    const api = this.deps.api;
    while (api && !this.closed && !this.finished) {
      await (this.deps.wait ?? sleep)(STOP_POLL_MS);
      if (this.closed) return;
      let value: AccountDeletionRead;
      try {
        value = await api.accountDeletion();
      } catch (error) {
        if (signedOut(error)) return this.scheduled(this.stoppingDeleteAfter, stoppedBefore);
        this.busy = false;
        this.set({ sending: null, notice: { kind: "unknown" } });
        return;
      }
      this.set({ read: value });
      if (!(await this.settle(value.deletion, stoppedBefore))) return;
    }
  }

  /** After an answer was lost: read what the server holds before anything is sent again. */
  check = (): void => {
    if (!this.busy) void this.verify();
  };

  private async verify(): Promise<void> {
    const api = this.deps.api;
    if (!api) return;
    this.busy = true;
    const running = this.running();
    let value: AccountDeletionRead;
    try {
      value = await api.accountDeletion();
    } catch (error) {
      // Signed out everywhere: the deletion was scheduled.
      if (signedOut(error)) return this.scheduled(this.stoppingDeleteAfter, running);
      this.busy = false;
      this.set({ notice: { kind: "unknown" } });
      return;
    }
    this.set({ read: value });
    const attempt = value.deletion;
    if (attempt && ["stopping", "scheduled", "deleting"].includes(attempt.state)) {
      if (await this.settle(attempt, running)) await this.follow(running);
      return;
    }
    // Nothing under way: the earlier request changed nothing.
    this.busy = false;
    this.set({ sending: null, notice: null });
  }

  signInAgain = (): void => {
    if (this.busy || this.state.signingIn) return;
    this.set({ signingIn: true });
    void this.deps.reauthenticate().then(async (outcome) => {
      if (outcome === "other-account") this.set({ notice: { kind: "other-account" } });
      if (outcome === "signed-in") {
        if (this.state.notice?.kind === "stale" || this.state.notice?.kind === "other-account") this.set({ notice: null });
        await this.load(true);
      }
    }, () => undefined).finally(() => this.set({ signingIn: false }));
  };
}

export type AccountDeletionController = DeletionState & Pick<AccountDeletionFlow, "confirm" | "check" | "reload" | "signInAgain">;

/** The page's flow, read when it opens and again each time the app comes back to the front. */
export function useAccountDeletion(deps: AccountDeletionDeps): AccountDeletionController {
  const [flow] = useState(() => new AccountDeletionFlow(deps));
  // The latest of what the page hands in (the network, a provider name read since) is what the next request uses.
  useEffect(() => { flow.update(deps); });
  const hasApi = deps.api !== null;
  useEffect(() => {
    if (hasApi) void flow.load();
  }, [flow, hasApi]);
  useEffect(() => {
    flow.open();
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") flow.refocus(); });
    return () => { subscription.remove(); flow.close(); };
  }, [flow]);
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
  return { ...state, confirm: flow.confirm, check: flow.check, reload: flow.reload, signInAgain: flow.signInAgain };
}
