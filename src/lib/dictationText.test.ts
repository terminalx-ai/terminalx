import { describe, expect, it } from "vitest";
import { anchorAt, applyFinal, applyPartial, draftWithSpeech, EMPTY_BUFFER, joinSpoken, revises, type DictationAnchor, type DictationBuffer } from "@/lib/dictationText";

/** A recogniser event, as the store hands it over. */
type Event = { partial: string; at?: number; segment?: number } | { final: string; segment?: number };

/** Replay a dictation and read back the draft and the caret at the end. */
function dictate(draft: string, caret: number, events: Event[]): { text: string; caret: number } {
  const anchor = anchorAt(draft, caret, caret);
  let buffer: DictationBuffer = EMPTY_BUFFER;
  let out = draftWithSpeech(anchor, buffer);
  let previousPartialAt: number | undefined;
  for (const e of events) {
    if ("partial" in e) {
      const sincePreviousMs = e.at == null || previousPartialAt == null ? undefined : e.at - previousPartialAt;
      buffer = applyPartial(buffer, e.partial, { segment: e.segment, sincePreviousMs });
      previousPartialAt = e.at;
    } else {
      buffer = applyFinal(buffer, e.final, { segment: e.segment });
      previousPartialAt = undefined;
    }
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

  it("counts a rewrite with the same first word as the same segment", () => {
    expect(revises("Green Light lighthouse", "Green lighthouse beam shine brightly", 80)).toBe(true);
  });
});

