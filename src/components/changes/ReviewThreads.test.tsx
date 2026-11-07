import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewThreads, ReviewThreadCard, REVIEW_REFRESH_MS } from "./ReviewThreads";
import { reviewSnapshot as snapshot, reviewThread as thread } from "@/test/reviewThreads";
import type { GitSource } from "@/lib/gitSource";
import type { ReviewThreads as Snapshot } from "@/lib/reviewThreads";
import { getDraft, setDraft } from "@/lib/drafts";

vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: [{ id: "session", activeTab: "tab" }] }) }));
const read = vi.fn<() => Promise<Snapshot>>();
const resolve = vi.fn();
const reply = vi.fn();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const source = { key: "local:repo", canWrite: true, reviewThreads: () => ({ read, resolve, reply }), errorMessage } as unknown as GitSource;
const props = { source, url: snapshot.url, sessionId: "session", active: true };

beforeEach(() => {
  read.mockReset().mockResolvedValue(snapshot);
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
  expect(getDraft("tab")).toContain("Existing draft\n\nGitHub review thread — src/login.ts:42 (head)");
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
