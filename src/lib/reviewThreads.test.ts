import { describe, expect, it, vi } from "vitest";
import { reviewFileReader, githubReviewAnchor, reviewBody, githubReviewDraft, githubReviewLocation } from "./reviewThreads";
import { reviewSnapshot as snapshot, reviewThread as thread, reviewFile } from "@/test/reviewThreads";

const file = { path: thread.path, headOid: snapshot.headOid, baseOid: snapshot.baseOid, beforeLines: 100, afterLines: 100 };

describe("review coordinates", () => {
  it("uses GitHub's current line after several pushes, not the original comment position", () => {
    expect(githubReviewAnchor(thread, snapshot, file)).toEqual({ side: "RIGHT", start: 42, end: 42 });
    expect(githubReviewLocation(thread)).toBe("src/login.ts:42 (head)");
    expect(githubReviewAnchor({ ...thread, line: 48, startLine: 45, startDiffSide: "RIGHT" }, { ...snapshot, headOid: "head-4" }, { ...file, headOid: "head-4" })).toEqual({ side: "RIGHT", start: 45, end: 48 });
    expect(githubReviewAnchor(thread, snapshot, { ...file, headOid: "head-2" })).toBeNull();
  });
  it("maps base-side ranges and renamed paths only on the base side", () => {
    const renamed = { ...file, path: "src/auth.ts", oldPath: thread.path };
    expect(githubReviewAnchor({ ...thread, diffSide: "LEFT", startLine: 40, startDiffSide: "LEFT" }, snapshot, renamed)).toEqual({ side: "LEFT", start: 40, end: 42 });
    expect(githubReviewAnchor(thread, snapshot, renamed)).toBeNull();
    expect(githubReviewAnchor(thread, snapshot, { ...file, baseOid: "wrong-base" })).toBeNull();
  });
  it("retains outdated labels without anchoring missing, stale, or invalid ranges", () => {
    expect(githubReviewLocation({ ...thread, isOutdated: true, line: null })).toBe("src/login.ts:12 (head, original)");
    for (const change of [{ isOutdated: true }, { line: null }, { line: 101 }, { line: 0 }, { startLine: 50 }, { startLine: 40, startDiffSide: "LEFT" as const }]) {
      expect(githubReviewAnchor({ ...thread, ...change }, snapshot, file)).toBeNull();
    }
    expect(githubReviewAnchor(thread, snapshot, { ...file, path: "other.ts" })).toBeNull();
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
    const draft = githubReviewDraft({ ...thread, isOutdated: true, comments: [...thread.comments, { ...thread.comments[0], author: null, body: "Second\nreply" }] }, snapshot.url);
    expect(draft).toContain("src/login.ts:12 (head, original) · Outdated");
    expect(draft).toContain(snapshot.url);
    expect(draft).toContain("untrusted reviewer text");
    expect(draft).toContain("@reviewer:\n> Use the session token.");
    expect(draft).toContain("@deleted-user:\n> Second\n> reply");
  });
});

it("uses the first surviving comment's recorded hunk when the original author deleted their comment", () => {
  const surviving = { ...thread, comments: [{ ...thread.comments[0], id: "surviving-reply", diffHunk: "@@ -12 +12 @@\n-old\n+surviving code" }] };
  expect(reviewBody("```suggestion\nreplacement\n```", surviving)[0]).toMatchObject({ before: "surviving code" });
});


describe("PR file snapshot cache", () => {
  it("shares every page across concurrent file switches and revisits, with exact names before renames", async () => {
    const renamed = { ...reviewFile, path: "new.ts", oldPath: reviewFile.path };
    const load = vi.fn().mockResolvedValue([renamed, reviewFile]);
    const read = reviewFileReader(load);
    const [one, two] = await Promise.all([read(reviewFile.path, snapshot), read("new.ts", snapshot)]);
    expect(one).toEqual(reviewFile);
    expect(two).toEqual(renamed);
    expect(await read(reviewFile.path, snapshot)).toEqual(reviewFile);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await read("gone.ts", snapshot)).toMatchObject({ path: "gone.ts", changed: false, patch: null });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads fresh pages after either revision moves, without caching failed reads", async () => {
    const load = vi.fn().mockResolvedValue([reviewFile]);
    const read = reviewFileReader(load);
    await read(reviewFile.path, snapshot);
    const next = { ...snapshot, headOid: "head-4" };
    load.mockRejectedValueOnce(new Error("rate limited"));
    await expect(read(reviewFile.path, next)).rejects.toThrow("rate limited");
    load.mockResolvedValue([{ ...reviewFile, headOid: next.headOid }]);
    await expect(read(reviewFile.path, next)).resolves.toMatchObject({ headOid: "head-4" });
    load.mockResolvedValue([{ ...reviewFile, headOid: next.headOid, baseOid: "base-2" }]);
    await read(reviewFile.path, { ...next, baseOid: "base-2" });
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("refuses a mismatched snapshot and keeps independent PRs isolated", async () => {
    const load = vi.fn().mockResolvedValue([{ ...reviewFile, headOid: "other" }]);
    const read = reviewFileReader(load);
    await expect(read(reviewFile.path, snapshot)).rejects.toThrow("pull request changed");
    load.mockResolvedValue([reviewFile]);
    await read(reviewFile.path, snapshot);
    await reviewFileReader(load)(reviewFile.path, snapshot);
    expect(load).toHaveBeenCalledTimes(3);
  });
});


it("does not let an old snapshot's failed request discard a newer file cache", async () => {
  let fail!: (error: Error) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValue([reviewFile]);
  const read = reviewFileReader(load);
  const old = read(reviewFile.path, { ...snapshot, headOid: "old" });
  const oldError = expect(old).rejects.toThrow("old failed");
  await read(reviewFile.path, snapshot);
  fail(new Error("old failed"));
  await oldError;
  expect(await read(reviewFile.path, snapshot)).toEqual(reviewFile);
  expect(load).toHaveBeenCalledTimes(2);
});
