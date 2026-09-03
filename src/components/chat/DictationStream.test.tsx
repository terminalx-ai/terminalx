import { StrictMode, useCallback, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The composer against the shapes the recogniser really produces, and against
 * the ways the plumbing around it can misbehave. The rule these all check is
 * the same: whatever is dropped, delayed or coalesced on the way, no phrase
 * the reader spoke may go missing from the draft.
 */

let deliver: (payload: { kind: string; text?: string }) => void = () => {};

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

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const mic = () => screen.getAllByRole("button")[0];
const flush = () => screen.getAllByRole("button")[1];

const send = async (...events: { kind: string; text?: string }[]) => {
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
