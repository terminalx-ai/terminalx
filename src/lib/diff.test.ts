import { describe, expect, it } from "vitest";
import { countChanges, diffLines } from "./diff";

describe("diffLines (Myers O((N+M)·D))", () => {
  it("handles empty strings and identical documents", () => {
    expect(diffLines("", "")).toEqual([]);
    expect(diffLines("a\nb", "a\nb")).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "ctx", text: "b", oldNo: 2, newNo: 2 },
    ]);
  });

  it("handles pure insertion and pure deletion", () => {
    const added = diffLines("", "one\ntwo");
    expect(added).toEqual([
      { kind: "add", text: "one", newNo: 1 },
      { kind: "add", text: "two", newNo: 2 },
    ]);
    const deleted = diffLines("one\ntwo", "");
    expect(deleted).toEqual([
      { kind: "del", text: "one", oldNo: 1 },
      { kind: "del", text: "two", oldNo: 2 },
    ]);
  });

  it("produces minimal edit scripts for middle edits and collapses distant context", () => {
    const oldLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[19] = "line 20 edited";
    newLines.splice(20, 0, "inserted line");
    const result = diffLines(oldLines.join("\n"), newLines.join("\n"));
    expect(countChanges(result)).toEqual({ additions: 2, deletions: 1 });
    expect(result.some((l) => l.kind === "del" && l.oldNo === 20 && l.text === "line 20")).toBe(true);
    expect(result.some((l) => l.kind === "add" && l.newNo === 20 && l.text === "line 20 edited")).toBe(true);
    expect(result.some((l) => l.kind === "add" && l.newNo === 21 && l.text === "inserted line")).toBe(true);
    // Distant unchanged lines are collapsed into markers
    expect(result.some((l) => l.kind === "ctx" && l.text.startsWith("⋯ "))).toBe(true);
  });

  it("handles large 6,000-line files with scattered edits quickly without O(N*M) fallback", () => {
    const oldLines = Array.from({ length: 6000 }, (_, i) => `const row_${i} = ${i};`);
    const newLines = [...oldLines];
    newLines[100] = "const row_100 = 1000;";
    newLines[3000] = "const row_3000 = 30000;";
    newLines[5900] = "const row_5900 = 59000;";
    const start = performance.now();
    const result = diffLines(oldLines.join("\n"), newLines.join("\n"), 3000);
    const elapsed = performance.now() - start;
    expect(countChanges(result)).toEqual({ additions: 3, deletions: 3 });
    expect(elapsed).toBeLessThan(250);
  });

  it("degrades gracefully when edit distance exceeds limit", () => {
    const a = Array.from({ length: 30 }, (_, i) => `old-${i}`).join("\n");
    const b = Array.from({ length: 30 }, (_, i) => `new-${i}`).join("\n");
    const result = diffLines(a, b, 5);
    expect(countChanges(result)).toEqual({ additions: 30, deletions: 30 });
  });
});
