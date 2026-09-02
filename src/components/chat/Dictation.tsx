import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { keycaps } from "@/lib/hotkeys";
import { clearDictationError, dictationAvailable, startDictation, stopDictation, useDictation, type DictationState } from "@/lib/dictation";
import { anchorAt, insertSpoken, type DictationAnchor } from "@/lib/dictationText";

/**
 * The mic, shared by the two composers: the one inside a session and the one
 * that starts a session. Dictation is a single global recogniser, so a composer
 * only needs a target to recognise its own text coming back.
 */

/** Dictation target for the new-session composer, which has no tab yet. */
export const NEW_SESSION_TARGET = "new-session";

export interface Dictation {
  state: DictationState;
  /** This composer is the one currently dictating. */
  dictating: boolean;
  /** null until the check comes back; false hides the mic. */
  available: boolean | null;
  toggle: () => void;
}

/**
 * Dictate into a draft. Where the caret sits when the mic opens is where the
 * words go: the draft is split there and both halves are kept as they are, so
 * nothing the reader typed is ever overwritten. The store folds the results
 * together (see `@/lib/dictationText`) and publishes everything heard so far,
 * and this hook rebuilds the whole draft from that on every change. No draft is
 * ever built from the one before it, so a render that is dropped, coalesced or
 * late costs a moment rather than a phrase.
 *
 * `field` is the textarea the draft belongs to: watched for where the reader
 * leaves the caret, and moved to the end of the dictated words as they arrive.
 *
 * If the reader edits the draft while the mic is open the hook stops trying to
 * be clever: their draft becomes the new base, the caret is read again, and
 * what has already been dictated stays where it sits.
 */
export function useDictationInto(target: string, draft: string, onDraftChange: (v: string) => void, field?: RefObject<HTMLTextAreaElement | null>): Dictation {
  const state = useDictation();
  const dictating = state.target === target && state.phase !== "idle";
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    void dictationAvailable().then(setAvailable);
  }, []);

  // The draft split where the words go, and how much of what has been heard is
  // already part of the half in front of them — which is none, until the reader
  // edits the draft and everything so far becomes part of their text.
  const anchor = useRef<DictationAnchor>({ before: "", after: "" });
  const consumed = useRef(0);
  // The dictation this composer is following, the reader's own draft under it,
  // and the last few it has written itself. A draft that is none of those is
  // the reader typing; an older write is a state update still on its way, which
  // says nothing about what they want.
  const session = useRef<number | null>(null);
  const base = useRef("");
  const recent = useRef<string[]>([]);
  const last = useRef<string | null>(null);
  // Where the caret should end up once the draft comes back round.
  const caret = useRef<number | null>(null);
  const current = useRef(draft);
  current.current = draft;
  const change = useRef(onDraftChange);
  change.current = onDraftChange;

  // The caret as the reader last left it. Clicking the mic takes the focus out
  // of the field, so where they meant to dictate has to be remembered before
  // then rather than read back afterwards.
  const mark = useRef<{ value: string; start: number; end: number } | null>(null);
  useEffect(() => {
    const el = field?.current;
    if (!el) return;
    const remember = () => {
      if (document.activeElement !== el) return;
      mark.current = { value: el.value, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
    };
    const events = ["keyup", "mouseup", "input", "select"] as const;
    for (const e of events) el.addEventListener(e, remember);
    return () => {
      for (const e of events) el.removeEventListener(e, remember);
    };
  }, [field]);

  /** Start the words at the reader's caret, keeping `heard` as their text. */
  const reanchor = useCallback(
    (heard: string) => {
      const text = current.current;
      // Where the reader last had the caret, if that is still their draft. A
      // field they never put it in reports it at the very start, which is the
      // one place dictated words must not go, so that is not taken for an
      // answer: without a caret of their own the words go on the end.
      const m = mark.current;
      const at = m && m.value === text ? { start: m.start, end: m.end } : { start: text.length, end: text.length };
      anchor.current = anchorAt(text, at.start, at.end);
      consumed.current = heard.length;
      base.current = text;
      recent.current = [];
      last.current = null;
    },
    [],
  );

  const write = useCallback((spoken: string) => {
    const next = insertSpoken(anchor.current, spoken);
    last.current = next.text;
    recent.current = [...recent.current.slice(-3), next.text];
    caret.current = next.caret;
    change.current(next.text);
  }, []);

  useEffect(() => {
    if (session.current !== state.session) {
      // A composer that came back mid-dictation adopts the one that is running
      // rather than sitting the rest of it out.
      if (!dictating || session.current != null) return;
      session.current = state.session;
      reanchor(state.text);
      return;
    }
    // A draft that this composer never wrote is the reader editing around the
    // words. Take their draft as the new base and leave what they have alone.
    if (last.current != null && draft !== last.current && draft !== base.current && !recent.current.includes(draft)) reanchor(state.text);
    // What is left is what the reader has not already got. The cut can land on
    // the space between two segments, which the anchor puts back itself.
    const spoken = state.text.slice(Math.min(consumed.current, state.text.length)).trimStart();
    if (!spoken) return;
    write(spoken);
  }, [state.text, state.session, draft, dictating, reanchor, write]);

  // Put the caret back after the words, once the draft has come round again.
  useLayoutEffect(() => {
    const el = field?.current;
    const pos = caret.current;
    if (!el || pos == null || draft !== last.current) return;
    caret.current = null;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      /* the field would not take the caret; the text is what matters */
    }
  }, [draft, field]);

  // Clicking the mic took the focus out of the field; give it back at the end.
  const done = session.current === state.session && state.phase === "idle";
  useEffect(() => {
    if (!done) return;
    field?.current?.focus();
  }, [done, field]);

  const toggle = useCallback(() => {
    if (dictating) {
      void stopDictation();
      return;
    }
    if (state.phase !== "idle") return;
    const id = startDictation(target);
    if (id == null) return;
    session.current = id;
    reanchor("");
  }, [dictating, state.phase, target, reanchor]);

  return { state, dictating, available, toggle };
}

/** The error row and the listening row, above the composer box. */
export function DictationStatus({ dictation }: { dictation: Dictation }) {
  const { state, dictating } = dictation;
  return (
    <>
      {state.error && state.target === null && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span className="flex-1">{state.error}</span>
          <button type="button" className="underline-offset-2 hover:underline" onClick={clearDictationError}>
            Dismiss
          </button>
        </div>
      )}
      {dictating && (
        <div className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", state.phase === "listening" ? "bg-destructive animate-pulse-soft" : "bg-faint")} />
          {state.phase === "starting" ? "Opening the microphone…" : state.phase === "finishing" ? "Finishing…" : "Listening. Speak, then press the mic again."}
        </div>
      )}
    </>
  );
}

/** Nothing while the availability check is out or dictation is unsupported. */
export function MicButton({ dictation }: { dictation: Dictation }) {
  const { state, dictating, available, toggle } = dictation;
  if (available === false) return null;
  return (
    <WithTooltip label={dictating ? "Stop dictating" : `Dictate · ${state.engine}`} keys={keycaps("mod+shift+d")}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={dictating ? "Stop dictating" : "Dictate"}
        aria-pressed={dictating}
        onClick={toggle}
        disabled={state.phase !== "idle" && !dictating}
        className={cn(dictating && "bg-destructive/15 text-destructive hover:bg-destructive/25 hover:text-destructive")}
      >
        <Mic className={cn(dictating && state.phase === "listening" && "animate-pulse-soft")} />
      </Button>
    </WithTooltip>
  );
}
