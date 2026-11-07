import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrConversation as Conversation, PrConversationAccess, PrConversationAction } from "@terminalx/portable/workspaceGit";
import type { GitSource } from "@/lib/gitSource";
import type { SessionPr } from "@/lib/sessionPrs";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { PrConversation } from "./PrConversation";

vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div> }));
const row: SessionPr = { identity: "https://github.com/acme/repo/pull/1", current: true, pr: { number: 1, url: "https://github.com/acme/repo/pull/1", title: "Title", body: "Body", author: "author", state: "OPEN", base: "main", head: "feature", additions: 1, deletions: 0, checks: [], mergeable: "MERGEABLE", isDraft: false, reviewDecision: null } };
const initial = (): Conversation => ({ url: row.identity, title: "Title", body: "**Description**", author: "author", viewer: "reviewer", state: "OPEN", canEdit: true, reviewers: [{ login: "ada", kind: "user", state: "APPROVED", requested: false }], unresolvedThreads: 2, activity: [] });
let data: Conversation;
let access: PrConversationAccess;
let source: Pick<GitSource, "conversation" | "canWrite" | "errorMessage">;
const onEdited = vi.fn();
function view(active = true, key = "first") { return <PrConversation key={key} source={source} row={row} active={active} refresh={0} onEdited={onEdited} />; }

