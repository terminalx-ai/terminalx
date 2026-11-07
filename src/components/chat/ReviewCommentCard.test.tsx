import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolCall } from "@/lib/transcript";
import type { ReviewComment } from "@/lib/reviewComments";
import { ToolCallRow } from "./ToolCallRow";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

const comment: ReviewComment = {
  id: "comment-1", path: "src/foo.ts", side: "after", startLine: 40, endLine: 40,
  note: "High: validate the request before writing.", lineText: "save(request);",
  author: { type: "reviewerAgent", name: "Reviewer", sessionId: "session-1", tabId: "tab-1" }, revision: 1, sent: false, outdated: false,
};
const call: ToolCall = {
  callId: "review-comment:comment-1", name: "terminalx.review.comment", toolType: "other",
  input: comment, seq: 4, result: { text: "Commented on src/foo.ts:40", isError: false },
};

it("shows a saved comment's location, agent name, note and quoted source", () => {
  render(<ToolCallRow call={call} />);
  const card = screen.getByTestId("review-comment-card");
  expect(card.textContent).toContain("Commented on src/foo.ts:40");
  expect(screen.getByText("Reviewer")).toBeDefined();
  expect(screen.getByText(comment.note)).toBeDefined();
  expect(screen.queryByText(comment.lineText)).toBeNull();
  const details = screen.getByText("Quoted lines").parentElement as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(screen.getByText(comment.lineText)).toBeDefined();
});

it("keeps an inclusive range and renders body and source as plain text", () => {
  const value = { ...comment, path: "src/file with spaces.ts", endLine: 43, note: "<img src=x onerror=alert(1)>\nSecond line", lineText: "<script>alert(1)</script>" };
  const { container } = render(<ToolCallRow call={{ ...call, input: value }} />);
  expect(screen.getByTestId("review-comment-card").textContent).toContain("src/file with spaces.ts:40-43");
  expect(container.textContent).toContain(value.note);
  expect(container.querySelector("img, script")).toBeNull();
});

it("never claims a pending, interrupted or failed call was saved", () => {
  const { rerender } = render(<ToolCallRow call={{ ...call, result: undefined }} />);
  expect(screen.getByText("Saving comment on")).toBeDefined();
  expect(screen.queryByText("Commented on")).toBeNull();
  rerender(<ToolCallRow call={{ ...call, result: undefined, abandoned: true }} />);
  expect(screen.getByText("Comment interrupted on")).toBeDefined();
  rerender(<ToolCallRow call={{ ...call, result: { text: "Line is past the end of the file.", isError: true } }} />);
  expect(screen.getByText("Could not comment on")).toBeDefined();
  expect(screen.getByText("Line is past the end of the file.")).toBeDefined();
  expect(screen.queryByText(comment.note)).toBeNull();
});

it("leaves shell calls and malformed control events in the ordinary tool row", () => {
  const { rerender } = render(<ToolCallRow call={{ ...call, name: "Bash", toolType: "shell", input: { command: 'echo "Commented on foo.ts:40"' } }} />);
  expect(screen.queryByTestId("review-comment-card")).toBeNull();
  for (const input of [null, { ...comment, startLine: 0 }, { ...comment, endLine: 39 }, { ...comment, author: null }]) {
    rerender(<ToolCallRow call={{ ...call, input }} />);
    expect(screen.queryByTestId("review-comment-card")).toBeNull();
  }
});

it("mounts only a bounded preview of large or legacy quotes when expanded", () => {
  const quote = Array.from({ length: 1000 }, (_, i) => `quoted ${i}`).join("\n");
  const { container } = render(<ToolCallRow call={{ ...call, input: { ...comment, startLine: 1, endLine: 1000, lineText: quote } }} />);
  expect(container.querySelector("pre")).toBeNull();
  const details = screen.getByText("Quoted lines (preview of 1000 lines)").parentElement as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  const preview = container.querySelector("pre")!;
  expect(preview.textContent?.split("\n")).toHaveLength(20);
  expect(preview.textContent).toContain("quoted 19");
  expect(preview.textContent).not.toContain("quoted 20");
});
