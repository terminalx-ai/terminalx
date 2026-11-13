import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewComment } from "@/lib/reviewComments";
import type { GitSource } from "@/lib/gitSource";
import { reviewSnapshot as snapshot, reviewThread as thread } from "@/test/reviewThreads";
import { githubThreadComment, registerReviewPr, requestThreadJump, useThreadFocus, useWatchThreads, type ReviewThreadAccess } from "@/lib/reviewThreads";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: [] }) }));
const { DiffPane } = await import("./DiffPane");
const { ReviewCommentsProvider } = await import("./ReviewComments");

const base = "b".repeat(40);
// The thread's recorded hunk puts its code after "context" and "new"; the local tree has moved it to line 42.
const after = [...Array.from({ length: 39 }, (_, i) => `line ${i + 1}`), "context", "new", "const token = legacy.token;", "return token;"].join("\n");
const before = [...Array.from({ length: 39 }, (_, i) => `line ${i + 1}`), "context", "old", "const token = legacy.token;", "return token;"].join("\n");
let n = 0;
let workspace: string;
let stop: () => void;
const read = vi.fn();

function Watch() { useWatchThreads(workspace, true); return null; }
function Focus() { return <output data-testid="focus">{useThreadFocus(workspace)?.threadId ?? ""}</output>; }

beforeEach(() => {
  workspace = `local:/diff-${++n}`;
  read.mockReset().mockResolvedValue({ ...snapshot, threads: [thread, { ...thread, id: "outdated", isOutdated: true, line: null }] });
  stop = registerReviewPr(workspace, { url: snapshot.url, number: 14, state: "OPEN", canWrite: true, tabId: "tab", errorMessage: String,
    access: { read, file: vi.fn(), resolve: vi.fn(), reply: vi.fn() } as ReviewThreadAccess });
  invoke.mockResolvedValue([] as ReviewComment[]);
});
afterEach(() => { cleanup(); stop(); });

it("turns a current thread into a line comment of kind github, anchored by its recorded code", () => {
  const comment = githubThreadComment(thread, { path: thread.path, base });
  expect(comment).toMatchObject({ id: "github:thread-1", side: "after", base, startLine: 42, endLine: 42, lineText: "const token = legacy.token;",
    contextBefore: ["context", "new"], author: { kind: "github", login: "reviewer", threadId: "thread-1" } });
  expect(githubThreadComment({ ...thread, diffSide: "LEFT", originalLine: 11 }, { path: thread.path, base })).toMatchObject({ side: "before", lineText: "old" });
  expect(githubThreadComment({ ...thread, isOutdated: true }, { path: thread.path, base })).toBeNull();
  expect(githubThreadComment(thread, { path: "other.ts", base })).toBeNull();
});

for (const mode of ["unified", "split"] as const) {
  it(`draws the thread inline in the ${mode} Changes diff on its line, with outdated ones listed under it`, async () => {
    render(<><Watch /><ReviewCommentsProvider source={{ key: workspace, canWrite: true, fileContentsAt: vi.fn() } as unknown as GitSource} tabId="tab">
      <DiffPane workspace={workspace} base={base} path={thread.path} before={before} after={after} mode={mode} />
    </ReviewCommentsProvider></>);
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.diff-pane article[data-review-thread="thread-1"]');
      expect(el).not.toBeNull(); return el!;
    });
    // The shared widget mounts right after the commented line.
    const widget = card.parentElement!.parentElement!;
    expect(widget.previousElementSibling?.textContent).toContain("const token = legacy.token;");
    expect(within(card).getByText("reviewer")).toBeTruthy();
    expect(within(card).getByText("on GitHub · line 42")).toBeTruthy();
    expect(within(card).getByText("Use the session token.")).toBeTruthy();
    expect(within(card).getByLabelText("Suggestion diff").textContent).toBe("-const token = legacy.token;+const token = session.token;");
    const listed = within(screen.getByRole("region", { name: "Threads without a current diff line" })).getByRole("article");
    expect(listed.getAttribute("data-review-thread")).toBe("outdated");
    expect(within(listed).getByText("Outdated")).toBeTruthy();
  });
}

it("draws threads without a review-comment provider, and focuses the one a Checks row jumps to", async () => {
  render(<><Watch /><Focus /><DiffPane workspace={workspace} base={base} path={thread.path} before={before} after={after} mode="unified" /></>);
  const card = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.diff-pane article[data-review-thread="thread-1"]');
    expect(el).not.toBeNull(); return el!;
  });
  const scroll = vi.fn();
  card.scrollIntoView = scroll;
  act(() => { requestThreadJump(workspace, thread); });
  await waitFor(() => expect(document.activeElement).toBe(card));
  expect(scroll).toHaveBeenCalledWith({ block: "center" });
  expect(screen.getByTestId("focus").textContent).toBe("");
});
