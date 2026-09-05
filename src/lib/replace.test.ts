import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { TextHit } from "./api";
import { expandReplacement, hitKey, planReplace, replaceInState, splitTargets } from "./replace";

function apply(doc: string, spec: Parameters<typeof replaceInState>[1], lines?: Set<number>) {
  const state = EditorState.create({ doc });
  const r = replaceInState(state, spec, lines);
  return { text: state.update({ changes: r.changes }).state.doc.toString(), count: r.count };
}

describe("expandReplacement", () => {
  const m = /(?<word>f(o+))/.exec("xfoo")!;
  it("reads editor-style templates", () => {
    expect(expandReplacement("[$1|$2]", m)).toBe("[foo|oo]");
    expect(expandReplacement("<$&>", m)).toBe("<foo>");
    expect(expandReplacement("$<word>!", m)).toBe("foo!");
    expect(expandReplacement("cost $$5", m)).toBe("cost $5");
  });
  it("expands a missing group to nothing, like the backend", () => {
    expect(expandReplacement("$9x", m)).toBe("x");
    expect(expandReplacement("$<nope>", m)).toBe("");
  });
});

describe("replaceInState", () => {
  const literal = { query: "foo", replacement: "bar", regex: false, caseSensitive: false };
  it("rewrites every match, case-insensitively by default", () => {
    expect(apply("foo Foo\nfoo", literal)).toEqual({ text: "bar bar\nbar", count: 3 });
    expect(apply("foo Foo", { ...literal, caseSensitive: true })).toEqual({ text: "bar Foo", count: 1 });
  });
  it("limits itself to the lines asked for", () => {
    expect(apply("foo\nfoo\nfoo", literal, new Set([2]))).toEqual({ text: "foo\nbar\nfoo", count: 1 });
  });
  it("takes a literal query as typed", () => {
    expect(apply("a.c abc", { ...literal, query: "a.c" })).toEqual({ text: "bar abc", count: 1 });
    expect(apply("a\\nb", { ...literal, query: "\\n", replacement: "-" })).toEqual({ text: "a-b", count: 1 });
  });
  it("expands capture groups for a regex", () => {
    expect(apply("f(1) f(22)", { query: "f\\((\\d+)\\)", replacement: "g[$1]", regex: true, caseSensitive: true })).toEqual({ text: "g[1] g[22]", count: 2 });
  });
  it("does nothing for an empty or invalid query", () => {
    expect(apply("foo", { ...literal, query: "" })).toEqual({ text: "foo", count: 0 });
    expect(apply("foo", { ...literal, query: "(", regex: true })).toEqual({ text: "foo", count: 0 });
  });
});

const hit = (path: string, line: number, matches = 1): TextHit => ({ path, line, col: 0, text: "x", matches: Array.from({ length: matches }, (_, i) => [i, i + 1]) });

describe("planReplace", () => {
  const hits = [hit("a.ts", 1, 2), hit("a.ts", 5), hit("b.ts", 3), hit("c.ts", 9)];
  it("rewrites a file whole when nothing in it is excluded", () => {
    const plan = planReplace(hits, new Set());
    expect(plan.targets).toEqual([{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }]);
    expect(plan.files).toBe(3);
    expect(plan.occurrences).toBe(5);
  });
  it("names the lines kept once something is excluded", () => {
    const plan = planReplace(hits, new Set([hitKey(hits[0]), hitKey(hits[2])]));
    expect(plan.targets).toEqual([{ path: "a.ts", lines: [5] }, { path: "c.ts" }]);
    expect(plan.files).toBe(2);
    expect(plan.occurrences).toBe(2);
  });
});

describe("splitTargets", () => {
  it("sends open files through the editor and the rest to disk", () => {
    const { live, disk } = splitTargets([{ path: "a" }, { path: "b", lines: [1] }], (p) => p === "b");
    expect(live).toEqual([{ path: "b", lines: [1] }]);
    expect(disk).toEqual([{ path: "a" }]);
  });
});
