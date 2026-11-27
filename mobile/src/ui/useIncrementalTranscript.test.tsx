// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeAgentEvents, type AgentEvent } from "@terminalx/portable/events";
import type { Transcript } from "@terminalx/portable/transcript";
import { useIncrementalTranscript } from "./useIncrementalTranscript";

const makeEvent = (seq: number, payload: AgentEvent["payload"]): AgentEvent => ({
  id: `e-${seq}`,
  sessionId: "s1",
  tabId: "t1",
  harness: "claude",
  seq,
  ts: "2026-11-01T00:00:00Z",
  payload,
});

describe("useIncrementalTranscript (P-13, P-45)", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("reuses committed Turn references when appending new events and rebuilds on prepend", async () => {
    let latest: Transcript | null = null;
    function Probe({ events, live, continuity }: { events: readonly AgentEvent[]; live: boolean; continuity: boolean }) {
      latest = useIncrementalTranscript(events, live, continuity);
      return null;
    }

    const turn1 = mergeAgentEvents([], [
      makeEvent(10, { type: "user_message", text: "First prompt", queued: false }),
      makeEvent(11, { type: "assistant_text", text: "First answer" }),
      makeEvent(12, { type: "turn_completed", status: "ok", authFailed: false }),
    ]);

    await act(async () => root.render(<Probe events={turn1} live={true} continuity={true} />));
    expect(latest!.turns).toHaveLength(1);
    const firstTurnRef = latest!.turns[0];

    const turn2 = mergeAgentEvents(turn1, [
      makeEvent(13, { type: "user_message", text: "Second prompt", queued: false }),
      makeEvent(14, { type: "assistant_text", text: "Streaming reply" }),
    ]);
    await act(async () => root.render(<Probe events={turn2} live={true} continuity={true} />));
    expect(latest!.turns).toHaveLength(2);
    // Committed turn 1 keeps the exact same object identity so memoized TurnCard/turnRows skip work.
    expect(latest!.turns[0]).toBe(firstTurnRef);

    // Prepending earlier history rebuilds cleanly in sequence order.
    const withEarlier = mergeAgentEvents(turn2, [
      makeEvent(1, { type: "user_message", text: "Earlier prompt", queued: false }),
      makeEvent(2, { type: "turn_completed", status: "ok", authFailed: false, finalText: "Earlier reply" }),
    ]);
    await act(async () => root.render(<Probe events={withEarlier} live={true} continuity={true} />));
    expect(latest!.turns).toHaveLength(3);
    expect(latest!.turns[0].prompt?.text).toBe("Earlier prompt");
    expect(latest!.turns[1].prompt?.text).toBe("First prompt");
    expect(latest!.turns[2].prompt?.text).toBe("Second prompt");
  });
});
