import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { CloudApiError, type CloudApi, type CodexDeviceLogin, type CredentialConsent } from "../../api";
import { CANCELED, EXPIRED, REFUSED, failure } from "./words";

/**
 * Codex's "Sign in with ChatGPT" (25.04): one device login per organization
 * at a time, kept in memory while it can still be finished.
 *
 * The login lives here rather than in the page, so leaving the page or the
 * app and coming back carries on with the same code; a page that finds one
 * under way, or one being asked for, waits on it and never asks for a second.
 * Nothing of it is written anywhere: the code is shown, and lost with the app.
 */
export interface Attempt {
  orgId: string;
  login: CodexDeviceLogin;
  /** When the code stops working, on the phone's clock: the time the answer came plus the seconds the server gave. */
  expiresAt: number;
  /** The sign-in page was opened at least once: the page says it is waiting. */
  opened: boolean;
  /** When the server was last asked about it (at first, when the code came): the next question waits its interval from here. */
  askedAt: number;
}

const attempts = new Map<string, Attempt>();
const starting = new Map<string, { promise: Promise<Attempt>; abandoned: boolean }>();

/** The organization's login that can still be finished, if there is one. */
export function liveAttempt(orgId: string, now = Date.now()): Attempt | null {
  const attempt = attempts.get(orgId);
  if (!attempt) return null;
  if (attempt.expiresAt <= now) {
    attempts.delete(orgId);
    return null;
  }
  return attempt;
}

/** The live login, the one being asked for, or a new one: never two at once for an organization. */
export function startAttempt(api: CloudApi, orgId: string): Promise<Attempt> {
  const live = liveAttempt(orgId);
  if (live) return Promise.resolve(live);
  const pending = starting.get(orgId);
  if (pending && !pending.abandoned) return pending.promise;
  const entry = { abandoned: false, promise: null as unknown as Promise<Attempt> };
  entry.promise = api.startCodexLogin(orgId).then((login) => {
    const now = Date.now();
    const attempt: Attempt = { orgId, login, expiresAt: now + login.expiresInSeconds * 1000, opened: false, askedAt: now };
    if (entry.abandoned) {
      // Asked for, then given up before it came: the server is told, so the code never works.
      void api.cancelCodexLogin(orgId, login).catch(() => undefined);
      throw new CloudApiError("cloud_workspace_device_auth_not_found", 410);
    }
    attempts.set(orgId, attempt);
    return attempt;
  }).finally(() => {
    if (starting.get(orgId) === entry) starting.delete(orgId);
  });
  starting.set(orgId, entry);
  return entry.promise;
}

/** Give up a login still being asked for: when it comes, it is cancelled on the server. */
export function abandonStart(orgId: string): void {
  const pending = starting.get(orgId);
  if (pending) pending.abandoned = true;
}

/** The login ended (connected, cancelled, expired, refused): the next page asks for a new one. */
export function endAttempt(orgId: string, login: CodexDeviceLogin): void {
  if (attempts.get(orgId)?.login.attemptId === login.attemptId) attempts.delete(orgId);
}

function markOpened(orgId: string, login: CodexDeviceLogin): void {
  const attempt = attempts.get(orgId);
  if (attempt?.login.attemptId === login.attemptId) attempt.opened = true;
}

/** For tests: forget every login. */
export function resetDeviceLogins(): void {
  attempts.clear();
  starting.clear();
}

export type DeviceLoginPhase =
  | { phase: "requesting" }
  /** No code could be had; `error` says why (cloud_workspace_device_auth_unavailable and the like). */
  | { phase: "start-failed"; error: CloudApiError }
  /** The code is shown. `offline`: the last question never reached the service. */
  | { phase: "code"; attempt: Attempt; offline: boolean }
  | { phase: "connected"; identity: string | null }
  /** The code no longer works; it stays in view, struck through, with the reason. */
  | { phase: "ended"; code: string; outcome: "canceled" | "expired" | "failed"; text: string };

const ended = (attempt: Attempt, outcome: "canceled" | "expired" | "failed", text?: string): DeviceLoginPhase => ({
  phase: "ended", code: attempt.login.userCode, outcome, text: text ?? (outcome === "canceled" ? CANCELED : outcome === "expired" ? EXPIRED : REFUSED),
});

/** Whether the app is in front, as iOS says. */
function useAppActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState === "active" || AppState.currentState == null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  return active;
}

/**
 * The device login as the page shows it. It asks the server whether the
 * person has finished only while `shown` (the page is in view) and the app is
 * active, no sooner than every `intervalSeconds` the server gave, and stops
 * the moment either ends. `consent` goes with each of those questions, as the
 * server requires; the page has it only when the admin gave it on the form.
 */
