import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { RecoveryKind } from "@/types/events";
import { recoveryIncidents } from "@/lib/api";

/**
 * What a window tells the runtime's recovery incident log (#815,
 * `recovery_log.rs`): what of a tab's warning was actually on screen, for how
 * long and why it went, and what was pressed about it with what result.
 *
 * Only what was seen is said. A warning counts as shown while its tab is the
 * one in front, the window is not hidden and (for a row in the chat) it is in
 * view; a tab mounted in the background, or drawn again, says nothing. Labels
 * and numbers only: never a message, a prompt or an error's words.
 */
export type Surface = "banner" | "composer_notice" | "error_row" | "dialog" | "chat";
export type HideReason = "cleared" | "tab_hidden" | "background" | "scrolled" | "unmounted" | "submitted" | "cancelled";
export type RecoveryAction = "retry" | "choose_model" | "continue_here" | "stop" | "continue_new" | "resend" | "send_again" | "sign_in" | "interrupt";
export type ActionInput = "pointer" | "keyboard" | "shortcut";
export type ActionResult = "accepted" | "rejected" | "ok" | "failed" | "cancelled";
export type RejectReason = "in_progress" | "blocked" | "unavailable";
export type DisplayedStatus = "idle" | "in_progress" | "waiting" | "completed";

export interface UiReport {
  kind: "exposure" | "action";
  surface: Surface;
  phase: "shown" | "hidden" | "resurfaced" | "start" | "result";
  reason?: RecoveryKind | null;
  clientId: string;
  placement?: "composer" | "top";
  activeTab: boolean;
  foreground: boolean;
  durationMs?: number;
  hideReason?: HideReason;
  action?: RecoveryAction;
  actor?: "human" | "agent" | "automatic";
  input?: ActionInput;
  sinceExposureMs?: number;
  tabStatus?: DisplayedStatus;
  result?: ActionResult;
  rejectReason?: RejectReason;
  errorKind?: RecoveryKind;
  at?: number;
  /** An error row's own event, so an old row is not taken for a warning raised since. */
  eventSeq?: number;
  /** Where a continuation went (a handoff), by the app's own ids. */
  targetSession?: string;
  targetTab?: string;
}

type Said = Omit<UiReport, "activeTab" | "foreground" | "at">;

/** Where one tab's reports go, and whether that tab is the one in front. */
export interface Reporter {
  readonly active: boolean;
  report(report: Said): void;
}

export function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Reports for a local tab. Best effort: a runtime that cannot take one (an older one) is not asked again for it. */
export function reporterFor(sessionId: string, tabId: string, active: boolean, send = recoveryIncidents.report): Reporter {
  return {
    active,
    report: (said) => {
      const report: UiReport = { ...said, activeTab: active, foreground: typeof document === "undefined" || document.hasFocus(), at: Date.now() };
      try {
        void Promise.resolve(send(sessionId, tabId, report)).catch(() => {});
      } catch {
        // Recording never gets in the way of the tab.
      }
    },
  };
}

/** The reporter of the tab a component is drawn in; none outside a local tab's chat. */
export const RecoveryReports = createContext<Reporter | null>(null);
export function useRecoveryReporter(): Reporter | null {
  return useContext(RecoveryReports);
}

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** The window is not hidden or minimised. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== "hidden", () => true);
}

/**
 * Whether at least half of `ref` is scrolled into view. Where the window
 * cannot say (no IntersectionObserver), it is never taken to be.
 */
export function useInView(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node || typeof IntersectionObserver === "undefined") {
      setInView(false);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setInView(entry.isIntersecting && entry.intersectionRatio >= 0.5);
    }, { threshold: [0, 0.5, 1] });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, ref]);
  return inView;
}

export interface Exposure {
  /** How long the current showing has been on screen, if it is. */
  sinceMs(): number | undefined;
  /** End the current showing for a reason only the caller knows (a dialog's ending). */
  end(why: HideReason): void;
}

/**
 * One surface's showings of a warning. `present`: the surface is drawn with
 * the warning in it; `inView`: it is scrolled into view, for a row.
 */
