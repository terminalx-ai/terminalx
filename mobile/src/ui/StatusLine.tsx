import { useCallback, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check, CircleAlert, CircleHelp, CircleX, ShieldAlert, Square } from "lucide-react-native";
import { Spinner } from "./Spinner";
import type { AgentEvent, RecoveryKind } from "@terminalx/portable/events";
import { recoveryFromEvents } from "@terminalx/portable/recovery";
import { sessionStatus, type StatusTab } from "@terminalx/portable/sessionStatus";
import { messageTime, type Transcript } from "@terminalx/portable/transcript";
import { useTheme } from "./theme";

/**
 * What the agent is doing now, in one line above the composer (22.03):
 * Working, waiting on the reader, or how its last turn ended.
 */
export type StatusLineState =
  /** `since`: when the turn began (ms), where the transcript says. */
  | { kind: "working"; since?: number }
  /** `since`: when the agent asked (ms). */
  | { kind: "needs_answer" | "needs_approval"; since?: number }
  /** `at`: when the turn ended (RFC 3339). */
  | { kind: "done"; at: string }
  | { kind: "stopped" | "failed"; reason: string | null; at?: string }
  /** The Mac says the tab waits on the reader for something the transcript does not show. */
  | { kind: "needs_you" };

/** The Sessions list's own words, so the phone and the Mac say the same thing. */
const listLabel = (tab: StatusTab) => sessionStatus({ tabs: [tab] }).label;

/** A recovery the Mac named for a stopped or failed turn, in a few words. */
const RECOVERY_REASON: Record<RecoveryKind, string> = {
  capacity: "model over capacity",
  usage_limit: "usage limit reached",
  tool: "a tool failed",
  timeout: "timed out",
  delivery_unconfirmed: "delivery not confirmed",
  unsent: "prompt not sent",
  disconnected: "agent disconnected",
  permission_expired: "permission expired",
  signed_out: "signed out",
  failed: "turn failed",
};

