import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { TERMINAL_OUTBOX_STATES, type OutboxEntry } from "@/lib/cloudAgentApi";
import { RECOVERY_PROMPT } from "@/lib/recovery";
import type { Transcript } from "@/lib/transcript";

/**
 * The messages sent in a tab, oldest first: what Up and Down walk through in
 * the composer (PRO-85). They are read from the tab's own transcript, so they
 * are per tab, the same for a local and a cloud tab, and back after a restart
 * with the conversation itself. A cloud tab adds what the transcript does not
 * hold yet: the follow-ups the runtime has queued behind a running turn and the
 * commands still in the mailbox outbox.
 *
 * A message sent twice is listed once, where it was last sent.
 */
export function sentMessages(transcript: Transcript, pending?: { entries?: OutboxEntry[]; followUps?: { text: string }[] }): string[] {
  const items: { text: string; at: number }[] = [];
  let at = 0;
  for (const turn of transcript.turns) {
    if (turn.prompt) {
      at = Date.parse(turn.prompt.ts) || at;
      items.push({ text: turn.prompt.text, at });
    }
    // A follow-up queued while the agent worked.
    for (const item of turn.work) if (item.kind === "queued") items.push({ text: item.text, at });
  }
  // A command that reached the runtime is in the transcript already. One that ended some other way (rejected,
  // cancelled, outcome unknown) is placed by when it was written; one still on its way is the newest there is,
  // after the follow-ups the runtime has already taken in.
  const waiting: OutboxEntry[] = [];
  for (const entry of pending?.entries ?? []) {
    if ((entry.kind !== "send" && entry.kind !== "steer") || entry.state === "applied" || !entry.text) continue;
    if (TERMINAL_OUTBOX_STATES.has(entry.state)) items.push({ text: entry.text, at: entry.createdAt });
    else waiting.push(entry);
  }
  items.sort((a, b) => a.at - b.at);
  waiting.sort((a, b) => a.createdAt - b.createdAt);
  const texts = [...items.map((item) => item.text), ...(pending?.followUps ?? []).map((followUp) => followUp.text), ...waiting.map((entry) => entry.text!)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i].trim();
    // The recovery prompt is the app's own message, not something the reader typed.
    if (!text || text === RECOVERY_PROMPT || seen.has(text)) continue;
    seen.add(text);
    out.unshift(text);
  }
  return out;
}

/**
 * Where a tab's composer is in its history. `lines` is a working copy of the
 * history with the unsent draft as its last line, so an edit to a recalled
 * message is kept while browsing and the history itself is never changed.
 */
interface Browse {
  entries: string[];
  lines: string[];
  at: number;
  /** The text the last move put in the composer. */
  shown: string;
}

// Module-level like the drafts, so a remount (switching sessions) keeps the unsent draft behind a recalled message.
const browsing = new Map<string, Browse>();

/** Forgets where every composer was in its history (tests). */
export function resetComposerHistory() {
  browsing.clear();
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((text, i) => text === b[i]);

/**
 * Up and Down in the composer recall earlier and later messages, as a shell
 * does. Up starts from the first line of the draft and Down continues from the
 * last line, so the arrows still move the caret inside a multi-line draft.
 * Past the newest message Down brings back the draft that was being typed.
 *
 * The composer calls `onKeyDown` only when no menu has the arrows; it returns
 * true when it took the key. `sent` ends the browsing after a send and returns
 * the draft to put back: the one set aside when a recalled message was sent.
 */
export function useComposerHistory({
  id,
  history,
  draft,
  onDraftChange,
  field,
  onRecall,
}: {
  /** The tab the history and the draft belong to. */
  id: string;
  /** Sent messages, oldest first. */
  history: string[];
  draft: string;
  onDraftChange: (text: string) => void;
  field: RefObject<HTMLTextAreaElement | null>;
  /** A history line was put in the composer, with the caret at its end. */
  onRecall?: (text: string) => void;
}) {
  // The recalled text whose caret still has to be placed, once the draft comes back round.
  const placing = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (placing.current !== draft) return;
    placing.current = null;
    field.current?.setSelectionRange(draft.length, draft.length);
  }, [draft, field]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const up = e.key === "ArrowUp";
    if (!up && e.key !== "ArrowDown") return false;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return false;
    const el = e.currentTarget;
    const value = el.value;
    const caret = el.selectionStart ?? value.length;
    if ((el.selectionEnd ?? caret) !== caret) return false;

    let state = browsing.get(id);
    if (state) {
      const last = state.lines.length - 1;
      // Back on the draft, a history that has moved on is read afresh; so is one whose recalled line went out another way (a steer).
      if (state.at === last ? !same(state.entries, history) : !value && !state.lines[last]) state = undefined;
    }
    if (!state) {
      // Down has nothing newer than the draft itself.
      if (!up || !history.length) return false;
      state = { entries: history, lines: [...history, value], at: history.length, shown: value };
    }
    const last = state.lines.length - 1;
    // A message just recalled, caret untouched at its end: the arrows keep walking even when it has several lines.
    const walking = state.at < last && value === state.shown && caret === value.length;
    const onEdgeLine = up ? !value.slice(0, caret).includes("\n") : !value.slice(caret).includes("\n");
    if (!walking && !onEdgeLine) return false;
    const next = state.at + (up ? -1 : 1);
    if (next < 0 || next > last) return false;

    e.preventDefault();
    state.lines[state.at] = value;
    state.at = next;
    state.shown = state.lines[next];
    browsing.set(id, state);
    if (state.shown === value) {
      el.setSelectionRange(value.length, value.length);
    } else {
      placing.current = state.shown;
      onDraftChange(state.shown);
    }
    onRecall?.(state.shown);
    return true;
  };

  const sent = (): string => {
    const state = browsing.get(id);
    browsing.delete(id);
    return state && state.at < state.lines.length - 1 ? state.lines[state.lines.length - 1] : "";
  };

  return { onKeyDown, sent };
}