describe("a dictated draft", () => {
  it("replaces the short leading guess when the recogniser revises it", () => {
    const events: Event[] = [
      { partial: "Green", at: 0 },
      { partial: "Green Light", at: 80 },
      { partial: "Green Light lighthouse", at: 160 },
      { partial: "Green lighthouse beam shine brightly beyond the quiet Harbour this morning", at: 240 },
      // The pause. The next partial stands on its own.
      { partial: "Silver lanterns glow softly beside the open window tonight", at: 1_840 },
    ];
    expect(end("", events)).toEqual({
      text: "Green lighthouse beam shine brightly beyond the quiet Harbour this morning Silver lanterns glow softly beside the open window tonight",
      caret: 133,
    });
  });

  it("keeps a short guess live until a long enough pause separates it", () => {
    const short = applyPartial(EMPTY_BUFFER, "Hello");
    expect(applyPartial(short, "Goodbye", { sincePreviousMs: 1_499 })).toEqual({ committed: "", live: "Goodbye" });
    expect(applyPartial(short, "Goodbye", { sincePreviousMs: 1_500 })).toEqual({ committed: "Hello", live: "Goodbye" });
  });

  it("keeps a new utterance apart from the live one however soon it arrives", () => {
    // Apple settles an utterance and starts the next in the same tick after a
    // cold start, so the gap between results says nothing about the pause.
    const first = applyPartial(EMPTY_BUFFER, "Alpha beta gamma", { segment: 7 });
    expect(applyPartial(first, "Delta", { segment: 8, sincePreviousMs: 0 })).toEqual({ committed: "Alpha beta gamma", live: "Delta", segment: 8 });
    expect(applyPartial(first, "Alpha starts again", { segment: 8, sincePreviousMs: 10 })).toEqual({ committed: "Alpha beta gamma", live: "Alpha starts again", segment: 8 });
    // Even one that opens with every old word: the recogniser's identity is final.
    expect(applyPartial(first, "Alpha beta gamma again", { segment: 8, sincePreviousMs: 5_000 })).toEqual({
      committed: "Alpha beta gamma",
      live: "Alpha beta gamma again",
      segment: 8,
    });
  });

  it("keeps a one-word utterance when the next one opens with the same word", () => {
    const okay = applyPartial(EMPTY_BUFFER, "Okay", { segment: 0 });
    const again = applyPartial(okay, "Okay", { segment: 1 });
    expect(again).toEqual({ committed: "Okay", live: "Okay", segment: 1 });
    expect(applyPartial(again, "Okay now fix it", { segment: 1 })).toEqual({ committed: "Okay", live: "Okay now fix it", segment: 1 });
  });

  it("revises inside one utterance by the words alone, however late", () => {
    const first = applyPartial(EMPTY_BUFFER, "Alpha beta gamma", { segment: 7 });
    expect(applyPartial(first, "Alpha beta, gamma delta", { segment: 7, sincePreviousMs: 200 })).toEqual({ committed: "", live: "Alpha beta, gamma delta", segment: 7 });
    expect(applyPartial(first, "Alpha bitter gamma", { segment: 7, sincePreviousMs: 200 })).toEqual({ committed: "", live: "Alpha bitter gamma", segment: 7 });
    // The settled form comes a couple of seconds later and can correct the first word.
    expect(applyPartial(first, "Alfa beta gamma", { segment: 7, sincePreviousMs: 1_800 })).toEqual({ committed: "", live: "Alfa beta gamma", segment: 7 });
    const short = applyPartial(EMPTY_BUFFER, "Shipped", { segment: 0 });
    expect(applyPartial(short, "Ship", { segment: 0, sincePreviousMs: 1_800 })).toEqual({ committed: "", live: "Ship", segment: 0 });
    // Nothing in common is a new phrase, not a rewrite, even under the same identity.
    expect(applyPartial(first, "Entirely different", { segment: 7, sincePreviousMs: 200 })).toEqual({ committed: "Alpha beta gamma", live: "Entirely different", segment: 7 });
  });

  it("does not repeat an utterance that comes back settled", () => {
    // Every partial has placeholder timestamps; the settled form of the
    // utterance follows with real ones, and keeps the identity Rust gave it.
    const events: Event[] = [
      { partial: "Green Light", at: 0, segment: 0 },
      { partial: "Green lighthouse beam shine bright brightly beyond the quiet Harbour this morning", at: 200, segment: 0 },
      { partial: "Green lighthouse beam shine brightly beyond the quiet Harbour this morning", at: 2_200, segment: 0 },
      // The pause. The next utterance stands alone under a new identity.
      { partial: "Silver lanterns glow softly beside the open window tonight", at: 4_000, segment: 1 },
      { partial: "Silver lanterns glow softly beside the open window tonight", at: 6_000, segment: 1 },
      { final: "", segment: 1 },
    ];
    expect(end("", events)).toEqual({
      text: "Green lighthouse beam shine brightly beyond the quiet Harbour this morning Silver lanterns glow softly beside the open window tonight",
      caret: 133,
    });
  });

  it("ignores a late correction of an utterance it has already moved past", () => {
    const first = applyPartial(EMPTY_BUFFER, "Fix the build, please", { segment: 0 });
    const second = applyPartial(first, "Then", { segment: 1 });
    expect(applyPartial(second, "Fix the build please.", { segment: 0 })).toBe(second);
    expect(applyFinal(second, "Fix the build please.", { segment: 0 })).toBe(second);
    expect(applyPartial(second, "Then run", { segment: 1 })).toEqual({ committed: "Fix the build, please", live: "Then run", segment: 1 });
  });

  it("carries on after an early final restarts recognition", () => {
    // Apple can end its task with a final mid-dictation; Rust starts a new
    // request and identities keep counting up.
    const events: Event[] = [
      { partial: "Fix the build", segment: 0 },
      { final: "Fix the build.", segment: 0 },
      { partial: "Then", segment: 1 },
      { partial: "Then run the tests", segment: 1 },
      { partial: "Then run the tests", segment: 1 },
      { partial: "And ship it", segment: 2 },
    ];
    expect(end("", events)).toEqual({ text: "Fix the build. Then run the tests And ship it", caret: 45 });
  });

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

  it("keeps a phrase that shares only common words with the last one", () => {
    const first = applyPartial(EMPTY_BUFFER, "run the tests", { segment: 0 });
    expect(applyPartial(first, "run the build", { segment: 1 })).toEqual({ committed: "run the tests", live: "run the build", segment: 1 });
  });

  it("inserts a whole dictation at a caret in the middle", () => {
    const events: Event[] = [{ partial: "the" }, { partial: "the release" }, { final: "the release" }, { partial: "and staging" }];
    expect(dictate("Fix build", 4, events)).toEqual({ text: "Fix the release and staging build", caret: 27 });
  });
});

/**
 * Apple's on-device recogniser on macOS 26.3.1, fed synthesized speech with
 * pauses. Every partial arrives with placeholder timestamps; about two seconds
 * after the speaker stops the utterance comes back settled with real ones,
 * and the next utterance stands alone. Identities are what `dictation.rs`
 * derives for that stream; the times are as observed, including a cold start
 * that delivered three utterances' worth of results in the same tick.
 */
