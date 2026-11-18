import { describe, expect, it } from "vitest";
import { speakable } from "./readAloud";

describe("an answer read aloud (PRO-379)", () => {
  it("says the words, not the marks, and names a code block instead of spelling it", () => {
    expect(speakable("## Done\n\n**Dedupe:** `cardsFor()` keeps the [first card](https://x.test).\n\n```ts\nconst a = 1;\n```\n- one\n- two"))
      .toBe("Done\n\nDedupe: cardsFor() keeps the first card.\n\n (code block) \none\ntwo");
  });
});