export function useDeviceLogin(api: CloudApi | null, orgId: string | null, consent: CredentialConsent | null, shown: boolean) {
  const [state, setState] = useState<DeviceLoginPhase>({ phase: "requesting" });
  const [, raise] = useState<null>(null);
  const active = useAppActive();
  // Which request for a code is current, which run of questions is, and whether a cancel is under way.
  const startRun = useRef(0);
  const pollRun = useRef(0);
  const cancelling = useRef(false);

  const begin = useCallback(() => {
    if (!api || !orgId || !consent) return;
    const id = ++startRun.current;
    const live = liveAttempt(orgId);
    if (live) { setState({ phase: "code", attempt: live, offline: false }); return; }
    setState({ phase: "requesting" });
    startAttempt(api, orgId).then(
      (attempt) => { if (startRun.current === id) setState({ phase: "code", attempt, offline: false }); },
      (error: unknown) => {
        if (startRun.current !== id) return;
        if (!(error instanceof CloudApiError)) { raise(() => { throw error; }); return; }
        setState({ phase: "start-failed", error });
      },
    );
  }, [api, orgId, consent]);

  // The first showing carries on with a login under way, or asks for one.
  useEffect(() => { begin(); return () => { startRun.current += 1; }; }, [begin]);

  const attempt = state.phase === "code" ? state.attempt : null;
  const asking = !!api && !!orgId && !!consent && !!attempt && shown && active;

  useEffect(() => {
    if (!asking || !attempt || !api || !orgId || !consent) return;
    const id = ++pollRun.current;
    const current = () => pollRun.current === id && !cancelling.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const interval = attempt.login.intervalSeconds * 1000;
    const next = () => { if (pollRun.current === id) timer = setTimeout(() => void ask(), interval); };
    const ask = async () => {
      timer = null;
      if (pollRun.current !== id) return;
      // While a cancel is under way nothing is asked; if it fails, asking carries on.
      if (cancelling.current) { next(); return; }
      attempt.askedAt = Date.now();
      try {
        const answer = await api.pollCodexLogin(orgId, attempt.login, consent);
        if (!current()) { next(); return; }
        if (answer.status === "pending") { setState((now) => (now.phase === "code" && now.offline ? { ...now, offline: false } : now)); next(); return; }
        endAttempt(orgId, attempt.login);
        if (answer.status === "complete") setState({ phase: "connected", identity: answer.credential.displayIdentity ?? null });
        else setState(ended(attempt, answer.status === "canceled" ? "canceled" : answer.status === "expired" ? "expired" : "failed"));
      } catch (error) {
        if (!(error instanceof CloudApiError)) { raise(() => { throw error; }); return; }
        if (!current()) { next(); return; }
        // No answer at all: the phone is offline. The code is still good; asking carries on.
        if (error.status === null) { setState((now) => (now.phase === "code" ? { ...now, offline: true } : now)); next(); return; }
        // The service is busy or down for a moment: asked again, nothing said.
        if (error.unreachable) { next(); return; }
        endAttempt(orgId, attempt.login);
        setState(error.refusal === "device-login-not-found" ? ended(attempt, "expired") : ended(attempt, "failed", failure(error)));
      }
    };
    // Back from the browser or the background: asked at once if the last question is old enough.
    timer = setTimeout(() => void ask(), Math.max(0, attempt.askedAt + interval - Date.now()));
    return () => { pollRun.current += 1; if (timer) clearTimeout(timer); };
    // A new attempt, or a change in whether the page may ask; not each change to the same attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking, attempt?.login.attemptId, api, orgId, consent]);

  /** The clock ran out on a code still shown. */
  const expire = useCallback(() => {
    setState((current) => {
      if (current.phase !== "code" || !orgId) return current;
      endAttempt(orgId, current.attempt.login);
      return ended(current.attempt, "expired");
    });
  }, [orgId]);

  /** The sign-in page was opened: from now on the page says it is waiting. */
  const opened = useCallback(() => {
    setState((current) => {
      if (current.phase !== "code" || !orgId) return current;
      markOpened(orgId, current.attempt.login);
      current.attempt.opened = true;
      return { ...current };
    });
  }, [orgId]);

  /**
   * Cancel tells the server, so the code stops working. Its answer is where
   * the attempt ended, which is connected when the sign-in won the race.
   * Resolves with the error when the server could not be told; the page then
   * keeps waiting on the same code.
   */
  const cancel = useCallback(async (): Promise<CloudApiError | null> => {
    if (!api || !orgId || !attempt) return null;
    cancelling.current = true;
    try {
      const status = await api.cancelCodexLogin(orgId, attempt.login);
      if (status === "waiting") return new CloudApiError("cloud_workspace_device_auth_cancel_failed", 409);
      endAttempt(orgId, attempt.login);
      pollRun.current += 1;
      if (status === "connected") {
        const answer = consent ? await api.pollCodexLogin(orgId, attempt.login, consent).catch(() => null) : null;
        setState({ phase: "connected", identity: answer?.status === "complete" ? answer.credential.displayIdentity ?? null : null });
      } else setState(ended(attempt, status === "canceled" ? "canceled" : status === "expired" ? "expired" : "failed"));
      return null;
    } catch (error) {
      if (!(error instanceof CloudApiError)) throw error;
      return error;
    } finally {
      cancelling.current = false;
    }
  }, [api, orgId, attempt, consent]);

  /** Leave while the code is still being asked for: it is cancelled on the server when it comes. */
  const abandon = useCallback(() => {
    if (orgId && state.phase === "requesting") abandonStart(orgId);
    startRun.current += 1;
  }, [orgId, state.phase]);

  /** A new code, after one that ended or could not be had. */
  const restart = useCallback(() => {
    if (orgId && attempt) endAttempt(orgId, attempt.login);
    begin();
  }, [orgId, attempt, begin]);

  return { state, expire, opened, cancel, abandon, restart };
}
