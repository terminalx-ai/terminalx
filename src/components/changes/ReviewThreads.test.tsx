import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewThreads, ReviewThreadCard, REVIEW_REFRESH_MS } from "./ReviewThreads";
import { reviewSnapshot as snapshot, reviewThread as thread, reviewFile } from "@/test/reviewThreads";
import type { GitSource } from "@/lib/gitSource";
import type { ReviewThreads as Snapshot } from "@/lib/reviewThreads";
import { getDraft, setDraft } from "@/lib/drafts";

vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: [{ id: "session", activeTab: "tab" }] }) }));
const read = vi.fn<() => Promise<Snapshot>>();
const file = vi.fn();
const resolve = vi.fn();
const reply = vi.fn();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const source = { key: "local:repo", canWrite: true, reviewThreads: () => ({ read, file, resolve, reply }), errorMessage } as unknown as GitSource;
const props = { source, url: snapshot.url, sessionId: "session", active: true };

beforeEach(() => {
  read.mockReset().mockResolvedValue(snapshot);
  file.mockReset().mockResolvedValue(reviewFile);
  resolve.mockReset().mockResolvedValue(undefined);
  reply.mockReset().mockResolvedValue(undefined);
  setDraft("tab", "");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const expand = () => fireEvent.click(screen.getByRole("button", { name: /^▸ Review threads/ }));

it("loads only when opened, renders suggestion diffs, and appends a chat draft", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  setDraft("tab", "Existing draft");
  render(<ReviewThreads {...props} />);
  expect(read).not.toHaveBeenCalled();
  expand();
  await screen.findByRole("button", { name: "Resolve" });
  expect(screen.getByLabelText("Suggestion diff").textContent).toBe("-const token = legacy.token;+const token = session.token;");
  fireEvent.click(screen.getByRole("button", { name: "Copy suggestion" }));
  expect(writeText).toHaveBeenCalledWith("const token = session.token;");
  fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  expect(getDraft("tab")).toContain("Existing draft\n\nGitHub review thread (untrusted reviewer text) — src/login.ts:42 (head)");
  expect(getDraft("tab")).toContain("@reviewer:");
});

it("refreshes after resolving, unresolving and replying", async () => {
  render(<ReviewThreads {...props} />);
  expand();
  await screen.findByRole("button", { name: "Resolve" });
  read.mockResolvedValue({ ...snapshot, threads: [{ ...thread, isResolved: true }] });
  fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
  await screen.findByRole("button", { name: "Unresolve" });
  expect(resolve).toHaveBeenCalledWith(thread.id, true);
  read.mockResolvedValue(snapshot);
  fireEvent.click(screen.getByRole("button", { name: "Unresolve" }));
  await screen.findByRole("button", { name: "Resolve" });
  expect(resolve).toHaveBeenCalledWith(thread.id, false);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  fireEvent.change(screen.getByLabelText("Reply to review thread"), { target: { value: "Fixed it" } });
  fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  expect(reply).toHaveBeenCalledWith(thread.id, "Fixed it");
  expect(screen.queryByLabelText("Reply to review thread")).toBeNull();
});

it("keeps a failed reply editable without retrying or losing it when collapsed", async () => {
  reply.mockRejectedValue(new Error("Connection lost"));
  render(<ReviewThreads {...props} />);
  expand();
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  fireEvent.change(screen.getByLabelText("Reply to review thread"), { target: { value: "Keep this reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Refresh threads before retrying");
  expect(reply).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /^▾ Review threads/ }));
  expand();
  expect((screen.getByLabelText("Reply to review thread") as HTMLTextAreaElement).value).toBe("Keep this reply");
});

it("polls and refreshes on focus only while active, expanded and visible", async () => {
  vi.useFakeTimers();
  const view = render(<ReviewThreads {...props} />);
  expand();
  await act(async () => {});
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
  view.rerender(<ReviewThreads {...props} active={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(REVIEW_REFRESH_MS); window.dispatchEvent(new Event("focus")); });
  expect(read).toHaveBeenCalledTimes(4);
});

