import { StrictMode, useCallback, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The composer against the shapes the recogniser really produces, and against
 * the ways the plumbing around it can misbehave. The rule these all check is
 * the same: whatever is dropped, delayed or coalesced on the way, no phrase
 * the reader spoke may go missing from the draft.
 */

let deliver: (payload: { kind: string; text?: string; segment?: number }) => void = () => {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "dictation_available") return true;
    if (cmd === "transcription_preferences") return { model: "apple" };
    if (cmd === "transcription_models") return [];
    return undefined;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: unknown }) => void) => {
    deliver = (payload) => cb({ payload });
    return () => {};
  }),
}));

const { useDictationInto, NEW_SESSION_TARGET } = await import("./Dictation");
const { getDraft, setDraft, useDraft } = await import("@/lib/drafts");

/** Apple, within one utterance: every partial revises the one before it. */
const SENTENCE_ONE = [
  "Please",
  "Please add",
  "Please add a settings",
  "Please add a settings page",
  "Please add a settings page for notifications.",
];
/** Apple, after a pause: a segment that stands on its own. */
const SENTENCE_TWO = ["Then", "Then write", "Then write the unit", "Then write the unit tests for it."];
const BOTH = "Please add a settings page for notifications. Then write the unit tests for it.";

/** The new-session composer, stripped to the textarea and the mic. */
function Field({ initial = "", hold = false }: { initial?: string; hold?: boolean }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  // `hold` keeps the draft one the composer asked for but has not been given,
  // the way a parent that batches or defers its state would.
  const pending = useRef(initial);
  const change = useCallback(
    (v: string) => {
      pending.current = v;
      if (!hold) setText(v);
    },
    [hold],
  );
  const dictation = useDictationInto(NEW_SESSION_TARGET, text, change, ref);
  return (
    <>
      <textarea ref={ref} autoFocus value={text} onChange={(e) => change(e.target.value)} />
      <button onClick={dictation.toggle}>mic</button>
      <button onClick={() => setText(pending.current)}>flush</button>
    </>
  );
}

