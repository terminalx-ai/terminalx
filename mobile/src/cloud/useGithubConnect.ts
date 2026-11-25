import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as WebBrowser from "expo-web-browser";
import type { CloudApi, CloudGithubApp, GithubConnectAttempt, GithubConnectStart } from "./api";
import { GITHUB_RETURN_URL, browserFailedOutcome, connectOutcome, expiredOutcome, githubRefusal, githubReturn, returnedAttempt, startRefusal, type ConnectOutcome } from "./github";

/** How often a waiting attempt is asked about (the contract's figure). */
export const ATTEMPT_POLL_MS = 2_000;

type GithubApi = Pick<CloudApi, "githubApp" | "startGithubConnect" | "githubConnectAttempt" | "cancelGithubConnect" | "serverNow">;

// ── The organization's GitHub App, as read ──

export type GithubAppRead =
  | { status: "loading" }
  | { status: "ready"; app: CloudGithubApp }
  | { status: "failed" };

/** The organization's installations and chosen repositories, read when the page opens and again when asked. */
export function useGithubApp(api: Pick<CloudApi, "githubApp">, orgId: string): { read: GithubAppRead; reload(): Promise<void>; put(app: CloudGithubApp): void } {
  // What was read is of one organization: for another, nothing is read yet.
  const [held, setHeld] = useState<{ orgId: string; read: GithubAppRead }>({ orgId, read: { status: "loading" } });
  const turn = useRef(0);
  const reload = useCallback(() => {
    const mine = ++turn.current;
    const kept = (was: { orgId: string; read: GithubAppRead }) => was.orgId === orgId && was.read.status === "ready";
    // What is shown stays while it is read again; only a first read shows as loading.
    setHeld((was) => (kept(was) ? was : { orgId, read: { status: "loading" } }));
    return api.githubApp(orgId).then(
      (app) => { if (turn.current === mine) setHeld({ orgId, read: { status: "ready", app } }); },
      () => { if (turn.current === mine) setHeld((was) => (kept(was) ? was : { orgId, read: { status: "failed" } })); },
    );
  }, [api, orgId]);
  useEffect(() => {
    const mine = ++turn.current;
    api.githubApp(orgId).then(
      (app) => { if (turn.current === mine) setHeld({ orgId, read: { status: "ready", app } }); },
      () => { if (turn.current === mine) setHeld({ orgId, read: { status: "failed" } }); },
    );
    return () => { turn.current += 1; };
  }, [api, orgId]);
  /** The server's answer to a save is the new status: it takes the old one's place at once. */
  const put = useCallback((app: CloudGithubApp) => { turn.current += 1; setHeld({ orgId, read: { status: "ready", app } }); }, [orgId]);
  const read: GithubAppRead = held.orgId === orgId ? held.read : { status: "loading" };
  return { read, reload, put };
}

// ── Connecting ──

export type GithubConnect =
  | { phase: "idle" }
  /** The attempt is being asked for. */
  | { phase: "starting" }
  /** The attempt waits on the browser. `browser`: the sign-in sheet is open over the page. `canceling`: Cancel was pressed and is being asked for. `problem`: why the last Cancel did not go through. */
  | { phase: "waiting"; expiresAt: number; browser: boolean; canceling?: boolean; problem?: string }
  /** Back from the browser: the server is asked how the attempt ended. */
  | { phase: "checking" }
  /** Over: connected, or why not. `installationId` is the one just connected. */
  | { phase: "ended"; outcome: ConnectOutcome; installationId: string | null };

/**
 * One GitHub connect from the phone (the contract's steps 1 to 5). The
 * attempt's two addresses are secrets: they stay in a ref, are handed to the
 * system's sign-in browser, and never reach what is drawn or logged.
 *
 * The browser's return link proves nothing, so nothing is concluded from it:
 * every way back (the link, the sheet closing, the app coming to the front,
 * the clock) only asks the server about the attempt this page started.
 * Leaving the page, or closing the browser while the attempt still waits,
 * cancels it, so it cannot be finished from the browser later.
 */