/** The first line of what the agent said, short enough for the line. */
function fewWords(text: string | undefined): string | null {
  // Plain words: the agent's markdown marks (emphasis, code, headings, list marks) are not shown as typed.
  const line = text?.split("\n").map((part) => part.replace(/^\s*(?:#{1,6}|[-*+>]|\d+\.)\s+/, "").replace(/[*`]+|~~/g, "").replace(/(^|\W)_{1,2}([^_]+?)_{1,2}(?=\W|$)/g, "$1$2").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim()).find(Boolean);
  if (!line) return null;
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

const timeOf = (events: readonly AgentEvent[], seq: number) => {
  const found = events.find((event) => event.seq === seq);
  const ms = found ? Date.parse(found.ts) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * The line's state, from the transcript first and the Mac's tab status
 * second: an ask waiting wins, then a turn under way, then how the last turn
 * ended. `tabStatus` is the Sessions list's, which may lag the transcript.
 */
export function statusLineState({ transcript, events, tabStatus }: { transcript: Transcript; events: readonly AgentEvent[]; tabStatus?: StatusTab["status"] | null }): StatusLineState | null {
  const ask = transcript.pendingAsks.at(-1);
  if (ask) return { kind: ask.kind === "questions" ? "needs_answer" : "needs_approval", since: timeOf(events, ask.seq) };
  const own = events.filter((event) => !event.subagent);
  const latest = own.at(-1)?.payload;
  const recovery = recoveryFromEvents([...own]);
  // A launch the Mac refused, or an agent that exited, says so in a fatal error and no turn end.
  if (latest?.type === "error" && latest.fatal) return { kind: "failed", reason: fewWords(latest.message), at: own.at(-1)!.ts };
  let last = transcript.turns.at(-1);
  if (last && !last.completed) {
    if (transcript.workingSince !== undefined) return { kind: "working", since: transcript.workingSince };
    if (tabStatus === "in_progress") return { kind: "working", since: Date.parse(last.ts) || undefined };
    // A status or error line after a turn ended opens a turn of no one's
    // prompt that nothing runs: the turn before it says how things stand.
    if (!last.prompt) last = transcript.turns.findLast((turn) => turn.completed);
  }
  if (last?.completed) {
    const { status, ts } = last.completed;
    if (status === "ok") return { kind: "done", at: ts };
    if (status === "aborted") return { kind: "stopped", reason: recovery ? RECOVERY_REASON[recovery] : null, at: ts };
    const reason = transcript.authFailed ? RECOVERY_REASON.signed_out : recovery ? RECOVERY_REASON[recovery] : fewWords(last.finalText) ?? fewWords(last.detail);
    return { kind: "failed", reason, at: ts };
  }
  if (tabStatus === "in_progress") return { kind: "working" };
  if (tabStatus === "waiting") return { kind: "needs_you" };
  return null;
}

/**
 * A turn is open: the agent works, or waits on the reader mid-turn (a
 * question, a permission request, or something only the Mac shows). Stop
 * stays on the line throughout, since a card the phone cannot answer
 * ("Answer this question from your Mac.") must not leave it with no way out.
 */
export function turnOpen(state: StatusLineState): boolean {
  return state.kind === "working" || state.kind === "needs_answer" || state.kind === "needs_approval" || state.kind === "needs_you";
}

/** How long, in the line's words: "just now", "3 min", "2 h 5 min", "1 d 4 h". */
export function elapsed(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** The label and what follows the dot, as the line reads it. */
export function statusLineText(state: StatusLineState, now: number, locales?: string, timeZone?: string): { label: string; detail: string | null } {
  const time = (ts?: string) => messageTime(ts, locales, timeZone)?.short ?? null;
  switch (state.kind) {
    case "working": return { label: listLabel({ status: "in_progress" }), detail: state.since !== undefined ? elapsed(state.since, now) : null };
    case "needs_answer": return { label: "Needs your answer", detail: state.since !== undefined ? elapsed(state.since, now) : null };
    case "needs_approval": return { label: listLabel({ status: "waiting", activity: "needs_permission" }), detail: state.since !== undefined ? elapsed(state.since, now) : null };
    case "needs_you": return { label: listLabel({ status: "waiting", activity: null }), detail: null };
    case "done": return { label: "Done", detail: time(state.at) };
    case "stopped": return { label: "Stopped", detail: state.reason ?? time(state.at) };
    case "failed": return { label: "Failed", detail: state.reason ?? time(state.at) };
  }
}

/**
 * The clock while the line counts minutes from `since`; a settled line never
 * ticks. Each render reads the clock afresh (to the second), so a new `since`
 * (Working, then a question) is counted from the clock read then, not the one
 * the line before it last read.
 */
let clock = 0;
function readClock(): number {
  // Held for a second so React reads one value per render; rounded up, never
  // behind, so a wait begun exactly three minutes ago reads 3 min, not 2.
  const now = Date.now();
  if (now > clock || clock - now >= 1_000) clock = Math.ceil(now / 1_000) * 1_000;
  return clock;
}
function useNow(since: number | undefined): number {
  const subscribe = useCallback((changed: () => void) => {
    if (since === undefined) return () => undefined;
    const timer = setInterval(changed, 15_000);
    return () => clearInterval(timer);
  }, [since]);
  return useSyncExternalStore(subscribe, readClock);
}

/**
 * The line itself: Working with how long, the amber ask under its card, or
 * how the turn ended; Stop while the turn is open (`turnOpen`). `onStop`
 * stops the turn; without it (a Mac that takes no controls from a phone) the
 * line offers none. A long press on Stop (`onStopSession`) offers to stop the
 * whole session.
 */
export function StatusLine({ state, onStop, onStopSession, stopping = false }: { state: StatusLineState | null; onStop?: () => void; onStopSession?: () => void; stopping?: boolean }) {
  const { palette } = useTheme();
  const since = state && (state.kind === "working" || state.kind === "needs_answer" || state.kind === "needs_approval") ? state.since : undefined;
  const now = useNow(since);
  if (!state) return null;
  const { label, detail } = statusLineText(state, now);
  const waiting = state.kind === "needs_answer" || state.kind === "needs_approval" || state.kind === "needs_you";
  const labelColor = waiting ? palette.warning : state.kind === "failed" ? palette.danger : palette.ink;
  const icon = state.kind === "working" ? <Spinner size={14} color={palette.info} />
    : state.kind === "needs_answer" ? <CircleHelp size={16} color={palette.warning} />
      : state.kind === "needs_approval" ? <ShieldAlert size={16} color={palette.warning} />
        : state.kind === "needs_you" ? <CircleAlert size={16} color={palette.warning} />
          : state.kind === "done" ? <Check size={16} color={palette.success} />
            : state.kind === "stopped" ? <Square size={14} color={palette.muted} />
              : <CircleX size={16} color={palette.danger} />;
  const spoken = detail ? `${label} · ${detail}` : label;
  return <View style={styles.line}>
    <View accessible accessibilityLabel={spoken} accessibilityLiveRegion="polite" style={styles.words}>
      {icon}
      <Text numberOfLines={1} style={[styles.text, { color: palette.muted }]}>
        <Text style={[styles.label, { color: labelColor }]}>{label}</Text>{detail ? ` · ${detail}` : ""}
      </Text>
    </View>
    {turnOpen(state) && onStop ? <Pressable accessibilityRole="button" accessibilityLabel="Stop" accessibilityHint={onStopSession ? "Stops the agent's turn. Long press to stop the session" : "Stops the agent's turn"} disabled={stopping} hitSlop={6} onPress={onStop} onLongPress={onStopSession} style={({ pressed }) => [styles.stop, { backgroundColor: palette.raised, opacity: stopping ? 0.4 : pressed ? 0.7 : 1 }]}>
      <Square size={14} color={palette.ink} strokeWidth={2} />
      <Text style={[styles.stopText, { color: palette.ink }]}>Stop</Text>
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 34, paddingHorizontal: 6, paddingBottom: 2 },
  words: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  text: { flex: 1, fontSize: 14, lineHeight: 19 },
  label: { fontWeight: "600" },
  stop: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 34, borderRadius: 10, borderCurve: "continuous", paddingHorizontal: 12 },
  stopText: { fontSize: 14, fontWeight: "600" },
});
