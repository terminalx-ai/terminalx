import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mouseClick } from "@/test/press";
import { createIssueOpsMock, githubIssueFixture, linearIssueFixture, type IssueOpsMock } from "@/test/issueOpsMock";
import type { IssueComment, IssueProvider } from "@/lib/issueOps";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));

const { IssueCommentThread, THREAD_WINDOW } = await import("./IssueCommentThread");

const fixtures = { github: githubIssueFixture(), linear: linearIssueFixture() };
let issues: IssueOpsMock;

/** `count` comments, the viewer's own every third one. */
function manyComments(provider: IssueProvider, count: number): IssueComment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${provider}-${index + 1}`,
    author: index % 3 === 0 ? { id: "me", name: "Me" } : { id: "other", name: "Other" },
    body: `Comment ${index + 1}`,
    createdAt: new Date(Date.parse("2026-09-01T00:00:00Z") + index * 60_000).toISOString(),
    viewerCanEdit: index % 3 === 0,
    viewerCanDelete: index % 3 === 0,
  }));
}

function backend(seed?: Parameters<typeof createIssueOpsMock>[0]) {
  issues = createIssueOpsMock(seed);
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => issues.handle(command, args) ?? Promise.resolve(undefined));
}

function renderThread(provider: IssueProvider, refreshKey = 0) {
  const issue = fixtures[provider];
  return render(<IssueCommentThread projectPath="/repo" provider={provider} issueId={issue.id} refreshKey={refreshKey} />);
}

const bodies = () => screen.queryAllByRole("listitem").map((item) => item.getAttribute("data-comment-id"));

beforeEach(() => {
  invoke.mockReset();
  backend();
});
afterEach(cleanup);

describe.each(["github", "linear"] as const)("the %s comment thread", (provider) => {
  const key = `${provider}:${fixtures[provider].id}`;

  it("reaches every comment of a long thread with Show earlier comments, in order and once each", async () => {
    const all = manyComments(provider, 137);
    backend({ issues: [fixtures[provider]], comments: { [key]: all } });
    renderThread(provider);
    await waitFor(() => expect(bodies()).toHaveLength(THREAD_WINDOW));
    // The most recent ones first, oldest at the top.
    expect(bodies()).toEqual(all.slice(-THREAD_WINDOW).map((comment) => comment.id));
    // Three pages of 50 were read through the cursor.
    expect(issues.calls.filter((call) => call.command === "issue_comments").map((call) => call.args.cursor)).toEqual([null, "50", "100"]);
    while (screen.queryByRole("button", { name: /Show earlier comments/ })) {
      fireEvent.click(screen.getByRole("button", { name: /Show earlier comments/ }));
    }
    expect(bodies()).toEqual(all.map((comment) => comment.id));
    expect(within(screen.getByRole("region", { name: "Comments" })).getByText("137")).toBeTruthy();
  });

  it("says when the oldest comments of a very long thread are only on the website", async () => {
    const all = manyComments(provider, 2_010);
    backend({ issues: [fixtures[provider]], comments: { [key]: all } });
    renderThread(provider);
    await waitFor(() => expect(bodies()).toHaveLength(THREAD_WINDOW));
    expect(bodies().at(-1)).toBe(all.at(-1)!.id);
    expect(within(screen.getByRole("region", { name: "Comments" })).getByText("2010")).toBeTruthy();
    expect(screen.getByText("Showing the newest 2000 comments. 10 older ones are only on the website; open the issue in your browser to read them.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show earlier comments/ }).textContent).toContain(String(2_000 - THREAD_WINDOW));
  });

  it("keeps a comment that turns up on two pages once", async () => {
    const all = manyComments(provider, 3);
    backend({ issues: [fixtures[provider]], comments: { [key]: all } });
    issues.pageSize = 2;
    const handle = issues.handle;
    // A comment posted while paging pushes the last of page one onto page two.
    issues.handle = (command, args) =>
      command === "issue_comments" && args?.cursor === "2"
        ? Promise.resolve({ comments: [all[1], all[2]], nextCursor: null })
        : handle(command, args);
    renderThread(provider);
    await waitFor(() => expect(bodies()).toEqual(all.map((comment) => comment.id)));
  });

  it("offers edit and delete only on the viewer's own comments", async () => {
    renderThread(provider);
    const [theirs, mine] = await screen.findAllByRole("listitem");
    expect(within(theirs).queryByRole("button", { name: /Actions for comment/ })).toBeNull();
    mouseClick(within(mine).getByRole("button", { name: /Actions for comment/ }));
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("marks an edited comment, with the times on hover", async () => {
    renderThread(provider);
    const [first, second] = await screen.findAllByRole("listitem");
    expect(within(first).queryByText(/edited/)).toBeNull();
    const edited = within(second).getByText(/edited/);
    expect(edited.getAttribute("title")).toMatch(/^Edited /);
    expect(second.querySelector("time")?.getAttribute("dateTime")).toBe("2026-09-01T13:00:00Z");
    expect(second.querySelector("time")?.getAttribute("title")).toBeTruthy();
  });

  it("edits the viewer's comment in place", async () => {
    renderThread(provider);
    const mine = (await screen.findAllByRole("listitem"))[1];
    mouseClick(within(mine).getByRole("button", { name: /Actions for comment/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const box = within(mine).getByRole("textbox", { name: "Edit comment" });
    expect((box as HTMLTextAreaElement).value).toBe("I'll take it.");
    fireEvent.change(box, { target: { value: "I'll take it after lunch." } });
    // Preview shows the Markdown being written.
    fireEvent.click(within(mine).getByRole("tab", { name: "Preview" }));
    expect(within(mine).getByText("I'll take it after lunch.")).toBeTruthy();
    fireEvent.click(within(mine).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(mine).queryByRole("button", { name: "Save" })).toBeNull());
    expect(within(mine).getByText("I'll take it after lunch.")).toBeTruthy();
    expect(issues.calls.find((call) => call.command === "issue_comment_edit")?.args).toMatchObject({ commentId: `${provider}-c2`, body: "I'll take it after lunch." });
  });

  it("keeps the draft and says why when an edit is refused", async () => {
    issues.fail("issue_comment_edit", "forbidden");
    renderThread(provider);
    const mine = (await screen.findAllByRole("listitem"))[1];
    mouseClick(within(mine).getByRole("button", { name: /Actions for comment/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    fireEvent.change(within(mine).getByRole("textbox", { name: "Edit comment" }), { target: { value: "Changed" } });
    fireEvent.keyDown(within(mine).getByRole("textbox", { name: "Edit comment" }), { key: "Enter", metaKey: true });
    expect((await within(mine).findByRole("alert")).textContent).toBe("Your account doesn't have permission to do that.");
    expect((within(mine).getByRole("textbox", { name: "Edit comment" }) as HTMLTextAreaElement).value).toBe("Changed");
  });

  it("deletes the viewer's comment only after a confirmation", async () => {
    renderThread(provider);
    const mine = (await screen.findAllByRole("listitem"))[1];
    mouseClick(within(mine).getByRole("button", { name: /Actions for comment/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(issues.calls.some((call) => call.command === "issue_comment_delete")).toBe(false);
    fireEvent.click(within(mine).getByRole("button", { name: "Cancel" }));
    expect(within(mine).queryByRole("group", { name: "Confirm delete" })).toBeNull();
    mouseClick(within(mine).getByRole("button", { name: /Actions for comment/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(mine).getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(bodies()).toEqual([`${provider}-c1`]));
    expect(issues.calls.find((call) => call.command === "issue_comment_delete")?.args).toMatchObject({ commentId: `${provider}-c2` });
  });

  it("says when there are no comments", async () => {
    backend({ issues: [fixtures[provider]], comments: { [key]: [] } });
    renderThread(provider);
    expect(await screen.findByText("No comments yet.")).toBeTruthy();
  });

  it("says when the comments cannot be read, and reads them again on request", async () => {
    issues.fail("issue_comments", "network");
    renderThread(provider);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't reach the provider. Check your connection, then try again.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bodies()).toEqual([`${provider}-c1`, `${provider}-c2`]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads the thread again on refresh, keeping what was opened", async () => {
    const all = manyComments(provider, 40);
    backend({ issues: [fixtures[provider]], comments: { [key]: all } });
    const view = renderThread(provider);
    await waitFor(() => expect(bodies()).toHaveLength(THREAD_WINDOW));
    fireEvent.click(screen.getByRole("button", { name: /Show earlier comments/ }));
    expect(bodies()).toHaveLength(40);
    // Someone wrote on the website.
    issues.issues.get(key)!.comments.push({ ...all[1], id: `${provider}-new`, body: "From the website" });
    await act(async () => view.rerender(<IssueCommentThread projectPath="/repo" provider={provider} issueId={fixtures[provider].id} refreshKey={1} />));
    await waitFor(() => expect(bodies()).toHaveLength(41));
    expect(screen.getByText("From the website")).toBeTruthy();
  });
});