export function useGithubConnect(api: GithubApi, orgId: string, onSettled: () => void): { state: GithubConnect; now(): number; connect(): void; reopen(): void; cancel(): void; dismiss(): void } {
  const [state, setState] = useState<GithubConnect>({ phase: "idle" });
  const attempt = useRef<GithubConnectStart | null>(null);
  const browsing = useRef(false);
  const asking = useRef(false);
  const alive = useRef(true);
  const settled = useRef(onSettled);
  useEffect(() => { settled.current = onSettled; });

  const closeBrowser = () => {
    if (!browsing.current) return;
    // The sign-in sheet closes itself on iOS; where there is nothing to close this is a no-op.
    try { void Promise.resolve(WebBrowser.dismissAuthSession()).catch(() => undefined); } catch { /* Nothing was open. */ }
  };

  /** Show how the attempt ended; false while it still waits. */
  const settle = useCallback((answer: GithubConnectAttempt, ended: "poll" | "cancel" | "closed"): boolean => {
    const outcome = connectOutcome(answer, ended);
    if (!outcome) return false;
    attempt.current = null;
    closeBrowser();
    if (alive.current) setState({ phase: "ended", outcome, installationId: outcome.connected ? answer.installation?.id ?? null : null });
    // Connected or not, what the organization has may have changed: it is read again.
    settled.current();
    return true;
  }, []);

  /** Ask the server about the attempt. Its answer is the only thing that ends the wait. */
  const ask = useCallback(async (): Promise<"settled" | "waiting" | "unknown" | "busy"> => {
    const mine = attempt.current;
    if (!mine) return "settled";
    // One question at a time: the one already on its way answers for this one too.
    if (asking.current) return "busy";
    asking.current = true;
    try {
      const answer = await api.githubConnectAttempt(orgId, mine.attemptId);
      if (attempt.current !== mine) return "settled";
      return settle(answer, "poll") ? "settled" : "waiting";
    } catch {
      // No answer, or one that says nothing of the attempt: it is asked again at the next turn.
      return attempt.current === mine ? "unknown" : "settled";
    } finally {
      asking.current = false;
    }
  }, [api, orgId, settle]);

  /** End an attempt that still waits, and say why. */
  const end = useCallback(async (ended: "cancel" | "closed") => {
    const mine = attempt.current;
    if (!mine) return;
    try {
      const answer = await api.cancelGithubConnect(orgId, mine.attemptId);
      if (attempt.current !== mine) return;
      // Canceling an attempt that already ended returns how it ended: connected, when the browser won the race.
      if (!settle(answer, ended) && alive.current) setState({ phase: "waiting", expiresAt: mine.expiresAt, browser: browsing.current });
    } catch (error) {
      // Not canceled as far as is known: the attempt keeps waiting, and the page keeps asking.
      if (attempt.current === mine && alive.current) setState({ phase: "waiting", expiresAt: mine.expiresAt, browser: browsing.current, problem: githubRefusal(error) });
    }
  }, [api, orgId, settle]);

  /** Open GitHub in the system's sign-in browser, and act on how that session ends. */
  const browse = useCallback(async (mine: GithubConnectStart) => {
    browsing.current = true;
    let result: { type: string; url?: string };
    try {
      // The platform's sign-in session, not a web view, and not a private one: the person's GitHub sign-in in the browser is used.
      result = await WebBrowser.openAuthSessionAsync(mine.installUrl, GITHUB_RETURN_URL, { preferEphemeralSession: false });
    } catch {
      result = { type: "failed" };
    }
    browsing.current = false;
    if (attempt.current !== mine || !alive.current) return;
    if (result.type === "failed" || result.type === "locked") {
      // GitHub was never shown: the attempt is ended, and the page says the browser did not open.
      attempt.current = null;
      void api.cancelGithubConnect(orgId, mine.attemptId).catch(() => undefined);
      setState({ phase: "ended", outcome: browserFailedOutcome(), installationId: null });
      return;
    }
    // A link for another attempt is not this page's: it is treated as the sheet having closed, no more.
    const returned = result.type === "success" && typeof result.url === "string" && returnedAttempt(result.url) === mine.attemptId;
    setState({ phase: "checking" });
    const answer = await ask();
    if (answer === "settled" || attempt.current !== mine || !alive.current) return;
    // The person closed the sheet (iOS's Cancel) with the attempt still waiting: it is ended, so the browser cannot finish it later.
    if (result.type === "cancel" && !returned) return end("closed");
    // Otherwise the app is back with the attempt still open (Android's tab may live on): the page waits, and can open GitHub again.
    setState({ phase: "waiting", expiresAt: mine.expiresAt, browser: false });
  }, [api, orgId, ask, end]);

  const connect = useCallback(() => {
    if (attempt.current || state.phase === "starting" || state.phase === "checking") return;
    setState({ phase: "starting" });
    void api.startGithubConnect(orgId).then((started) => {
      if (!alive.current) return void api.cancelGithubConnect(orgId, started.attemptId).catch(() => undefined);
      attempt.current = started;
      setState({ phase: "waiting", expiresAt: started.expiresAt, browser: true });
      void browse(started);
    }, (error: unknown) => {
      if (!alive.current) return;
      setState({ phase: "ended", outcome: startRefusal(error), installationId: null });
      settled.current();
    });
  }, [api, orgId, browse, state.phase]);

  const reopen = useCallback(() => {
    const mine = attempt.current;
    if (!mine || browsing.current) return;
    setState({ phase: "waiting", expiresAt: mine.expiresAt, browser: true });
    void browse(mine);
  }, [browse]);

  const cancel = useCallback(() => {
    const mine = attempt.current;
    if (!mine) return;
    setState({ phase: "waiting", expiresAt: mine.expiresAt, browser: browsing.current, canceling: true });
    void end("cancel");
  }, [end]);

  /** Put away what was said about an attempt that is over. */
  const dismiss = useCallback(() => { if (!attempt.current) setState({ phase: "idle" }); }, []);

  // While it waits: asked every two seconds, when the app comes back to the front, when a return link
  // arrives outside the browser session, and one last time when its fifteen minutes are up.
  const waiting = state.phase === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const turn = async () => {
      const mine = attempt.current;
      if (!mine) return;
      const late = api.serverNow() >= mine.expiresAt;
      const answer = await ask();
      if (answer === "settled" || answer === "busy" || !late || attempt.current !== mine) return;
      // Its time is up and the server did not say otherwise: it cannot be finished any more.
      attempt.current = null;
      closeBrowser();
      void api.cancelGithubConnect(orgId, mine.attemptId).catch(() => undefined);
      if (alive.current) setState({ phase: "ended", outcome: expiredOutcome(), installationId: null });
      settled.current();
    };
    const timer = setInterval(() => void turn(), ATTEMPT_POLL_MS);
    const front = AppState.addEventListener("change", (next) => { if (next === "active") void turn(); });
    const link = githubReturn.subscribe((attemptId) => { if (attemptId === attempt.current?.attemptId) void turn(); });
    return () => { clearInterval(timer); front.remove(); link(); };
  }, [waiting, api, orgId, ask]);

  // Backing out of the page ends an attempt that still waits.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const mine = attempt.current;
      attempt.current = null;
      closeBrowser();
      if (mine) void api.cancelGithubConnect(orgId, mine.attemptId).catch(() => undefined);
    };
  }, [api, orgId]);

  return { state, now: api.serverNow, connect, reopen, cancel, dismiss };
}
