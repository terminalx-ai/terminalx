import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { keycaps } from "@/lib/hotkeys";
import { clearDictationError, dictationAvailable, startDictation, stopDictation, useDictation, type DictationState } from "@/lib/dictation";
import { anchorAt, applyFinal, applyPartial, draftWithSpeech, EMPTY_BUFFER, type DictationAnchor, type DictationBuffer } from "@/lib/dictationText";

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
 * words go: the draft is split there and the two halves are kept as they are,
 * so nothing the reader typed is ever overwritten. What the recogniser hands
 * back is folded together by `@/lib/dictationText`, which is where the rules
 * about segments and spacing live.
 *
 * `field` is the textarea the draft belongs to. It is read for the caret when
 * the mic opens, and moved to the end of the dictated words as they arrive.
 *
 * If the reader edits the draft while the mic is open, the hook stops trying
 * to be clever: the draft in front of them becomes the new base, the caret is
 * read again, and what has been dictated so far is left where it already sits.
 */
export function useDictationInto(target: string, draft: string, onDraftChange: (v: string) => void, field?: RefObject<HTMLTextAreaElement | null>): Dictation {
  const state = useDictation();
  const dictating = state.target === target && state.phase !== "idle";
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    void dictationAvailable().then(setAvailable);
  }, []);

  // Where the words go, and what has been heard so far.
  const anchor = useRef<DictationAnchor>({ before: "", after: "" });
  const buffer = useRef<DictationBuffer>(EMPTY_BUFFER);
  // The draft as this hook last wrote it. Anything else is the reader typing.
  const written = useRef<string | null>(null);
  // Where the caret should end up, and whether the field should be focused
  // first — it is, after a phrase lands, because clicking the mic blurred it.
  const caret = useRef<number | null>(null);
  const refocus = useRef(false);
  const current = useRef(draft);
  current.current = draft;
  const change = useRef(onDraftChange);
  change.current = onDraftChange;

  /** Read the field's caret and start the words from there. */
  const reanchor = useCallback(() => {
    const text = current.current;
    const el = field?.current;
    anchor.current = anchorAt(text, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length);
    buffer.current = EMPTY_BUFFER;
    written.current = text;
  }, [field]);

  const write = useCallback(() => {
    const next = draftWithSpeech(anchor.current, buffer.current);
    written.current = next.text;
    caret.current = next.caret;
    change.current(next.text);
  }, []);

  useEffect(() => {
    if (!dictating || state.phase !== "listening" || !state.partial) return;
    if (written.current !== current.current) reanchor();
    buffer.current = applyPartial(buffer.current, state.partial);
    write();
  }, [state.partial, dictating, state.phase, reanchor, write]);

  // Put the caret back after the words, once the draft has come round again.
  useLayoutEffect(() => {
    const el = field?.current;
    const pos = caret.current;
    if (!el || pos == null || draft !== written.current) return;
    caret.current = null;
    if (refocus.current) {
      refocus.current = false;
      el.focus();
    }
    el.setSelectionRange(pos, pos);
  }, [draft, field]);

  const toggle = useCallback(() => {
    if (dictating) {
      void stopDictation();
      return;
    }
    if (state.phase !== "idle") return;
    reanchor();
    void startDictation(target, (text) => {
      if (written.current !== current.current) reanchor();
      buffer.current = applyFinal(buffer.current, text);
      refocus.current = true;
      write();
    });
  }, [dictating, state.phase, target, reanchor, write]);

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
