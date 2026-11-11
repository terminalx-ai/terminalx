import { beforeEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => []) }));
vi.mock("@/lib/api", () => ({ invoke }));
import { addReviewsToChat, captureReviewSend, markReviewsSent, moveReviewRanges, restoreReviewSend, reviewDraft, reviewEntry, type ReviewComment } from "./reviewComments";
import { getDraft, setDraft } from "./drafts";
const comment = (props: Partial<ReviewComment> = {}): ReviewComment => ({ id: "c1", revision: 1, path: "src/a.ts", side: "after", startLine: 2, endLine: 3, lineText: "const old = 1;\nold++;", note: "Rename old.\nKeep the increment.", sent: false, outdated: false, ...props });
beforeEach(() => { invoke.mockClear(); setDraft("tab", ""); });

describe("review draft", () => {
  it("includes reviewer attribution and sends the shared record's revision", async () => {
    const agent = comment({ author: { kind: "agent", role: "reviewer", sessionId: "review", tabId: "review-tab", name: "Reviewer" } });
    addReviewsToChat("local:/repo", "tab", [agent]);
    expect(getDraft("tab")).toContain("src/a.ts:2-3 (after)\nReviewer agent: Reviewer\n> const old = 1;");
    await markReviewsSent(captureReviewSend("tab", getDraft("tab")));
    expect(invoke).toHaveBeenCalledWith("review_comments", { workspace: "local:/repo", action: { type: "sent", comments: [{ id: "c1", revision: 1 }] } });
  });
  it("quotes every original line, identifies side and range, and retains literal note text", () => {
    expect(reviewDraft([comment()])).toBe("src/a.ts:2-3 (after)\n> const old = 1;\n> old++;\n\nRename old.\nKeep the increment.");
    expect(reviewEntry(comment({ side: "before", base: "abcdef1234567890", startLine: 3, outdated: true, lineText: "`</script>`" }))).toContain("src/a.ts:3 (before at abcdef123456, outdated)\n> `</script>`");
  });
  it("includes every unsent comment in file and line order without changing the input", () => {
    const comments = [comment({ id: "z", path: "z.ts" }), comment({ id: "a2", startLine: 20, endLine: 20 }), comment({ id: "sent", sent: true }), comment({ id: "a1", outdated: true })];
    const text = reviewDraft(comments);
    expect(text.indexOf("src/a.ts:2-3")).toBeLessThan(text.indexOf("src/a.ts:20"));
    expect(text.indexOf("src/a.ts:20")).toBeLessThan(text.indexOf("z.ts:2-3"));
    expect(text.match(/Rename old/g)).toHaveLength(3);
    expect(comments[0].id).toBe("z");
  });
  it("appends to existing prose, deduplicates repeated Add, and only marks after success", async () => {
    setDraft("tab", "Please also run tests.");
    addReviewsToChat("w", "tab", [comment()]);
    addReviewsToChat("w", "tab", [comment()]);
    const text = getDraft("tab");
    expect(text).toBe(`Please also run tests.\n\n${reviewEntry(comment())}`);
    const receipts = captureReviewSend("tab", text);
    expect(receipts).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
    setDraft("tab", "");
    await markReviewsSent(receipts);
    expect(invoke).toHaveBeenCalledWith("review_comments", { workspace: "w", action: { type: "sent", comments: [{ id: "c1", revision: 1 }] } });
  });
  it("follows note edits and prefix edits, but not a removed entry", () => {
    addReviewsToChat("w", "tab", [comment(), comment({ id: "c2", path: "z.ts" })]);
    setDraft("tab", `A prefix.\n${getDraft("tab").replace("Rename old.", "Use a descriptive name.")}`);
    expect(captureReviewSend("tab", getDraft("tab")).map((c) => c.id)).toEqual(["c1", "c2"]);
    setDraft("tab", getDraft("tab").split("\n\nz.ts:")[0]);
    expect(captureReviewSend("tab", getDraft("tab")).map((c) => c.id)).toEqual(["c1"]);
    setDraft("tab", "different request");
    expect(captureReviewSend("tab", getDraft("tab"))).toEqual([]);
  });
  it("restores receipt ownership on a failed send without marking anything", () => {
    addReviewsToChat("w", "tab", [comment()]);
    const text = getDraft("tab");
    const receipts = captureReviewSend("tab", text);
    setDraft("tab", "");
    setDraft("tab", `${text}\n\nnew draft`);
    restoreReviewSend("tab", text, receipts);
    expect(captureReviewSend("tab", getDraft("tab"))).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("keeps receipts scoped to workspace and tab, including identical comment IDs", async () => {
    setDraft("other", "");
    addReviewsToChat("one", "tab", [comment()]);
    addReviewsToChat("two", "other", [comment()]);
    await markReviewsSent(captureReviewSend("tab", getDraft("tab")));
    expect(invoke.mock.calls.map((c) => (c as unknown as [string, { workspace: string }])[1].workspace)).toEqual(["one"]);
  });
  it("keeps trimmed sends and drops a replaced location sharing the same prefix", () => {
    setDraft("tab", "  ");
    addReviewsToChat("w", "tab", [comment()]);
    setDraft("tab", getDraft("tab") + "  ");
    expect(captureReviewSend("tab", getDraft("tab").trim())).toHaveLength(1);
    setDraft("tab", "  src/other.ts:10 (after)\n> different\n\nA new request  ");
    expect(captureReviewSend("tab", getDraft("tab").trim())).toHaveLength(0);
  });
  it("shifts ranges at an insertion boundary and removes a whole replacement", () => {
    const entry = { id: "id", revision: 1, workspace: "w", from: 3, to: 6 };
    expect(moveReviewRanges("abcDEF", "abcXDEF", [entry])[0]).toMatchObject({ from: 4, to: 7 });
    expect(moveReviewRanges("abcDEF", "abcXYZ", [entry])).toEqual([]);
  });
});

it("caps long quotes by lines and characters while retaining the location and note", () => {
  const long = reviewEntry(comment({ lineText: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") }));
  expect(long).toContain("> line 19\n> … (30 more lines omitted)");
  expect(long).not.toContain("> line 20");
  const minified = reviewEntry(comment({ lineText: "x".repeat(100000) }));
  expect(minified.length).toBeLessThan(4200);
  expect(minified).toContain("remaining text omitted");
  expect(minified).toContain("Rename old.");
});