beforeEach(() => {
  data = initial();
  access = {
    read: vi.fn(async () => structuredClone(data)),
    act: vi.fn(async (action: PrConversationAction) => {
      if (action.kind === "request") data.reviewers = [{ login: action.login, kind: "user", state: "PENDING", requested: true }];
      if (action.kind === "remove") data.reviewers = [];
      if (action.kind === "edit") { data.title = action.title; data.body = action.body; }
    }),
    search: vi.fn(async () => ["author", "ben"]),
  };
  source = { canWrite: true, conversation: () => access, errorMessage: (error: unknown) => String(error) };
  setPrefs({ prActivityOrder: "newest" });
  onEdited.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("requests, re-requests and removes reviewers by refreshing only the conversation", async () => {
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Re-request review from ada" }));
  await screen.findByRole("button", { name: "Remove reviewer ada" });
  expect(access.act).toHaveBeenCalledWith({ kind: "request", login: "ada", team: false });
  fireEvent.click(screen.getByRole("button", { name: "Remove reviewer ada" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove reviewer ada" })).toBeNull());
  fireEvent.change(screen.getByLabelText("Search reviewers"), { target: { value: "ben" } });
  fireEvent.click(await screen.findByRole("button", { name: "Request ben" }));
  await screen.findByRole("button", { name: "Remove reviewer ben" });
  expect(screen.queryByRole("button", { name: "Request author" })).toBeNull();
  expect(screen.getByText("2 unresolved threads")).toBeTruthy();
});

it("edits title and body, preserves unsaved drafts on refresh, and updates the card", async () => {
  const rendered = render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Edit title and description" }));
  fireEvent.change(screen.getByLabelText("Pull request title"), { target: { value: "New title" } });
  fireEvent.change(screen.getByLabelText("Pull request description"), { target: { value: "New **body**" } });
  rendered.rerender(<PrConversation source={source} row={row} active refresh={1} onEdited={onEdited} key="first" />);
  expect((screen.getByLabelText("Pull request title") as HTMLInputElement).value).toBe("New title");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("New **body**");
  expect(access.act).toHaveBeenCalledWith({ kind: "edit", title: "New title", body: "New **body**" });
  expect(onEdited).toHaveBeenCalledWith("New title", "New **body**");
});

it("keeps a failed edit and its error visible after a successful background read", async () => {
  vi.mocked(access.act).mockRejectedValue(new Error("GitHub refused edit"));
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Edit title and description" }));
  fireEvent.change(screen.getByLabelText("Pull request title"), { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Error: GitHub refused edit");
  await waitFor(() => expect(access.read).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("alert").textContent).toContain("GitHub refused edit");
  expect((screen.getByLabelText("Pull request title") as HTMLInputElement).value).toBe("Keep my draft");
});

it("offers approval to a non-author and prevents writes on a read-only source", async () => {
  const rendered = render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  await waitFor(() => expect(access.act).toHaveBeenCalledWith({ kind: "approve" }));
  data.viewer = "AUTHOR";
  rendered.rerender(view(true, "author"));
  await screen.findByText("2 unresolved threads");
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  source = { ...source, canWrite: false };
  rendered.rerender(view(true, "readonly"));
  await screen.findByText("2 unresolved threads");
  expect(screen.queryByRole("button", { name: "Edit title and description" })).toBeNull();
  expect(screen.queryByLabelText("Search reviewers")).toBeNull();
});

it("shows 200 activities, folds long comments, and persists sort across remounts", async () => {
  data.activity = Array.from({ length: 200 }, (_, i) => ({ id: String(i), kind: "comment", author: `person-${i}`, body: i === 199 ? "x".repeat(1800) : `comment-${i}`, at: "2026-11-07T00:00:00Z", url: null, state: null, before: null, after: null }));
  const rendered = render(view());
  await screen.findByText("Activity · 200");
  expect(screen.getAllByTestId("pr-activity-item")).toHaveLength(200);
  expect(screen.getAllByTestId("pr-activity-item")[0].textContent).toContain("person-199");
  expect(screen.queryByText("x".repeat(1800))).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(screen.getByText("x".repeat(1800))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  fireEvent.change(screen.getByLabelText("Activity order"), { target: { value: "oldest" } });
  expect(screen.getAllByTestId("pr-activity-item")[0].textContent).toContain("person-0");
  expect(getPrefs().prActivityOrder).toBe("oldest");
  expect(JSON.parse(localStorage.getItem("raccoon.prefs")!).prActivityOrder).toBe("oldest");
  rendered.rerender(view(true, "remount"));
  await screen.findByText("Activity · 200");
  expect(screen.getAllByTestId("pr-activity-item")[0].textContent).toContain("person-0");
});

describe("visibility and late responses", () => {
  it("revalidates a changed cloud workspace before allowing another action", async () => {
    source.conversation = vi.fn((_pr, association) => {
      if (association?.scope.kind !== "cloud" || association.scope.workspace !== "first") throw new Error("Reconnect this PR's workspace");
      return access;
    });
    const associated = (workspace: string): SessionPr => ({ ...row, association: { url: row.identity, number: 1, head: "feature", scope: { kind: "cloud", workspace, repo: "app" } } });
    const rendered = render(<PrConversation source={source} row={associated("first")} active refresh={0} onEdited={onEdited} />);
    await screen.findByText("2 unresolved threads");
    rendered.rerender(<PrConversation source={source} row={associated("second")} active refresh={0} onEdited={onEdited} />);
    expect(screen.getByRole("alert").textContent).toContain("Reconnect this PR's workspace");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(access.act).not.toHaveBeenCalled();
    expect(source.conversation).toHaveBeenCalledTimes(2);
  });

  it("polls only while the tab and document are visible", async () => {
    vi.useFakeTimers();
    const rendered = render(view(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(access.read).not.toHaveBeenCalled();
    rendered.rerender(view());
    await act(async () => {});
    expect(access.read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(access.read).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(access.read).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {});
    expect(access.read).toHaveBeenCalledTimes(3);
    rendered.rerender(view(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(access.read).toHaveBeenCalledTimes(3);
  });

  it("ignores a load superseded by a mutation and an action completing after unmount", async () => {
    let finishRead!: (value: Conversation) => void;
    vi.mocked(access.read).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const rendered = render(view());
    rendered.rerender(view(true, "second"));
    await screen.findByText("2 unresolved threads");
    await act(async () => finishRead({ ...initial(), body: "Stale old PR body" }));
    expect(screen.queryByText("Stale old PR body")).toBeNull();
    let finishAction!: () => void;
    vi.mocked(access.act).mockImplementationOnce(() => new Promise((resolve) => { finishAction = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    rendered.unmount();
    const reads = vi.mocked(access.read).mock.calls.length;
    await act(async () => finishAction());
    expect(access.read).toHaveBeenCalledTimes(reads);
  });

  it("ignores stale user searches", async () => {
    let finish!: (value: string[]) => void;
    vi.mocked(access.search).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(view());
    fireEvent.change(await screen.findByLabelText("Search reviewers"), { target: { value: "alice" } });
    await waitFor(() => expect(access.search).toHaveBeenCalledWith("alice"));
    fireEvent.change(screen.getByLabelText("Search reviewers"), { target: { value: "ben" } });
    await screen.findByRole("button", { name: "Request ben" });
    await act(async () => finish(["alice"]));
    expect(within(screen.getByRole("list", { name: "Reviewer search results" })).queryByText("alice")).toBeNull();
  });
});
