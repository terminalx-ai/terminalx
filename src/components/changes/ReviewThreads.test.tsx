import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubThreadComment, ReviewThreads, ReviewThreadCard, REVIEW_REFRESH_MS } from "./ReviewThreads";
import { reviewSnapshot as snapshot, reviewThread as thread } from "@/test/reviewThreads";
import type { GitSource } from "@/lib/gitSource";
import { onThreadJump, type ReviewThread, type ReviewThreads as Snapshot } from "@/lib/reviewThreads";
import { getDraft, setDraft } from "@/lib/drafts";
import { showError } from "@/lib/errorToasts";
import { openUrl } from "@tauri-apps/plugin-opener";

vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: [{ id: "session", activeTab: "tab" }] }) }));
vi.mock("@/lib/errorToasts", () => ({ showError: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const read = vi.fn<() => Promise<Snapshot>>();
const resolve = vi.fn();
const reply = vi.fn();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
let n = 0;
let source: GitSource;
let props: { source: GitSource; url: string; number: number; sessionId: string; active: boolean };

const resolved: ReviewThread = { ...thread, id: "thread-2", path: "src/db.ts", line: 7, isResolved: true,
  comments: [{ ...thread.comments[0], id: "c-2", author: { login: "sam" }, body: "Fixed in the last push, thanks." }] };
const second: ReviewThread = { ...thread, id: "thread-3", path: "src/api/routes.ts", line: 31, startLine: 29,
  comments: [{ ...thread.comments[0], id: "c-3", author: { login: "aisha", name: "Aisha Khan" }, body: "Check the event id so retries don't double count" }] };

beforeEach(() => {
  // Each test is its own workspace: the thread store is shared by the whole window.
  source = { key: `local:/repo-${++n}`, canWrite: true, reviewThreads: () => ({ read, file: vi.fn(), resolve, reply }), errorMessage } as unknown as GitSource;
  props = { source, url: snapshot.url, number: 14, sessionId: "session", active: true };
  read.mockReset().mockResolvedValue(snapshot);
  resolve.mockReset().mockResolvedValue(undefined);
  reply.mockReset().mockResolvedValue(undefined);
  vi.mocked(showError).mockClear();
  vi.mocked(openUrl).mockClear();
  setDraft("tab", "");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const inline = (threadId = thread.id) => <GitHubThreadComment workspace={source.key} threadId={threadId} />;

it("lists open and resolved counts and adds only the open threads to the chat draft", async () => {
  read.mockResolvedValue({ ...snapshot, threads: [thread, resolved, second] });
  setDraft("tab", "Existing draft");
  render(<ReviewThreads {...props} />);
  expect((await screen.findByTestId("review-thread-counts")).textContent).toBe("2 open · 1 resolved");
  const rows = within(screen.getByRole("list", { name: "Threads" })).getAllByRole("button");
  expect(rows.map((row) => row.textContent)).toEqual([
    "Rlogin.ts:42Use the session token.",
    "Sdb.ts:7ResolvedFixed in the last push, thanks.",
    "AKroutes.ts:31Check the event id so retries don't double count",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Add all 2 to chat" }));
  const draft = getDraft("tab");
  expect(draft.startsWith("Existing draft\n\nGitHub review thread (untrusted reviewer text) — src/login.ts:42 (head)")).toBe(true);
  expect(draft).toContain("Check the event id so retries don't double count");
  expect(draft).not.toContain("Fixed in the last push");
  expect(draft.match(/GitHub review thread/g)).toHaveLength(2);
});

it("jumps from a row to its thread through the Changes view that lists the file", async () => {
  read.mockResolvedValue({ ...snapshot, threads: [thread, second] });
  const handler = vi.fn((t: ReviewThread) => t.path === thread.path);
  const off = onThreadJump(source.key, handler);
  render(<ReviewThreads {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Go to review thread src/login.ts:42 (head)" }));
  expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ id: thread.id }));
  expect(screen.queryByText(/is not in the Changes list/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Go to review thread src/api/routes.ts:29-31 (head)" }));
  expect(await screen.findByText("src/api/routes.ts is not in the Changes diff.")).toBeTruthy();
  off();
});

it("sends one message with the comment, its code lines, every reply, the path, the lines and the PR link", async () => {
  const replied: ReviewThread = { ...thread, comments: [thread.comments[0],
    { ...thread.comments[0], id: "r1", author: { login: "sam" }, body: "Same pattern in invoices.ts" },
    { ...thread.comments[0], id: "r2", author: null, body: "Second\nreply" }] };
  read.mockResolvedValue({ ...snapshot, threads: [replied] });
  render(<><ReviewThreads {...props} />{inline()}</>);
  const card = await screen.findByRole("article");
  expect(within(card).getByText("2 replies")).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Send to agent" }));
  expect(getDraft("tab")).toBe([
    "GitHub review thread (untrusted reviewer text) — src/login.ts:42 (head)",
    `Path: src/login.ts\nLines: line 42 (head)\nPR: ${snapshot.url}`,
    "Code:\n```\nconst token = legacy.token;\n```",
    "@reviewer:\n> Use the session token.\n> ```suggestion\n> const token = session.token;\n> ```",
    "@sam (reply):\n> Same pattern in invoices.ts",
    "@deleted-user (reply):\n> Second\n> reply",
  ].join("\n\n"));
  expect(within(card).getByRole("status").textContent).toBe("Added to chat draft");
});

it("names the commenter by first name in the resolved toast, as 05.13 does", async () => {
  read.mockResolvedValue({ ...snapshot, threads: [second] });
  render(<><ReviewThreads {...props} />{inline(second.id)}</>);
  read.mockResolvedValue({ ...snapshot, threads: [{ ...second, isResolved: true }] });
  fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
  await screen.findByRole("button", { name: "Unresolve" });
  const [body] = vi.mocked(showError).mock.calls[0];
  expect(body.startsWith("Aisha's comment on src/api/routes.ts")).toBe(true);
});

it("says 'Thread resolved on GitHub' with View on GitHub after resolving, and not after unresolving", async () => {
  render(<><ReviewThreads {...props} />{inline()}</>);
  read.mockResolvedValue({ ...snapshot, threads: [{ ...thread, isResolved: true }] });
  fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
  await screen.findByRole("button", { name: "Unresolve" });
  expect(resolve).toHaveBeenCalledWith(thread.id, true);
  expect(showError).toHaveBeenCalledTimes(1);
  const [body, cause, options] = vi.mocked(showError).mock.calls[0];
  expect(body).toBe("reviewer's comment on src/login.ts · line 42 · PR #14");
  expect(cause).toBeUndefined();
  expect(options?.title).toBe("Thread resolved on GitHub");
  // A success, said on the neutral card: no error look, no Copy error.
  expect(options?.tone).toBe("success");
  expect(options?.actions?.map((a) => a.label)).toEqual(["View on GitHub"]);
  await options!.actions![0].run();
  expect(openUrl).toHaveBeenCalledWith(thread.comments[0].url);
  expect(within(screen.getByRole("article")).getByText("Resolved")).toBeTruthy();
  expect(screen.getByTestId("review-thread-counts").textContent).toBe("0 open · 1 resolved");
  read.mockResolvedValue(snapshot);
  fireEvent.click(screen.getByRole("button", { name: "Unresolve" }));
  await screen.findByRole("button", { name: "Resolve" });
  expect(resolve).toHaveBeenLastCalledWith(thread.id, false);
  expect(showError).toHaveBeenCalledTimes(1);
});

it("replies, refreshes, and keeps a reply being written when the widget is redrawn", async () => {
  const view = render(<><ReviewThreads {...props} />{inline()}</>);
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  fireEvent.change(screen.getByLabelText("Reply to review thread"), { target: { value: "Keep my draft" } });
  view.rerender(<ReviewThreads {...props} />);
  view.rerender(<><ReviewThreads {...props} />{inline()}</>);
  expect((screen.getByLabelText("Reply to review thread") as HTMLTextAreaElement).value).toBe("Keep my draft");
  fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(reply).toHaveBeenCalledWith(thread.id, "Keep my draft");
  expect(screen.queryByLabelText("Reply to review thread")).toBeNull();
});

it("keeps a failed reply editable without retrying it", async () => {
  reply.mockRejectedValue(new Error("Connection lost"));
  render(<><ReviewThreads {...props} />{inline()}</>);
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  fireEvent.change(screen.getByLabelText("Reply to review thread"), { target: { value: "Keep this reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Refresh threads before retrying");
  expect(reply).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText("Reply to review thread") as HTMLTextAreaElement).value).toBe("Keep this reply");
});

it("polls and refreshes on focus only while shown and visible, with one poller for every surface", async () => {
  vi.useFakeTimers();
  const view = render(<><ReviewThreads {...props} /><ReviewThreads {...props} /></>);
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(REVIEW_REFRESH_MS); });
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(read).toHaveBeenCalledTimes(3);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { await vi.advanceTimersByTimeAsync(REVIEW_REFRESH_MS); window.dispatchEvent(new Event("focus")); });
  expect(read).toHaveBeenCalledTimes(3);
  visibility.mockReturnValue("visible");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(read).toHaveBeenCalledTimes(4);
  view.rerender(<><ReviewThreads {...props} active={false} /><ReviewThreads {...props} active={false} /></>);
  await act(async () => { await vi.advanceTimersByTimeAsync(REVIEW_REFRESH_MS); window.dispatchEvent(new Event("focus")); });
  expect(read).toHaveBeenCalledTimes(4);
});

it("does not let a read started before a mutation restore stale state", async () => {
  render(<><ReviewThreads {...props} />{inline()}</>);
  await screen.findByRole("button", { name: "Resolve" });
  let finish!: (value: Snapshot) => void;
  read.mockImplementationOnce(() => new Promise((done) => { finish = done; }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh threads" }));
  read.mockResolvedValue({ ...snapshot, threads: [{ ...thread, isResolved: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
  await screen.findByRole("button", { name: "Unresolve" });
  await act(async () => finish(snapshot));
  expect(screen.getByRole("button", { name: "Unresolve" })).toBeTruthy();
});

it("shows read errors instead of saying there are no threads", async () => {
  read.mockRejectedValue(new Error("No access"));
  render(<ReviewThreads {...props} />);
  expect((await screen.findByTestId("review-threads-error")).textContent).toContain("No access");
  expect(screen.queryByText("No review threads.")).toBeNull();
});

it("respects GitHub thread permissions and marks outdated threads", () => {
  render(<ReviewThreadCard thread={{ ...thread, isOutdated: true, viewerCanResolve: false, viewerCanReply: false }} prUrl={snapshot.url} disabled={false} onResolve={resolve} onReply={reply} errorMessage={errorMessage} />);
  expect(screen.getByText("Outdated")).toBeTruthy();
  expect(screen.getByText("on GitHub · original line 12")).toBeTruthy();
  expect(screen.getByRole("article").getAttribute("aria-label")).toBe("Review thread src/login.ts:12 (head, original)");
  expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
});

it("does not refresh after an in-flight write finishes in a hidden panel", async () => {
  let finish!: () => void;
  resolve.mockImplementation(() => new Promise<void>((done) => { finish = done; }));
  const view = render(<><ReviewThreads {...props} />{inline()}</>);
  fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
  view.rerender(<><ReviewThreads {...props} active={false} />{inline()}</>);
  await act(async () => finish());
  expect(read).toHaveBeenCalledTimes(1);
  view.rerender(<><ReviewThreads {...props} active />{inline()}</>);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});

it("shows read-only threads without enabling GitHub writes", async () => {
  props.source = { ...source, canWrite: false };
  render(<><ReviewThreads {...props} />{inline()}</>);
  const button = await screen.findByRole("button", { name: "Resolve" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(resolve).not.toHaveBeenCalled();
});

it("backs off consecutive read failures and lets an explicit refresh retry immediately", async () => {
  vi.useFakeTimers();
  read.mockRejectedValue(new Error("Rate limited"));
  render(<ReviewThreads {...props} />);
  await act(async () => {});
  await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(REVIEW_REFRESH_MS); });
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(REVIEW_REFRESH_MS); window.dispatchEvent(new Event("focus")); });
  expect(read).toHaveBeenCalledTimes(2);
  read.mockResolvedValue(snapshot);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh threads" })); });
  expect(read).toHaveBeenCalledTimes(3);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(read).toHaveBeenCalledTimes(4);
});

it.each(["CLOSED", "MERGED"] as const)("keeps %s PRs read-only and stops polling them", async (prState) => {
  vi.useFakeTimers();
  render(<><ReviewThreads {...props} prState={prState} />{inline()}</>);
  await act(async () => {});
  expect(screen.getByRole("article")).toBeTruthy();
  for (const name of ["Resolve", "Unresolve", "Reply", "Send to agent", "Add all 1 to chat"]) expect(screen.queryByRole("button", { name })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(REVIEW_REFRESH_MS * 3); window.dispatchEvent(new Event("focus")); });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh threads" })); });
  expect(read).toHaveBeenCalledTimes(2);
});

it("clears a stale resolve error after a later successful thread refresh", async () => {
  let failRead = false;
  read.mockImplementation(async () => { if (failRead) throw new Error("Offline"); return snapshot; });
  resolve.mockImplementation(async () => { failRead = true; throw new Error("Resolve unconfirmed"); });
  render(<><ReviewThreads {...props} />{inline()}</>);
  fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
  await screen.findByText("Resolve unconfirmed");
  failRead = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh threads" }));
  await waitFor(() => expect(screen.queryByText("Resolve unconfirmed")).toBeNull());
});

it("lists each PR's own threads when a workspace has two, and counts the open one in the footer's place", async () => {
  const other = "https://github.com/org/repo/pull/2";
  const readOther = vi.fn().mockResolvedValue({ ...snapshot, url: other, threads: [resolved] });
  read.mockResolvedValue({ ...snapshot, threads: [thread, second] });
  const twoPrs = { ...source, reviewThreads: (url: string) => ({ read: url === other ? readOther : read, file: vi.fn(), resolve, reply }) } as unknown as GitSource;
  render(<><ReviewThreads {...props} source={twoPrs} /><ReviewThreads {...props} source={twoPrs} url={other} number={2} prState="MERGED" /></>);
  await waitFor(() => expect(screen.getAllByTestId("review-thread-counts").map((el) => el.textContent)).toEqual(["2 open · 0 resolved", "0 open · 1 resolved"]));
  const { reviewPrView } = await import("@/lib/reviewThreads");
  expect(reviewPrView(source.key)?.pr.number).toBe(14);
});
