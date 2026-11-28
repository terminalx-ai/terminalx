import { useMemo, useRef } from "react";
import { isStrictEventAppend, type AgentEvent } from "@terminalx/portable/events";
import { TranscriptReducer, type Transcript } from "@terminalx/portable/transcript";

interface ReducerState {
  reducer: TranscriptReducer;
  continuity: boolean;
  source: readonly AgentEvent[];
  consumed: number;
}

/**
 * Incrementally reduces an `AgentEvent[]` stream into a `Transcript`, reusing
 * `TranscriptReducer` (and preserving `Turn` object references for all
 * committed turns) whenever new events are strictly appended in `seq` order.
 */
export function useIncrementalTranscript(
  events: readonly AgentEvent[],
  live: boolean,
  compactionContinuityKnown: boolean,
): Transcript {
  const stateRef = useRef<ReducerState | null>(null);

  return useMemo(() => {
    let state = stateRef.current;
    const canAppend =
      state !== null &&
      state.continuity === compactionContinuityKnown &&
      (events === state.source ||
        (events.length >= state.consumed &&
          (state.consumed === 0 || isStrictEventAppend(state.source, events))));

    if (!canAppend || !state) {
      const reducer = new TranscriptReducer({ compactionContinuityKnown });
      for (const event of events) reducer.push(event);
      state = { reducer, continuity: compactionContinuityKnown, source: events, consumed: events.length };
      stateRef.current = state;
    } else if (events !== state.source) {
      for (let i = state.consumed; i < events.length; i++) {
        state.reducer.push(events[i]);
      }
      state.source = events;
      state.consumed = events.length;
    }

    return state.reducer.snapshot(live);
  }, [events, live, compactionContinuityKnown]);
}
