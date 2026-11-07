import { describe, expect, it } from "vitest";
import { reviewAnchor, reviewBody, reviewDraft, reviewLocation } from "./reviewThreads";
import { reviewSnapshot as snapshot, reviewThread as thread } from "@/test/reviewThreads";

const file = { path: thread.path, headOid: snapshot.headOid, baseOid: snapshot.baseOid, beforeLines: 100, afterLines: 100 };

describe("review coordinates", () => {
  it("uses GitHub's current line after several pushes, not the original comment position", () => {
    expect(reviewAnchor(thread, snapshot, file)).toEqual({ side: "RIGHT", start: 42, end: 42 });
    expect(reviewLocation(thread)).toBe("src/login.ts:42 (head)");
    expect(reviewAnchor({ ...thread, line: 48, startLine: 45, startDiffSide: "RIGHT" }, { ...snapshot, headOid: "head-4" }, { ...file, headOid: "head-4" })).toEqual({ side: "RIGHT", start: 45, end: 48 });
    expect(reviewAnchor(thread, snapshot, { ...file, headOid: "head-2" })).toBeNull();
  });
  it("maps base-side ranges and renamed paths only on the base side", () => {
    const renamed = { ...file, path: "src/auth.ts", oldPath: thread.path };
    expect(reviewAnchor({ ...thread, diffSide: "LEFT", startLine: 40, startDiffSide: "LEFT" }, snapshot, renamed)).toEqual({ side: "LEFT", start: 40, end: 42 });
    expect(reviewAnchor(thread, snapshot, renamed)).toBeNull();
    expect(reviewAnchor(thread, snapshot, { ...file, baseOid: "wrong-base" })).toBeNull();
  });
  it("retains outdated labels without anchoring missing, stale, or invalid ranges", () => {
    expect(reviewLocation({ ...thread, isOutdated: true, line: null })).toBe("src/login.ts:12 (head, original)");
    for (const change of [{ isOutdated: true }, { line: null }, { line: 101 }, { line: 0 }, { startLine: 50 }, { startLine: 40, startDiffSide: "LEFT" as const }]) {
      expect(reviewAnchor({ ...thread, ...change }, snapshot, file)).toBeNull();
    }
    expect(reviewAnchor(thread, snapshot, { ...file, path: "other.ts" })).toBeNull();
  });
});

describe("suggestions and chat drafts", () => {
  it("uses original hunk coordinates for suggestion preimages after pushes", () => {
    expect(reviewBody(thread.comments[0].body, thread)).toEqual([
      { kind: "markdown", text: "Use the session token." },
      { kind: "suggestion", text: "const token = session.token;", before: "const token = legacy.token;" },
    ]);
    expect(reviewBody("```suggestion\n\n```", thread)[0]).toEqual({ kind: "suggestion", text: "", before: "const token = legacy.token;" });
  });
  it("handles ranges, base-side deletions, and missing original context", () => {
    expect(reviewBody("```suggestion:-1+0\nreplacement\n```", thread)[0]).toMatchObject({ before: "new\nconst token = legacy.token;" });
    expect(reviewBody("~~~suggestion\nreplacement\n~~~", { ...thread, diffSide: "LEFT", originalLine: 11 })[0]).toMatchObject({ before: "old" });
    expect(reviewBody("```suggestion\nreplacement\n```", { ...thread, originalLine: 300 })[0]).toMatchObject({ before: null });
  });
  it("does not interpret suggestions nested in examples or incomplete fences", () => {
    const body = "````markdown\n```suggestion\nexample\n```\n````\n```suggestion\nunclosed";
    expect(reviewBody(body, thread)).toEqual([{ kind: "markdown", text: body }]);
  });
  it("includes path, side, text from every author, and stale state in a draft", () => {
    const draft = reviewDraft({ ...thread, isOutdated: true, comments: [...thread.comments, { ...thread.comments[0], author: null, body: "Second\nreply" }] }, snapshot.url);
    expect(draft).toContain("src/login.ts:12 (head, original) · Outdated");
    expect(draft).toContain(snapshot.url);
    expect(draft).toContain("@reviewer:\n> Use the session token.");
    expect(draft).toContain("@deleted-user:\n> Second\n> reply");
  });
});
