import { useEffect, useState } from "react";
import type { ConnectionStage } from "../transport/connection";

/**
 * The connection to the Mac as every screen shows it (#983): one state, in
 * one place, said with the same few words everywhere. The session subtitle,
 * the Sessions header and the machine's row all read it from here, so they
 * cannot disagree.
 *
 * - `connecting`: first contact after the app opens or comes back, or a
 *   connection lost a moment ago that the phone is making again.
 * - `updating`: connected, and reading what changed while it was not.
 * - `connected`: nothing to say in a session; "Connected" on a machine's row.
 * - `waiting`: no answer for `WAITING_AFTER_MS`. The phone keeps retrying by
 *   itself; only now is "Try again" offered.
 * - `offline`: the phone itself has no network.
 * - `held`: the person disconnected this phone on the Mac; it reconnects
 *   only when asked.
 * - `none`: no Mac chosen.
 */
export type ConnectionState = "none" | "connecting" | "updating" | "connected" | "waiting" | "offline" | "held";

/** How long the phone tries quietly before it says it is waiting for the Mac and offers Try again. */
export const WAITING_AFTER_MS = 15_000;

export interface ConnectionFacts {
  stage: ConnectionStage;
  hasHost: boolean;
  /** The phone has been trying for `WAITING_AFTER_MS` without reaching the Mac (`useWaited`). */
  waited: boolean;
  /** False only when the phone's own network is down. */
  online: boolean;
  /** Connected, and reading what it missed. */
  updating: boolean;
}

export function connectionState(facts: ConnectionFacts): ConnectionState {
  if (!facts.hasHost) return "none";
  if (facts.stage === "disconnected-on-mac") return "held";
  if (facts.stage === "connected") return facts.updating ? "updating" : "connected";
  if (!facts.online) return "offline";
  return facts.waited ? "waiting" : "connecting";
}

const WORDS: Record<ConnectionState, string | null> = {
  none: null,
  connecting: "Connecting…",
  updating: "Updating…",
  connected: "Connected",
  waiting: "Waiting for Mac…",
  offline: "No internet",
  held: "Disconnected on your computer",
};

/** The words for a state; the only ones any screen uses for the connection. */
export function connectionWords(state: ConnectionState): string | null {
  return WORDS[state];
}

/** Whether the state is something under way, drawn with a small spinner. */
export function connectionBusy(state: ConnectionState): boolean {
  return state === "connecting" || state === "updating";
}

/** Whether requests can go to the Mac. */
export function connectionUsable(state: ConnectionState): boolean {
  return state === "connected" || state === "updating";
}

/**
 * The one clock (#983): whether `WAITING_AFTER_MS` have passed since `since`,
 * the moment the phone began trying this time (null while it is not trying).
 * The app keeps it, once, so every screen turns to "Waiting for Mac…" together.
 */
export function useWaited(since: number | null): boolean {
  const [waitedFor, setWaitedFor] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    const timer = setTimeout(() => setWaitedFor(since), Math.max(0, since + WAITING_AFTER_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [since]);
  return since !== null && waitedFor === since;
}

/** What the app context carries for it; the newer fields are optional so a context without them reads as before. */
export interface ConnectionSource {
  activeHost: unknown;
  connectionStage: ConnectionStage;
  connectionWaiting?: boolean;
  online?: boolean;
  updating?: boolean;
}

export function connectionFacts(source: ConnectionSource): ConnectionFacts {
  return {
    stage: source.connectionStage,
    hasHost: !!source.activeHost,
    waited: source.connectionWaiting ?? false,
    online: source.online ?? true,
    updating: source.updating ?? false,
  };
}

/** The state for a screen: the same for every screen at any moment, as they all read it from the app. */
export function useConnectionState(source: ConnectionSource): ConnectionState {
  return connectionState(connectionFacts(source));
}
