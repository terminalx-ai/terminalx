import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageTime } from "./MessageTime";
import { TurnBlock } from "./TurnBlock";
import { buildTranscript, messageTime } from "@terminalx/portable/transcript";
import type { AgentEvent, Payload } from "@terminalx/portable/events";
import { turnRows } from "../../../mobile/src/ui/transcript-rows";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path, invoke: vi.fn() }));
afterEach(cleanup);
const event = (seq: number, ts: string, payload: Payload): AgentEvent => ({ id: `e${seq}`, seq, ts, messageTs: ts, sessionId: "synthetic", tabId: "tab", harness: "claude", payload });
const sent = "2026-10-22T23:59:00Z";
const replied = "2026-10-23T00:01:00Z";
const events = [event(1, sent, { type: "user_message", text: "Synthetic prompt", queued: false }), event(2, replied, { type: "assistant_text", text: "Synthetic reply" })];

it("formats across midnight in the chosen locale and timezone and rejects unknown times", () => {
  expect(messageTime(sent, "en-US", "UTC")?.short).toBe("11:59 PM");
  expect(messageTime(replied, "en-GB", "UTC")?.short).toBe("00:01");
  expect(messageTime(sent, "en-GB", "Asia/Dubai")?.short).toBe("03:59");
  expect(messageTime(sent, "en-US", "UTC")?.full).toContain("October 22");
  expect(messageTime(replied, "en-US", "UTC")?.full).toContain("October 23");
  expect(messageTime(sent, "en-US", "Asia/Dubai")?.full).toContain("October 23");
  for (const ts of [undefined, "", "invalid", "2026-10-23T12:00:00"]) expect(messageTime(ts)).toBeUndefined();
});

it("offers a focusable native disclosure with an accessible full date and time", () => {
  const { container } = render(<MessageTime ts={sent} />);
  const summary = screen.getByLabelText(`Message time: ${messageTime(sent)!.full}`);
  summary.focus();
  expect(document.activeElement).toBe(summary);
  fireEvent.click(summary);
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector("time")?.dateTime).toBe(new Date(sent).toISOString());
  fireEvent.click(summary);
  expect(container.querySelector("details")?.open).toBe(false);
});

it.each([undefined, "/synthetic/repo"])("renders persisted times in shared local/cloud views (cwd %s) after reload", (cwd) => {
  const turn = buildTranscript(events, false).turns[0];
  const { container, rerender } = render(<TurnBlock turn={turn} sessionId="synthetic" cwd={cwd} stream={[]} working={false} />);
  const times = () => [...container.querySelectorAll("time")].map((node) => [node.dateTime, node.textContent]);
  const before = times();
  expect(before.map(([iso]) => iso)).toEqual([new Date(sent).toISOString(), new Date(replied).toISOString()]);
  rerender(<TurnBlock turn={buildTranscript(JSON.parse(JSON.stringify(events)), false).turns[0]} sessionId="synthetic" cwd={cwd} stream={[]} working={false} />);
  expect(times()).toEqual(before);
});

it("preserves sent times when queued messages are absorbed or become the next prompt", () => {
  const queued = event(3, replied, { type: "user_message", text: "Synthetic follow-up", queued: true });
  const absorbed = buildTranscript([...events, queued, event(4, "2026-10-23T01:00:00Z", { type: "prompt_absorbed", promptSeq: 3 })], false);
  expect(absorbed.turns[0].work.at(-1)).toMatchObject({ kind: "message", messageTs: replied });
  const promoted = buildTranscript([...events, queued, event(4, "2026-10-23T01:00:00Z", { type: "turn_started", promptSeq: 3 })], false);
  expect(promoted.turns.at(-1)?.prompt?.messageTs).toBe(replied);
  const unknown = buildTranscript([events[0], event(3, "", queued.payload), event(4, replied, { type: "turn_completed", status: "ok", authFailed: false }), event(5, replied, { type: "turn_started", promptSeq: 3 })], false);
  expect(unknown.turns.at(-1)?.prompt?.messageTs).toBe("");
  const { container } = render(<TurnBlock turn={unknown.turns.at(-1)!} sessionId="synthetic" stream={[]} working={false} />);
  expect(container.querySelector("time")).toBeNull();
});

it("shows one time per message across mobile markdown chunks and queued/absorbed rows", () => {
  const turn = buildTranscript([...events, event(3, sent, { type: "user_message", text: "Queued", queued: true }), event(4, replied, { type: "user_message", text: "Absorbed", queued: true }), event(5, replied, { type: "prompt_absorbed", promptSeq: 4 })], false).turns[0];
  const text = turn.work.find((item) => item.kind === "text")!;
  if (text.kind === "text") text.text = "First paragraph\n\nSecond paragraph";
  const rows = turnRows(turn);
  // The prompt, the reply's first chunk, then the queued and the absorbed message, each drawn
  // as the reader's own message (#985) with its time once.
  expect(rows.filter((row) => row.ts).map((row) => row.ts)).toEqual([sent, replied, sent, replied]);
  expect(rows.filter((row) => row.kind === "prompt" && row.text === "Queued").map((row) => row.ts)).toEqual([sent]);
});

it.each([undefined, "/synthetic/repo"])("omits valid-looking legacy import times after upgrade and reload (cwd %s)", (cwd) => {
  // An older runtime imported a multi-day conversation in one batch. Its ts
  // values are valid ISO dates, but say nothing about when the messages were sent.
  const imported = "2026-10-23T12:00:00Z";
  const legacyPayloads: Payload[] = [
    { type: "user_message", text: "Synthetic old prompt", queued: false },
    { type: "assistant_text", text: "Synthetic old reply" },
    { type: "user_message", text: "Synthetic old absorbed input", queued: true },
    { type: "prompt_absorbed", promptSeq: 3 },
    { type: "user_message", text: "Synthetic old queued input", queued: true },
    { type: "turn_completed", status: "ok", authFailed: false },
    { type: "turn_started", promptSeq: 5 },
    { type: "turn_completed", status: "ok", finalText: "Synthetic old final-only reply", authFailed: false },
  ];
  const legacy = legacyPayloads.map((payload, index) => {
    const { messageTs: _unverified, ...old } = event(index + 1, imported, payload);
    return old;
  });
  const modern = [event(9, sent, events[0].payload), event(10, replied, events[1].payload)];
  // The new marker survives ordinary serialization/sync. No timestamp is
  // inferred for old records, and their event metadata remains untouched.
  const saved = JSON.stringify([...legacy, ...modern]);
  const draw = () => {
    const transcript = buildTranscript(JSON.parse(saved), false);
    expect(transcript.turns[0].ts).toBe(imported);
    expect(transcript.turns[0].prompt?.ts).toBe(imported);
    const mobileTimes = transcript.turns.flatMap(turnRows).flatMap((row) => row.kind === "work" && "messageTs" in row.item ? [row.item.messageTs] : [row.ts]).filter(Boolean);
    expect(mobileTimes).toEqual([sent, replied]);
    return <>{transcript.turns.map((turn) => <TurnBlock key={turn.key} turn={turn} sessionId="synthetic" cwd={cwd} stream={[]} working={false} />)}</>;
  };
  const { container, rerender } = render(draw());
  const times = () => [...container.querySelectorAll("time")].map((time) => time.dateTime);
  expect(times()).toEqual([new Date(sent).toISOString(), new Date(replied).toISOString()]);
  rerender(draw());
  expect(times()).toEqual([new Date(sent).toISOString(), new Date(replied).toISOString()]);
});
