import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { GitHubReviewPatchPane } from "./GitHubReviewPatchPane";
import { reviewThread as thread, reviewSnapshot as snapshot, reviewFile as file } from "@/test/reviewThreads";
import { reviewPatch, splitReviewRows } from "@/lib/reviewPatch";
import type { ReviewThread } from "@/lib/reviewThreads";

afterEach(cleanup);
const renderThread = (thread: ReviewThread) => <article>{thread.id}{thread.isOutdated ? " Outdated" : ""}</article>;

it("places current head and base-side threads under their exact split diff lines", () => {
  render(<GitHubReviewPatchPane mode="split" review={{ file, snapshot: { ...snapshot, threads: [thread, { ...thread, id: "base-thread", diffSide: "LEFT", line: 41 }] }, renderThread }} />);
  const current = screen.getByText("thread-1").closest("[data-review-line]")!;
  expect(current.getAttribute("data-review-line")).toBe("42");
  expect(current.getAttribute("data-review-side")).toBe("RIGHT");
  const base = screen.getByText("base-thread").closest("[data-review-line]")!;
  expect(base.getAttribute("data-review-line")).toBe("41");
  expect(base.getAttribute("data-review-side")).toBe("LEFT");
  expect(base.closest("td")?.cellIndex).toBe(0);
  expect(current.closest("td")?.cellIndex).toBe(1);
});

it("moves anchors after pushes and keeps outdated threads visible without guessing a line", () => {
  const view = render(<GitHubReviewPatchPane mode="unified" review={{ file, snapshot, renderThread }} />);
  expect(screen.getByText(thread.id).closest("[data-review-line]")?.getAttribute("data-review-line")).toBe("42");
  const next = { ...snapshot, headOid: "head-4", threads: [{ ...thread, line: 52 }, { ...thread, id: "old-thread", isOutdated: true, line: null }] };
  view.rerender(<GitHubReviewPatchPane mode="unified" review={{ file: { ...file, headOid: "head-4", patch: file.patch!.replaceAll("40,3", "50,3") }, snapshot: next, renderThread }} />);
  expect(screen.getByText(thread.id).closest("[data-review-line]")?.getAttribute("data-review-line")).toBe("52");
  const old = screen.getByText("old-thread Outdated");
  expect(old.closest("[data-review-line]")).toBeNull();
  expect(old.closest("section")?.getAttribute("aria-label")).toBe("Threads without a current diff line");
});

it("refuses stale or truncated patches, but retains all discussions", () => {
  const view = render(<GitHubReviewPatchPane mode="split" review={{ file: { ...file, headOid: "wrong-head" }, snapshot, renderThread }} />);
  expect(screen.getByText(thread.id).closest("[data-review-line]")).toBeNull();
  view.rerender(<GitHubReviewPatchPane mode="unified" review={{ file: { ...file, patch: "@@ -40,4 +40,4 @@\n context\n context\n line" }, snapshot, renderThread }} />);
  expect(screen.getByRole("alert").textContent).toContain("incomplete diff");
  expect(screen.getByText(thread.id).closest("[data-review-line]")).toBeNull();
});

it("parses multiple hunks, additions, deletions, and missing-newline markers", () => {
  const parsed = reviewPatch("@@ -0,0 +1,2 @@\n+one\n+two\n@@ -10,2 +12,0 @@\n-old\n-older\n\\ No newline at end of file");
  expect(parsed.complete).toBe(true);
  expect(parsed.rows.filter((row) => row.kind === "add").map((row) => row.newNo)).toEqual([1, 2]);
  expect(parsed.rows.filter((row) => row.kind === "del").map((row) => row.oldNo)).toEqual([10, 11]);
  expect(splitReviewRows(reviewPatch(file.patch!).rows)[2]).toMatchObject({ left: { kind: "del", oldNo: 41 }, right: { kind: "add", newNo: 41 } });
});


it("distinguishes reverted files from unavailable binary patches", () => {
  const view = render(<GitHubReviewPatchPane mode="unified" review={{ file: { ...file, patch: null, changed: false }, snapshot, renderThread }} />);
  expect(screen.getByText("This file is no longer changed in the PR.")).toBeTruthy();
  expect(screen.getByText(thread.id)).toBeTruthy();
  view.rerender(<GitHubReviewPatchPane mode="unified" review={{ file: { ...file, patch: null }, snapshot, renderThread }} />);
  expect(screen.getByText("GitHub has no text diff for this file at the current PR head.")).toBeTruthy();
});