describe("the stream observed from Apple", () => {
  /** "Fix the build please. [1.5 s] Then run the tests for it." */
  const ONE: Event[] = [
    { partial: "Fix", at: 4481, segment: 0 },
    { partial: "Fix the", at: 4481, segment: 0 },
    { partial: "Fix the build", at: 4481, segment: 0 },
    { partial: "Fix the build, please", at: 4481, segment: 0 },
    { partial: "Fix the build, please", at: 4481, segment: 0 },
    { partial: "Then", at: 4481, segment: 1 },
    { partial: "Then run", at: 4481, segment: 1 },
    { partial: "Then run the", at: 4481, segment: 1 },
    { partial: "Then run the test", at: 4481, segment: 1 },
    { partial: "Then run the test for", at: 4691, segment: 1 },
    { partial: "Then run the test for it", at: 4906, segment: 1 },
    { partial: "Then run the test for it", at: 6708, segment: 1 },
  ];
  const ONE_TEXT = "Fix the build, please Then run the test for it";

  /** "I need a settings page. [1.2 s] I also need unit tests. [2.5 s] Ship it tomorrow." */
  const TWO: Event[] = [
    { partial: "I", at: 8606, segment: 0 },
    { partial: "I need", at: 8606, segment: 0 },
    { partial: "I need a settings page", at: 8606, segment: 0 },
    // The shorter pause is absorbed: the utterance carries on cumulatively.
    { partial: "I need a settings page I", at: 8606, segment: 0 },
    { partial: "I need a settings page. I am", at: 8606, segment: 0 },
    { partial: "I need a settings page. I am also need unit test.", at: 8606, segment: 0 },
    { partial: "I need a settings page. I am also need unit tests.", at: 8606, segment: 0 },
    { partial: "I need a settings page. I am also need unit tests.", at: 8607, segment: 0 },
    // The longer pause. The next utterance stands alone, in the same tick.
    { partial: "Ship", at: 8607, segment: 1 },
    { partial: "Shipped", at: 8607, segment: 1 },
    { partial: "Shipped it", at: 8607, segment: 1 },
    { partial: "Shipped it tomorrow", at: 8812, segment: 1 },
    // Settled, with its first word corrected.
    { partial: "Ship it tomorrow", at: 10588, segment: 1 },
  ];
  const TWO_TEXT = "I need a settings page. I am also need unit tests. Ship it tomorrow";

  /** "Fix the build [0.4 s] then run the tests." — one utterance throughout. */
  const SHORT: Event[] = [
    { partial: "Fix", at: 5586, segment: 0 },
    { partial: "Fix the build", at: 5586, segment: 0 },
    { partial: "Fix the build then", at: 5586, segment: 0 },
    { partial: "Fix the build, then run the", at: 5586, segment: 0 },
    { partial: "Fix the build, then run the test", at: 5690, segment: 0 },
    { partial: "Fix the build, then run the test", at: 7681, segment: 0 },
  ];

  it("appends the utterance after the pause instead of replacing the one before it", () => {
    expect(end("", ONE)).toEqual({ text: ONE_TEXT, caret: ONE_TEXT.length });
  });

  it("keeps the reader's draft in front of both utterances", () => {
    expect(end("Notes:", ONE)).toEqual({ text: `Notes: ${ONE_TEXT}`, caret: 7 + ONE_TEXT.length });
  });

  it("keeps every utterance across two pauses, one absorbed and one not", () => {
    expect(end("", TWO)).toEqual({ text: TWO_TEXT, caret: TWO_TEXT.length });
  });

  it("keeps a hesitation inside one utterance as one phrase", () => {
    expect(end("", SHORT)).toEqual({ text: "Fix the build, then run the test", caret: 32 });
  });

  it("puts every utterance between the halves of a draft split at the caret", () => {
    expect(dictate("Before after", 6, ONE)).toEqual({ text: `Before ${ONE_TEXT} after`, caret: 7 + ONE_TEXT.length });
  });

  it("replaces a selection with every utterance, not just the last", () => {
    const anchor = anchorAt("Keep this, drop that and keep this too", 11, 20); // "drop that" selected
    let buffer: DictationBuffer = EMPTY_BUFFER;
    for (const e of ONE) buffer = "partial" in e ? applyPartial(buffer, e.partial, { segment: e.segment }) : applyFinal(buffer, e.final, { segment: e.segment });
    expect(draftWithSpeech(anchor, buffer)).toEqual({ text: `Keep this, ${ONE_TEXT} and keep this too`, caret: 11 + ONE_TEXT.length });
  });

  it.each([
    ["before the pause", ONE.slice(0, 5)],
    ["as the next utterance begins", ONE.slice(0, 6)],
    ["after the second utterance", ONE],
  ])("keeps the whole draft when dictation stops %s", (_when, events) => {
    // Stopping delivers an empty final, as observed.
    const heard = end("Draft:", events).text;
    expect(end("Draft:", [...events, { final: "", segment: events[events.length - 1].segment }]).text).toBe(heard);
    expect(heard.startsWith("Draft: Fix the build")).toBe(true);
  });

  it("keeps the whole draft when dictation stops after each of several pauses", () => {
    for (const cut of [8, 12, TWO.length]) {
      const events = TWO.slice(0, cut);
      const heard = end("Draft:", events).text;
      expect(end("Draft:", [...events, { final: "", segment: 1 }]).text).toBe(heard);
      expect(heard.startsWith("Draft: I need a settings page")).toBe(true);
    }
  });
});
