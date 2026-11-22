import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  attemptOutcome,
  githubAppErrorCode,
  githubAppErrorMessage,
  organizationGithubApp,
  unsettledOutcome,
  type AttemptOutcome,
  type ConnectAttempt,
} from "@/lib/organizationGithubApp";

export const CONNECT_POLL_INTERVAL_MS = 2000;
/**
 * How long the desktop keeps checking one attempt: its own UX budget, not the
 * account service's attempt lifetime, which it neither knows nor assumes
 * (#1370). Only the server ends an attempt; while it answers "waiting" the
 * desktop polls, up to this budget on its monotonic clock from when it started
 * the attempt. Past it the desktop stops without calling the attempt expired
 * and re-reads the installations, so one that connected on the server shows
 * up; one that connects even later shows on the next read of the installations.
 * The server-issued `expiresAt` is never compared with the desktop's wall
 * clock: the two clocks need not agree, and the wall clock can jump.
 */
export const CONNECT_POLL_BUDGET_MS = 30 * 60_000;

const monotonicNow = () => performance.now();

/**
 * One GitHub App connect attempt, shared by the organization settings card
 * and the cloud setup wizard (#1285): polls a waiting attempt until the
 * account service settles it or the desktop's polling budget runs out
 * (`CONNECT_POLL_BUDGET_MS`), and turns every ending into one outcome the
 * caller shows.
 *
 * Completion is only visible through the poll: GitHub redirects the browser to
 * the account service, never to the desktop.
 */
export function useGithubConnectAttempt({
  pollIntervalMs = CONNECT_POLL_INTERVAL_MS,
  epoch,
  onEnd,
  clock = monotonicNow,
}: {
  pollIntervalMs?: number;
  /** Bumped by the caller when its account or organization changes; a poll started under an older value is dropped. */
  epoch?: MutableRefObject<number>;
  /** Called once per ending, with the attempt as the server last reported it (null when it could not be read). */
  onEnd: (outcome: AttemptOutcome | null, attempt: ConnectAttempt | null) => void;
  /** A monotonic clock in milliseconds; not the wall clock. */
  clock?: () => number;
}) {
  const [attempt, setAttempt] = useState<ConnectAttempt | null>(null);
  // When the desktop started the shown attempt, on `clock`.
  const startedAt = useRef(0);
  // Bumped whenever the caller ends or replaces an attempt itself, so a poll
  // already in flight cannot bring it back.
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const clockRef = useRef(clock);
  clockRef.current = clock;

  const timedOut = () => clockRef.current() - startedAt.current > CONNECT_POLL_BUDGET_MS;

  useEffect(() => {
    if (!attempt || attempt.state !== "waiting") return;
    const context = epoch?.current;
    const started = seq.current;
    let stopped = false;
    const current = () => !stopped && mounted.current && started === seq.current && context === epoch?.current;
    const endExpired = () => {
      const expired = { ...attempt, state: "expired" };
      setAttempt(expired);
      onEndRef.current(attemptOutcome(expired, "poll"), expired);
    };
    // Not an expiry: the server has not said how the attempt ended.
    const stopUnsettled = () => {
      setAttempt(null);
      onEndRef.current(unsettledOutcome(), null);
    };
    const timer = setTimeout(async () => {
      try {
        const next = await organizationGithubApp.attempt(attempt.attemptId);
        if (!current()) return;
        if (next.state === "waiting") {
          // A poll answer carries neither the install page nor whether the
          // browser opened: keep them, or the panel loses its "Open install
          // page" button after the first poll.
          const merged = {
            ...next,
            installUrl: next.installUrl ?? attempt.installUrl,
            expiresAt: next.expiresAt ?? attempt.expiresAt,
            browserOpened: attempt.browserOpened,
          };
          // The server expires an attempt when it is polled, so "waiting" is
          // believed; this only bounds a server that keeps answering it.
          if (timedOut()) stopUnsettled();
          else setAttempt(merged);
          return;
        }
        setAttempt(next);
        onEndRef.current(attemptOutcome(next, "poll"), next);
      } catch (failure) {
        if (!current()) return;
        if (githubAppErrorCode(failure) === "github_connect_attempt_expired") {
          endExpired();
        } else if (githubAppErrorCode(failure) === "github_app_request_failed") {
          // A network blip keeps polling, until the desktop's polling budget runs out.
          if (timedOut()) stopUnsettled();
          else setAttempt({ ...attempt });
        } else {
          setAttempt(null);
          onEndRef.current({ kind: "error", message: githubAppErrorMessage(failure) }, null);
        }
      }
    }, pollIntervalMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // `epoch` is a ref; reading it at the start of each poll is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, pollIntervalMs]);

  /** Show and poll a newly created attempt. */
  const start = useCallback((next: ConnectAttempt) => {
    seq.current += 1;
    startedAt.current = clockRef.current();
    setAttempt(next);
  }, []);

  /** Forget the attempt without telling the server (the context changed). */
  const reset = useCallback(() => {
    seq.current += 1;
    setAttempt(null);
  }, []);

  /**
   * Cancel from the desktop. `send` runs the request through the caller's
   * busy and error handling and resolves to null when it was refused.
   */
  const cancel = useCallback(
    async (send: (attemptId: string) => Promise<{ value: ConnectAttempt } | null>) => {
      const shown = attempt;
      if (!shown) return;
      seq.current += 1;
      const result = await send(shown.attemptId);
      if (!mounted.current) return;
      // A poll can start while the cancel is in flight (an earlier poll's
      // answer re-arms it). Its answer still says "waiting", and landing after
      // this one it would put the canceled attempt back on screen.
      seq.current += 1;
      const ended = result?.value;
      if (!ended) {
        // Not canceled: keep polling the attempt.
        setAttempt((visible) => (visible ? { ...visible } : visible));
        return;
      }
      setAttempt(ended.state === "waiting" ? null : ended);
      onEndRef.current(attemptOutcome(ended, "cancel"), ended);
    },
    [attempt],
  );

  return { attempt, waiting: attempt?.state === "waiting", start, cancel, reset };
}
