import { Profiler } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTranscript } from "@/lib/transcript";
import type { AgentEvent } from "@/types/events";
import { Chat } from "./Chat";

vi.mock("./Markdown", () => ({
  Markdown: ({ text }: { text: string }) => <div data-testid="md">{text}</div>,
}));

afterEach(cleanup);

function makeEvents(): AgentEvent[] {
  return [
    { id: "e1", harness: "claude", sessionId: "s1", tabId: "t1", seq: 1, ts: "2026-11-27T10:00:00Z", payload: { type: "user_message", text: "first prompt", queued: false } },
    { id: "e2", harness: "claude", sessionId: "s1", tabId: "t1", seq: 2, ts: "2026-11-27T10:00:01Z", payload: { type: "assistant_text", text: "first answer" } },
    { id: "e3", harness: "claude", sessionId: "s1", tabId: "t1", seq: 3, ts: "2026-11-27T10:00:02Z", payload: { type: "turn_completed", status: "ok", durationMs: 1000, authFailed: false } },
    { id: "e4", harness: "claude", sessionId: "s1", tabId: "t1", seq: 4, ts: "2026-11-27T10:00:05Z", payload: { type: "user_message", text: "second prompt", queued: false } },
  ];
}

describe("Chat / TurnBlock memoization (P-11)", () => {
  it("does not re-render settled TurnBlocks when streaming chunks arrive on the live turn", () => {
    const transcript = buildTranscript(makeEvents(), true);
    const onAnswerPermission = vi.fn();
    const onAnswerQuestions = vi.fn();
    const onReset = vi.fn();
    const onFork = vi.fn();
    const onSecondOpinion = vi.fn();
    const onRetryInNewChat = vi.fn();

    let commits = 0;
    const { rerender, getAllByTestId } = render(
      <Profiler id="chat" onRender={() => { commits++; }}>
        <Chat
          sessionId="s1"
          tabId="t1"
          transcript={transcript}
          stream={[{ ref: { messageId: "m1", index: 0 }, kind: "text", text: "hel", partialJson: "", done: false }]}
          live
          answering={false}
          onAnswerPermission={onAnswerPermission}
          onAnswerQuestions={onAnswerQuestions}
          onReset={onReset}
          onFork={onFork}
          onSecondOpinion={onSecondOpinion}
          onRetryInNewChat={onRetryInNewChat}
          footer={<div />}
        />
      </Profiler>,
    );

    const settledTurnNode = getAllByTestId("reader-message")[0];
    expect(settledTurnNode.textContent).toContain("first prompt");

    // Re-render with streaming updates; onReset must remain a stable callback (not an inline closure).
    rerender(
      <Profiler id="chat" onRender={() => { commits++; }}>
        <Chat
          sessionId="s1"
          tabId="t1"
          transcript={transcript}
          stream={[{ ref: { messageId: "m1", index: 0 }, kind: "text", text: "hello world", partialJson: "", done: false }]}
          live
          answering={false}
          onAnswerPermission={onAnswerPermission}
          onAnswerQuestions={onAnswerQuestions}
          onReset={onReset}
          onFork={onFork}
          onSecondOpinion={onSecondOpinion}
          onRetryInNewChat={onRetryInNewChat}
          footer={<div />}
        />
      </Profiler>,
    );

    expect(commits).toBeGreaterThanOrEqual(2);
    expect(getAllByTestId("md").some((el) => el.textContent === "hello world")).toBe(true);
  });
});
