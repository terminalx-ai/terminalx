import { locateReview } from "@/lib/reviewAnchors";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/icons", () => new Proxy({}, { has: () => true, get: (_, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : prop === "__esModule" ? true : (props: Record<string, unknown>) => <svg {...props} />) }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: import("react").ReactNode }) => children,
  WithTooltip: ({ children }: { children: import("react").ReactNode }) => children,
  Tooltip: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipContent: () => null,
  Kbd: ({ children }: { children: import("react").ReactNode }) => <kbd data-slot="kbd">{children}</kbd>,
  KbdGroup: ({ keys }: { keys: string[] }) => <span data-slot="kbd">{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span>,
}));
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
const base = "a".repeat(40);
const source = (key: string) => ({ key, cloud: false, canWrite: true,
  reviewRange: vi.fn(async () => ({ base, head: "head", target: "main" })),
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
    else if (action.type === "reconcile") comments = comments.map((c) => {
      if (c.base !== action.base || c.path !== action.path) return c;
      const location = locateReview(c, action[c.side]);
      return { ...c, outdated: location.outdated, startLine: location.startLine ?? c.startLine, endLine: location.endLine ?? c.endLine };
    });
    return [...comments];
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
for (const mode of ["unified", "split", "entire"] as const) {
  it(`shows a reviewer agent's shared-store record on its ${mode} lines and adds it with user notes to chat`, async () => {
    const after = "first\nsecond\nthird";
    const s = source(`local:/reviewer-${mode}`);
    s.fileContentsAt = vi.fn(async () => ({ before: "first\nold", after }));
    comments = [
      { id: "agent", revision: 1, base, path: "foo.ts", side: "after", startLine: 2, endLine: 3, lineText: "second\nthird", note: "Validate this range.", sent: false, outdated: false,
        author: { kind: "agent", role: "reviewer", name: "Reviewer", sessionId: "session", tabId: "reviewer-tab" } },
      { id: "user", revision: 1, base, path: "foo.ts", side: "after", startLine: 1, endLine: 1, lineText: "first", note: "User note", sent: false, outdated: false },
    ];
    render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="foo.ts" before={"first\nold"} after={after} mode={mode} /></ReviewCommentsProvider>);
    const inline = await waitFor(() => {
      const el = document.querySelector('.diff-pane article[aria-label="Comment on foo.ts:2-3"]');
      expect(el).not.toBeNull(); return el as HTMLElement;
    });
    expect(within(inline).getByText("Reviewer")).toBeTruthy();
    expect(within(inline).getByText("Validate this range.")).toBeTruthy();
    expect(inline.parentElement?.previousElementSibling?.textContent).toContain("third");
    fireEvent.click(screen.getByRole("button", { name: "Add all to chat (2)" }));
    expect(getDraft("review-tab")).toBe("foo.ts:1 (after)\n> first\n\nUser note\n\nfoo.ts:2-3 (after)\nReviewer agent: Reviewer\n> second\n> third\n\nValidate this range.");
    expect(comments.every((comment) => !comment.sent)).toBe(true);
  });
}
for (const mode of ["unified", "split"] as const) {
  it(`saves a ${mode} deleted range inline, edits it, appends a draft and deletes it`, async () => {
    const s = source(`range-${mode}`);
    s.fileContentsAt = vi.fn(async () => ({ before: "one\nold\nremoved", after: "one\nnew" }));
    render(<ReviewCommentsProvider source={s} tabId="review-tab"><div style={{ height: 500 }}><DiffPane base={base} path="a.ts" before={"one\nold\nremoved"} after={"one\nnew"} mode={mode} /></div><FileList base={base} files={[{ path: "a.ts", status: "modified", additions: 1, deletions: 2 }]} selected={null} onSelect={() => {}} empty="" /></ReviewCommentsProvider>);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Comment on before line 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment on before line 3" }), { shiftKey: true });
    // The draft is written under its lines (PRO-392), not in a form above the diff.
    const draft = await waitFor(() => { const el = document.querySelector<HTMLElement>('.diff-pane form[aria-label="Review comment draft"]'); expect(el).not.toBeNull(); return el!; });
    expect(within(draft).getByText("lines 2–3 (before) · comment for the agent")).toBeTruthy();
    expect(within(draft).getByText("Draft · not saved")).toBeTruthy();
    fireEvent.change(within(draft).getByRole("textbox", { name: "Review comment" }), { target: { value: "Keep the old behavior" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Review comment" })).toBeNull());
    expect(comments[0]).toMatchObject({ side: "before", startLine: 2, endLine: 3, lineText: "old\nremoved" });
    const inline = await waitFor(() => { const article = document.querySelector(".diff-pane article"); expect(article).not.toBeNull(); return article as HTMLElement; });
    expect(within(inline).getByText("Keep the old behavior")).toBeTruthy();
    expect(screen.getByText("1 comment")).toBeTruthy();
    expect(within(inline).getByText("Draft")).toBeTruthy();
    expect(within(inline).getByText("on lines 2–3 (before)")).toBeTruthy();
    fireEvent.click(within(inline).getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Review comment" }), { target: { value: "Keep both lines" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(comments[0].note).toBe("Keep both lines"));
    setDraft("review-tab", "Existing request");
    fireEvent.click(screen.getByRole("button", { name: "Add all to chat (1)" }));
    expect(getDraft("review-tab")).toBe("Existing request\n\na.ts:2-3 (before at aaaaaaaaaaaa)\n> old\n> removed\n\nKeep both lines");
    expect(comments[0].sent).toBe(false);
    const saved = await waitFor(() => { const article = document.querySelector<HTMLElement>(".diff-pane article"); expect(article).not.toBeNull(); return article!; });
    fireEvent.click(within(saved).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(document.querySelector(".diff-pane article")).toBeNull());
  });
}
it("asks in the draft before discarding edits and keeps them when declined", async () => {
  const confirm = vi.spyOn(window, "confirm");
  render(<ReviewCommentsProvider source={source("discard")} tabId="review-tab"><DiffPane base={base} path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Comment on after line 1" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Review comment" }), { target: { value: "Unfinished" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  // An in-app popover anchored to the draft (PRO-392), never the browser's confirm.
  const ask = screen.getByRole("alertdialog", { name: "Discard this comment?" });
  expect(ask.textContent).toContain("What you wrote on line 1 will be lost. It hasn't been sent to the agent.");
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Review comment" }) as HTMLTextAreaElement).value).toBe("Unfinished");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Review comment" }), { key: "Escape" });
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Review comment" })).toBeNull());
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Comment on after line 1"));
});
it("keeps saved quotes and displays Outdated when the selected lines change", async () => {
  const s = source("outdated");
  const view = render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Comment on after line 1" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Review comment" }), { target: { value: "Rename" } });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Review comment" })).toBeNull());
  s.fileContentsAt = vi.fn(async () => ({ before: "old", after: "changed" }));
  view.rerender(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before="old" after="changed" mode="unified" /></ReviewCommentsProvider>);
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(comments[0].outdated).toBe(true));
  expect(document.querySelector(".diff-pane article")).toBeNull();
  const details = screen.getByText("All review comments").parentElement as HTMLDetailsElement;
  details.open = true; fireEvent(details, new Event("toggle"));
  expect(await screen.findByText("Outdated")).toBeTruthy();
  // The note is shown without a quote of its line (PRO-392).
  expect(screen.getByText("Rename")).toBeTruthy();
});
it("keeps an unsaved draft across a file switch and reopening the panel", async () => {
  const s = source("retained");
  const view = render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Comment on after line 1" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Review comment" }), { target: { value: "Keep me" } });
  view.unmount();
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="b" before="x" after="y" mode="split" /></ReviewCommentsProvider>);
  // Its line is not in this diff: it is kept above it.
  expect(((await screen.findByRole("textbox", { name: "Review comment" })) as HTMLTextAreaElement).value).toBe("Keep me");
  expect(screen.getByText("a:1 (after)")).toBeTruthy();
});
it("uses the live workspace for Outdated, even while a historical diff is displayed", async () => {
  comments = [{ id: "current", revision: 1, base, path: "a", side: "after", startLine: 1, endLine: 1, lineText: "new", note: "Current note", sent: false, outdated: false }];
  const s = source("history-does-not-invalidate");
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before="ancient" after="historic" mode="unified" /></ReviewCommentsProvider>);
  await waitFor(() => expect(s.fileContentsAt).toHaveBeenCalledWith("a", base, null));
  expect(document.querySelector(".diff-pane article")).toBeNull();
  expect(comments[0].outdated).toBe(false);
});
it("reconciles a disappeared file without opening it and retains its comment in the inventory", async () => {
  comments = [{ id: "gone", revision: 1, base, path: "gone.ts", side: "after", startLine: 1, endLine: 1, lineText: "gone", note: "Keep this note", sent: false, outdated: false }];
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
  comments = [{ id: "before", revision: 1, base, path: "new.ts", originalPath: "old.ts", side: "before", startLine: 1, endLine: 1, lineText: "from HEAD", note: "Keep this", sent: false, outdated: false }];
  const s = source("before-tree");
  s.fileContentsAt = vi.fn(async (path, tree) => ({ before: path === "old.ts" && tree === base ? "from HEAD" : "merge base", after: "current work" }));
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><p>Different scope</p></ReviewCommentsProvider>);
  await waitFor(() => expect(s.fileContentsAt).toHaveBeenCalledWith("old.ts", base, null));
  expect(comments[0].outdated).toBe(false);
});
for (const mode of ["unified", "split"] as const) it(`keeps a comment inside collapsed unchanged context visible in ${mode}`, async () => {
  const before = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 60", "changed 60");
  comments = [{ id: "context", revision: 1, base, path: "a", side: "after", startLine: 20, endLine: 20, lineText: "line 20", note: "Visible in context", sent: false, outdated: false }];
  const s = source(`collapsed-${mode}`);
  s.fileContentsAt = vi.fn(async () => ({ before, after }));
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before={before} after={after} mode={mode} /></ReviewCommentsProvider>);
  await waitFor(() => expect(document.querySelector(".diff-pane article")?.textContent).toContain("Visible in context"));
  expect(screen.getByRole("button", { name: "Comment on after line 20" })).toBeTruthy();
  if (mode === "split") expect(screen.getByRole("button", { name: "Comment on before line 20" })).toBeTruthy();
});

