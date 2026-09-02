import { useCallback, useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { keycaps } from "@/lib/hotkeys";
import { clearDictationError, dictationAvailable, startDictation, stopDictation, useDictation, type DictationState } from "@/lib/dictation";

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
 * Dictate into a draft. The draft at the moment the mic opens is the base;
 * partial results replace what follows it, and each finished phrase extends it.
 * `onCommitted` runs after a phrase lands, to put the caret back in the field.
 */
export function useDictationInto(target: string, draft: string, onDraftChange: (v: string) => void, onCommitted?: () => void): Dictation {
  const state = useDictation();
  const dictating = state.target === target && state.phase !== "idle";
  const base = useRef("");
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    void dictationAvailable().then(setAvailable);
  }, []);

  useEffect(() => {
    if (!dictating || state.phase !== "listening") return;
    const b = base.current;
    const sep = b && !/\s$/.test(b) && state.partial ? " " : "";
    onDraftChange(state.partial ? b + sep + state.partial : b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.partial, dictating, state.phase]);

  const toggle = useCallback(() => {
    if (dictating) {
      void stopDictation();
      return;
    }
    if (state.phase !== "idle") return;
    base.current = draft;
    void startDictation(target, (text) => {
      const b = base.current;
      const sep = b && !/\s$/.test(b) ? " " : "";
      base.current = b + sep + text + " ";
      onDraftChange(base.current);
      requestAnimationFrame(() => onCommitted?.());
    });
  }, [dictating, state.phase, draft, target, onDraftChange, onCommitted]);

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
