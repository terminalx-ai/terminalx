import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createIssueOpsMock, githubIssueFixture, linearIssueFixture, type IssueOpsMock } from "@/test/issueOpsMock";
import type { IssueDetails, IssueProvider } from "@/lib/issueOps";

const { invoke, dictation } = vi.hoisted(() => ({
  invoke: vi.fn(),
  dictation: { target: "", change: (_: string) => {}, keys: true },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/components/chat/Dictation", () => ({
  DictationStatus: () => null,
  MicButton: () => <button type="button">Dictate</button>,
  useDictationInto: (target: string, _draft: string, change: (value: string) => void) => {
    dictation.target = target;
    dictation.change = change;
    return { dictating: false, toggle: vi.fn() };
  },
  useDictationShortcuts: (_: unknown, enabled = true) => {
    dictation.keys = enabled;
  },
}));
vi.mock("@/lib/dictation", () => ({ stopDictation: vi.fn() }));

const fixtures = { github: githubIssueFixture(), linear: linearIssueFixture() };
let issues: IssueOpsMock;

function backend() {
  issues = createIssueOpsMock();
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => issues.handle(command, args) ?? Promise.resolve(undefined));
}

/** The modules afresh, as an app restart reads them: the drafts come back from storage only. */
async function load() {
  vi.resetModules();
  const thread = await import("./IssueCommentThread");
  const composer = await import("./IssueCommentComposer");
  return { ...thread, ...composer };
}
let modules: Awaited<ReturnType<typeof load>>;

function renderIssue(provider: IssueProvider, extra: { id?: string; onIssue?: (issue: IssueDetails) => void; stateType?: IssueDetails["stateType"]; refreshKey?: number } = {}) {
  const { IssueCommentThread, IssueCommentComposer } = modules;
  const issue = { ...fixtures[provider], id: extra.id ?? fixtures[provider].id, stateType: extra.stateType ?? fixtures[provider].stateType };
  return render(
    <IssueCommentThread
      key={`${provider}:${issue.id}`}
      projectPath="/repo"
      provider={provider}
      issueId={issue.id}
      refreshKey={extra.refreshKey}
      footer={(controls) => <IssueCommentComposer projectPath="/repo" issue={issue} controls={controls} hooks={{ onIssue: extra.onIssue }} />}
    />,
  );
}

const box = () => screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const commentIds = () => Array.from(document.querySelectorAll("[data-comment-id]")).map((item) => item.getAttribute("data-comment-id"));

beforeEach(async () => {
  localStorage.clear();
  invoke.mockReset();
  backend();
  modules = await load();
});
afterEach(cleanup);

