import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Payload = { kind: string; text?: string; message?: string; settings?: string; segment?: number };

/** The recogniser lives in Rust; here it is a function this file calls. */
let deliver: (payload: Payload) => void = () => {};

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

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { openUrl } = await import("@tauri-apps/plugin-opener");
const { clearDictationError } = await import("@/lib/dictation");
const { DictationStatus, useDictationInto } = await import("./Dictation");

/** A composer, stripped to the textarea and the mic. */
function Field({ initial = "" }: { initial?: string }) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictationInto("tab-1", draft, setDraft, ref);
  return (
    <>
      <textarea ref={ref} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={dictation.toggle}>mic</button>
      {/* What a composer does to its own draft once the message has gone. */}
      <button onClick={() => setDraft("")}>sent</button>
      <DictationStatus dictation={dictation} />
    </>
  );
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const send = async (...payloads: Payload[]) => {
  await act(async () => {
    for (const payload of payloads) deliver(payload);
  });
};

/** Render a composer holding `initial`, the reader's caret at `caret`. */
async function open(initial = "", caret = initial.length) {
  render(<Field initial={initial} />);
  await act(async () => {});
  // As the reader would: click into the field, then put the caret there.
  box().focus();
  box().setSelectionRange(caret, caret);
  fireEvent.mouseUp(box());
}

/** Press the mic and get as far as listening. */
async function startDictating() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "mic" }));
  });
  await send({ kind: "listening" });
}

/** Press the mic again; the recogniser then finishes the utterance as `settled` and closes. */
async function stopDictating(settled = "") {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "mic" }));
  });
  await send({ kind: "final", text: settled, segment: 0 }, { kind: "stopped" });
}

/**
 * The reader changing the field themselves, as the browser reports it: the
 * field holds the new text with the caret where the edit left it (or, after an
 * Undo, the restored text selected), and then says so with an input event.
 */
async function edit(value: string, inputType: string, start: number, end = start) {
  const el = box();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.setSelectionRange(start, end);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  });
}

/** Select a range and remove it with Backspace, Delete or Cut. */
async function erase(start: number, end: number, inputType = "deleteContentBackward") {
  const el = box();
  el.focus();
  el.setSelectionRange(start, end);
  fireEvent.select(el);
  await edit(el.value.slice(0, start) + el.value.slice(end), inputType, start);
}

afterEach(async () => {
  await send({ kind: "stopped" });
  clearDictationError();
  vi.mocked(openUrl).mockClear();
  cleanup();
});

describe("dictating into a composer", () => {
  it.each([
    ["microphone", "Microphone access is denied.", "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"],
    ["speechRecognition", "Speech recognition access is denied.", "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"],
  ])("links denied %s access to its System Settings privacy pane", async (settings, message, url) => {
    await open();
    await startDictating();

    await send({ kind: "error", message, settings });

    expect(screen.getByText(message)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open System Settings/i }));
    expect(openUrl).toHaveBeenCalledWith(url);
  });

  it("appends past a pause instead of replacing what came before", async () => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "Fix" });
    await send({ kind: "partial", text: "Fix the build" });
    // The pause: a segment that stands on its own.
    await send({ kind: "partial", text: "Then run the tests" });
    expect(box().value).toBe("Fix the build Then run the tests");
    await send({ kind: "final", text: "Then run the tests." });
    expect(box().value).toBe("Fix the build Then run the tests.");
    expect(box().selectionStart).toBe(33);
  });

  it("inserts at the caret and leaves the rest where it was", async () => {
    await open("Fix the build", 7); // "Fix the| build"
    await startDictating();
    await send({ kind: "partial", text: "release" });
    expect(box().value).toBe("Fix the release build");
    expect(box().selectionStart).toBe(15);
    await send({ kind: "final", text: "release and staging" });
    expect(box().value).toBe("Fix the release and staging build");
  });

  it("appends with one space when the caret is at the end", async () => {
    await open("Fix the build");
    await startDictating();
    await send({ kind: "partial", text: "and ship it" });
    expect(box().value).toBe("Fix the build and ship it");
  });

  it("takes the edited draft as the new base when the reader types mid-dictation", async () => {
    await open("Fix the build");
    await startDictating();
    await send({ kind: "partial", text: "and ship it" });
    expect(box().value).toBe("Fix the build and ship it");
    // The reader tidies the draft themselves, caret left at the end.
    await act(async () => {
      fireEvent.change(box(), { target: { value: "Fix the build and ship it today." } });
    });
    box().setSelectionRange(32, 32);
    await send({ kind: "partial", text: "Then run the tests" });
    expect(box().value).toBe("Fix the build and ship it today. Then run the tests");
  });
});