/** The session composer's wiring: the draft lives in the per-tab store. */
function TabField({ tabId }: { tabId: string }) {
  const text = useDraft(tabId);
  const ref = useRef<HTMLTextAreaElement>(null);
  const change = useCallback((v: string) => setDraft(tabId, v), [tabId]);
  const dictation = useDictationInto(tabId, text, change, ref);
  return (
    <>
      <textarea ref={ref} autoFocus value={text} onChange={(e) => change(e.target.value)} />
      <button onClick={dictation.toggle}>mic</button>
    </>
  );
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const mic = () => screen.getAllByRole("button")[0];
const flush = () => screen.getAllByRole("button")[1];

const send = async (...events: { kind: string; text?: string; segment?: number }[]) => {
  await act(async () => {
    for (const e of events) deliver(e);
  });
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

async function open(ui = <Field />) {
  render(ui);
  await act(async () => {});
  await click(mic());
  await send({ kind: "listening" });
}

afterEach(async () => {
  await send({ kind: "stopped" });
  cleanup();
});

describe("the stream Apple really sends", () => {
  it("shows each revision, keeps the sentence before the pause, and settles on the final", async () => {
    await open();
    for (const partial of SENTENCE_ONE) {
      await send({ kind: "partial", text: partial });
      expect(box().value).toBe(partial);
    }
    for (const partial of SENTENCE_TWO) {
      await send({ kind: "partial", text: partial });
      expect(box().value).toBe(`${SENTENCE_ONE[4]} ${partial}`);
    }
    await send({ kind: "final", text: SENTENCE_TWO[3] });
    expect(box().value).toBe(BOTH);
  });

  it("does the same under StrictMode, as the app mounts it", async () => {
    await open(
      <StrictMode>
        <Field />
      </StrictMode>,
    );
    for (const partial of [...SENTENCE_ONE, ...SENTENCE_TWO]) await send({ kind: "partial", text: partial });
    await send({ kind: "final", text: SENTENCE_TWO[3] });
    expect(box().value).toBe(BOTH);
  });

  it("loses nothing when several results land before a single render", async () => {
    await open();
    await send(...SENTENCE_ONE.map((text) => ({ kind: "partial", text })));
    expect(box().value).toBe(SENTENCE_ONE[4]);
    await send(...SENTENCE_TWO.map((text) => ({ kind: "partial", text })), { kind: "final", text: SENTENCE_TWO[3] });
    expect(box().value).toBe(BOTH);
  });

  it("keeps a final that arrives in the same tick as the stop", async () => {
    await open();
    for (const partial of SENTENCE_ONE) await send({ kind: "partial", text: partial });
    await send({ kind: "final", text: SENTENCE_ONE[4] }, { kind: "stopped" });
    expect(box().value).toBe(SENTENCE_ONE[4]);
  });
});

describe("a local model", () => {
  it("takes one final holding every sentence", async () => {
    await open();
    await send({ kind: "transcribing" });
    await send({ kind: "final", text: BOTH });
    expect(box().value).toBe(BOTH);
  });

  it("appends that final to what the reader had typed", async () => {
    await open(<Field initial="Notes:" />);
    await send({ kind: "transcribing" }, { kind: "final", text: BOTH }, { kind: "stopped" });
    expect(box().value).toBe(`Notes: ${BOTH}`);
  });
});

describe("a draft the reader never put the caret in", () => {
  it("takes the words on the end, not in front of what is already there", async () => {
    await open(<Field initial="Notes:" />);
    for (const partial of SENTENCE_ONE) await send({ kind: "partial", text: partial });
    expect(box().value).toBe(`Notes: ${SENTENCE_ONE[4]}`);
  });

  it("still takes them where the reader did leave it", async () => {
    render(<Field initial="Fix the build" />);
    await act(async () => {});
    box().focus();
    box().setSelectionRange(7, 7); // "Fix the| build"
    fireEvent.mouseUp(box());
    await click(mic());
    await send({ kind: "listening" }, { kind: "partial", text: "release" });
    expect(box().value).toBe("Fix the release build");
  });
});

describe("when the plumbing misbehaves", () => {
  it("catches up rather than losing text when the draft it is given lags behind", async () => {
    await open(<Field hold />);
    for (const partial of [...SENTENCE_ONE, ...SENTENCE_TWO]) await send({ kind: "partial", text: partial });
    await send({ kind: "final", text: SENTENCE_TWO[3] });
    // The composer has been handed nothing back this whole time.
    expect(box().value).toBe("");
    await click(flush());
    expect(box().value).toBe(BOTH);
  });

  it("keeps streaming when the field will not take the caret", async () => {
    const real = HTMLTextAreaElement.prototype.setSelectionRange;
    HTMLTextAreaElement.prototype.setSelectionRange = () => {
      throw new DOMException("the field would not take the caret");
    };
    try {
      await open();
      for (const partial of [...SENTENCE_ONE, ...SENTENCE_TWO]) await send({ kind: "partial", text: partial });
      await send({ kind: "final", text: SENTENCE_TWO[3] });
      expect(box().value).toBe(BOTH);
    } finally {
      HTMLTextAreaElement.prototype.setSelectionRange = real;
    }
  });

  it("carries on into a composer that was remounted mid-dictation", async () => {
    await open();
    for (const partial of SENTENCE_ONE) await send({ kind: "partial", text: partial });
    cleanup();
    render(<Field initial={SENTENCE_ONE[4]} />);
    await act(async () => {});
    for (const partial of SENTENCE_TWO) await send({ kind: "partial", text: partial });
    await send({ kind: "final", text: SENTENCE_TWO[3] });
    expect(box().value).toBe(BOTH);
  });
});

/**
 * Apple's on-device recogniser on macOS 26.3.1, as observed: every partial has
 * placeholder timestamps, an utterance comes back settled with real ones about
 * two seconds after the speaker stops, and the next utterance stands alone.
 * The identities are what `dictation.rs` derives for that stream. Results
 * can land in one tick, so nothing here relies on the time between them.
 */
const OBSERVED = [
  { kind: "partial", text: "Fix", segment: 0 },
  { kind: "partial", text: "Fix the build", segment: 0 },
  { kind: "partial", text: "Fix the build, please", segment: 0 },
  // Settled: the same words again, with real timestamps behind them.
  { kind: "partial", text: "Fix the build, please", segment: 0 },
  // The pause. The next utterance stands alone.
  { kind: "partial", text: "Then", segment: 1 },
  { kind: "partial", text: "Then run the test for it", segment: 1 },
  { kind: "partial", text: "Then run the test for it", segment: 1 },
  // Another pause, then a phrase that shares its opening with the last one.
  { kind: "partial", text: "Then", segment: 2 },
  { kind: "partial", text: "Then shipped it", segment: 2 },
  { kind: "partial", text: "Then ship it", segment: 2 },
];
const OBSERVED_TEXT = "Fix the build, please Then run the test for it Then ship it";
const AFTER_FIRST_PAUSE = "Fix the build, please Then";

describe("the utterances Apple hands over across pauses", () => {
  it("appends the utterance after the pause instead of replacing the phrase before it", async () => {
    await open();
    await send(...OBSERVED.slice(0, 4));
    expect(box().value).toBe("Fix the build, please");
    await send(OBSERVED[4]);
    expect(box().value).toBe(AFTER_FIRST_PAUSE);
    await send(...OBSERVED.slice(5));
    expect(box().value).toBe(OBSERVED_TEXT);
  });

  it("keeps the text typed before the mic opened in front of every utterance", async () => {
    await open(<Field initial="Notes:" />);
    await send(...OBSERVED);
    expect(box().value).toBe(`Notes: ${OBSERVED_TEXT}`);
  });

  it("does the same in a session composer, whose draft lives in the tab store", async () => {
    setDraft("tab-7", "Notes:");
    render(<TabField tabId="tab-7" />);
    await act(async () => {});
    await click(mic());
    await send({ kind: "listening" }, ...OBSERVED);
    expect(box().value).toBe(`Notes: ${OBSERVED_TEXT}`);
    expect(getDraft("tab-7")).toBe(`Notes: ${OBSERVED_TEXT}`);
  });

  it("keeps both halves of a draft split at the caret across every pause", async () => {
    render(<Field initial="Before after" />);
    await act(async () => {});
    box().focus();
    box().setSelectionRange(6, 6); // "Before| after"
    fireEvent.mouseUp(box());
    await click(mic());
    await send({ kind: "listening" }, ...OBSERVED);
    expect(box().value).toBe(`Before ${OBSERVED_TEXT} after`);
    expect(box().selectionStart).toBe(7 + OBSERVED_TEXT.length);
  });

  it("replaces a selection with every utterance rather than the last one", async () => {
    render(<Field initial="Keep this, drop that and keep this too" />);
    await act(async () => {});
    box().focus();
    box().setSelectionRange(11, 20); // "drop that"
    fireEvent.mouseUp(box());
    await click(mic());
    await send({ kind: "listening" }, ...OBSERVED);
    expect(box().value).toBe(`Keep this, ${OBSERVED_TEXT} and keep this too`);
  });

  it.each([
    ["before the pause", 4],
    ["as the next utterance begins", 5],
    ["after the second utterance", 7],
    ["after the third", OBSERVED.length],
  ])("keeps the whole draft when dictation stops %s", async (_when, cut) => {
    await open(<Field initial="Draft:" />);
    await send(...OBSERVED.slice(0, cut));
    const shown = box().value;
    expect(shown.startsWith("Draft: Fix the build")).toBe(true);
    // Stopping delivers an empty final, as observed, then the stop itself.
    await click(mic());
    await send({ kind: "final", text: "", segment: OBSERVED[cut - 1].segment }, { kind: "stopped" });
    expect(box().value).toBe(shown);
  });

  it("keeps every utterance when the whole stream lands in one tick", async () => {
    await open(<Field initial="Notes:" />);
    await send(...OBSERVED, { kind: "final", text: "", segment: 2 }, { kind: "stopped" });
    expect(box().value).toBe(`Notes: ${OBSERVED_TEXT}`);
  });
});