describe.each(["github", "linear"] as const)("the %s comment box", (provider) => {
  it("posts with Comment: it shows as sending at once, then as a comment of the thread, and the box empties", async () => {
    let answer!: () => void;
    const gate = new Promise<void>((resolve) => (answer = resolve));
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "issue_comment_add") await gate;
      return issues.handle(command, args) ?? undefined;
    });
    renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    const button = screen.getByRole("button", { name: "Comment" });
    expect(button).toHaveProperty("disabled", true);
    type("Fixed in `main`:\n\n- one\n- [link](https://example.com)");
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);

    const sending = await screen.findByRole("listitem", { name: "Comment sending" });
    expect(sending?.textContent).toContain("Sending…");
    expect(sending?.textContent).toContain("[link](https://example.com)");
    expect(box().value).toBe("");
    // One post at a time.
    type("next");
    expect(screen.getByRole("button", { name: "Comment" })).toHaveProperty("disabled", true);

    await act(async () => answer());
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Comment sending" })).toBeNull());
    const posted = issues.calls.find((call) => call.command === "issue_comment_add");
    expect(posted?.args).toMatchObject({ provider, id: fixtures[provider].id, body: "Fixed in `main`:\n\n- one\n- [link](https://example.com)" });
    const last = document.querySelectorAll("[data-comment-id]");
    expect(last[last.length - 1]?.textContent).toContain("[link](https://example.com)");
    expect(screen.getByRole("button", { name: "Comment" })).toHaveProperty("disabled", false);
  });

  it("posts with ⌘/Ctrl+Enter, but not while an input method is composing", async () => {
    renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    type("Looks good");
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true, isComposing: true });
    expect(issues.calls.some((call) => call.command === "issue_comment_add")).toBe(false);
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(issues.calls.filter((call) => call.command === "issue_comment_add")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Comment sending" })).toBeNull());
    expect(box().value).toBe("");
  });

  it("keeps a failed post's text with Retry, which posts it once the network is back, and Discard", async () => {
    renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    issues.fail("issue_comment_add", "network", "Couldn't reach the provider. Check your connection.");
    type("Offline thought");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const failed = await screen.findByRole("listitem", { name: "Comment not posted" });
    expect(within(failed).getByRole("alert")?.textContent).toContain("Couldn't reach the provider");
    expect(failed?.textContent).toContain("Offline thought");
    expect(issues.issues.get(`${provider}:${fixtures[provider].id}`)?.comments.some((comment) => comment.body === "Offline thought")).toBeFalsy();

    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: /Comment (not posted|sending)/ })).toBeNull());
    expect(issues.issues.get(`${provider}:${fixtures[provider].id}`)?.comments.filter((comment) => comment.body === "Offline thought")).toHaveLength(1);
    expect(document.querySelector("[data-comment-id]:last-of-type")?.textContent).toContain("Offline thought");

    issues.fail("issue_comment_add", "network");
    type("Never mind");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const again = await screen.findByRole("listitem", { name: "Comment not posted" });
    fireEvent.click(within(again).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("listitem", { name: "Comment not posted" })).toBeNull();
  });

  it("keeps the draft across switching issues and an app restart, and clears it once posted", async () => {
    const first = renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    type("Half a thought");
    first.unmount();

    const other = renderIssue(provider, { id: "other-issue" });
    await screen.findByRole("textbox", { name: "Comment" });
    expect(box().value).toBe("");
    other.unmount();

    const back = renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    expect(box().value).toBe("Half a thought");
    back.unmount();

    // A restart: the modules are read again, from storage alone.
    modules = await load();
    renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    expect(box().value).toBe("Half a thought");

    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Comment sending" })).toBeNull());
    expect(box().value).toBe("");
    expect(localStorage.getItem("terminalx.issueDrafts.v1")).toBeNull();
    cleanup();
    modules = await load();
    renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    expect(box().value).toBe("");
  });

  it("keeps a failed post over a restart, and lands a post on its own issue after a switch", async () => {
    let answer!: () => void;
    const gate = new Promise<void>((resolve) => (answer = resolve));
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "issue_comment_add") await gate;
      return issues.handle(command, args) ?? undefined;
    });
    const first = renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    type("Slow one");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await screen.findByRole("listitem", { name: "Comment sending" });
    first.unmount();

    // Another issue is open when the answer comes: nothing of it shows there.
    renderIssue(provider, { id: "other-issue" });
    await screen.findByRole("textbox", { name: "Comment" });
    await act(async () => answer());
    expect(screen.queryByRole("listitem", { name: /Comment (sending|not posted)/ })).toBeNull();
    expect(document.body?.textContent).not.toContain("Slow one");
    cleanup();

    renderIssue(provider);
    await waitFor(() => expect(document.querySelector("[data-comment-id]:last-of-type")?.textContent).toContain("Slow one"));
    expect(screen.queryByRole("listitem", { name: "Comment sending" })).toBeNull();
    expect(commentIds().filter((id, index, all) => all.indexOf(id) !== index)).toEqual([]);
    cleanup();

    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => issues.handle(command, args) ?? Promise.resolve(undefined));
    issues.fail("issue_comment_add", "network");
    renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    type("Kept over a restart");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await screen.findByRole("listitem", { name: "Comment not posted" });
    cleanup();
    modules = await load();
    renderIssue(provider);
    const failed = await screen.findByRole("listitem", { name: "Comment not posted" });
    expect(failed?.textContent).toContain("Kept over a restart");
    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(document.querySelector("[data-comment-id]:last-of-type")?.textContent).toContain("Kept over a restart"));
  });

  it("dictates into the issue's own draft", async () => {
    renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    expect(dictation.target).toBe(`issue\n/repo\n${provider}\n${fixtures[provider].id}`);
    act(() => dictation.change("spoken words"));
    expect(box().value).toBe("spoken words");
  });
});