it("relocates inline after an insertion and does not attach in another base", async () => {
  comments = [{ id: "shift", revision: 1, base, path: "a", side: "after", startLine: 2, endLine: 2, lineText: "target", contextBefore: ["one"], contextAfter: ["last"], note: "Move with the code", sent: false, outdated: false }];
  const s = source("shift");
  s.fileContentsAt = vi.fn(async () => ({ before: "old", after: "inserted\none\ntarget\nlast" }));
  const view = render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before="old" after={"inserted\none\ntarget\nlast"} mode="unified" /></ReviewCommentsProvider>);
  await waitFor(() => expect(document.querySelector(".diff-pane article")?.textContent).toContain("on line 3"));
  expect(comments[0].outdated).toBe(false);
  view.rerender(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={"b".repeat(40)} path="a" before="old" after={"inserted\none\ntarget\nlast"} mode="unified" /></ReviewCommentsProvider>);
  expect(document.querySelector(".diff-pane article")).toBeNull();
  expect(s.reviewRange).not.toHaveBeenCalled();
  expect(s.changesBetween).not.toHaveBeenCalled();
});
it("keeps before comments on the correct line when whitespace-only edits are hidden", async () => {
  const before = "    first\n    target\n    final", after = "first\ntarget\nfinal";
  comments = [{ id: "whitespace", revision: 1, base, path: "a", side: "before", startLine: 2, endLine: 2, lineText: "    target", note: "Original indentation", sent: false, outdated: false }];
  const s = source("whitespace-comments"); s.fileContentsAt = vi.fn(async () => ({ before, after }));
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before={before} after={after} mode="unified" hideWhitespace wrap={false} /></ReviewCommentsProvider>);
  const card = await waitFor(() => { const el = document.querySelector(".diff-pane article"); expect(el).not.toBeNull(); return el!; });
  expect(card.parentElement?.previousElementSibling?.textContent).toBe("target");
  expect(document.querySelector(".cm-lineWrapping")).toBeNull();
  expect(document.querySelector(".cm-deletedChunk")).toBeNull();
});
it("shows only one editor when Changes and the centre diff share a workspace", async () => {
  const s = source("two-panels");
  render(<><ReviewCommentsProvider source={s} tabId="review-tab"><p>Changes panel</p></ReviewCommentsProvider><ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider></>);
  fireEvent.click(await screen.findByRole("button", { name: "Comment on after line 1" }));
  expect(await screen.findAllByRole("textbox", { name: "Review comment" })).toHaveLength(1);
  // Drawn under its line in the centre diff, and nowhere else.
  await waitFor(() => expect(document.querySelector(".diff-pane textarea")).not.toBeNull());
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await waitFor(() => expect(screen.getAllByRole("textbox", { name: "Review comment" })).toHaveLength(1));
  fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Shared note" } });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Review comment" })).toBeNull());
  await waitFor(() => expect(screen.getAllByText("1 review comment")).toHaveLength(2));
});

