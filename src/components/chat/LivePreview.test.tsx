import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
vi.mock("@/lib/sessions", () => ({ getSessions: () => ({ sessions: [] }), patchTab: vi.fn(), refreshWorkspaces: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
import { applyEvent, dropTabLog, useTabLog } from "@/lib/agentEvents";
import { useConversationView } from "@/lib/conversationView";
import { Chat } from "./Chat";

// The store draws once per animation frame; frames run when the test says.
let frames: FrameRequestCallback[] = [];
const nextFrame = () => act(() => {
  const due = frames;
  frames = [];
  due.forEach((run) => run(0));
});

let seq = 0;
const send = (payload: Payload) => act(() => {
  seq += 1;
  applyEvent({ id: `e${seq}`, seq, sessionId: "preview", tabId: "tab", harness: "codex", ts: "2026-11-02T12:00:00Z", messageTs: "2026-11-02T12:00:00Z", payload } as AgentEvent);
});

/** The live chat as a tab draws it: the store's log, its transcript and its stream. */
function LiveTab() {
  const log = useTabLog("preview", "tab");
  const view = useConversationView(log, undefined);
  return <Chat sessionId="preview" transcript={view.transcript(true)} stream={log.stream} live progressing answering={false} onAnswerPermission={() => {}} onAnswerQuestions={() => {}} footer={null} />;
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => frames.push(run));
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
  // jsdom answers no media queries; reduced motion keeps the working raccoon still.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  cleanup();
  act(() => dropTabLog("preview", "tab"));
  vi.unstubAllGlobals();
});

it("draws each streamed piece of a reply at the next frame, not only the first", () => {
  const view = render(<LiveTab />);
  send({ type: "user_message", text: "Say something", queued: false });
  const block = { messageId: "msg_2", index: 0 };
  send({ type: "delta", delta: "text_delta", block, text: "w0" });
  nextFrame();
  expect(view.container.textContent).toContain("w0");
  send({ type: "delta", delta: "text_delta", block, text: " w1" });
  expect(view.container.textContent).not.toContain("w0 w1"); // batched to the frame, not drawn per piece
  nextFrame();
  expect(view.container.textContent).toContain("w0 w1");
  send({ type: "delta", delta: "text_delta", block, text: " w2" });
  nextFrame();
  expect(view.container.textContent).toContain("w0 w1 w2");
});

it("redraws a streaming thought, its end, and a tool call's input as they change", () => {
  const view = render(<LiveTab />);
  send({ type: "user_message", text: "List the files", queued: false });
  const thought = { messageId: "rs_1", index: 0 };
  send({ type: "delta", delta: "thinking_delta", block: thought, text: "Reading" });
  nextFrame();
  send({ type: "delta", delta: "thinking_delta", block: thought, text: " the tree" });
  nextFrame();
  expect(view.container.textContent).toContain("Reading the tree");
  send({ type: "delta", delta: "block_stop", block: thought });
  nextFrame();
  expect(view.container.textContent).not.toContain("Reading the tree");

  const tool = { messageId: "msg_3", index: 1 };
  send({ type: "delta", delta: "input_delta", block: tool, partialJson: '{"command":"ls' });
  nextFrame();
  expect(view.container.textContent).toContain("Calling a tool");
  send({ type: "delta", delta: "input_delta", block: tool, partialJson: ' -la"}' });
  send({ type: "status", text: "tool_pending:call-1:Bash" });
  nextFrame();
  expect(view.container.textContent).toContain("Bash");
  expect(view.container.textContent).toContain("ls -la");
});