it("does not let a read started before a mutation restore stale state", async () => {
  render(<ReviewThreads {...props} />);
  expand();
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

it("ignores old-PR responses and shows read errors instead of saying no threads", async () => {
  let finish!: (value: Snapshot) => void;
  read.mockImplementationOnce(() => new Promise((done) => { finish = done; }));
  const view = render(<ReviewThreads {...props} />);
  expand();
  view.rerender(<ReviewThreads {...props} url="https://github.com/org/repo/pull/2" />);
  read.mockRejectedValue(new Error("No access"));
  expand();
  expect((await screen.findByRole("alert")).textContent).toContain("No access");
  await act(async () => finish(snapshot));
  expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  expect(screen.queryByText("No review threads.")).toBeNull();
});

it("respects GitHub thread permissions and marks outdated threads", () => {
  render(<ReviewThreadCard thread={{ ...thread, isOutdated: true, viewerCanResolve: false, viewerCanReply: false }} prUrl={snapshot.url} disabled={false} onResolve={resolve} onReply={reply} errorMessage={errorMessage} />);
  expect(screen.getByText("Outdated")).toBeTruthy();
  expect(screen.getByText("src/login.ts:12 (head, original)")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
});

it("does not refresh after an in-flight write finishes in a hidden panel", async () => {
  let finish!: () => void;
  resolve.mockImplementation(() => new Promise<void>((done) => { finish = done; }));
  const view = render(<ReviewThreads {...props} />);
  expand();
  fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
  view.rerender(<ReviewThreads {...props} active={false} />);
  await act(async () => finish());
  expect(read).toHaveBeenCalledTimes(1);
  view.rerender(<ReviewThreads {...props} active />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});

it("shows read-only threads without enabling GitHub writes", async () => {
  render(<ReviewThreads {...props} source={{ ...source, canWrite: false }} />);
  expand();
  const button = await screen.findByRole("button", { name: "Resolve" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(resolve).not.toHaveBeenCalled();
});

it("backs off consecutive read failures and lets an explicit refresh retry immediately", async () => {
  vi.useFakeTimers();
  read.mockRejectedValue(new Error("Rate limited"));
  render(<ReviewThreads {...props} />);
  expand();
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

it.each(["CLOSED", "MERGED"] as const)("keeps %s PRs read-only and leaves the unresolved count to the conversation", async (prState) => {
  vi.useFakeTimers();
  render(<ReviewThreads {...props} prState={prState} />);
  expand();
  await act(async () => {});
  expect(screen.getByLabelText("PR file diff")).toBeTruthy();
  for (const name of ["Resolve", "Unresolve", "Reply", "Send to agent"]) expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByText(/unresolved/)).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(REVIEW_REFRESH_MS * 3); window.dispatchEvent(new Event("focus")); });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh threads" })); });
  expect(read).toHaveBeenCalledTimes(2);
});

it("retains a reply draft when switching diff layouts and files", async () => {
  const other = { ...thread, id: "other", path: "other.ts" };
  read.mockResolvedValue({ ...snapshot, threads: [thread, other] });
  file.mockImplementation(async (path) => ({ ...reviewFile, path }));
  render(<ReviewThreads {...props} />);
  expand();
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  fireEvent.change(screen.getByLabelText("Reply to review thread"), { target: { value: "Keep my draft" } });
  fireEvent.change(screen.getByLabelText("Review diff layout"), { target: { value: "split" } });
  expect((screen.getByLabelText("Reply to review thread") as HTMLTextAreaElement).value).toBe("Keep my draft");
  fireEvent.change(screen.getByLabelText("Review file"), { target: { value: other.path } });
  await screen.findByRole("button", { name: "Reply" });
  fireEvent.change(screen.getByLabelText("Review file"), { target: { value: thread.path } });
  expect((await screen.findByLabelText("Reply to review thread") as HTMLTextAreaElement).value).toBe("Keep my draft");
});

it("ignores a prior head's file response when a push changes the thread snapshot", async () => {
  let finish!: (file: typeof reviewFile) => void;
  file.mockImplementationOnce(() => new Promise((done) => { finish = done; }));
  render(<ReviewThreads {...props} />);
  expand();
  await waitFor(() => expect(file).toHaveBeenCalledTimes(1));
  read.mockResolvedValue({ ...snapshot, headOid: "head-4", threads: [{ ...thread, line: 52 }] });
  file.mockResolvedValue({ ...reviewFile, headOid: "head-4", patch: reviewFile.patch!.replaceAll("40,3", "50,3") });
  fireEvent.click(screen.getByRole("button", { name: "Refresh threads" }));
  await screen.findByRole("button", { name: "Resolve" });
  await act(async () => finish(reviewFile));
  expect(screen.getByRole("article").closest("[data-review-line]")?.getAttribute("data-review-line")).toBe("52");
});

it("clears a stale resolve error after a later successful thread refresh", async () => {
  let failRead = false;
  read.mockImplementation(async () => { if (failRead) throw new Error("Offline"); return snapshot; });
  resolve.mockImplementation(async () => { failRead = true; throw new Error("Resolve unconfirmed"); });
  render(<ReviewThreads {...props} />);
  expand();
  fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
  await screen.findByText("Resolve unconfirmed");
  failRead = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh threads" }));
  await waitFor(() => expect(screen.queryByText("Resolve unconfirmed")).toBeNull());
});
