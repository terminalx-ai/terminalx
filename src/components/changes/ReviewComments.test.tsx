import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewComment } from "@/lib/reviewComments";
import type { GitSource } from "@/lib/gitSource";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke }));
import { ReviewCommentsProvider } from "./ReviewComments";
import { DiffPane } from "./DiffPane";
import { getDraft, setDraft } from "@/lib/drafts";
import { FileList } from "./FileList";
let comments: ReviewComment[];
let id = 0;
const source = (key: string) => ({ key, cloud: false, canWrite: true,
  reviewRange: vi.fn(async () => ({ base: "base", head: "head", target: "main" })),
  changesBetween: vi.fn(async () => []),
  fileContentsAt: vi.fn(async () => ({ before: "old", after: "new" })),
} as unknown as GitSource);
beforeEach(() => {
  comments = []; setDraft("review-tab", "");
  invoke.mockImplementation(async (_command, { action }) => {
    if (action.type === "save") {
      if (action.expected) comments = comments.map((c) => c.id === action.expected.id ? { ...c, note: action.note, revision: c.revision + 1, sent: false } : c);
      else comments.push({ ...action.anchor, id: `${++id}`, revision: 1, note: action.note, sent: false, outdated: false });
    } else if (action.type === "delete") comments = comments.filter((c) => c.id !== action.expected.id);
    else if (action.type === "reconcile") comments = comments.map((c) => ({ ...c, outdated: c.outdated || action[c.side]?.split("\n").slice(c.startLine - 1, c.endLine).join("\n") !== c.lineText }));
    return [...comments];
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
for (const mode of ["unified", "split"] as const) {
  it(`saves a ${mode} deleted range inline, edits it, appends a draft and deletes it`, async () => {
    const s = source(`range-${mode}`);
    s.fileContentsAt = vi.fn(async () => ({ before: "one\nold\nremoved", after: "one\nnew" }));
    render(<ReviewCommentsProvider source={s} tabId="review-tab"><div style={{ height: 500 }}><DiffPane path="a.ts" before={"one\nold\nremoved"} after={"one\nnew"} mode={mode} /></div><FileList files={[{ path: "a.ts", status: "modified", additions: 1, deletions: 2 }]} selected={null} onSelect={() => {}} empty="" /></ReviewCommentsProvider>);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Comment on before line 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment on before line 3" }), { shiftKey: true });
    expect(screen.getByText("a.ts:2-3 (before)")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Keep the old behavior" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Review comment" })).toBeNull());
    expect(comments[0]).toMatchObject({ side: "before", startLine: 2, endLine: 3, lineText: "old\nremoved" });
    const inline = await waitFor(() => { const article = document.querySelector(".diff-pane article"); expect(article).not.toBeNull(); return article as HTMLElement; });
    expect(within(inline).getByText("Keep the old behavior")).toBeTruthy();
    expect(screen.getByText("1 comment")).toBeTruthy();
    fireEvent.click(within(inline).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Keep both lines" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(comments[0].note).toBe("Keep both lines"));
    setDraft("review-tab", "Existing request");
    fireEvent.click(screen.getByRole("button", { name: "Add all to chat (1)" }));
    expect(getDraft("review-tab")).toBe("Existing request\n\na.ts:2-3 (before)\n> old\n> removed\n\nKeep both lines");
    expect(comments[0].sent).toBe(false);
    fireEvent.click(within(inline).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(document.querySelector(".diff-pane article")).toBeNull());
  });
}
it("warns before discarding edits and keeps them when declined", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<ReviewCommentsProvider source={source("discard")} tabId="review-tab"><DiffPane path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Comment on after line 1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Unfinished" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(confirm).toHaveBeenCalledWith("Discard this unsaved review comment?");
  expect((screen.getByRole("textbox", { name: "Review comment" }) as HTMLTextAreaElement).value).toBe("Unfinished");
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("textbox", { name: "Review comment" })).toBeNull();
});
it("keeps saved quotes and displays Outdated when the selected lines change", async () => {
  const s = source("outdated");
  const view = render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Comment on after line 1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Rename" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Review comment" })).toBeNull());
  s.fileContentsAt = vi.fn(async () => ({ before: "old", after: "changed" }));
  view.rerender(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane path="a" before="old" after="changed" mode="unified" /></ReviewCommentsProvider>);
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(comments[0].outdated).toBe(true));
  const inline = await waitFor(() => { const el = document.querySelector(".diff-pane article"); expect(el?.textContent).toContain("Outdated"); return el as HTMLElement; });
  expect(within(inline).getByText("new")).toBeTruthy();
});
it("keeps an unsaved draft across a file switch and reopening the panel", async () => {
  const s = source("retained");
  const view = render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Comment on after line 1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Keep me" } });
  view.unmount();
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane path="b" before="x" after="y" mode="split" /></ReviewCommentsProvider>);
  expect((screen.getByRole("textbox", { name: "Review comment" }) as HTMLTextAreaElement).value).toBe("Keep me");
  expect(screen.getByText("a:1 (after)")).toBeTruthy();
});
it("uses the live workspace for Outdated, even while a historical diff is displayed", async () => {
  comments = [{ id: "current", revision: 1, path: "a", side: "after", startLine: 1, endLine: 1, lineText: "new", note: "Current note", sent: false, outdated: false }];
  const s = source("history-does-not-invalidate");
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane path="a" before="ancient" after="historic" mode="unified" /></ReviewCommentsProvider>);
  await waitFor(() => expect(s.fileContentsAt).toHaveBeenCalledWith("a", "base", null));
  await waitFor(() => expect(document.querySelector(".diff-pane article")?.textContent).toContain("Current note"));
  expect(comments[0].outdated).toBe(false);
});
it("reconciles a disappeared file without opening it and retains its comment in the inventory", async () => {
  comments = [{ id: "gone", revision: 1, path: "gone.ts", side: "after", startLine: 1, endLine: 1, lineText: "gone", note: "Keep this note", sent: false, outdated: false }];
  const s = source("removed-file");
  s.fileContentsAt = vi.fn(async () => ({ before: null, after: null }));
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><p>No changed files</p></ReviewCommentsProvider>);
  await waitFor(() => expect(comments[0].outdated).toBe(true));
  // The details element's actual open state governs rendering, as in the browser.
  const details = screen.getByText("All review comments").parentElement as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(await screen.findByText("Keep this note")).toBeTruthy();
  expect(screen.getByText("Outdated")).toBeTruthy();
});
it("keeps the original tree and renamed path for notes on HEAD or a historical old side", async () => {
  const base = "a".repeat(40);
  comments = [{ id: "before", revision: 1, path: "new.ts", originalPath: "old.ts", base, side: "before", startLine: 1, endLine: 1, lineText: "from HEAD", note: "Keep this", sent: false, outdated: false }];
  const s = source("before-tree");
  s.fileContentsAt = vi.fn(async (path, tree) => ({ before: path === "old.ts" && tree === base ? "from HEAD" : "merge base", after: "current work" }));
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><p>Different scope</p></ReviewCommentsProvider>);
  await waitFor(() => expect(s.fileContentsAt).toHaveBeenCalledWith("old.ts", base, null));
  expect(comments[0].outdated).toBe(false);
});
for (const mode of ["unified", "split"] as const) it(`keeps a comment inside collapsed unchanged context visible in ${mode}`, async () => {
  const before = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 60", "changed 60");
  comments = [{ id: "context", revision: 1, path: "a", side: "after", startLine: 20, endLine: 20, lineText: "line 20", note: "Visible in context", sent: false, outdated: false }];
  const s = source(`collapsed-${mode}`);
  s.fileContentsAt = vi.fn(async () => ({ before, after }));
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane path="a" before={before} after={after} mode={mode} /></ReviewCommentsProvider>);
  await waitFor(() => expect(document.querySelector(".diff-pane article")?.textContent).toContain("Visible in context"));
  expect(screen.getByRole("button", { name: "Comment on after line 20" })).toBeTruthy();
  if (mode === "split") expect(screen.getByRole("button", { name: "Comment on before line 20" })).toBeTruthy();
});
