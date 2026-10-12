import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useHeldShortcut, useShortcut, useShortcutKeys } from "@/lib/hotkeys";
import { clearDictationError, dictationAvailable, startDictation, stopDictation, useDictation, type DictationState } from "@/lib/dictation";
import { anchorAt, insertSpoken, spokenSince, type DictationAnchor } from "@/lib/dictationText";
import { useTranscriptionInput } from "@/lib/transcriptionInput";
import { TranscriptionInputPicker } from "./TranscriptionInputPicker";

/**
 * The mic, shared by the two composers: the one inside a session and the one
 * that starts a session. Dictation is a single global recogniser, so a composer
 * only needs a target to recognise its own text coming back.
 */

/** Dictation target for the new-session composer, which has no tab yet. */
export const NEW_SESSION_TARGET = "new-session";

const PRIVACY_SETTINGS_URLS = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  speechRecognition: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
} as const;

export interface Dictation {
  state: DictationState;
  /** This composer is the one currently dictating. */
  dictating: boolean;
  /** null until the check comes back; false hides the mic. */
  available: boolean | null;
  toggle: () => void;
  /** Open the mic for this composer; false when a dictation is already going. `held` is a key being held to talk. */
  start: (opts?: { held?: boolean }) => boolean;
  stop: () => void;
  /** This dictation runs while a key is held, and stops when it is released. */
  held: boolean;
}

/** How many drafts on their way back to the composer are remembered, so that a draft which lags cannot grow the list for ever. */
const EXPECTED_DRAFTS = 8;

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
 * leaves the caret and for what they change, and moved to the end of the
 * dictated words as they arrive.
 *
 * The reader's edit always wins (#428). Whatever they type, delete, cut, paste
 * or undo in the field while the mic is open becomes their text: the draft is
 * split again at their caret, everything heard so far is theirs to keep or to
 * have deleted, and only what is said afterwards is added. That is the same
 * whether the mic was toggled on or a key is held to talk. An edit is known
 * from the field saying so, never from what the draft then reads: deleting the
 * dictated words leaves the very draft there was before them, and deleting the
 * last word leaves one this hook wrote a moment earlier.
 *
 * The hook owns the draft only while its dictation runs. Once the mic has
 * closed and the last words are in, the draft is the reader's alone again.
 */
export function useDictationInto(target: string, draft: string, onDraftChange: (v: string) => void, field?: RefObject<HTMLTextAreaElement | null>): Dictation {
  const state = useDictation();
  const dictating = state.target === target && state.phase !== "idle";
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    void dictationAvailable().then(setAvailable);
  }, []);

  // The draft split where the words go, and what had been heard when it was
  // last split: nothing when the mic opened, and everything so far once the
  // reader has edited the draft, since those words are then part of their text.
  const anchor = useRef<DictationAnchor>({ before: "", after: "" });
  const taken = useRef("");
  // The dictation this composer is following, and whether it has ended.
  const session = useRef<number | null>(null);
  const over = useRef(false);
  // The draft as this hook last saw it, and the ones on their way back to it:
  // what it wrote itself and what the reader left in the field. A draft that
  // changes to anything else was changed by the composer (a message sent, a
  // file mentioned), and is taken as it stands.
  const seen = useRef(draft);
  const expected = useRef<string[]>([]);
  // The last draft written, and where the caret should end up once it comes back round.
  const last = useRef<string | null>(null);
  const caret = useRef<number | null>(null);
  const current = useRef(draft);
  current.current = draft;
  const change = useRef(onDraftChange);
  change.current = onDraftChange;
  const heard = useRef(state);
  heard.current = state;

  /** Split `text` at a caret (or around a selection) and take `said` as already part of it. */
  const split = useCallback((text: string, start: number, end: number, said: string) => {
    anchor.current = anchorAt(text, start, end);
    taken.current = said;
    expected.current = [];
    last.current = null;
    caret.current = null;
  }, []);

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
    // The field only says this when the reader changed it themselves; a draft
    // written from here does not. The field is read as they left it, before the
    // draft has come round. Undo can leave what it restored selected, and the
    // words that follow must not replace that, so they go after it.
    const edited = () => {
      remember();
      if (session.current !== heard.current.session || over.current) return;
      const at = el.selectionEnd ?? el.value.length;
      split(el.value, at, at, heard.current.text);
      expected.current = [el.value];
    };
    const events = ["keyup", "mouseup", "select"] as const;
    for (const e of events) el.addEventListener(e, remember);
    el.addEventListener("input", edited);
    return () => {
      for (const e of events) el.removeEventListener(e, remember);
      el.removeEventListener("input", edited);
    };
  }, [field, split]);

  /** Start the words at the reader's caret in the draft as it stands, keeping `said` as their text. */
  const reanchor = useCallback(
    (said: string) => {
      const text = current.current;
      // Where the reader last had the caret, if that is still their draft. A
      // field they never put it in reports it at the very start, which is the
      // one place dictated words must not go, so that is not taken for an
      // answer: without a caret of their own the words go on the end.
      const m = mark.current;
      const at = m && m.value === text ? { start: m.start, end: m.end } : { start: text.length, end: text.length };
      split(text, at.start, at.end, said);
      seen.current = text;
    },
    [split],
  );

  const write = useCallback((spoken: string) => {
    const next = insertSpoken(anchor.current, spoken);
    last.current = next.text;
    if (next.text === current.current) return;
    caret.current = next.caret;
    if (expected.current[expected.current.length - 1] !== next.text) expected.current = [...expected.current.slice(1 - EXPECTED_DRAFTS), next.text];
    change.current(next.text);
  }, []);

  useEffect(() => {
    if (session.current !== state.session) {
      // A composer that came back mid-dictation adopts the one that is running
      // rather than sitting the rest of it out.
      if (!dictating || session.current != null) return;
      session.current = state.session;
      over.current = false;
      reanchor(state.text);
      return;
    }
    // Its dictation has ended: whatever happens to the draft now is not this hook's to answer.
    if (over.current) return;
    if (draft !== seen.current) {
      seen.current = draft;
      const at = expected.current.indexOf(draft);
      if (at < 0) reanchor(state.text);
      else expected.current = expected.current.slice(at + 1);
    }
    // What is left is what the reader has not already got.
    const since = spokenSince(taken.current, state.text);
    taken.current = since.taken;
    // Nothing is written until there is something to say, so a selection the
    // mic opened on is not removed by silence. After that even nothing is
    // written: words the recogniser took back must leave the draft too.
    if (since.spoken || last.current != null) write(since.spoken);
    if (state.phase === "idle") over.current = true;
  }, [state.text, state.session, state.phase, draft, dictating, reanchor, write]);

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

  const [held, setHeld] = useState(false);
  const start = useCallback(
    (opts?: { held?: boolean }) => {
      const id = startDictation(target);
      if (id == null) return false;
      session.current = id;
      over.current = false;
      setHeld(!!opts?.held);
      reanchor("");
      return true;
    },
    [target, reanchor],
  );
  const stop = useCallback(() => void stopDictation(), []);
  const toggle = useCallback(() => {
    if (dictating) stop();
    else start();
  }, [dictating, start, stop]);

  return { state, dictating, available, toggle, start, stop, held: held && dictating };
}