describe("Close with comment", () => {
  it("posts the comment and closes the GitHub issue as completed in one action", async () => {
    const onIssue = vi.fn();
    renderIssue("github", { onIssue });
    await screen.findByRole("textbox", { name: "Comment" });
    const close = screen.getByRole("button", { name: "Close with comment" });
    expect(close).toHaveProperty("disabled", true);
    type("Done in #42");
    fireEvent.click(close);
    await waitFor(() => expect(onIssue).toHaveBeenCalledTimes(1));
    const order = issues.calls.filter((call) => call.command === "issue_comment_add" || call.command === "issue_set_state");
    expect(order.map((call) => call.command)).toEqual(["issue_comment_add", "issue_set_state"]);
    expect(order[1].args.change).toEqual({ kind: "close", reason: "completed" });
    expect(onIssue.mock.calls[0][0]).toMatchObject({ stateType: "completed", closeReason: "completed" });
    await waitFor(() => expect(document.querySelector("[data-comment-id]:last-of-type")?.textContent).toContain("Done in #42"));
  });

  it("retries only the close when the comment went in and the close did not", async () => {
    renderIssue("github");
    await screen.findByRole("textbox", { name: "Comment" });
    issues.fail("issue_set_state", "forbidden");
    type("Closing");
    fireEvent.click(screen.getByRole("button", { name: "Close with comment" }));
    const failed = await screen.findByRole("listitem", { name: "Comment posted, issue not closed" });
    expect(within(failed).getByRole("alert")?.textContent).toContain("The comment is posted, but the issue couldn’t be closed.");
    expect(failed.textContent).toContain("posted · issue not closed");
    expect(within(failed).queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(within(failed).getByRole("button", { name: "Try closing again" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Comment posted, issue not closed" })).toBeNull());
    expect(issues.calls.filter((call) => call.command === "issue_comment_add")).toHaveLength(1);
    expect(issues.issue("github", fixtures.github.id).stateType).toBe("completed");
  });

  it("is offered on an open GitHub issue only", async () => {
    renderIssue("linear");
    await screen.findByRole("textbox", { name: "Comment" });
    expect(screen.queryByRole("button", { name: "Close with comment" })).toBeNull();
    cleanup();
    renderIssue("github", { stateType: "completed" });
    await screen.findByRole("textbox", { name: "Comment" });
    expect(screen.queryByRole("button", { name: "Close with comment" })).toBeNull();
  });
  it("keeps the comment in the thread when the close failed and the notice is dismissed, and reads the issue again", async () => {
    const onIssue = vi.fn();
    renderIssue("github", { onIssue });
    await screen.findByRole("textbox", { name: "Comment" });
    issues.fail("issue_set_state", "network");
    type("Closing, maybe");
    fireEvent.click(screen.getByRole("button", { name: "Close with comment" }));
    const failed = await screen.findByRole("listitem", { name: "Comment posted, issue not closed" });
    // The failed write is followed by a fresh read of the issue, which the view is handed.
    await waitFor(() => expect(onIssue).toHaveBeenCalledWith(expect.objectContaining({ id: fixtures.github.id, stateType: "open" })));
    fireEvent.click(within(failed).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("listitem", { name: "Comment posted, issue not closed" })).toBeNull();
    await waitFor(() => expect(Array.from(document.querySelectorAll("[data-comment-id]")).filter((item) => item.textContent?.includes("Closing, maybe"))).toHaveLength(1));
    expect(issues.calls.filter((call) => call.command === "issue_comment_add")).toHaveLength(1);
  });
});

describe.each(["github", "linear"] as const)("a %s post whose answer was lost", (provider) => {
  it("is known in the thread read again, so it shows as posted and is never offered for a second post", async () => {
    // The provider's clock: the mock dates comments from 2026-10-01.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-01T00:00:00Z") });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    // The reader is the one the mock posts as.
    issues.viewer[provider] = issues.options[provider].members[0];
    const onIssue = vi.fn();
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "issue_comment_add") {
        await issues.handle(command, args);
        throw { kind: "network", message: "Couldn't reach the provider." };
      }
      return issues.handle(command, args) ?? undefined;
    });
    renderIssue(provider, { onIssue });
    await screen.findByRole("textbox", { name: "Comment" });
    type("Went in after all");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(Array.from(document.querySelectorAll("[data-comment-id]")).filter((item) => item.textContent?.includes("Went in after all"))).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: /Comment (sending|not posted)/ })).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(issues.calls.filter((call) => call.command === "issue_comment_add")).toHaveLength(1);
    expect(issues.calls.some((call) => call.command === "issue_details")).toBe(true);
    expect(onIssue).toHaveBeenCalled();
  });

  it("is offered for Retry when the thread read again doesn't have it", async () => {
    issues.viewer[provider] = issues.options[provider].members[0];
    renderIssue(provider);
    await screen.findByRole("textbox", { name: "Comment" });
    // The same text posted earlier by the reader is not this post.
    type("Same words");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Comment sending" })).toBeNull());
    issues.fail("issue_comment_add", "network");
    type("Same words");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const failed = await screen.findByRole("listitem", { name: "Comment not posted" });
    expect(within(failed).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("the comment box around the thread", () => {
  it("stays, with the focus, while a thread that couldn't be read is read again", async () => {
    issues.fail("issue_comments", "network");
    const view = renderIssue("github");
    await screen.findByText(/Couldn’t load the comments/);
    const before = box();
    before.focus();
    type("Still here");
    view.rerender(
      <modules.IssueCommentThread
        key="github:41"
        projectPath="/repo"
        provider="github"
        issueId={fixtures.github.id}
        refreshKey={1}
        footer={(controls) => <modules.IssueCommentComposer projectPath="/repo" issue={fixtures.github} controls={controls} />}
      />,
    );
    expect(box()).toBe(before);
    expect(document.activeElement).toBe(before);
    await waitFor(() => expect(document.querySelectorAll("[data-comment-id]").length).toBeGreaterThan(0));
    expect(box()).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(before.value).toBe("Still here");
  });

  it("takes the dictation keys only while it, or nothing that takes text, has the focus", async () => {
    renderIssue("github");
    await screen.findByRole("textbox", { name: "Comment" });
    const title = document.createElement("input");
    document.body.append(title);
    act(() => title.focus());
    expect(dictation.keys).toBe(false);
    act(() => box().focus());
    expect(dictation.keys).toBe(true);
    act(() => box().blur());
    expect(dictation.keys).toBe(true);
    title.remove();
  });
});

describe("@ mentions", () => {
  it("offers the repository's assignable people and inserts their login", async () => {
    renderIssue("github");
    await screen.findByRole("textbox", { name: "Comment" });
    box().focus();
    fireEvent.change(box(), { target: { value: "Thanks @al", selectionStart: 10, selectionEnd: 10 } });
    const list = await screen.findByRole("listbox", { name: "Mention someone" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["alex"]);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("Thanks @alex ");
    expect(issues.calls.some((call) => call.command === "issue_comment_add")).toBe(false);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("offers a Linear team's members and inserts a link to their profile, which Linear shows as a mention", async () => {
    renderIssue("linear");
    await screen.findByRole("textbox", { name: "Comment" });
    box().focus();
    fireEvent.change(box(), { target: { value: "cc @ki", selectionStart: 6, selectionEnd: 6 } });
    const list = await screen.findByRole("listbox", { name: "Mention someone" });
    expect(within(list).getAllByRole("option").map((option) => option.querySelector(".font-medium")?.textContent)).toEqual(["Kim"]);
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box().value).toBe("cc https://linear.app/acme/profiles/Kim ");
  });

  it("finds the word being typed after an @", async () => {
    const { mentionAt } = modules;
    expect(mentionAt("hi @sa", 6)).toEqual({ start: 3, query: "sa" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("mail me@example", 15)).toBeNull();
    expect(mentionAt("hi @sam there", 13)).toBeNull();
  });
});
