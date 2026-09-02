import { describe, expect, it } from "vitest";
import { anchorAt, applyFinal, applyPartial, draftWithSpeech, EMPTY_BUFFER, joinSpoken, revises, type DictationAnchor, type DictationBuffer } from "@/lib/dictationText";

/** A recogniser event, as the store hands it over. */
type Event = { partial: string } | { final: string };

/** Replay a dictation and read back the draft and the caret at the end. */
function dictate(draft: string, caret: number, events: Event[]): { text: string; caret: number } {
  const anchor = anchorAt(draft, caret, caret);
  let buffer: DictationBuffer = EMPTY_BUFFER;
  let out = draftWithSpeech(anchor, buffer);
  for (const e of events) {
    buffer = "partial" in e ? applyPartial(buffer, e.partial) : applyFinal(buffer, e.final);
    out = draftWithSpeech(anchor, buffer);
  }
  return out;
}

const end = (draft: string, events: Event[]) => dictate(draft, draft.length, events);

describe("joinSpoken", () => {
  it("puts exactly one space between two pieces and none at an edge", () => {
    expect(joinSpoken("", "hello")).toBe("hello");
    expect(joinSpoken("hello", "")).toBe("hello");
    expect(joinSpoken("hello", "there")).toBe("hello there");
    expect(joinSpoken("hello ", "there")).toBe("hello there");
    expect(joinSpoken("hello\n", "there")).toBe("hello\nthere");
  });
});

describe("draftWithSpeech", () => {
  const spoken = (committed: string, live = ""): DictationBuffer => ({ committed, live });
  const at = (before: string, after = ""): DictationAnchor => ({ before, after });

  it("starts an empty draft without a leading space", () => {
    expect(draftWithSpeech(at(""), spoken("Hello there"))).toEqual({ text: "Hello there", caret: 11 });
  });

  it("keeps a single space after text that has none", () => {
    expect(draftWithSpeech(at("Fix the"), spoken("build please"))).toEqual({ text: "Fix the build please", caret: 20 });
  });

  it("adds no second space after text that already ends in one", () => {
    expect(draftWithSpeech(at("Fix the "), spoken("build"))).toEqual({ text: "Fix the build", caret: 13 });
  });

  it("adds nothing after a line break, which separates already", () => {
    expect(draftWithSpeech(at("Fix the build\n"), spoken("then run the tests"))).toEqual({ text: "Fix the build\nthen run the tests", caret: 32 });
  });

  it("inserts at a caret in the middle, spaced on both sides, caret after the words", () => {
    const anchor = anchorAt("Fix the build", 7, 7); // "Fix the| build"
    expect(draftWithSpeech(anchor, spoken("release"))).toEqual({ text: "Fix the release build", caret: 15 });
  });

  it("does not double the spaces already around the caret", () => {
    const anchor = anchorAt("Fix the  build", 8, 8); // "Fix the | build"
    expect(draftWithSpeech(anchor, spoken("release"))).toEqual({ text: "Fix the release build", caret: 15 });
  });

  it("leaves the draft and the caret alone while nothing has been heard", () => {
    expect(draftWithSpeech(anchorAt("Fix the build", 7, 7), EMPTY_BUFFER)).toEqual({ text: "Fix the build", caret: 7 });
  });

  it("replaces a selection, as typing into it would", () => {
    const anchor = anchorAt("Fix the old build", 8, 11); // "old" selected
    expect(draftWithSpeech(anchor, spoken("new"))).toEqual({ text: "Fix the new build", caret: 11 });
  });
});

describe("revises", () => {
  it("counts an extension, a shortening and a corrected tail as the same segment", () => {
    expect(revises("", "Hello")).toBe(true);
    expect(revises("Hello", "Hello there")).toBe(true);
    expect(revises("Hello there world", "Hello there")).toBe(true);
    expect(revises("hello there", "Hello, there!")).toBe(true);
    expect(revises("I have to", "I have two apples")).toBe(true);
  });

  it("counts a sentence that shares almost nothing as a new segment", () => {
    expect(revises("I have two apples", "I will go now")).toBe(false);
    expect(revises("Hello", "Goodbye")).toBe(false);
    expect(revises("Testing one two three", "Four five six")).toBe(false);
  });
});

describe("a dictated draft", () => {
  it("grows with cumulative partials rather than repeating them", () => {
    expect(end("", [{ partial: "Fix" }, { partial: "Fix the" }, { partial: "Fix the build" }])).toEqual({ text: "Fix the build", caret: 13 });
  });

  it("keeps the words from before a pause when the recogniser starts a new segment", () => {
    const events: Event[] = [
      { partial: "Fix the build" },
      // The pause. Apple hands back a segment that stands on its own.
      { partial: "Then" },
      { partial: "Then run the tests" },
    ];
    expect(end("", events)).toEqual({ text: "Fix the build Then run the tests", caret: 32 });
  });

  it("does not repeat a final that only says the last partial again", () => {
    expect(end("", [{ partial: "Fix the build" }, { final: "Fix the build." }])).toEqual({ text: "Fix the build.", caret: 14 });
  });

  it("keeps a final that stands on its own instead of the partial it followed", () => {
    expect(end("", [{ partial: "Fix the build" }, { final: "Ship it tomorrow" }])).toEqual({ text: "Fix the build Ship it tomorrow", caret: 30 });
  });

  it("appends the second utterance after the first has been committed", () => {
    const events: Event[] = [
      { partial: "Fix the build" },
      { final: "Fix the build." },
      { partial: "Then" },
      { partial: "Then run the tests" },
      { final: "Then run the tests." },
    ];
    expect(end("", events)).toEqual({ text: "Fix the build. Then run the tests.", caret: 34 });
  });

  it("appends to what the reader had already typed", () => {
    expect(end("Fix the build", [{ partial: "and" }, { partial: "and ship it" }, { final: "and ship it." }])).toEqual({ text: "Fix the build and ship it.", caret: 26 });
  });

  it("takes a single final from a local model the same way", () => {
    expect(end("Notes:", [{ final: " Fix the build. " }])).toEqual({ text: "Notes: Fix the build.", caret: 21 });
  });

  it("ignores a blank partial", () => {
    expect(end("", [{ partial: "Fix the build" }, { partial: "   " }])).toEqual({ text: "Fix the build", caret: 13 });
  });

  it("settles the last partial when the final arrives empty", () => {
    expect(applyFinal({ committed: "Fix the build.", live: "Then run" }, "")).toEqual({ committed: "Fix the build. Then run", live: "" });
  });

  it("inserts a whole dictation at a caret in the middle", () => {
    const events: Event[] = [{ partial: "the" }, { partial: "the release" }, { final: "the release" }, { partial: "and staging" }];
    expect(dictate("Fix build", 4, events)).toEqual({ text: "Fix the release and staging build", caret: 27 });
  });
});