/**
 * The keys for dictation: its chord toggles the mic, and its held modifier
 * (Right Option by default on macOS) is hold-to-talk: the mic opens while the
 * key is down and closes when it is released. Pressing another key while it is
 * held makes it an ordinary combination, and a dictation it started stops.
 */
export function useDictationShortcuts(dictation: Dictation, enabled = true) {
  useShortcut("composer.dictate", dictation.toggle, { enabled });
  // Only a dictation this hold opened is closed by its release; one toggled on stays on.
  const holding = useRef(false);
  useHeldShortcut(
    "composer.dictate",
    {
      onStart: () => {
        // Where dictation is not available there is no mic to open, and no error to show for a key held by habit.
        holding.current = dictation.available !== false && dictation.start({ held: true });
      },
      onEnd: () => {
        if (!holding.current) return;
        holding.current = false;
        dictation.stop();
      },
    },
    { enabled },
  );
}

/** The error row and the listening row, above the composer box. */
export function DictationStatus({ dictation }: { dictation: Dictation }) {
  const { state, dictating } = dictation;
  return (
    <>
      {state.error && state.target === null && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span className="flex-1">{state.error}</span>
          {state.settings && (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 underline-offset-2 hover:underline"
              onClick={() => void openUrl(PRIVACY_SETTINGS_URLS[state.settings!])}
            >
              Open System Settings
              <ExternalLink className="size-3" />
            </button>
          )}
          <button type="button" className="underline-offset-2 hover:underline" onClick={clearDictationError}>
            Dismiss
          </button>
        </div>
      )}
      {dictating && (
        <div className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", state.phase === "listening" ? "bg-destructive animate-pulse-soft" : "bg-faint")} />
          {state.phase === "starting" ? "Opening the microphone…" : state.phase === "finishing" ? "Finishing…" : dictation.held ? "Listening. Speak, then release the key." : "Listening. Speak, then press the mic again."}
        </div>
      )}
    </>
  );
}

/** Nothing while the availability check is out or dictation is unsupported. */
export function MicButton({ dictation, disabled = false }: { dictation: Dictation; disabled?: boolean }) {
  const { state, dictating, available, toggle } = dictation;
  const input = useTranscriptionInput();
  const keys = useShortcutKeys("composer.dictate");
  if (available === false) return null;
  return (
    // In a narrow composer the input picker gives way first, down to its chevron (`min-w-14`: the mic and that chevron), and never past it.
    <div className="flex min-w-14 shrink-[8] items-center">
      <WithTooltip label={dictating ? "Stop dictating" : `Dictate · ${state.engine}`} keys={keys}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={dictating ? "Stop dictating" : "Dictate"}
          aria-pressed={dictating}
          onClick={toggle}
          disabled={(disabled && !dictating) || input.saving || (state.phase !== "idle" && !dictating)}
          className={cn("shrink-0", dictating && "bg-destructive/15 text-destructive hover:bg-destructive/25 hover:text-destructive")}
        >
          <Mic className={cn(dictating && state.phase === "listening" && "animate-pulse-soft")} />
        </Button>
      </WithTooltip>
      <TranscriptionInputPicker compact />
    </div>
  );
}