it("clears a completed save after its draft moves to a reopened panel", async () => {
  const original = invoke.getMockImplementation()!;
  let finish!: () => void;
  invoke.mockImplementation((command, args) => args.action.type === "save" ? new Promise((resolve) => { finish = () => { void original(command, args).then(resolve); }; }) : original(command, args));
  const s = source("save-handoff");
  const view = render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Comment on after line 1" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Review comment" }), { target: { value: "Save across panels" } });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  view.unmount();
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><p>Reopened</p></ReviewCommentsProvider>);
  expect(await screen.findByRole("textbox", { name: "Review comment" })).toBeTruthy();
  await act(async () => finish());
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Review comment" })).toBeNull());
  expect(comments).toHaveLength(1);
});

it("numbers removed lines, marks only changed lines and saves a draft with ⌘↵ (PRO-392)", async () => {
  const s = source("gutter");
  s.fileContentsAt = vi.fn(async () => ({ before: "same\nold", after: "same\nnew" }));
  render(<ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before={"same\nold"} after={"same\nnew"} mode="unified" /></ReviewCommentsProvider>);
  await waitFor(() => expect(document.querySelector(".cm-deleted-number")?.textContent).toBe("2"));
  expect(document.querySelector(".cm-deletedLine .cm-change-del")?.textContent).toBe("−");
  const markers = [...document.querySelectorAll(".cm-change-gutter .cm-gutterElement")].map((el) => el.textContent).filter(Boolean);
  expect(markers).toEqual(["+"]);
  // Changed characters are not underlined: the line's tint is flat.
  expect(document.querySelector(".cm-changedText")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Comment on after line 2" }));
  const text = await screen.findByRole("textbox", { name: "Review comment" });
  fireEvent.change(text, { target: { value: "Name it" } });
  fireEvent.keyDown(text, { key: "Enter", metaKey: true });
  await waitFor(() => expect(comments).toHaveLength(1));
  expect(comments[0]).toMatchObject({ side: "after", startLine: 2, endLine: 2, note: "Name it" });
});

it("gives a saved comment a filled Add to chat, Add all N and quiet Edit · Delete, without quoting its line", async () => {
  comments = [
    { id: "one", revision: 1, base, path: "a", side: "after", startLine: 1, endLine: 1, lineText: "new", note: "First", sent: false, outdated: false },
    { id: "two", revision: 1, base, path: "b", side: "after", startLine: 1, endLine: 1, lineText: "other", note: "Second", sent: false, outdated: false },
  ];
  render(<ReviewCommentsProvider source={source("card")} tabId="review-tab" chrome={false}><DiffPane base={base} path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider>);
  const card = await waitFor(() => { const el = document.querySelector<HTMLElement>(".diff-pane article"); expect(el).not.toBeNull(); return el!; });
  expect(within(card).queryByText("new")).toBeNull();
  expect(within(card).getByText("on line 1")).toBeTruthy();
  expect(within(card).getByText("Draft")).toBeTruthy();
  expect(screen.queryByText("2 review comments")).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "Add all 2 comments" }));
  expect(getDraft("review-tab")).toContain("First");
  expect(getDraft("review-tab")).toContain("Second");
});