export function useExposure({ reporter, surface, present, reason, placement, eventSeq, inView = true }: {
  reporter: Reporter | null;
  surface: Surface;
  present: boolean;
  reason: RecoveryKind | null;
  placement?: "composer" | "top";
  eventSeq?: number;
  inView?: boolean;
}): Exposure {
  const visible = useDocumentVisible();
  const active = reporter?.active ?? false;
  const seen = !!reporter && present && active && visible && inView;
  const current = useRef<{ id: string; at: number; reason: RecoveryKind | null } | null>(null);
  // The warning last taken off screen while it was still up: on screen
  // again, it has resurfaced rather than been shown anew.
  const away = useRef<RecoveryKind | null | undefined>(undefined);
  const latest = useRef({ reporter, surface, present, active, visible, inView, placement, eventSeq });
  latest.current = { reporter, surface, present, active, visible, inView, placement, eventSeq };

  const exposure = useMemo<Exposure>(() => {
    const end = (why: HideReason) => {
      const shown = current.current;
      if (!shown) return;
      current.current = null;
      away.current = why === "tab_hidden" || why === "background" || why === "scrolled" ? shown.reason : undefined;
      const { reporter, surface, placement, eventSeq } = latest.current;
      reporter?.report({ kind: "exposure", surface, phase: "hidden", reason: shown.reason, clientId: shown.id, placement, eventSeq, durationMs: Math.round(performance.now() - shown.at), hideReason: why });
    };
    return { end, sinceMs: () => (current.current ? Math.round(performance.now() - current.current.at) : undefined) };
  }, []);

  useEffect(() => {
    if (!present) away.current = undefined;
  }, [present]);

  useEffect(() => {
    const shown = current.current;
    if (shown && (!seen || shown.reason !== reason)) {
      const { present, active, visible, inView } = latest.current;
      exposure.end(shown.reason !== reason || !present ? "cleared" : !active ? "tab_hidden" : !visible ? "background" : !inView ? "scrolled" : "cleared");
    }
    if (seen && !current.current) {
      const id = newClientId();
      const phase = away.current !== undefined && away.current === reason ? "resurfaced" : "shown";
      away.current = undefined;
      current.current = { id, at: performance.now(), reason };
      reporter!.report({ kind: "exposure", surface, phase, reason, clientId: id, placement, eventSeq });
    }
  }, [seen, reason]);

  useEffect(() => () => exposure.end("unmounted"), [exposure]);
  return exposure;
}

/** What the tab was showing when something was pressed. */
export interface ActionState {
  reason: RecoveryKind | null;
  tabStatus: DisplayedStatus;
  sinceExposureMs?: number;
}

export interface ActionReports {
  /** How the next action was pressed, as the control saw it. */
  pressedWith(input: ActionInput): void;
  rejected(action: RecoveryAction, why: RejectReason, surface?: Surface): void;
  /** The action began: its end is told with the function returned. */
  start(action: RecoveryAction, surface?: Surface): (result: Exclude<ActionResult, "accepted" | "rejected">, detail?: { errorKind?: RecoveryKind; targetSession?: string; targetTab?: string }) => void;
}

/** How a click came, from the event: a button pressed with a key fires a click with no count. */
export function inputOf(event: { detail?: number } | undefined): ActionInput {
  return event && event.detail === 0 ? "keyboard" : "pointer";
}

export function actionReports(reporter: Reporter | null, state: () => ActionState): ActionReports {
  let input: ActionInput | undefined;
  // How it was pressed is said only when the control said: a choice in a list is not guessed at.
  const take = () => {
    const pressed = input;
    input = undefined;
    return pressed;
  };
  const base = (action: RecoveryAction, surface: Surface, clientId: string) => {
    const now = state();
    return { kind: "action" as const, surface, action, actor: "human" as const, clientId, reason: now.reason, tabStatus: now.tabStatus, sinceExposureMs: now.sinceExposureMs };
  };
  return {
    pressedWith: (pressed) => { input = pressed; },
    rejected: (action, why, surface = "banner") => {
      reporter?.report({ ...base(action, surface, newClientId()), phase: "start", input: take(), result: "rejected", rejectReason: why });
    },
    start: (action, surface = "banner") => {
      const clientId = newClientId();
      reporter?.report({ ...base(action, surface, clientId), phase: "start", input: take(), result: "accepted" });
      let told = false;
      return (result, detail) => {
        if (told) return;
        told = true;
        reporter?.report({ ...base(action, surface, clientId), phase: "result", result, ...detail });
      };
    },
  };
}
