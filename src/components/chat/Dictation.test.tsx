import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The recogniser lives in Rust; here it is a function this file calls. */
let deliver: (payload: { kind: string; text?: string; message?: string }) => void = () => {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "dictation_available") return true;
    if (cmd === "transcription_settings") return { model: "apple" };
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

const { useDictationInto } = await import("./Dictation");

/** A composer, stripped to the textarea and the mic. */
function Field({ initial = "" }: { initial?: string }) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictationInto("tab-1", draft, setDraft, ref);
  return (
    <>
      <textarea ref={ref} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={dictation.toggle}>mic</button>
    </>
  );
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const send = async (payload: { kind: string; text?: string }) => {
  await act(async () => {
    deliver(payload);
  });
};

/** Render a composer holding `initial`, with the caret at `caret`. */
async function open(initial = "", caret = initial.length) {
  render(<Field initial={initial} />);
  await act(async () => {});
  box().setSelectionRange(caret, caret);
}

/** Press the mic and get as far as listening. */
async function startDictating() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button"));
  });
  await send({ kind: "listening" });
}

afterEach(async () => {
  await send({ kind: "stopped" });
  cleanup();
});

describe("dictating into a composer", () => {
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