it("marks each side of a split view on its own lines when an earlier hunk shifts them", async () => {
  const before = "a\nb\nc\nx", after = "a\nnew1\nnew2\nb\nc\ny";
  render(<ReviewCommentsProvider source={source("split-markers")} tabId="review-tab"><DiffPane base={base} path="a" before={before} after={after} mode="split" /></ReviewCommentsProvider>);
  const marks = (side: "a" | "b") => [...document.querySelectorAll(`.cm-merge-${side} .cm-change-gutter .cm-gutterElement`)].map((el) => el.textContent).filter(Boolean);
  await waitFor(() => expect(marks("b")).toEqual(["+", "+", "+"]));
  // The before side's one changed line is its fourth ("x"), not the after side's 2, 3 and 6.
  expect(marks("a")).toEqual(["−"]);
});

it("asks about an unsaved draft held by a hidden tab in the panel that starts a new comment", async () => {
  const s = source("hidden-owner");
  const view = render(<>
    <div data-testid="hidden"><ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider></div>
  </>);
  const hidden = within(screen.getByTestId("hidden"));
  fireEvent.click(await hidden.findByRole("button", { name: "Comment on after line 1" }));
  fireEvent.change(await hidden.findByRole("textbox", { name: "Review comment" }), { target: { value: "Unsaved" } });
  // The tab that holds it is hidden (still mounted, inactive); another tab shows the same file.
  view.rerender(<>
    <div data-testid="hidden"><ReviewCommentsProvider source={s} tabId="review-tab" active={false}><DiffPane base={base} path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider></div>
    <div data-testid="shown"><ReviewCommentsProvider source={s} tabId="review-tab"><DiffPane base={base} path="a" before="old" after="new" mode="unified" /></ReviewCommentsProvider></div>
  </>);
  const shown = within(screen.getByTestId("shown"));
  fireEvent.click(await shown.findByRole("button", { name: "Comment on after line 1" }));
  const ask = await shown.findByRole("alertdialog", { name: "Discard this comment?" });
  expect(hidden.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(shown.getAllByRole("textbox", { name: "Review comment" })).toHaveLength(1));
  expect((shown.getByRole("textbox", { name: "Review comment" }) as HTMLTextAreaElement).value).toBe("Unsaved");
  fireEvent.click(within(ask).getByRole("button", { name: "Discard" }));
  await waitFor(() => expect((shown.getByRole("textbox", { name: "Review comment" }) as HTMLTextAreaElement).value).toBe(""));
  expect(hidden.queryByRole("textbox", { name: "Review comment" })).toBeNull();
});
