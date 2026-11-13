import { describe, expect, it } from "vitest";
import { admit, isReservedName, limitNotice, MAX_ATTACHMENT_BYTES, renameSuggestion, reservedNotice, summaryParts } from "./attachmentRules";

const file = (name: string, size = 10) => ({ name, size });

describe("attachment rules", () => {
  it("attaches the first 10 of 15 dropped files, refuses the reserved one and leaves 4 out", () => {
    const offered = [...Array.from({ length: 10 }, (_, i) => file(`f${i}.log`)), file("terminalx.json"), ...Array.from({ length: 4 }, (_, i) => file(`g${i}.log`))];
    const result = admit(0, offered);
    expect(result.attached.map((f) => f.name)).toEqual(Array.from({ length: 10 }, (_, i) => `f${i}.log`));
    expect(result.refused).toEqual([{ item: file("terminalx.json"), reason: "reserved" }]);
    expect(result.notAdded.map((f) => f.name)).toEqual(["g0.log", "g1.log", "g2.log", "g3.log"]);
    expect(summaryParts({ attached: 10, refused: 1, notAdded: 4 }).map((p) => p.text)).toEqual(["10 attached", "1 refused", "4 not added"]);
  });

  it("counts files already on the message against the limit", () => {
    expect(admit(8, [file("a"), file("b"), file("c")]).notAdded.map((f) => f.name)).toEqual(["c"]);
    expect(admit(10, [file("a")]).attached).toEqual([]);
  });

  it("refuses an oversized file without taking a place", () => {
    const result = admit(9, [file("big.bin", MAX_ATTACHMENT_BYTES + 1), file("small.txt")]);
    expect(result.refused[0].reason).toBe("too-large");
    expect(result.attached.map((f) => f.name)).toEqual(["small.txt"]);
  });

  it("matches reserved names in any case and by the last path segment only", () => {
    expect(isReservedName("TerminalX.JSON")).toBe(true);
    expect(isReservedName("/Users/me/repo/terminalx.json")).toBe(true);
    expect(isReservedName("terminalx.json.bak")).toBe(false);
    expect(isReservedName("settings.json")).toBe(false);
  });

  it("words the notices as the design does", () => {
    expect(renameSuggestion("terminalx.json")).toBe("terminalx.copy.json");
    expect(renameSuggestion("Makefile")).toBe("Makefile.copy");
    expect(reservedNotice("terminalx.json")).toEqual({
      title: "terminalx.json is a name TerminalX uses for session files",
      body: "Rename it, for example to terminalx.copy.json, and attach it again.",
    });
    expect(limitNotice(15, 4)).toEqual({
      title: "Only the first 10 files were attached",
      body: "You dropped 15 files. 4 weren’t added; send them in another message.",
    });
  });
});