/**
 * #428: text the reader deleted while dictating came back. The hook told an
 * edit from its own writes by what the draft read, so a deletion that left a
 * draft it knew (the one from before the words, or one it wrote a moment
 * earlier) was taken for a late update and written over.
 */
describe("the reader's own edits while dictating (#428)", () => {
  const DELETIONS = [
    ["Backspace", "deleteContentBackward"],
    ["Delete", "deleteContentForward"],
    ["Cut", "deleteByCut"],
  ] as const;

  it.each(DELETIONS)("%s over everything dictated into an empty composer removes it for good", async (_key, inputType) => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    expect(box().value).toBe("Fix the build");
    // The draft is now exactly what it was before the words.
    await erase(0, 13, inputType);
    expect(box().value).toBe("");
    // The utterance comes back settled, as it does a moment after the speaker stops.
    await send({ kind: "partial", text: "Fix the build.", segment: 0 });
    expect(box().value).toBe("");
    await send({ kind: "partial", text: "Then run the tests", segment: 1 });
    expect(box().value).toBe("Then run the tests");
  });

  it.each(DELETIONS)("%s over the dictated words leaves the text typed before them", async (_key, inputType) => {
    await open("Notes:");
    await startDictating();
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    expect(box().value).toBe("Notes: Fix the build");
    await erase(6, 20, inputType);
    expect(box().value).toBe("Notes:");
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    expect(box().value).toBe("Notes:");
    expect(box().selectionStart).toBe(6);
  });

  it.each(DELETIONS)("%s over the last dictated word removes it for good", async (_key, inputType) => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "Fix", segment: 0 });
    await send({ kind: "partial", text: "Fix the", segment: 0 });
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    // The draft is now one the dictation wrote two results ago.
    await erase(7, 13, inputType);
    expect(box().value).toBe("Fix the");
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    expect(box().value).toBe("Fix the");
  });

  it("keeps a second edit made straight after the first", async () => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "Fix the build please", segment: 0 });
    await erase(14, 20, "deleteByCut"); // "please"
    expect(box().value).toBe("Fix the build ");
    await erase(8, 14); // "build "
    expect(box().value).toBe("Fix the ");
    // Nothing was written between the two edits; the settled utterance is the first thing to arrive.
    await send({ kind: "partial", text: "Fix the build, please.", segment: 0 });
    expect(box().value).toBe("Fix the ");
  });

  it("puts what is said after a deletion at the caret, in the same utterance and the next", async () => {
    await open("Before after", 6); // "Before| after"
    await startDictating();
    await send({ kind: "partial", text: "fix the bill", segment: 0 });
    expect(box().value).toBe("Before fix the bill after");
    await erase(14, 19); // " bill"
    expect(box().value).toBe("Before fix the after");
    // The recogniser corrects the deleted word and carries on: only the new words go in.
    await send({ kind: "partial", text: "Fix the build and ship", segment: 0 });
    expect(box().value).toBe("Before fix the and ship after");
    expect(box().selectionStart).toBe(23);
    await send({ kind: "partial", text: "Fix the build, and ship it.", segment: 0 });
    await send({ kind: "partial", text: "Then rest", segment: 1 });
    expect(box().value).toBe("Before fix the and ship it. Then rest after");
  });

  it("does not put a piece of a word in when the utterance the reader typed after settles", async () => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "fix the build please", segment: 0 });
    await edit("fix the build please!", "insertText", 21);
    await send({ kind: "partial", text: "Fix the build, please.", segment: 0 });
    expect(box().value).toBe("fix the build please!");
  });

  it("takes back words the recogniser took back after an edit", async () => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    await edit("Fix the build!", "insertText", 14);
    await send({ kind: "partial", text: "Fix the build and", segment: 0 });
    expect(box().value).toBe("Fix the build! and");
    await send({ kind: "partial", text: "Fix the build.", segment: 0 });
    expect(box().value).toBe("Fix the build!");
  });

  it("keeps the text an Undo restores, and adds what is said next after it", async () => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    await erase(0, 13);
    expect(box().value).toBe("");
    // Undo puts the words back and leaves them selected.
    await edit("Fix the build", "historyUndo", 0, 13);
    expect(box().value).toBe("Fix the build");
    await send({ kind: "partial", text: "Fix the build.", segment: 0 });
    expect(box().value).toBe("Fix the build");
    await send({ kind: "partial", text: "Then run the tests", segment: 1 });
    expect(box().value).toBe("Fix the build Then run the tests");
  });

  it("keeps a deletion made while the last utterance is still settling", async () => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "fix the build", segment: 0 });
    // The mic is closed; the final has not arrived.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "mic" }));
    });
    expect(screen.getByText("Finishing…")).toBeTruthy();
    await erase(0, 13);
    await send({ kind: "final", text: "Fix the build.", segment: 0 }, { kind: "stopped" });
    expect(box().value).toBe("");
  });

  it("keeps edits made before the first words arrive, as all of a local model's do when the mic closes", async () => {
    await open("Old notes");
    await startDictating();
    // Nothing has been written yet, so there is no draft of the dictation's to compare with.
    await erase(0, 9);
    await edit("New:", "insertText", 4);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "mic" }));
    });
    await send({ kind: "transcribing" });
    await edit("New: ready.", "insertText", 11);
    await send({ kind: "final", text: "Fix the build." }, { kind: "stopped" });
    expect(box().value).toBe("New: ready. Fix the build.");
  });

  it("leaves the draft to the reader once the mic has closed", async () => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    await stopDictating("Fix the build.");
    expect(box().value).toBe("Fix the build.");
    await erase(0, 14);
    expect(box().value).toBe("");
    await edit("Run the tests", "insertText", 13);
    expect(box().value).toBe("Run the tests");
  });

  it.each([
    ["while the mic is open", false],
    ["once it has closed", true],
  ])("does not put a sent message back in the composer %s", async (_when, closed) => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    if (closed) await stopDictating();
    expect(box().value).toBe("Fix the build");
    // The composer empties its own draft: no key was pressed in the field.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "sent" }));
    });
    expect(box().value).toBe("");
    if (closed) return;
    // The mic is still open: the sent utterance settles, then the next message is dictated.
    await send({ kind: "partial", text: "Fix the build.", segment: 0 });
    expect(box().value).toBe("");
    await send({ kind: "partial", text: "Then run the tests", segment: 1 });
    expect(box().value).toBe("Then run the tests");
  });

  it("ignores a dictation it did not start once its own has ended", async () => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    await stopDictating();
    // Another window dictates: every window is sent the recogniser's events.
    await send({ kind: "listening" }, { kind: "partial", text: "Something else", segment: 0 }, { kind: "final", text: "", segment: 0 }, { kind: "stopped" });
    expect(box().value).toBe("Fix the build");
  });

  it("dictates again after all of that, from where the reader left the caret", async () => {
    await open();
    await startDictating();
    await send({ kind: "partial", text: "Fix the build", segment: 0 });
    await erase(0, 13);
    await stopDictating();
    await edit("Notes:", "insertText", 6);
    fireEvent.keyUp(box());
    await startDictating();
    await send({ kind: "partial", text: "run the tests", segment: 0 });
    expect(box().value).toBe("Notes: run the tests");
  });
});
